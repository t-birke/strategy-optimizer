/**
 * Binance klines ingestion — fetch 1m candles and store in DuckDB.
 *
 * Usage:
 *   node data/ingest.js BTCUSDT              # Full backfill (5 years)
 *   node data/ingest.js BTCUSDT --update     # Incremental (from last stored)
 *   node data/ingest.js --update-all          # Update all stored symbols
 */

import { insertCandles, getLastTimestamp, getSymbolStats } from '../db/candles.js';

const BINANCE_BASE = 'https://api.binance.com';
const KLINE_LIMIT = 1000;
const RATE_LIMIT_DELAY = 100; // ms between requests (conservative)

/**
 * Check if a symbol exists on Binance and return its earliest available date.
 */
export async function checkSymbol(symbol) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&limit=1`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 400) return { exists: false };
    throw new Error(`Binance API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.length === 0) return { exists: false };

  // Get earliest available candle
  const earliest = await fetch(
    `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=0&limit=1`
  );
  const earlyData = await earliest.json();

  return {
    exists: true,
    earliestTs: earlyData[0]?.[0],
    latestTs: data[0]?.[0],
  };
}

/**
 * Fetch klines from Binance for a symbol.
 * Yields batches of candle rows: [symbol, ts, open, high, low, close, volume]
 *
 * onProgress({ fetched, estimatedTotal }) is called after each batch.
 */
export async function* fetchKlines(symbol, startTs, endTs = Date.now(), onProgress) {
  let currentStart = startTs;
  let fetched = 0;
  const estimatedTotal = Math.ceil((endTs - startTs) / 60000);

  while (currentStart < endTs) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${currentStart}&endTime=${endTs}&limit=${KLINE_LIMIT}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        // Rate limited — wait and retry
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      throw new Error(`Binance API error: ${res.status}`);
    }

    const data = await res.json();
    if (data.length === 0) break;

    const rows = data.map(k => [
      symbol,
      k[0],           // open time (ms)
      parseFloat(k[1]), // open
      parseFloat(k[2]), // high
      parseFloat(k[3]), // low
      parseFloat(k[4]), // close
      parseFloat(k[5]), // volume
    ]);

    yield rows;
    fetched += rows.length;

    if (onProgress) {
      onProgress({ fetched, estimatedTotal });
    }

    // Move start past the last candle
    currentStart = data[data.length - 1][0] + 60000;

    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
  }
}

/**
 * Ingest all 1m candles for a symbol from startTs to now.
 * Returns total candles inserted.
 */
export async function ingestSymbol(symbol, startTs, onProgress) {
  let total = 0;
  for await (const batch of fetchKlines(symbol, startTs, Date.now(), onProgress)) {
    await insertCandles(batch);
    total += batch.length;
  }
  return total;
}

/**
 * Update a symbol from its last stored candle to now.
 */
export async function updateSymbol(symbol, onProgress) {
  const lastTs = await getLastTimestamp(symbol);
  if (lastTs === null) {
    throw new Error(`No data for ${symbol}. Use full ingest first.`);
  }
  // Start from 1 minute after last stored candle
  return ingestSymbol(symbol, lastTs + 60000, onProgress);
}

// CLI entry point
if (process.argv[1]?.endsWith('ingest.js')) {
  const args = process.argv.slice(2);

  if (args.includes('--update-all')) {
    const stats = await getSymbolStats();
    for (const s of stats) {
      console.log(`Updating ${s.symbol}...`);
      const count = await updateSymbol(s.symbol, ({ fetched, estimatedTotal }) => {
        process.stdout.write(`\r  ${s.symbol}: ${fetched.toLocaleString()} / ~${estimatedTotal.toLocaleString()} candles`);
      });
      console.log(`\n  Added ${count.toLocaleString()} candles`);
    }
    process.exit(0);
  }

  const symbol = args.find(a => !a.startsWith('--'));
  if (!symbol) {
    console.error('Usage: node data/ingest.js SYMBOL [--update]');
    process.exit(1);
  }

  const isUpdate = args.includes('--update');

  if (isUpdate) {
    console.log(`Updating ${symbol}...`);
    const count = await updateSymbol(symbol, ({ fetched }) => {
      process.stdout.write(`\r  ${fetched.toLocaleString()} candles fetched`);
    });
    console.log(`\n  Done. Added ${count.toLocaleString()} candles.`);
  } else {
    console.log(`Checking ${symbol} on Binance...`);
    const info = await checkSymbol(symbol);
    if (!info.exists) {
      console.error(`  ${symbol} not found on Binance`);
      process.exit(1);
    }
    console.log(`  Available since ${new Date(info.earliestTs).toISOString().split('T')[0]}`);

    // Default: ingest last 5 years
    const fiveYearsAgo = Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000;
    const startTs = Math.max(info.earliestTs, fiveYearsAgo);
    console.log(`  Ingesting from ${new Date(startTs).toISOString().split('T')[0]}...`);

    const count = await ingestSymbol(symbol, startTs, ({ fetched, estimatedTotal }) => {
      const pct = Math.round(fetched / estimatedTotal * 100);
      process.stdout.write(`\r  ${fetched.toLocaleString()} / ~${estimatedTotal.toLocaleString()} candles (${pct}%)`);
    });
    console.log(`\n  Done. Stored ${count.toLocaleString()} candles.`);
  }

  process.exit(0);
}
