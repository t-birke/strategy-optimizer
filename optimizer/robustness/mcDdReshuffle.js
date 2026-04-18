/**
 * mcDdReshuffle — Monte Carlo trade-order reshuffle for drawdown robustness.
 *
 * Context (see docs/backlog.md §6.1 "Composite fitness with O(1) robustness
 * terms"): the backtest's `maxDDPct` is a SINGLE realization of one specific
 * trade sequence. The same set of trades in a different order would have
 * produced a different worst drawdown — sometimes much worse, sometimes much
 * milder. Live trading will not replay the exact historical sequence; the
 * statistics that matter for sizing decisions live in the DISTRIBUTION of
 * possible max-drawdowns, not in one sample.
 *
 * This module resamples that distribution. For N random shuffles of the
 * trade list's pnlPct values, we build an equity curve, measure its maxDD,
 * and return the percentiles:
 *
 *   p50 — median shuffled maxDD (typical outcome under reordering)
 *   p95 — 95th-percentile maxDD (honest live-trading DD estimate)
 *   p99 — worst-case tail
 *
 * Industry rule-of-thumb: live DD ≈ 1.5–2× backtest DD. MC-DD-P95 converges
 * to the upper end of that band, giving us a statistically grounded number
 * instead of a fudge factor.
 *
 * Why this works: max-drawdown is NOT invariant under trade reordering.
 * A losing streak concentrated early produces a deeper DD than the same
 * losses sprinkled across winners. By shuffling we measure how much of
 * the backtest's DD is structural (the trades themselves) vs incidental
 * (the happened-to-be ordering). Phase 6.1's fitness composition uses the
 * ratio `maxDD_backtest / max(MC_DD_P95, ε)` — genes whose backtest DD
 * looks benign but whose MC-DD-P95 is savage get penalized.
 *
 * Design notes:
 *
 *   • Deterministic. We seed a mulberry32 PRNG (same impl used in
 *     scripts/evaluate-gene-check.js for synthetic-bundle repro) rather
 *     than Math.random(), so identical inputs produce identical outputs —
 *     required for fitness determinism and for unit-test stability.
 *
 *   • Fisher-Yates on a Float64Array of pnlPct values (not trade objects).
 *     We only need the numeric pnl for the equity curve; shuffling objects
 *     would move ~10 fields per swap for no gain. Typed arrays also let
 *     V8 treat the hot loop as a tight numeric kernel.
 *
 *   • The equity curve is additive on initial-capital fractions. runtime.js
 *     already emits `pnlPct` as a fraction of initial capital per trade,
 *     so cumsum(pnlPct) starting at 1.0 is the correct equity trajectory
 *     for a constant-size (no-compounding-from-equity) sizing model —
 *     which matches how the backtest's maxDDPct is computed. Drawdown is
 *     then `(peak − equity) / peak`, the same ratio runtime uses.
 *
 *   • N=1000 samples × ~100-trade series is ~100k adds per call; on a
 *     modern CPU this is sub-millisecond. No parallelization needed.
 *
 *   • Empty / invalid trade list → all-zero result. The caller
 *     (fitness.js) decides whether that's a gate-failure or a free pass;
 *     we don't throw, because the composition multiplier expects a
 *     numeric shape even for pathological genes.
 *
 * Pure: no I/O, no time, no state. Feed it a trade list, get a deterministic
 * {p50, p95, p99, nSamples} — trivial to unit-test and to diff across
 * commits.
 */

/**
 * mulberry32 — 32-bit deterministic PRNG. Same impl as
 * scripts/evaluate-gene-check.js. Returns a function that yields uniform
 * doubles in [0, 1) on each call.
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Extract the `pnlPct` field from each trade into a Float64Array. Trades
 * lacking a finite pnlPct are dropped — they'd corrupt the equity curve
 * with NaN/Infinity and silently poison every sample. Returns null for
 * empty / non-array input so the caller can short-circuit.
 */
function extractPnlPct(tradeList) {
  if (!Array.isArray(tradeList) || tradeList.length === 0) return null;
  const buf = new Float64Array(tradeList.length);
  let n = 0;
  for (let i = 0; i < tradeList.length; i++) {
    const t = tradeList[i];
    const v = t?.pnlPct;
    if (typeof v === 'number' && Number.isFinite(v)) {
      buf[n++] = v;
    }
  }
  if (n === 0) return null;
  // Trim to actual length (cheap — single alloc + copy).
  return buf.subarray(0, n).slice();
}

/**
 * Compute max drawdown of an equity curve that starts at 1.0 and is
 * updated by successive pnlPct additions. Returns the DD as a non-negative
 * fraction of the running peak: (peak − equity) / peak.
 *
 * Hot inner loop — we keep it branch-light and in-register. The equity
 * scratch buffer is caller-provided so we don't allocate per sample.
 */
function maxDdFromShuffled(pnlArr, equityScratch) {
  const n = pnlArr.length;
  let equity = 1.0;
  let peak = 1.0;
  let worstDd = 0;
  for (let i = 0; i < n; i++) {
    equity += pnlArr[i];
    equityScratch[i] = equity;
    if (equity > peak) peak = equity;
    // Peak ≤ 0 means the account is wiped. Cap DD at 1.0 (total loss)
    // rather than letting the divisor flip sign and produce nonsense.
    if (peak <= 0) {
      worstDd = 1;
      continue;
    }
    const dd = (peak - equity) / peak;
    if (dd > worstDd) worstDd = dd;
  }
  return worstDd;
}

/**
 * Fisher-Yates shuffle on a Float64Array using the provided PRNG. Mutates
 * in place. Classical Durstenfeld variant — iterate from the end, swap
 * each element with a uniform pick from [0, i].
 */
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0; // floor via bitwise OR; safe for j < 2^31
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Percentile via linear interpolation on a pre-sorted array. Matches the
 * "R-7" / numpy-default convention so test expectations line up with
 * hand-computed values.
 */
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * p;
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Monte Carlo trade-order reshuffle. See file header for the "why".
 *
 * @param {Array<Object>} tradeList — runtime-produced trade array. Each
 *                                    trade has shape
 *                                    `{direction, entryTs, exitTs, signal,
 *                                       entryPrice, exitPrice, sizeAsset,
 *                                       sizeUsdt, riskUsdt, pnl, pnlPct,
 *                                       regime}`. We only read `pnlPct`.
 * @param {Object}  [opts]
 * @param {number}  [opts.nSamples=1000] — number of shuffles. 1000 gives
 *                                          a stable P95 (SE ~ 1% of the
 *                                          true value) without meaningful
 *                                          CPU cost on the 96-worker grid.
 * @param {number}  [opts.seed=42]       — PRNG seed. Same seed → identical
 *                                          output. Tests pin this.
 *
 * @returns {{
 *   p50DdPct: number,  // median shuffled maxDD, fraction of initial cap
 *   p95DdPct: number,  // 95th percentile (the headline "honest DD")
 *   p99DdPct: number,  // worst-case tail
 *   nSamples: number,  // echo of effective sample count
 * }}
 */
export function mcDdReshuffle(tradeList, { nSamples = 1000, seed = 42 } = {}) {
  const pnl = extractPnlPct(tradeList);
  // Empty / all-invalid trade list → nothing to resample. Return the
  // neutral zero so the composition multiplier treats this gene as
  // "no DD signal" rather than crashing.
  if (pnl === null) {
    return { p50DdPct: 0, p95DdPct: 0, p99DdPct: 0, nSamples: 0 };
  }
  // Clamp nSamples to a sane range. Negative / zero → return all-zero
  // so the contract is preserved; callers that disable the term can do so
  // by passing `nSamples: 0`.
  const N = (typeof nSamples === 'number' && nSamples > 0) ? Math.floor(nSamples) : 0;
  if (N === 0) {
    return { p50DdPct: 0, p95DdPct: 0, p99DdPct: 0, nSamples: 0 };
  }

  const rng = mulberry32((seed | 0) >>> 0);

  // Working buffers, allocated once and reused across samples:
  //   shuffleBuf — a mutable copy of `pnl`; Fisher-Yates operates here.
  //   equityBuf  — equity curve scratch passed into maxDdFromShuffled.
  //   dds        — collected maxDDs, one per sample, for percentile calc.
  const shuffleBuf = new Float64Array(pnl.length);
  const equityBuf  = new Float64Array(pnl.length);
  const dds        = new Float64Array(N);

  for (let s = 0; s < N; s++) {
    // Refresh the working copy each sample. Float64Array.set is a
    // native memcpy — cheap even at N=1000.
    shuffleBuf.set(pnl);
    shuffleInPlace(shuffleBuf, rng);
    dds[s] = maxDdFromShuffled(shuffleBuf, equityBuf);
  }

  // In-place ascending sort (TypedArray sort is numeric by default,
  // unlike Array.prototype.sort which would sort lexicographically).
  dds.sort();

  return {
    p50DdPct: percentile(dds, 0.50),
    p95DdPct: percentile(dds, 0.95),
    p99DdPct: percentile(dds, 0.99),
    nSamples: N,
  };
}
