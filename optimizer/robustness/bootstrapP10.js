/**
 * bootstrapP10 — trade-list bootstrap robustness term (Phase 6.1, term 2 of 5).
 *
 * Build Alpha-style robustness check, applied post-hoc on an existing
 * trade list. Zero extra backtests per gene. See `docs/backlog.md` §6.1
 * for the full composite-robustness design.
 *
 * The question it answers: **"Does the edge depend on a small number
 * of specific trades, or is it a general effect?"**
 *
 * Method: bootstrap-with-replacement resample of per-trade returns.
 * For each of N=1000 samples we draw `trades.length` returns WITH
 * REPLACEMENT from the actual trade list and sum them. The resulting
 * distribution of total net returns answers: if a randomly selected
 * (same-size) subset of these trade outcomes had materialized instead
 * of the historical ordering, how good/bad would the P&L have been?
 *
 * The **P10 net return** is the left-tail answer. If it is < 0, the
 * historical edge is fragile — a plausible alternative draw of the same
 * trade distribution would have been a losing year. If P10 > 0, the
 * edge holds up even after dropping a chunk of the biggest winners.
 * This catches the "three lucky trades carry the year" failure mode.
 *
 * P50 (median) and P90 are returned alongside P10 for sanity:
 *   - P50 should be close to the historical net return (a bootstrap
 *     is unbiased in expectation).
 *   - P90 is the right-tail counterpart, useful for asymmetry checks.
 *
 * Design notes:
 *
 *   • Uses per-trade `pnlPct` (return as a fraction of initial capital).
 *     This is what the runtime attaches to each trade record and is
 *     what the GA's fitness layer consumes. Summing pnlPct across N
 *     draws is the correct definition of "net return of this sample".
 *     (This is NOT compounding — bootstrapped samples are a statistical
 *     resample of the trade population, not a re-simulation of
 *     sequential trading. A single trade appearing 3× in one sample
 *     contributes 3× its pnlPct, not 3× compounded.)
 *
 *   • Deterministic: uses the seeded mulberry32 PRNG so repeat runs
 *     produce identical P10/P50/P90 for the same seed. The GA calls
 *     fitness N times per gene across generations; non-determinism
 *     would add noise to the selection gradient.
 *
 *   • Float64Array for the net-return samples: N=1000 doubles is 8 KB,
 *     avoids per-element boxing, and gives us a trivial in-place sort
 *     path via typed-array sort.
 *
 *   • Empty or non-array input → all-zero result, not a throw.
 *     Upstream (island-worker, evaluate-gene) already suppresses gene
 *     evaluation for zero-trade cases; this module inherits that
 *     convention so it can be called unconditionally post-backtest.
 *
 * Pure: no I/O, no time, no shared state. Feed it a trade list, get
 * a deterministic result.
 */

/**
 * Seeded 32-bit PRNG. Small, fast, well-distributed enough for
 * statistical resampling — not cryptographically secure. Copied
 * verbatim from the standard mulberry32 reference so the behavior
 * here matches other robustness modules that use the same seed.
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
 * Return the P-th percentile of a sorted Float64Array using linear
 * interpolation between the two nearest ranks. Matches NumPy's default
 * (`linear` method) so results are comparable to any reference
 * analysis done offline in Python.
 *
 * @param {Float64Array} sorted   — MUST already be sorted ascending.
 * @param {number}       p        — percentile in [0, 100].
 */
function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo   = Math.floor(rank);
  const hi   = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Bootstrap-with-replacement of the trade list to quantify how much
 * of the historical net return depends on a handful of specific trades.
 *
 * @param {Array<{pnlPct?: number}>} tradeList
 *        Runtime trade records. Only `pnlPct` is consulted; other
 *        fields (direction, entryTs, exitTs, signal, entryPrice,
 *        exitPrice, sizeAsset, sizeUsdt, riskUsdt, pnl, regime) are
 *        ignored here.
 * @param {Object}  [opts]
 * @param {number}  [opts.nSamples=1000]  — number of bootstrap samples.
 *                                          1000 is the Phase 6.1 default
 *                                          and gives stable P10 estimates
 *                                          for trade lists of ≥30.
 * @param {number}  [opts.seed=42]        — PRNG seed for determinism.
 *
 * @returns {{
 *   p10NetPct:  number,   // 10th-percentile net return (fraction of initial cap)
 *   p50NetPct:  number,   // median net return — sanity check vs historical
 *   p90NetPct:  number,   // 90th-percentile — right-tail counterpart
 *   sampleSize: number,   // trades.length — surfaced for clarity
 *   nSamples:   number,   // echoes nSamples — what actually ran
 * }}
 */
export function bootstrapP10(tradeList, {
  nSamples = 1000,
  seed     = 42,
} = {}) {
  // Empty / invalid → zeroed result. Lets the caller apply this
  // unconditionally without having to guard every call site.
  if (!Array.isArray(tradeList) || tradeList.length === 0) {
    return {
      p10NetPct:  0,
      p50NetPct:  0,
      p90NetPct:  0,
      sampleSize: 0,
      nSamples:   0,
    };
  }

  // Extract pnlPct into a dense typed array. Trades with non-finite
  // or missing pnlPct are coerced to 0 — safer than failing the whole
  // resample over one bad record (upstream runtime should never emit
  // these, but robustness terms are meant to be the last line of
  // defense, not fail loudly).
  const n = tradeList.length;
  const returns = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = tradeList[i]?.pnlPct;
    returns[i] = Number.isFinite(v) ? v : 0;
  }

  const rng = mulberry32(seed);
  const samples = new Float64Array(nSamples);

  // Outer loop: N bootstrap samples.
  // Inner loop: draw n random indices WITH REPLACEMENT and sum their
  // pnlPct. A trade may appear 0, 1, 2, or more times in one sample;
  // that is the defining property of bootstrap-with-replacement, and
  // it is what lets us recover the sampling distribution of the total
  // net return without any extra backtests.
  for (let s = 0; s < nSamples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // Index floor(rng()*n) is uniform in [0, n-1]. rng() < 1 by
      // construction so the index cannot overflow.
      const idx = (rng() * n) | 0;
      sum += returns[idx];
    }
    samples[s] = sum;
  }

  // Typed-array sort is in-place and ascending numeric — what
  // percentile() expects. No need to copy.
  samples.sort();

  return {
    p10NetPct:  percentile(samples, 10),
    p50NetPct:  percentile(samples, 50),
    p90NetPct:  percentile(samples, 90),
    sampleSize: n,
    nSamples,
  };
}
