/**
 * Binance klines ingestion — fetch 1m candles and store in DuckDB.
 *
 * Fetches newest data first (backwards) so recent candles are available
 * immediately, then backfills historical data.
 *
 * Usage:
 *   node data/ingest.js BTCUSDT              # Full ingest (all available, recent first)
 *   node data/ingest.js BTCUSDT --update     # Fill gaps (recent + historical)
 *   node data/ingest.js --update-all          # Update all stored symbols
 */

import { insertCandles, getLastTimestamp, getFirstTimestamp, getSymbolStats } from '../db/candles.js';

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
 * Fetch klines forwards from startTs to endTs.
 * Yields batches of candle rows: [symbol, ts, open, high, low, close, volume]
 */
async function* fetchKlinesForward(symbol, startTs, endTs, onProgress, progressOffset = 0) {
  let currentStart = startTs;
  let fetched = progressOffset;
  const estimatedTotal = progressOffset + Math.ceil((endTs - startTs) / 60000);

  while (currentStart < endTs) {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${currentStart}&endTime=${endTs}&limit=${KLINE_LIMIT}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      throw new Error(`Binance API error: ${res.status}`);
    }

    const data = await res.json();
    if (data.length === 0) break;

    const rows = data.map(k => [
      symbol,
      k[0],             // open time (ms)
      parseFloat(k[1]), // open
      parseFloat(k[2]), // high
      parseFloat(k[3]), // low
      parseFloat(k[4]), // close
      parseFloat(k[5]), // volume
    ]);

    yield rows;
    fetched += rows.length;

    if (onProgress) {
      onProgress({ fetched, estimatedTotal, phase: 'recent' });
    }

    currentStart = data[data.length - 1][0] + 60000;
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
  }

  return fetched;
}

/**
 * Fetch klines backwards from endTs toward startTs.
 * Yields batches of candle rows (each batch is in chronological order).
 */
async function* fetchKlinesBackward(symbol, startTs, endTs, onProgress, progressOffset = 0) {
  let currentEnd = endTs;
  let fetched = progressOffset;
  const estimatedTotal = progressOffset + Math.ceil((endTs - startTs) / 60000);

  while (currentEnd > startTs) {
    // Compute a window end: fetch the last KLINE_LIMIT candles before currentEnd
    // Binance returns candles from startTime ascending, so we set startTime to
    // (currentEnd - KLINE_LIMIT minutes) and endTime to currentEnd
    const windowStart = Math.max(startTs, currentEnd - KLINE_LIMIT * 60000);
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${windowStart}&endTime=${currentEnd}&limit=${KLINE_LIMIT}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      throw new Error(`Binance API error: ${res.status}`);
    }

    const data = await res.json();
    if (data.length === 0) break;

    const rows = data.map(k => [
      symbol,
      k[0],
      parseFloat(k[1]),
      parseFloat(k[2]),
      parseFloat(k[3]),
      parseFloat(k[4]),
      parseFloat(k[5]),
    ]);

    yield rows;
    fetched += rows.length;

    if (onProgress) {
      onProgress({ fetched, estimatedTotal, phase: 'backfill' });
    }

    // Move end before the earliest candle in this batch
    currentEnd = data[0][0] - 60000;
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
  }

  return fetched;
}

/**
 * Ingest all 1m candles for a symbol — recent data first, then backfill.
 * Returns total candles inserted.
 */
export async function ingestSymbol(symbol, earliestTs, onProgress) {
  const now = Date.now();
  const totalEstimate = Math.ceil((now - earliestTs) / 60000);
  let total = 0;

  // Phase 1: Fetch backwards from now to earliestTs
  for await (const batch of fetchKlinesBackward(symbol, earliestTs, now, (p) => {
    if (onProgress) onProgress({ ...p, estimatedTotal: totalEstimate, phase: 'recent' });
  })) {
    await insertCandles(batch);
    total += batch.length;
  }

  return total;
}

/**
 * Update a symbol — fill all missing gaps.
 * 1. Recent gap: last stored candle → now (fetched forward, fast)
 * 2. Historical gap: earliest available on Binance → first stored candle (fetched backward)
 */
export async function updateSymbol(symbol, onProgress) {
  const [lastTs, firstTs] = await Promise.all([
    getLastTimestamp(symbol),
    getFirstTimestamp(symbol),
  ]);

  if (lastTs === null) {
    throw new Error(`No data for ${symbol}. Use full ingest first.`);
  }

  const info = await checkSymbol(symbol);
  if (!info.exists) {
    throw new Error(`${symbol} not found on Binance`);
  }

  const now = Date.now();
  const recentGap = Math.ceil((now - Number(lastTs)) / 60000);
  const historicalGap = Number(firstTs) > info.earliestTs
    ? Math.ceil((Number(firstTs) - info.earliestTs) / 60000)
    : 0;
  const totalEstimate = recentGap + historicalGap;
  let total = 0;

  function report(phase) {
    if (onProgress) onProgress({ fetched: total, estimatedTotal: totalEstimate, phase });
  }

  // Phase 1: Fill recent gap (forward from last stored → now)
  if (recentGap > 1) {
    for await (const batch of fetchKlinesForward(symbol, Number(lastTs) + 60000, now)) {
      await insertCandles(batch);
      total += batch.length;
      report('recent');
    }
  }

  // Phase 2: Backfill historical gap (backward from first stored → earliest available)
  if (historicalGap > 0) {
    for await (const batch of fetchKlinesBackward(symbol, info.earliestTs, Number(firstTs) - 60000)) {
      await insertCandles(batch);
      total += batch.length;
      report('backfill');
    }
  }

  return total;
}

// CLI entry point
if (process.argv[1]?.endsWith('ingest.js')) {
  const args = process.argv.slice(2);

  if (args.includes('--update-all')) {
    const stats = await getSymbolStats();
    for (const s of stats) {
      console.log(`Updating ${s.symbol}...`);
      const count = await updateSymbol(s.symbol, ({ fetched, estimatedTotal, phase }) => {
        process.stdout.write(`\r  ${s.symbol} [${phase}]: ${fetched.toLocaleString()} / ~${estimatedTotal.toLocaleString()} candles`);
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
    console.log(`Updating ${symbol} (recent + historical gaps)...`);
    const count = await updateSymbol(symbol, ({ fetched, estimatedTotal, phase }) => {
      const pct = estimatedTotal > 0 ? Math.round(fetched / estimatedTotal * 100) : 0;
      process.stdout.write(`\r  [${phase}] ${fetched.toLocaleString()} / ~${estimatedTotal.toLocaleString()} candles (${pct}%)`);
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
    console.log(`  Ingesting newest data first...`);

    const count = await ingestSymbol(symbol, info.earliestTs, ({ fetched, estimatedTotal, phase }) => {
      const pct = estimatedTotal > 0 ? Math.round(fetched / estimatedTotal * 100) : 0;
      process.stdout.write(`\r  [${phase}] ${fetched.toLocaleString()} / ~${estimatedTotal.toLocaleString()} candles (${pct}%)`);
    });
    console.log(`\n  Done. Stored ${count.toLocaleString()} candles.`);
  }

  process.exit(0);
}
