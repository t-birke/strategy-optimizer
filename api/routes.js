/**
 * Express REST API routes.
 */

import { Router } from 'express';
import { getSymbolStats, getLastTimestamp, deleteSymbol } from '../db/candles.js';
import { query, exec } from '../db/connection.js';
import { checkSymbol, ingestSymbol, updateSymbol } from '../data/ingest.js';
import { runOptimization } from '../optimizer/runner.js';
import { geneShort } from '../optimizer/params.js';
import { broadcast } from './websocket.js';
import { sendToTradingView, checkTradingViewConnection } from './tradingview.js';
import { loadCandles } from '../db/candles.js';
import { runStrategy } from '../engine/strategy.js';

const router = Router();

// ─── Active state ────────────────────────────────────────────
let activeRun = null;        // currently running optimization
let cancelRequested = false;
const runQueue = [];          // pending optimization configs

// ─── Data management ─────────────────────────────────────────

router.get('/api/symbols', async (req, res) => {
  try {
    const stats = await getSymbolStats();
    const now = Date.now();
    const enriched = stats.map(s => ({
      ...s,
      firstDate: new Date(s.first_ts).toISOString().split('T')[0],
      lastDate: new Date(s.last_ts).toISOString().split('T')[0],
      gapDays: Math.floor((now - s.last_ts) / 86400000),
    }));
    res.json({ symbols: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/symbols/:symbol/check', async (req, res) => {
  try {
    const info = await checkSymbol(req.params.symbol.toUpperCase());
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/symbols/:symbol/ingest', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const info = await checkSymbol(symbol);
    if (!info.exists) return res.status(404).json({ error: `${symbol} not found on Binance` });

    res.json({ status: 'started', symbol });

    // Run ingestion in background — newest data first, then backfill
    ingestSymbol(symbol, info.earliestTs, ({ fetched, estimatedTotal, phase }) => {
      broadcast({
        type: 'ingest_progress',
        symbol,
        fetched,
        total: estimatedTotal,
        pct: estimatedTotal > 0 ? Math.round(fetched / estimatedTotal * 100) : 0,
        phase,
      });
    }).then(count => {
      broadcast({ type: 'ingest_complete', symbol, candles: count });
    }).catch(err => {
      broadcast({ type: 'ingest_error', symbol, error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/symbols/:symbol/update', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    res.json({ status: 'started', symbol });

    updateSymbol(symbol, ({ fetched, estimatedTotal, phase }) => {
      broadcast({
        type: 'ingest_progress',
        symbol,
        fetched,
        total: estimatedTotal,
        pct: estimatedTotal > 0 ? Math.round(fetched / estimatedTotal * 100) : 0,
        phase,
      });
    }).then(count => {
      broadcast({ type: 'ingest_complete', symbol, candles: count });
    }).catch(err => {
      broadcast({ type: 'ingest_error', symbol, error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/symbols/update-all', async (req, res) => {
  try {
    const stats = await getSymbolStats();
    res.json({ status: 'started', symbols: stats.map(s => s.symbol) });

    for (const s of stats) {
      try {
        broadcast({ type: 'ingest_progress', symbol: s.symbol, fetched: 0, total: 0, pct: 0, phase: 'recent' });
        const count = await updateSymbol(s.symbol, ({ fetched, estimatedTotal, phase }) => {
          broadcast({
            type: 'ingest_progress',
            symbol: s.symbol,
            fetched,
            total: estimatedTotal,
            pct: estimatedTotal > 0 ? Math.round(fetched / estimatedTotal * 100) : 0,
            phase,
          });
        });
        broadcast({ type: 'ingest_complete', symbol: s.symbol, candles: count });
      } catch (err) {
        broadcast({ type: 'ingest_error', symbol: s.symbol, error: err.message });
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/symbols/:symbol', async (req, res) => {
  try {
    await deleteSymbol(req.params.symbol.toUpperCase());
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Optimization runs ──────────────────────────────────────

router.get('/api/runs', async (req, res) => {
  try {
    const runs = await query(
      'SELECT id, symbol, timeframe, start_date, config, status, best_metrics, best_gene, generations_completed, total_evaluations, error, started_at, completed_at, created_at FROM runs ORDER BY id DESC'
    );
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/runs/:id', async (req, res) => {
  try {
    const runs = await query(`SELECT * FROM runs WHERE id = ${req.params.id}`);
    if (runs.length === 0) return res.status(404).json({ error: 'Run not found' });

    const run = runs[0];
    // Parse JSON fields
    for (const field of ['config', 'best_gene', 'best_metrics', 'top_results', 'generation_log']) {
      if (run[field] && typeof run[field] === 'string') {
        try { run[field] = JSON.parse(run[field]); } catch {}
      }
    }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/runs', async (req, res) => {
  try {
    const {
      symbols, intervals, period, startDate: rawStart, endDate: rawEnd,
      populationSize = 80, generations = 80, mutationRate = 0.4,
      numIslands = 4, numPlanets = 1, migrationInterval = 0, migrationCount = 3, migrationTopology = 'ring',
      spaceTravelInterval = 2, spaceTravelCount = 1,
      windowSizeDays = 0, consistencyWeight = 0.5,
    } = req.body;

    if (!symbols?.length || !intervals?.length) {
      return res.status(400).json({ error: 'symbols and intervals required' });
    }

    const INTERVAL_MAP = {
      '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
      '1H': 60, '2H': 120, '3H': 180, '4H': 240, '6H': 360, '8H': 480,
    };

    let startDate, endDate;
    if (rawStart) {
      startDate = rawStart;
      endDate = rawEnd || null;
    } else {
      const PERIOD_MAP = { '3M': 0.25, '6M': 0.5, '1y': 1, '2y': 2, '3y': 3, '4y': 4, '5y': 5 };
      const yearsBack = PERIOD_MAP[period] || 5;
      startDate = new Date(Date.now() - yearsBack * 365.25 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];
      endDate = null;
    }

    const runConfigs = [];
    for (const symbol of symbols) {
      for (const ivLabel of intervals) {
        const tf = INTERVAL_MAP[ivLabel];
        if (!tf) continue;
        runConfigs.push({
          symbol, timeframe: tf, startDate, endDate,
          label: ivLabel,
          populationSize, generations, mutationRate,
          numIslands, numPlanets, migrationInterval, migrationCount, migrationTopology,
          spaceTravelInterval, spaceTravelCount,
          windowSizeDays, consistencyWeight,
        });
      }
    }

    const runIds = [];
    for (const rc of runConfigs) {
      const configJson = JSON.stringify({ populationSize: rc.populationSize, generations: rc.generations, mutationRate: rc.mutationRate, numIslands: rc.numIslands, numPlanets: rc.numPlanets, migrationInterval: rc.migrationInterval, migrationCount: rc.migrationCount, migrationTopology: rc.migrationTopology, spaceTravelInterval: rc.spaceTravelInterval, spaceTravelCount: rc.spaceTravelCount, windowSizeDays: rc.windowSizeDays, consistencyWeight: rc.consistencyWeight, endDate: rc.endDate });
      await exec(`INSERT INTO runs (symbol, timeframe, start_date, status, config) VALUES ('${rc.symbol}', ${rc.timeframe}, '${rc.startDate}', 'pending', '${configJson}')`);
      const rows = await query('SELECT MAX(id) AS id FROM runs');
      const runId = rows[0].id;
      runIds.push(runId);
      runQueue.push({ ...rc, runId });
    }

    // Start processing queue if not already running
    processQueue();

    res.json({ status: 'queued', runIds, totalRuns: runConfigs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/runs/:id/trades', async (req, res) => {
  try {
    const runs = await query(`SELECT * FROM runs WHERE id = ${req.params.id}`);
    if (runs.length === 0) return res.status(404).json({ error: 'Run not found' });
    const run = runs[0];

    for (const field of ['config', 'best_gene', 'best_metrics']) {
      if (run[field] && typeof run[field] === 'string') {
        try { run[field] = JSON.parse(run[field]); } catch {}
      }
    }

    if (!run.best_gene) return res.status(400).json({ error: 'Run has no best gene yet' });

    const config = run.config || {};
    const startTs = new Date(run.start_date).getTime();
    const endTs = config.endDate ? new Date(config.endDate).getTime() : Infinity;
    const WARMUP_BARS = 200;
    const preloadTs = startTs - WARMUP_BARS * run.timeframe * 60000;
    let candles = await loadCandles(run.symbol, run.timeframe, preloadTs);

    if (endTs < Infinity) {
      let lastIdx = candles.close.length;
      for (let i = 0; i < candles.close.length; i++) {
        if (candles.ts[i] > endTs) { lastIdx = i; break; }
      }
      if (lastIdx < candles.close.length) {
        candles = {
          ts: candles.ts.slice(0, lastIdx),
          open: candles.open.slice(0, lastIdx),
          high: candles.high.slice(0, lastIdx),
          low: candles.low.slice(0, lastIdx),
          close: candles.close.slice(0, lastIdx),
          volume: candles.volume.slice(0, lastIdx),
        };
      }
    }

    let tradingStartBar = 0;
    for (let i = 0; i < candles.close.length; i++) {
      if (candles.ts[i] >= startTs) { tradingStartBar = i; break; }
    }

    const metrics = runStrategy(candles, run.best_gene, {
      tradingStartBar, collectTrades: true, collectEquity: true,
    });

    // Build candle OHLC array for price chart (only trading period, downsampled if huge)
    const ohlc = [];
    for (let i = tradingStartBar; i < candles.close.length; i++) {
      ohlc.push({
        time: Math.floor(Number(candles.ts[i]) / 1000),
        open: candles.open[i],
        high: candles.high[i],
        low: candles.low[i],
        close: candles.close[i],
      });
    }

    // Convert equity timestamps to seconds for lightweight-charts
    const equity = (metrics.equityHistory ?? []).map(e => ({
      time: Math.floor(e.ts / 1000),
      value: e.equity,
    }));

    res.json({
      metrics,
      tradeList: metrics.tradeList ?? [],
      ohlc,
      equity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint: get raw candle data for a symbol/timeframe/date range
router.get('/api/candles/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const tf = parseInt(req.query.tf || '240');
    const from = req.query.from ? new Date(req.query.from).getTime() : 0;
    const to = req.query.to ? new Date(req.query.to).getTime() : Infinity;
    const candles = await loadCandles(symbol, tf, from);
    const rows = [];
    for (let i = 0; i < candles.close.length; i++) {
      if (candles.ts[i] > to) break;
      rows.push({
        ts: candles.ts[i],
        date: new Date(candles.ts[i]).toISOString(),
        open: candles.open[i], high: candles.high[i],
        low: candles.low[i], close: candles.close[i],
      });
    }
    res.json({ count: rows.length, candles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/runs/:id/cancel', async (req, res) => {
  const id = parseInt(req.params.id);

  // Check if it's the active run
  if (activeRun?.runId === id) {
    cancelRequested = true;
    res.json({ status: 'cancelling' });
    return;
  }

  // Remove from queue
  const idx = runQueue.findIndex(r => r.runId === id);
  if (idx >= 0) {
    runQueue.splice(idx, 1);
    await exec(`UPDATE runs SET status = 'cancelled' WHERE id = ${id}`);
    broadcast({ type: 'run_cancelled', runId: id });
    res.json({ status: 'cancelled' });
    return;
  }

  res.status(404).json({ error: 'Run not in queue or active' });
});

router.get('/api/queue', (req, res) => {
  res.json({
    active: activeRun ? { runId: activeRun.runId, symbol: activeRun.symbol, timeframe: activeRun.timeframe } : null,
    pending: runQueue.map(r => ({ runId: r.runId, symbol: r.symbol, timeframe: r.timeframe, label: r.label })),
  });
});

// ─── TradingView bridge ────────────────────────────────────

router.get('/api/tv/status', async (req, res) => {
  try {
    const status = await checkTradingViewConnection();
    res.json(status);
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.post('/api/tv/send', async (req, res) => {
  try {
    const { gene, symbol, timeframe, startDate, endDate } = req.body;
    if (!gene) return res.status(400).json({ error: 'gene config required' });

    // Re-run JS strategy with current code to get fresh metrics
    let jsMetrics = null;
    try {
      const startTs = startDate
        ? new Date(startDate).getTime()
        : Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000;
      const endTs = endDate ? new Date(endDate).getTime() : Infinity;
      const WARMUP_BARS = 200;
      const preloadTs = startTs - WARMUP_BARS * (timeframe || 240) * 60000;
      let candles = await loadCandles(symbol || 'BTCUSDT', timeframe || 240, preloadTs);

      if (endTs < Infinity) {
        let lastIdx = candles.close.length;
        for (let i = 0; i < candles.close.length; i++) {
          if (candles.ts[i] > endTs) { lastIdx = i; break; }
        }
        if (lastIdx < candles.close.length) {
          candles = {
            ts: candles.ts.slice(0, lastIdx),
            open: candles.open.slice(0, lastIdx),
            high: candles.high.slice(0, lastIdx),
            low: candles.low.slice(0, lastIdx),
            close: candles.close.slice(0, lastIdx),
            volume: candles.volume.slice(0, lastIdx),
          };
        }
      }

      let tradingStartBar = 0;
      for (let i = 0; i < candles.close.length; i++) {
        if (candles.ts[i] >= startTs) { tradingStartBar = i; break; }
      }

      jsMetrics = runStrategy(candles, gene, { tradingStartBar });
    } catch (e) {
      console.warn('[tv/send] JS re-evaluation failed:', e.message);
    }

    const dateRange = { startDate, endDate };
    const result = await sendToTradingView(gene, symbol, timeframe, dateRange);
    res.json({ ...result, jsMetrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Diagnostics ────────────────────────────────────────────

router.get('/api/diagnose/:symbol/:tf', async (req, res) => {
  try {
    const { symbol, tf } = req.params;
    const tfMin = parseInt(tf);
    const startTs = new Date('2021-04-12').getTime();
    const candles = await loadCandles(symbol, tfMin, startTs);
    const len = candles.close.length;

    // Check timestamp gaps
    const tfMs = tfMin * 60000;
    let gaps = 0, bigGaps = [];
    for (let i = 1; i < len; i++) {
      const diff = Number(candles.ts[i] - candles.ts[i - 1]);
      if (diff !== tfMs) {
        gaps++;
        if (diff > tfMs * 3) {
          bigGaps.push({ bar: i, diffMin: diff / 60000, date: new Date(Number(candles.ts[i])).toISOString().slice(0, 16) });
        }
      }
    }

    // Sample candles
    const samples = [];
    for (let i = 100; i < Math.min(106, len); i++) {
      samples.push({
        ts: new Date(Number(candles.ts[i])).toISOString().slice(0, 16),
        o: candles.open[i], h: candles.high[i], l: candles.low[i], c: candles.close[i],
      });
    }

    res.json({
      bars: len,
      expected: Math.round(5 * 365.25 * 24 * 60 / tfMin),
      first: new Date(Number(candles.ts[0])).toISOString(),
      last: new Date(Number(candles.ts[len - 1])).toISOString(),
      gaps, bigGaps: bigGaps.slice(0, 20),
      samples,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Queue processor ────────────────────────────────────────

async function processQueue() {
  if (activeRun) return; // already processing

  while (runQueue.length > 0) {
    const config = runQueue.shift();
    activeRun = config;
    cancelRequested = false;

    const { runId } = config;

    try {
      await exec(`UPDATE runs SET status = 'running', started_at = current_timestamp WHERE id = ${runId}`);
      broadcast({ type: 'run_started', runId, symbol: config.symbol, timeframe: config.timeframe, label: config.label });

      const result = await runOptimization({
        ...config,
        onProgress: (progress) => {
          if (progress.setup) {
            broadcast({ type: 'run_status', runId, phase: progress.phase, detail: progress.detail });
            return;
          }
          broadcast({ type: 'generation', runId, ...progress });
          // Update DB periodically
          if (progress.gen % 10 === 0) {
            exec(`UPDATE runs SET generations_completed = ${progress.gen}, total_evaluations = ${progress.evalCount} WHERE id = ${runId}`).catch(() => {});
          }
        },
        shouldCancel: () => cancelRequested,
      });

      // Store results (including partial results from aborted runs)
      const finalStatus = cancelRequested ? 'cancelled' : 'completed';
      const bestGene = JSON.stringify(result.bestGene).replace(/'/g, "''");
      const bestMetrics = JSON.stringify(result.bestMetrics).replace(/'/g, "''");
      const topResults = JSON.stringify(result.topResults).replace(/'/g, "''");
      const genLog = JSON.stringify(result.generationLog).replace(/'/g, "''");

      await exec(`UPDATE runs SET status = '${finalStatus}', best_gene = '${bestGene}', best_metrics = '${bestMetrics}', top_results = '${topResults}', generation_log = '${genLog}', generations_completed = ${result.completedGens}, total_evaluations = ${result.totalEvaluations}, completed_at = current_timestamp WHERE id = ${runId}`);

      broadcast({
        type: cancelRequested ? 'run_cancelled' : 'run_completed',
        runId,
        bestScore: result.bestScore,
        bestMetrics: result.bestMetrics,
        bestConfig: geneShort(result.bestGene),
        totalTimeMs: result.totalTimeMs,
      });
    } catch (err) {
      const errorMsg = err.message.replace(/'/g, "''");
      await exec(`UPDATE runs SET status = 'failed', error = '${errorMsg}', completed_at = current_timestamp WHERE id = ${runId}`).catch(() => {});
      broadcast({ type: 'run_error', runId, error: err.message });
    }

    activeRun = null;
  }
}

export default router;
