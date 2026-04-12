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
 * Returns the percentage of past `period` values that are less than or equal to the current value.
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
      if (src[j] <= src[i]) count++;
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
