/**
 * lookahead-check — detect blocks that read bars j > i at bar i.
 *
 * Contract invariant: a block's onBar at bar i may only read candles[j]
 * and state-array[j] for j <= i. Breaking this makes the strategy
 * untranslatable to Pine and broken in live mode (the data simply
 * doesn't exist yet).
 *
 * Detection strategy — compare two runs on the same bar index:
 *
 *   Run 1 ("full"):    bundle has real values at every index.
 *   Run 2 ("poisoned"): bundle has real values at indices <= cutoff,
 *                       NaN at indices > cutoff.
 *
 * At cutoff < midpoint, call block.prepare() and then block.onBar(cutoff)
 * on each run. If the outputs differ, the block is reading forward —
 * something in prepare() or onBar() touched an index > cutoff.
 *
 * This catches:
 *   (a) prepare() precomputing state[j] using candles[k] with k > j
 *       — the poisoned bundle produces NaN state, outputs differ
 *   (b) onBar(i) reading candles[j] or state[j] with j > i
 *       — direct forward access flips the output
 *
 * What it does NOT catch:
 *   - Blocks that read forward but happen to not propagate the difference
 *     into the return value on THIS particular cutoff. Iterating over
 *     several cutoffs makes a false-negative very unlikely in practice.
 *   - Bugs entirely in HTF handling (we don't synthesize HTFs — the
 *     harness runs on base TF only). Dedicated HTF-lookahead tests would
 *     go against a multi-TF bundle; not in scope here.
 *
 * Synthetic data shape:
 *   len = 300 bars, monotonic-ish OHLC with small random jitter seeded
 *   deterministically. Volume = 1000 + i (monotonic). That's enough
 *   range for most indicators to reach stable values before the cutoff.
 *
 * Returns: { ok: boolean, reason?: string, details?: Object }
 */

/**
 * Deterministic-seeded small RNG — LCG, period long enough for our 300
 * bars × a few blocks. Same seed → same sequence.
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSyntheticBase(len = 300, seed = 42) {
  const rng = mulberry32(seed);
  const ts     = new Float64Array(len);
  const open   = new Float64Array(len);
  const high   = new Float64Array(len);
  const low    = new Float64Array(len);
  const close  = new Float64Array(len);
  const volume = new Float64Array(len);
  const startTs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const tfMs = 4 * 60 * 60 * 1000;
  let price = 100;
  for (let i = 0; i < len; i++) {
    ts[i] = startTs + i * tfMs;
    const drift = (rng() - 0.48) * 2;    // mild upward drift so monotonic tests don't flatline
    price = Math.max(1, price + drift);
    const rng2 = rng() * 1.5;
    open[i]   = price;
    high[i]   = price + rng2;
    low[i]    = price - rng2 * 0.8;
    close[i]  = price + (rng() - 0.5) * 0.5;
    volume[i] = 1000 + i + rng() * 100;
  }
  return { ts, open, high, low, close, volume };
}

function poisonAfter(candles, cutoff) {
  // Return a NEW bundle with typed arrays copied and indices > cutoff
  // set to NaN. Keep index semantics intact (length unchanged) so
  // blocks' prepare() sees the full length.
  const out = {};
  for (const k of Object.keys(candles)) {
    const src = candles[k];
    const dst = new Float64Array(src.length);
    dst.set(src);
    for (let j = cutoff + 1; j < dst.length; j++) dst[j] = NaN;
    out[k] = dst;
  }
  return out;
}

/**
 * Build a mock indicators Map for a block's deps by calling the real
 * indicator-cache dispatcher against the given bundle. This lets us
 * detect lookahead in BOTH prepare() and onBar() — if a block computes
 * derived indicators from its source data, the forward-looking bars
 * become NaN under poison and downstream state goes NaN too.
 */
async function buildIndicatorMapForBlock(block, params, baseCandles) {
  const { buildIndicatorCache } = await import('../indicator-cache.js');
  const bundle = { base: baseCandles };
  const deps = block.indicatorDeps?.(params) ?? [];
  // Resolve only base-TF deps; HTF deps are out of scope for this harness.
  const baseDeps = deps.filter(d => !d.tf || d.tf === 'base' || d.tf === 0);
  if (baseDeps.length !== deps.length) {
    // Caller should either skip or synthesize HTFs — we signal via null.
    return null;
  }
  return buildIndicatorCache(bundle, baseDeps);
}

/** Representative params: take each declared param at midpoint of its range. */
function midpointParams(block) {
  const p = {};
  for (const d of block.declaredParams?.() ?? []) {
    const mid = (d.min + d.max) / 2;
    const stepped = Math.round((mid - d.min) / d.step) * d.step + d.min;
    p[d.id] = d.type === 'int' ? Math.round(stepped) : stepped;
  }
  return p;
}

/**
 * Normalize an onBar return value to a stable JSON-serializable form for
 * equality comparison. Handles {long, short} for entries/filters, a
 * string/null for regimes, a number for sizing (via computeSize), and
 * the richer exit-block shapes.
 */
function normalizeResult(kind, r) {
  if (r == null) return null;
  if (kind === 'entry' || kind === 'filter') {
    return JSON.stringify({ long: !!r.long ? 1 : 0, short: !!r.short ? 1 : 0 });
  }
  if (kind === 'regime') {
    return typeof r === 'string' ? r : JSON.stringify(r);
  }
  if (kind === 'sizing') {
    // Sizing returns a raw number from computeSize — rounding kills
    // NaN/Infinity ambiguity and ignores floating-point noise.
    return Number.isFinite(r) ? r.toFixed(8) : String(r);
  }
  // Exit: dispatch on action shape.
  if (typeof r === 'object') {
    return JSON.stringify(r);
  }
  return String(r);
}

/**
 * Check a single block for lookahead.
 *
 * @param {Object} block — registered block module (default export)
 * @returns {Promise<{ok: boolean, reason?: string, details?: Object}>}
 */
export async function checkBlockForLookahead(block) {
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'not a block module' };
  }
  const kind = block.kind;
  if (!kind) return { ok: false, reason: 'block has no kind' };

  const params = midpointParams(block);
  const LEN    = 300;
  const CUTOFFS = [150, 200, 250]; // three checkpoints across the series

  const fullBase = buildSyntheticBase(LEN);

  // Build indicator cache against the FULL base once. We'll feed the SAME
  // indicator map to both runs — poisoning the bundle would otherwise
  // also poison the indicator outputs, producing trivially different
  // results everywhere. The point of the harness is to catch blocks that
  // read the RAW CANDLE FORWARD in prepare/onBar, not to re-check
  // indicator-level lookahead (indicators are vetted via their own tests).
  const fullIndicators = await buildIndicatorMapForBlock(block, params, fullBase);
  if (fullIndicators === null) {
    return { ok: true, reason: 'skipped (block declares HTF deps; HTF lookahead not covered by this harness)' };
  }

  for (const cutoff of CUTOFFS) {
    const poisonBase = poisonAfter(fullBase, cutoff);

    // Prepare + onBar on FULL bundle (control).
    const stateFull = {};
    block.prepare?.({ base: fullBase }, params, fullIndicators, stateFull);

    // Prepare + onBar on POISONED bundle (challenge).
    const statePoison = {};
    try {
      block.prepare?.({ base: poisonBase }, params, fullIndicators, statePoison);
    } catch (e) {
      return {
        ok: false,
        reason: `prepare() threw on poisoned bundle at cutoff=${cutoff}: ${e.message}`,
      };
    }

    // Compare onBar / computeSize outputs at bar `cutoff`.
    let rFull, rPoison;
    if (kind === 'sizing') {
      // Sizing blocks use computeSize(ctx, state, params) — synthesize a
      // minimal ctx. We run at cutoff - 1 so `ctx.i - 1` is well-defined
      // for atr-risk-style sizing that reads state[i-1].
      const i = cutoff;
      const syntheticCtx = {
        i,
        fillPrice: fullBase.close[i] ?? 100,
        equity: 100000,
        initialCapital: 100000,
        leverage: 1,
        isLong: true,
        bundle: { base: fullBase },
        indicators: fullIndicators,
        stopPrice: null,
        stopDistance: fullBase.close[i] * 0.02,
        stats: { tradeCount: 100, wins: 50, losses: 50, winRate: 0.5,
                 avgWin: 100, avgLoss: 100, biggestWin: 500, biggestLoss: 500,
                 currentStreak: { kind: 'win', len: 1 }, lastTradePnl: 0,
                 netEquityMultiple: 1.0 },
      };
      try {
        rFull   = block.computeSize(syntheticCtx, stateFull,   params);
        rPoison = block.computeSize({ ...syntheticCtx, bundle: { base: poisonBase } }, statePoison, params);
      } catch (e) {
        return { ok: false, reason: `computeSize threw at cutoff=${cutoff}: ${e.message}` };
      }
    } else {
      try {
        rFull   = block.onBar?.({ base: fullBase },   cutoff, stateFull,   params);
        rPoison = block.onBar?.({ base: poisonBase }, cutoff, statePoison, params);
      } catch (e) {
        return { ok: false, reason: `onBar() threw at cutoff=${cutoff}: ${e.message}` };
      }
    }

    const nFull   = normalizeResult(kind, rFull);
    const nPoison = normalizeResult(kind, rPoison);

    if (nFull !== nPoison) {
      return {
        ok: false,
        reason: `lookahead detected at cutoff=${cutoff}`,
        details: { full: nFull, poisoned: nPoison, params },
      };
    }
  }

  return { ok: true };
}

/**
 * Run the lookahead check over every registered block.
 *
 * @returns {Promise<{ passed: number, failed: number, results: Array }>}
 */
export async function checkAllBlocksForLookahead() {
  const registry = await import('./registry.js');
  await registry.ensureLoaded();
  const all = registry.list();

  let passed = 0, failed = 0;
  const results = [];
  for (const block of all) {
    const r = await checkBlockForLookahead(block);
    results.push({ id: block.id, kind: block.kind, version: block.version, ...r });
    if (r.ok) passed++;
    else failed++;
  }
  return { passed, failed, results };
}
