/**
 * Backtest orchestrator — loads candles and runs strategy.
 */

import { loadCandles } from '../db/candles.js';
import { runStrategy } from './strategy.js';

/**
 * Run a full backtest for a symbol/timeframe/date range.
 *
 * @param {string} symbol — e.g., 'BTCUSDT'
 * @param {number} timeframeMin — e.g., 240 for 4H
 * @param {string} startDate — e.g., '2021-04-11'
 * @param {Object} params — 17-gene parameter object
 * @param {Object} [opts] — { initialCapital, leverage }
 * @returns {Object} metrics from runStrategy
 */
export async function runBacktest(symbol, timeframeMin, startDate, params, opts = {}) {
  const startTs = new Date(startDate).getTime();
  const candles = await loadCandles(symbol, timeframeMin, startTs);

  if (candles.close.length < 100) {
    return { error: 'insufficient_data', trades: 0 };
  }

  return runStrategy(candles, params, opts);
}

/**
 * Run a backtest with pre-loaded candles (avoids DB round-trip per GA evaluation).
 * This is the fast path used by the optimizer.
 */
export function runBacktestWithCandles(candles, params, opts = {}) {
  return runStrategy(candles, params, opts);
}
