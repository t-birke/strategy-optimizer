/**
 * Technical indicator library — all functions take Float64Array input, return Float64Array output.
 * Matches TradingView PineScript v5 indicator implementations.
 */

/**
 * Simple Moving Average — ta.sma(src, period)
 * Handles NaN-prefixed input: starts accumulating from first valid value.
 */
export function sma(src, period) {
  const len = src.length;
  const out = new Float64Array(len);

  // Period 1 is the identity function — short-circuit to avoid
  // floating-point drift from the running-sum accumulator.
  if (period === 1) {
    out.set(src);
    return out;
  }

  // Find first non-NaN index
  let firstValid = 0;
  while (firstValid < len && isNaN(src[firstValid])) firstValid++;

  // Fill NaN before first valid window
  for (let i = 0; i < Math.min(firstValid + period - 1, len); i++) {
    out[i] = NaN;
  }

  let sum = 0;
  let count = 0;
  for (let i = firstValid; i < len; i++) {
    sum += src[i];
    count++;
    if (count > period) {
      sum -= src[i - period];
      count = period;
    }
    out[i] = count >= period ? sum / period : NaN;
  }
  return out;
}

/**
 * Exponential Moving Average — ta.ema(src, period)
 * Pine uses multiplier = 2 / (period + 1), seeds with SMA.
 * Handles NaN-prefixed input.
 */
export function ema(src, period) {
  const len = src.length;
  const out = new Float64Array(len);
  const k = 2 / (period + 1);

  // Find first non-NaN
  let firstValid = 0;
  while (firstValid < len && isNaN(src[firstValid])) firstValid++;

  // Fill NaN before seed
  for (let i = 0; i < Math.min(firstValid + period - 1, len); i++) {
    out[i] = NaN;
  }

  // Seed: SMA of first `period` valid values
  let sum = 0;
  let count = 0;
  let seeded = false;
  for (let i = firstValid; i < len; i++) {
    if (!seeded) {
      sum += src[i];
      count++;
      if (count === period) {
        out[i] = sum / period;
        seeded = true;
      } else {
        out[i] = NaN;
      }
    } else {
      out[i] = src[i] * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

/**
 * Relative Strength Index — ta.rsi(src, period)
 * Uses Wilder's smoothing (exponential with alpha = 1/period).
 */
export function rsi(src, period) {
  const len = src.length;
  const out = new Float64Array(len);

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < len; i++) {
    if (i === 0) {
      out[i] = NaN;
      continue;
    }

    const change = src[i] - src[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        out[i] = NaN;
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/**
 * Raw Stochastic — ta.stoch(close, high, low, period)
 * Returns (close - lowest low) / (highest high - lowest low) * 100
 */
export function stoch(close, high, low, period) {
  const len = close.length;
  const out = new Float64Array(len);

  for (let i = 0; i < len; i++) {
    if (i < period - 1) {
      out[i] = NaN;
      continue;
    }
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    const range = hh - ll;
    out[i] = range > 0 ? (close[i] - ll) / range * 100 : 50;
  }
  return out;
}

/**
 * Average True Range — ta.atr(period) using high, low, close
 * Uses Wilder's smoothing (RMA).
 */
export function atr(high, low, close, period) {
  const len = high.length;
  const tr = new Float64Array(len);
  const out = new Float64Array(len);

  // True Range
  for (let i = 0; i < len; i++) {
    if (i === 0) {
      tr[i] = high[i] - low[i];
    } else {
      const hl = high[i] - low[i];
      const hc = Math.abs(high[i] - close[i - 1]);
      const lc = Math.abs(low[i] - close[i - 1]);
      tr[i] = Math.max(hl, hc, lc);
    }
  }

  // RMA (Wilder's smoothing)
  let sum = 0;
  for (let i = 0; i < len; i++) {
    if (i < period - 1) {
      sum += tr[i];
      out[i] = NaN;
    } else if (i === period - 1) {
      sum += tr[i];
      out[i] = sum / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return out;
}

/**
 * Standard Deviation — ta.stdev(src, period)
 * Population stdev (Pine default, biased=true).
 * Handles NaN-prefixed input.
 */
export function stdev(src, period) {
  const len = src.length;
  const out = new Float64Array(len);
  const avg = sma(src, period);

  for (let i = 0; i < len; i++) {
    if (isNaN(avg[i])) {
      out[i] = NaN;
      continue;
    }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = src[j] - avg[i];
      sumSq += d * d;
    }
    out[i] = Math.sqrt(sumSq / period);
  }
  return out;
}

/**
 * Percent Rank — ta.percentrank(src, period)
 * Returns the percentage of past `period` values that are strictly less than the current value.
 * Pine v5 uses strict inequality (<), not (<=).
 */
export function percentrank(src, period) {
  const len = src.length;
  const out = new Float64Array(len);

  for (let i = 0; i < len; i++) {
    if (i < period) {
      out[i] = NaN;
      continue;
    }
    let count = 0;
    for (let j = i - period; j < i; j++) {
      if (src[j] < src[i]) count++;
    }
    out[i] = count / period * 100;
  }
  return out;
}

/**
 * Detect crossover — ta.crossover(a, b)
 * Returns boolean array: true when a crosses above b.
 * Skips NaN values.
 */
export function crossover(a, b) {
  const len = a.length;
  const out = new Uint8Array(len);
  for (let i = 1; i < len; i++) {
    if (isNaN(a[i]) || isNaN(b[i]) || isNaN(a[i - 1]) || isNaN(b[i - 1])) continue;
    out[i] = (a[i] > b[i] && a[i - 1] <= b[i - 1]) ? 1 : 0;
  }
  return out;
}

/**
 * Detect crossunder — ta.crossunder(a, b)
 * Returns boolean array: true when a crosses below b.
 * Skips NaN values.
 */
export function crossunder(a, b) {
  const len = a.length;
  const out = new Uint8Array(len);
  for (let i = 1; i < len; i++) {
    if (isNaN(a[i]) || isNaN(b[i]) || isNaN(a[i - 1]) || isNaN(b[i - 1])) continue;
    out[i] = (a[i] < b[i] && a[i - 1] >= b[i - 1]) ? 1 : 0;
  }
  return out;
}

/**
 * Rolling maximum — ta.highest(src, period).
 * Includes the current bar. Returns NaN for bars < period-1.
 *
 * O(n × period) naive scan; at period ≤ 200 on ~10–50k bars the hot-path
 * cost is negligible. If this ever profiles as a problem we can swap in a
 * monotonic-deque O(n) implementation.
 */
export function highest(src, period) {
  const len = src.length;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < period - 1) { out[i] = NaN; continue; }
    let hi = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (!isNaN(v) && v > hi) hi = v;
    }
    out[i] = hi === -Infinity ? NaN : hi;
  }
  return out;
}

/**
 * Rolling minimum — ta.lowest(src, period).
 * Mirror of `highest`. Returns NaN for bars < period-1.
 */
export function lowest(src, period) {
  const len = src.length;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < period - 1) { out[i] = NaN; continue; }
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (!isNaN(v) && v < lo) lo = v;
    }
    out[i] = lo === Infinity ? NaN : lo;
  }
  return out;
}

/**
 * Average Directional Index — ta.adx(dilen, adxlen) (with dilen == adxlen == period).
 *
 * Wilder's classic trend-strength oscillator, range 0–100. Above ~25 is
 * "trending", below ~20 is "ranging" (thresholds are conventional, not
 * hard-coded here — leave interpretation to the caller).
 *
 * Steps (Wilder 1978):
 *   1. +DM, -DM: directional movement from bar-to-bar high/low moves.
 *   2. TR: true range (same as `atr`).
 *   3. Wilder-smooth all three over `period` bars (RMA).
 *   4. +DI = 100 * smoothed+DM / smoothedTR
 *      -DI = 100 * smoothed-DM / smoothedTR
 *   5. DX = 100 * |+DI - -DI| / (+DI + -DI)   (→ NaN when sum is 0)
 *   6. ADX = Wilder-smooth DX over `period` bars.
 *
 * NaN for the first `2*period - 1` bars (one warmup for the DI smoothing,
 * another for ADX smoothing on top of that). Pine's `ta.adx` uses the
 * same convention.
 */
export function adx(high, low, close, period) {
  const len = high.length;
  const plusDm  = new Float64Array(len);
  const minusDm = new Float64Array(len);
  const tr      = new Float64Array(len);
  const out     = new Float64Array(len);
  out.fill(NaN);

  // Bar 0: all zeros (no prior bar to diff against).
  for (let i = 1; i < len; i++) {
    const upMove   = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDm[i]  = (upMove   > downMove && upMove   > 0) ? upMove   : 0;
    minusDm[i] = (downMove > upMove   && downMove > 0) ? downMove : 0;
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i]  - close[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }

  // Wilder's smoothing (RMA), seeded by the sum of the first `period` values.
  // Needs period bars of data first, so valid output starts at index `period`.
  if (len <= period) return out;

  let smTr = 0, smPlusDm = 0, smMinusDm = 0;
  for (let i = 1; i <= period; i++) {
    smTr      += tr[i];
    smPlusDm  += plusDm[i];
    smMinusDm += minusDm[i];
  }

  const dx = new Float64Array(len);
  dx.fill(NaN);

  for (let i = period; i < len; i++) {
    if (i > period) {
      smTr      = smTr      - smTr      / period + tr[i];
      smPlusDm  = smPlusDm  - smPlusDm  / period + plusDm[i];
      smMinusDm = smMinusDm - smMinusDm / period + minusDm[i];
    }
    const plusDi  = smTr > 0 ? 100 * smPlusDm  / smTr : 0;
    const minusDi = smTr > 0 ? 100 * smMinusDm / smTr : 0;
    const sumDi   = plusDi + minusDi;
    dx[i] = sumDi > 0 ? 100 * Math.abs(plusDi - minusDi) / sumDi : NaN;
  }

  // ADX = Wilder-smooth DX over `period` bars. First valid ADX is at
  // index `2*period - 1` (period bars of DX built up, then averaged).
  const firstAdxBar = 2 * period - 1;
  if (len <= firstAdxBar) return out;

  let sum = 0, count = 0;
  for (let i = period; i <= firstAdxBar; i++) {
    if (!isNaN(dx[i])) { sum += dx[i]; count++; }
  }
  if (count === 0) return out;
  out[firstAdxBar] = sum / count;

  for (let i = firstAdxBar + 1; i < len; i++) {
    if (isNaN(dx[i])) { out[i] = out[i - 1]; continue; }
    out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
  }
  return out;
}

/**
 * Rolling VWAP — volume-weighted average typical price over the last
 * `period` bars (inclusive of current). Typical price = (H+L+C)/3.
 *
 * This is the *rolling* flavor, not session-anchored VWAP. It's useful as
 * a fair-price reference at any timeframe. Session-anchored VWAP (the
 * intraday day-reset flavor) is Phase 7 work — it needs a session helper
 * that doesn't exist yet.
 *
 * Returns NaN for bars < period-1, or any bar whose window has zero
 * cumulative volume.
 *
 * O(n) via sliding sums.
 */
export function vwap(high, low, close, volume, period) {
  const len = close.length;
  const out = new Float64Array(len);
  out.fill(NaN);

  let num = 0, den = 0;
  for (let i = 0; i < len; i++) {
    const tp = (high[i] + low[i] + close[i]) / 3;
    num += tp * volume[i];
    den += volume[i];
    if (i >= period) {
      const o = i - period;
      const otp = (high[o] + low[o] + close[o]) / 3;
      num -= otp * volume[o];
      den -= volume[o];
    }
    if (i >= period - 1 && den > 0) out[i] = num / den;
  }
  return out;
}
