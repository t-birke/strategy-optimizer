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

    // Run ingestion in background
    const fiveYearsAgo = Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000;
    const startTs = Math.max(info.earliestTs, fiveYearsAgo);

    ingestSymbol(symbol, startTs, ({ fetched, estimatedTotal }) => {
      broadcast({
        type: 'ingest_progress',
        symbol,
        fetched,
        total: estimatedTotal,
        pct: Math.round(fetched / estimatedTotal * 100),
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

    updateSymbol(symbol, ({ fetched, estimatedTotal }) => {
      broadcast({
        type: 'ingest_progress',
        symbol,
        fetched,
        total: estimatedTotal,
        pct: Math.round(fetched / estimatedTotal * 100),
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
        broadcast({ type: 'ingest_progress', symbol: s.symbol, fetched: 0, total: 0, pct: 0 });
        const count = await updateSymbol(s.symbol, ({ fetched, estimatedTotal }) => {
          broadcast({
            type: 'ingest_progress',
            symbol: s.symbol,
            fetched,
            total: estimatedTotal,
            pct: Math.round(fetched / estimatedTotal * 100),
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
      'SELECT id, symbol, timeframe, start_date, status, best_metrics, best_gene, generations_completed, total_evaluations, error, started_at, completed_at, created_at FROM runs ORDER BY id DESC'
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
      symbols, intervals, period = '5y',
      populationSize = 80, generations = 80, mutationRate = 0.4,
      numIslands = 4, migrationInterval = 0, migrationCount = 3, migrationTopology = 'ring',
    } = req.body;

    if (!symbols?.length || !intervals?.length) {
      return res.status(400).json({ error: 'symbols and intervals required' });
    }

    // Interval label → minutes
    const INTERVAL_MAP = {
      '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
      '1H': 60, '2H': 120, '3H': 180, '4H': 240, '6H': 360, '8H': 480,
    };

    // Period → start date
    const PERIOD_MAP = {
      '6M': 0.5, '1y': 1, '2y': 2, '3y': 3, '4y': 4, '5y': 5,
    };
    const yearsBack = PERIOD_MAP[period] || 5;
    const startDate = new Date(Date.now() - yearsBack * 365.25 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];

    const runConfigs = [];
    for (const symbol of symbols) {
      for (const ivLabel of intervals) {
        const tf = INTERVAL_MAP[ivLabel];
        if (!tf) continue;
        runConfigs.push({
          symbol, timeframe: tf, startDate,
          label: ivLabel, period,
          populationSize, generations, mutationRate,
          numIslands, migrationInterval, migrationCount, migrationTopology,
        });
      }
    }

    // Create run records in DB
    const runIds = [];
    for (const rc of runConfigs) {
      await exec(`INSERT INTO runs (symbol, timeframe, start_date, status, config) VALUES ('${rc.symbol}', ${rc.timeframe}, '${rc.startDate}', 'pending', '${JSON.stringify({ populationSize: rc.populationSize, generations: rc.generations, mutationRate: rc.mutationRate, numIslands: rc.numIslands, migrationInterval: rc.migrationInterval, migrationCount: rc.migrationCount, migrationTopology: rc.migrationTopology })}')`);
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
          broadcast({ type: 'generation', runId, ...progress });
          // Update DB periodically
          if (progress.gen % 10 === 0) {
            exec(`UPDATE runs SET generations_completed = ${progress.gen}, total_evaluations = ${progress.evalCount} WHERE id = ${runId}`).catch(() => {});
          }
        },
        shouldCancel: () => cancelRequested,
      });

      // Store results
      const bestGene = JSON.stringify(result.bestGene).replace(/'/g, "''");
      const bestMetrics = JSON.stringify(result.bestMetrics).replace(/'/g, "''");
      const topResults = JSON.stringify(result.topResults).replace(/'/g, "''");
      const genLog = JSON.stringify(result.generationLog).replace(/'/g, "''");

      await exec(`UPDATE runs SET status = 'completed', best_gene = '${bestGene}', best_metrics = '${bestMetrics}', top_results = '${topResults}', generation_log = '${genLog}', generations_completed = ${result.completedGens}, total_evaluations = ${result.totalEvaluations}, completed_at = current_timestamp WHERE id = ${runId}`);

      broadcast({
        type: 'run_completed',
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
