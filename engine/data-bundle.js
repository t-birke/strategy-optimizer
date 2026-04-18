/**
 * Data bundle loader — multi-timeframe candle delivery for the runtime.
 *
 * A "bundle" is everything a spec needs to run on a specific instrument:
 *   - The base-TF candles the strategy iterates over
 *   - Zero or more HTF candles (weekly / daily / custom) requested by blocks
 *   - A per-HTF `htfBarIndex` map: baseBarIdx -> last-CLOSED HTF bar idx
 *
 * Last-closed semantics (critical for Pine parity):
 *   At base bar `i` with timestamp ts[i], the HTF value that Pine's
 *   `request.security(..., lookahead=barmerge.lookahead_off)` returns is the
 *   CLOSE of the most recent HTF bar that has FULLY COMPLETED by ts[i].
 *   We match this exactly:
 *     htfBarIndex[i] = largest j such that htfTs[j] + htfTfMs <= ts[i]
 *   Index -1 (represented as UINT32_MAX in the typed array) means
 *   "no HTF bar has closed yet" — block authors must guard against this.
 *
 * Warmup: each block declares its indicator deps (tf + period). We derive
 * the worst-case warmup per TF from the spec's param ranges (over-provision
 * is safe) and load that many bars BEFORE the trading start. The runtime
 * skips indicator-NaN bars in the main loop, so the exact warmup just has
 * to be "enough".
 */

import { loadCandles } from '../db/candles.js';
import * as registry from './blocks/registry.js';

// Sentinel for "no HTF bar closed yet" stored in a Uint32Array.
export const HTF_NONE = 0xFFFFFFFF;

// ─── Data requirements from spec ────────────────────────────

/**
 * Walk a spec's blocks and collect TF+lookback requirements.
 *
 * For each indicator dep declared by each block instance, compute the
 * worst-case lookback over the spec's param ranges (max of range.max for
 * params that feed into a period/length indicator arg). Result:
 *
 *   { htfTfMins: Set<int>, warmupBarsByTf: Map<tfMin, bars> }
 *
 * `base` TF is reported as tfMin = 0 (resolved to the run's actual base
 * TF at load time). HTFs are reported in minutes.
 */
export function computeDataRequirements(spec) {
  const warmupBarsByTf = new Map();  // tfMin -> max lookback bars (0 = base)
  const htfTfMinsSet   = new Set();

  const addDep = (tf, bars) => {
    const key = tf === 'base' ? 0 : tfToMin(tf);
    if (key !== 0) htfTfMinsSet.add(key);
    warmupBarsByTf.set(key, Math.max(warmupBarsByTf.get(key) ?? 0, bars));
  };

  const visit = (ref) => {
    if (!ref) return;
    if (!registry.has(ref.block, ref.version)) return;
    const block = registry.get(ref.block, ref.version);
    // Build a "worst-case" params object using the block's declared maxes
    // for each param that isn't pinned. This over-provisions warmup,
    // which is safe — we'd rather load a few extra bars than underflow.
    const worst = Object.create(null);
    for (const p of block.declaredParams()) {
      const supplied = ref.params?.[p.id];
      if (supplied && 'value' in supplied) worst[p.id] = supplied.value;
      else if (supplied && 'max' in supplied) worst[p.id] = supplied.max;
      else worst[p.id] = p.max;
    }
    const deps = block.indicatorDeps(worst) ?? [];
    for (const d of deps) {
      // Convention: indicator deps carry `args.period` (or `args.length`)
      // used for lookback. Blocks needing richer metadata can also
      // declare an explicit `lookback` field, which we prefer when present.
      const lookback = d.lookback
        ?? d.args?.period
        ?? d.args?.length
        ?? 0;
      if (lookback > 0) addDep(d.tf ?? 'base', lookback);
    }
  };

  visit(spec.regime);
  spec.entries?.blocks?.forEach(visit);
  spec.filters?.blocks?.forEach(visit);
  if (spec.exits) {
    visit(spec.exits.hardStop);
    visit(spec.exits.target);
    visit(spec.exits.trail);
  }
  visit(spec.sizing);

  return {
    htfTfMins: [...htfTfMinsSet].sort((a, b) => a - b),
    warmupBarsByTf,
  };
}

/**
 * Translate a timeframe alias ('base'|'daily'|'weekly'|'monthly') or numeric
 * minutes to minutes. Numeric passthrough is supported so blocks can declare
 * arbitrary TFs directly.
 */
export function tfToMin(tf) {
  if (typeof tf === 'number') return tf;
  switch (tf) {
    case 'base':    return 0;
    case 'hourly':  return 60;
    case 'daily':   return 1440;
    case 'weekly':  return 10080;
    case 'monthly': return 43200;  // Approx — Pine uses 1M as a native unit
    default:
      const n = Number(tf);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
      throw new Error(`Unknown timeframe alias: ${JSON.stringify(tf)}`);
  }
}

// ─── Bundle loader ──────────────────────────────────────────

/**
 * Load a data bundle for a run.
 *
 * @param {Object} cfg
 * @param {string} cfg.symbol            — e.g., 'BTCUSDT'
 * @param {number} cfg.baseTfMin         — base timeframe in minutes
 * @param {Object} cfg.spec              — validated spec (used to discover HTFs + warmup)
 * @param {number} cfg.startTs           — first trading bar ts (ms)
 * @param {number} [cfg.endTs]           — last trading bar ts (ms, exclusive upper bound)
 * @param {number} [cfg.minBaseWarmupBars=200] — floor on base warmup (indicators like bbLen+100 need headroom)
 * @returns {Promise<Object>} bundle — see module docstring
 */
export async function loadDataBundle(cfg) {
  const {
    symbol,
    baseTfMin,
    spec,
    startTs,
    endTs = Infinity,
    minBaseWarmupBars = 200,
  } = cfg;

  const reqs = computeDataRequirements(spec);

  // ── Base TF ──
  const baseWarmupBars = Math.max(minBaseWarmupBars, reqs.warmupBarsByTf.get(0) ?? 0);
  const baseTfMs = baseTfMin * 60_000;
  const basePreloadTs = startTs - baseWarmupBars * baseTfMs;

  const base = await loadCandles(symbol, baseTfMin, basePreloadTs);
  if (base.close.length === 0) {
    throw new Error(`No base candles for ${symbol} ${baseTfMin}min from ${new Date(basePreloadTs).toISOString()}`);
  }

  const tradingStartBar = findFirstIndexAtOrAfter(base.ts, startTs);
  const baseEndBar = endTs < Infinity
    ? findFirstIndexAtOrAfter(base.ts, endTs)
    : base.close.length;

  // Trim tail to endTs (leave head intact as warmup)
  const baseTrimmed = baseEndBar < base.close.length ? sliceCandles(base, 0, baseEndBar) : base;

  // ── HTFs ──
  const htfs = {};
  for (const htfTfMin of reqs.htfTfMins) {
    const htfWarmupBars = reqs.warmupBarsByTf.get(htfTfMin) ?? 0;
    const htfTfMs = htfTfMin * 60_000;
    const htfPreloadTs = startTs - htfWarmupBars * htfTfMs;

    const htfCandles = await loadCandles(symbol, htfTfMin, htfPreloadTs);
    if (htfCandles.close.length === 0) {
      throw new Error(`HTF ${htfTfMin}min: no data for ${symbol} from ${new Date(htfPreloadTs).toISOString()}`);
    }

    const htfBarIndex = makeHtfBarIndex(baseTrimmed.ts, htfCandles.ts, htfTfMs);
    htfs[htfTfMin] = {
      ts:     htfCandles.ts,
      open:   htfCandles.open,
      high:   htfCandles.high,
      low:    htfCandles.low,
      close:  htfCandles.close,
      volume: htfCandles.volume,
      tfMin:  htfTfMin,
      tfMs:   htfTfMs,
      htfBarIndex,
    };
  }

  const periodYears = base.close.length > 0
    ? (baseTrimmed.ts[baseTrimmed.ts.length - 1] - baseTrimmed.ts[tradingStartBar]) / (365.25 * 864e5)
    : 0;

  return {
    symbol,
    baseTfMin,
    baseTfMs,
    base: baseTrimmed,
    htfs,
    tradingStartBar,
    periodYears,
  };
}

// ─── Core mapping: base bar -> last-closed HTF bar ──────────

/**
 * For each base bar, find the most recent HTF bar that has fully closed
 * by the base bar's timestamp. O(baseLen + htfLen) single pass — HTF and
 * base are both pre-sorted by ts ascending.
 *
 * baseTs[i] is conventionally the bar's OPEN time. An HTF bar with
 * openTs = htfTs[j] closes at htfTs[j] + htfTfMs. So htfTs[j] + htfTfMs
 * <= baseTs[i] means "the HTF bar has fully closed at the moment base
 * bar i opens" — which is exactly Pine's default HTF lookup semantics.
 *
 * @param {Float64Array} baseTs
 * @param {Float64Array} htfTs
 * @param {number}       htfTfMs
 * @returns {Uint32Array} length == baseTs.length; HTF_NONE for "not yet"
 */
export function makeHtfBarIndex(baseTs, htfTs, htfTfMs) {
  const baseLen = baseTs.length;
  const htfLen  = htfTs.length;
  const out = new Uint32Array(baseLen);

  // Fill "no HTF bar yet" by default
  out.fill(HTF_NONE);

  let htfIdx = -1; // index of last-closed HTF bar so far
  for (let i = 0; i < baseLen; i++) {
    const t = baseTs[i];
    // Advance while the NEXT HTF bar has also closed by t
    while (htfIdx + 1 < htfLen && htfTs[htfIdx + 1] + htfTfMs <= t) htfIdx++;
    out[i] = htfIdx >= 0 ? htfIdx : HTF_NONE;
  }
  return out;
}

// ─── Small utilities ────────────────────────────────────────

function findFirstIndexAtOrAfter(ts, targetTs) {
  // Linear is fine — this is called O(1) times per bundle load, not per bar.
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] >= targetTs) return i;
  }
  return ts.length;
}

function sliceCandles(c, start, end) {
  return {
    ts:     c.ts.slice(start, end),
    open:   c.open.slice(start, end),
    high:   c.high.slice(start, end),
    low:    c.low.slice(start, end),
    close:  c.close.slice(start, end),
    volume: c.volume.slice(start, end),
  };
}
