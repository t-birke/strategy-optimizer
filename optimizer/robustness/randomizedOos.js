/**
 * Randomized OOS — post-hoc robustness term (Build Alpha concept).
 *
 * See `docs/backlog.md` §6.1 for the framing. The short version:
 *
 * Walk-forward OOS is ONE specific slice — typically the final 20–30%
 * of the dataset. That number has two confounds baked in:
 *
 *   1. The slice might have landed on a friendly tape (low-vol chop
 *      inside a clean trend) or a nasty one (flash crashes, regime
 *      change, etc.). A high OOS reading on an easy period means less
 *      than a mediocre reading on a brutal one.
 *
 *   2. There's nothing to compare against. Saying "OOS netPct = 18%"
 *      is meaningless without a yardstick for "what would ANY 30% of
 *      the dataset have produced with this trade list?"
 *
 * This module builds that yardstick. Given the full-run trade list, we
 * resample N=1000 random 30%-of-bars slices and tally the strategy's
 * metric on each. That's a null distribution of "possible OOS readings"
 * conditional on the gene's trade pattern.
 *
 * We then locate the actual OOS metric in that distribution as a
 * percentile:
 *
 *   • P25–P75 — "central band," what you'd expect most of the time.
 *     An OOS value in here is believable and neither lucky nor harsh.
 *   • Top 5%   — suspiciously lucky: the OOS window was kind.
 *   • Bottom 5% — suspiciously harsh: the OOS window was punishing.
 *
 * The output is consumed as one term in the composite fitness
 * multiplier — genes whose OOS reading sits in the central band get
 * the full credit of their OOS number; genes whose OOS sits in the
 * top 5% (lucky) are discounted because the signal is probably an
 * artifact of the particular slice.
 *
 *
 * ─── What this module is NOT ────────────────────────────────
 *
 *   • NOT a new backtest. We do not rerun the strategy on resampled
 *     candles. We re-window the EXISTING trade list and re-compute a
 *     metric from it. That's an O(N_trades · N_samples) operation —
 *     cheap enough to run per-gene during GA evaluation.
 *
 *   • NOT a bar-level Monte Carlo on prices. The random thing here is
 *     WHICH 30% slice of calendar time we look at, not the prices
 *     themselves. Bar-level MC lives in a separate module.
 *
 *   • NOT dependent on the runtime. This module knows nothing about
 *     candles, indicators, or block machinery. Trade list + metric +
 *     data span → percentile.
 *
 *
 * ─── Determinism ────────────────────────────────────────────
 *
 * Fitness must be reproducible, so the sampler uses a seeded
 * mulberry32 PRNG. Same (tradeList, opts) → same result, bit-for-bit.
 * No Math.random, no Date.now, no dependence on V8 iteration order.
 */

/**
 * Mulberry32 — tiny, fast, seeded 32-bit PRNG.
 *
 * Matches the RNG used elsewhere in the project (see
 * `scripts/evaluate-gene-check.js`). Returns a function that yields
 * uniform doubles in [0, 1). Period is 2^32 — plenty for 1000 samples.
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
 * Supported fitness metrics. Each takes a filtered trade array
 * (already restricted to the slice) and returns a scalar.
 *
 * `netPct` — sum of pnlPct across the slice. Approximates total %
 *            return of the slice (ignoring compounding, which is fine
 *            for percentile comparisons on small slices).
 * `avgPct` — mean pnlPct. Scale-invariant to trade count, so a slice
 *            with 2 big wins looks the same as a slice with 200 equal
 *            wins. Useful when you want to normalize out trade density.
 *
 * Empty slices → 0 for both. "No trades, no information" is the
 * neutral answer: a strategy that doesn't trade in a given slice
 * isn't good or bad — it's silent. Zero keeps that slice from
 * biasing the null distribution either direction.
 */
const METRIC_FNS = {
  netPct: (trades) => {
    let s = 0;
    for (const t of trades) s += numberOr(t.pnlPct, 0);
    return s;
  },
  avgPct: (trades) => {
    if (trades.length === 0) return 0;
    let s = 0;
    for (const t of trades) s += numberOr(t.pnlPct, 0);
    return s / trades.length;
  },
};

/**
 * Randomized-OOS percentile of an observed OOS metric.
 *
 * @param {Array}  tradeList              full-run trade list; each trade
 *                                        must have a numeric `entryTs` in
 *                                        ms since epoch and a numeric
 *                                        `pnlPct` (fraction, e.g. 0.01).
 * @param {number} actualOosFitnessValue  the real OOS metric to locate
 *                                        in the null distribution.
 * @param {Object} opts
 * @param {string} [opts.fitnessMetric='netPct']  'netPct' | 'avgPct'
 * @param {number} [opts.sliceFraction=0.3]  fraction of the dataset span
 *                                        each simulated slice covers.
 * @param {number}  opts.startTs          dataset start in ms (required).
 * @param {number}  opts.endTs            dataset end in ms (required).
 * @param {number} [opts.nSamples=1000]
 * @param {number} [opts.seed=42]
 *
 * @returns {{
 *   percentile:    number,   // [0, 100] — where actual sits in null
 *   p25:           number,   // 25th percentile of null distribution
 *   p50:           number,
 *   p75:           number,
 *   inCentralBand: boolean,  // p25 <= actual <= p75
 *   nSamples:     number,
 *   metric:        string,
 * }}
 */
export function randomizedOos(tradeList, actualOosFitnessValue, {
  fitnessMetric = 'netPct',
  sliceFraction = 0.3,
  startTs,
  endTs,
  nSamples = 1000,
  seed = 42,
} = {}) {
  // Fail fast on missing span. These aren't optional — without the
  // data-span we have nothing to sample slice starts within.
  if (typeof startTs !== 'number' || !Number.isFinite(startTs)) {
    throw new Error('randomizedOos: startTs (ms) is required');
  }
  if (typeof endTs !== 'number' || !Number.isFinite(endTs)) {
    throw new Error('randomizedOos: endTs (ms) is required');
  }
  if (endTs <= startTs) {
    throw new Error(`randomizedOos: endTs (${endTs}) must be > startTs (${startTs})`);
  }
  if (sliceFraction <= 0 || sliceFraction >= 1) {
    throw new Error(`randomizedOos: sliceFraction must be in (0, 1), got ${sliceFraction}`);
  }
  if (!Number.isInteger(nSamples) || nSamples < 1) {
    throw new Error(`randomizedOos: nSamples must be a positive integer, got ${nSamples}`);
  }
  const metricFn = METRIC_FNS[fitnessMetric];
  if (!metricFn) {
    throw new Error(
      `randomizedOos: unsupported fitnessMetric '${fitnessMetric}' ` +
      `(expected one of ${Object.keys(METRIC_FNS).join(', ')})`,
    );
  }

  // ─── Empty-input short-circuit ─────────────────────────────
  // No trades → no information. Return a neutral 50th-percentile
  // result with all three quartiles at 0, so downstream consumers
  // can treat this gene as "inconclusive" rather than "failed."
  if (!Array.isArray(tradeList) || tradeList.length === 0) {
    return {
      percentile:    50,
      p25:           0,
      p50:           0,
      p75:           0,
      inCentralBand: true,
      nSamples,
      metric:        fitnessMetric,
    };
  }

  // ─── Slice geometry ────────────────────────────────────────
  // The simulated OOS slice has a fixed span (sliceFraction of total).
  // We draw its start uniformly from [startTs, endTs - sliceSpan] so
  // the whole slice fits inside the dataset. Any trade whose entryTs
  // falls in [sliceStart, sliceStart + sliceSpan) is counted toward
  // the slice's metric.
  const totalSpan = endTs - startTs;
  const sliceSpan = totalSpan * sliceFraction;
  const maxStart  = endTs - sliceSpan;  // inclusive upper bound for start
  const startRange = maxStart - startTs; // width of the start-sample range

  // Pre-extract entry timestamps for cache-friendly inner loop.
  // A typed array keeps this tight even for 10k+ trade runs.
  const entryTs = new Float64Array(tradeList.length);
  for (let i = 0; i < tradeList.length; i++) {
    entryTs[i] = numberOr(tradeList[i]?.entryTs, NaN);
  }

  // ─── Resample N times ──────────────────────────────────────
  const rng = mulberry32(seed);
  const nullDist = new Float64Array(nSamples);
  for (let s = 0; s < nSamples; s++) {
    // startRange is 0 when sliceFraction = 1 exactly; we've already
    // rejected that in validation. Otherwise rng()*startRange is
    // always < startRange, giving us a half-open [startTs, maxStart).
    const sliceStart = startTs + rng() * startRange;
    const sliceEnd   = sliceStart + sliceSpan;

    // Collect trades whose entryTs ∈ [sliceStart, sliceEnd). Note the
    // half-open interval: matches the "end" convention everywhere
    // else in the optimizer (bar indices, walk-forward windows).
    const slice = [];
    for (let i = 0; i < tradeList.length; i++) {
      const ts = entryTs[i];
      if (ts >= sliceStart && ts < sliceEnd) slice.push(tradeList[i]);
    }
    nullDist[s] = metricFn(slice);
  }

  // ─── Quantiles + percentile of actual ──────────────────────
  // In-place sort on the Float64Array. We're allowed to mutate since
  // nullDist is local.
  nullDist.sort();
  const p25 = quantile(nullDist, 0.25);
  const p50 = quantile(nullDist, 0.50);
  const p75 = quantile(nullDist, 0.75);
  const percentile = percentileOf(nullDist, actualOosFitnessValue);
  const inCentralBand = actualOosFitnessValue >= p25 && actualOosFitnessValue <= p75;

  return {
    percentile,
    p25,
    p50,
    p75,
    inCentralBand,
    nSamples,
    metric: fitnessMetric,
  };
}

// ─── Internals (not exported) ──────────────────────────────

/**
 * Linear-interpolated quantile of a sorted array. Q(q) for q ∈ [0, 1].
 * Matches the "Type 7" quantile (NumPy default, R default).
 *
 * The sort is a precondition — callers pass `nullDist` after .sort().
 */
function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos  = (n - 1) * q;
  const lo   = Math.floor(pos);
  const hi   = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Convert a raw value into its percentile within a sorted distribution.
 * Returns a number in [0, 100]. Uses the "mean rank" convention so ties
 * split cleanly: values below all samples → 0, above all → 100, equal
 * to the median → ~50.
 *
 * We count {count_below + 0.5 * count_equal} / n. That matches SciPy's
 * `percentileofscore(kind='mean')` and is the standard way to report
 * "where does this value sit" for Monte-Carlo-style null distributions.
 */
function percentileOf(sorted, value) {
  const n = sorted.length;
  if (n === 0) return 50;
  let below = 0;
  let equal = 0;
  for (let i = 0; i < n; i++) {
    if (sorted[i] < value) below++;
    else if (sorted[i] === value) equal++;
    else break; // sorted ascending — no more matches
  }
  return ((below + 0.5 * equal) / n) * 100;
}

function numberOr(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
}
