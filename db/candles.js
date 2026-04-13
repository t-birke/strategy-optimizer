import { query, exec, getAppender } from './connection.js';

/**
 * Insert candles in bulk using DuckDB appender (fastest path).
 * Rows: array of [symbol, ts, open, high, low, close, volume]
 */
export async function insertCandles(rows) {
  if (rows.length === 0) return;

  // Use INSERT OR IGNORE via temp table + merge to handle duplicates
  // Appender doesn't support ON CONFLICT, so we insert to temp, then merge
  await exec('CREATE TEMPORARY TABLE IF NOT EXISTS _candle_staging (symbol VARCHAR, ts BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE)');
  await exec('DELETE FROM _candle_staging');

  const appender = await getAppender('_candle_staging');
  for (const [symbol, ts, open, high, low, close, volume] of rows) {
    appender.appendVarchar(symbol);
    appender.appendBigInt(BigInt(ts));
    appender.appendDouble(open);
    appender.appendDouble(high);
    appender.appendDouble(low);
    appender.appendDouble(close);
    appender.appendDouble(volume);
    appender.endRow();
  }
  appender.flushSync();
  appender.closeSync();

  await exec(`
    INSERT OR IGNORE INTO candles
    SELECT * FROM _candle_staging
  `);
}

/**
 * Get all stored symbols with their date ranges and candle counts.
 */
export async function getSymbolStats() {
  return query(`
    SELECT
      symbol,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts,
      COUNT(*) AS candle_count
    FROM candles
    GROUP BY symbol
    ORDER BY symbol
  `);
}

/**
 * Get the last stored timestamp for a symbol.
 */
export async function getLastTimestamp(symbol) {
  const rows = await query(
    `SELECT MAX(ts) AS last_ts FROM candles WHERE symbol = '${symbol}'`
  );
  return rows[0]?.last_ts ?? null;
}

/**
 * Get the first stored timestamp for a symbol.
 */
export async function getFirstTimestamp(symbol) {
  const rows = await query(
    `SELECT MIN(ts) AS first_ts FROM candles WHERE symbol = '${symbol}'`
  );
  return rows[0]?.first_ts ?? null;
}

/**
 * Load candles aggregated to a given timeframe as columnar Float64Arrays.
 * timeframeMin: timeframe in minutes (e.g., 240 for 4H)
 * startTs: start timestamp in milliseconds
 */
export async function loadCandles(symbol, timeframeMin, startTs = 0) {
  const tfMs = timeframeMin * 60000;

  const rows = await query(`
    SELECT
      (ts // ${tfMs}) * ${tfMs} AS bar_ts,
      FIRST(open ORDER BY ts) AS open,
      MAX(high) AS high,
      MIN(low) AS low,
      LAST(close ORDER BY ts) AS close,
      SUM(volume) AS volume
    FROM candles
    WHERE symbol = '${symbol}' AND ts >= ${startTs}
    GROUP BY (ts // ${tfMs}) * ${tfMs}
    ORDER BY bar_ts
  `);

  const len = rows.length;
  const candles = {
    ts: new Float64Array(len),
    open: new Float64Array(len),
    high: new Float64Array(len),
    low: new Float64Array(len),
    close: new Float64Array(len),
    volume: new Float64Array(len),
  };

  for (let i = 0; i < len; i++) {
    candles.ts[i] = rows[i].bar_ts;
    candles.open[i] = rows[i].open;
    candles.high[i] = rows[i].high;
    candles.low[i] = rows[i].low;
    candles.close[i] = rows[i].close;
    candles.volume[i] = rows[i].volume;
  }

  return candles;
}

/**
 * Delete all candle data for a symbol.
 */
export async function deleteSymbol(symbol) {
  await exec(`DELETE FROM candles WHERE symbol = '${symbol}'`);
}

/**
 * Get total candle count for a symbol.
 */
export async function getCandleCount(symbol) {
  const rows = await query(
    `SELECT COUNT(*) AS cnt FROM candles WHERE symbol = '${symbol}'`
  );
  return rows[0]?.cnt ?? 0;
}
