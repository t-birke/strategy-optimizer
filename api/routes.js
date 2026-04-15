/**
 * Express REST API routes.
 */

import { Router } from 'express';
import { readFile, readdir, stat, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import os from 'node:os';
import { getSymbolStats, getLastTimestamp, deleteSymbol } from '../db/candles.js';
import { query, exec } from '../db/connection.js';
import { upsertSpec, listSpecs, getSpec } from '../db/specs.js';
import {
  claimNextRun, heartbeat, completeRun,
  requestCancel, listQueue, recoverStaleRuns,
} from '../db/queue.js';
import { checkSymbol, ingestSymbol, updateSymbol } from '../data/ingest.js';
import { runOptimization } from '../optimizer/runner.js';
import { geneShort } from '../optimizer/params.js';
import { broadcast } from './websocket.js';
import { sendToTradingView, checkTradingViewConnection } from './tradingview.js';
import { loadCandles } from '../db/candles.js';
import { runStrategy } from '../engine/strategy.js';
import * as registry from '../engine/blocks/registry.js';
import { validateSpec, DEFAULT_FITNESS, DEFAULT_WALK_FORWARD } from '../engine/spec.js';

const router = Router();

// ─── Active state ────────────────────────────────────────────
// Phase 4.2b: the queue itself is now DB-backed (runs.status='pending' IS
// the queue). We still keep a handful of in-process variables for the
// single active run's coordination:
//   activeRun         — { runId, symbol, timeframe, label } of the run
//                       currently holding the GA. `null` when idle.
//   cancelRequested   — mid-GA cancel flag. Flipped true by the cancel
//                       endpoint when the active run's id matches. The
//                       runner reads it via shouldCancel().
//   hyperRequested    — one-shot super-mutator trigger, consumed by runner.
//   heartbeatTimer    — interval that bumps runs.heartbeat_at while the
//                       GA is running. Cleared on completion/error.
//   processing        — guard so processQueue is effectively single-threaded
//                       against itself (drop re-entrant kicks).
// The old `runQueue = []` array is gone — `claimNextRun` is the source of
// truth. Pending rows survive server restarts (previous bug: they didn't).
let activeRun = null;
let cancelRequested = false;
let hyperRequested = false;
let heartbeatTimer = null;
let cancelPollTimer = null;
let processing = false;

// Heartbeat interval during a running GA. 10s matches the db-schema-check
// timing budget and is well below recoverStaleRuns's default 60s timeout.
const HEARTBEAT_MS = 10_000;

// Phase 4.2d — DB-polling interval for `runs.cancel_requested`. The
// HTTP cancel path already flips the in-process `cancelRequested` flag
// synchronously, so single-process users never wait on this. The poll
// is belt-and-suspenders:
//   - A future CLI or admin tool that flips the DB column directly
//     (bypassing the HTTP endpoint) still reaches the runner within
//     ~2s.
//   - A future remote-worker shape (see "Remote optimizer workers" in
//     the backlog's Deferred section) can propagate cancel by writing
//     to `cancel_requested` on the central DB — this timer is what
//     turns that write into a runner-visible signal.
// 2s is a compromise: fast enough that cancel latency is imperceptible
// to a human clicking Cancel, slow enough that it doesn't hammer the
// DB (the poll is one small SELECT per interval).
const CANCEL_POLL_MS = 2_000;

// Worker identifier stamped into runs.claimed_by when the in-process
// drain claims a row. Mostly for debugging — even single-process mode
// benefits from seeing which pid owned a stuck row.
const WORKER_ID = `inproc.${os.hostname()}.${process.pid}`;

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
      minTrades = 30, maxDrawdownPct = 50,
      knockoutMode = 'none', knockoutValueMode = 'midpoint',
      spec: specInput = null,       // Phase 4.1: optional spec-mode run. Accepts
                                    // an inline object or a filename string
                                    // under `strategies/` (e.g.
                                    // `"20260414-001-jm-simple-3tp-legacy.json"`).
    } = req.body;

    if (!symbols?.length || !intervals?.length) {
      return res.status(400).json({ error: 'symbols and intervals required' });
    }

    // ─── Spec-mode setup (Phase 4.1) ─────────────────────
    // If the caller provided a spec, resolve → validate → upsert into the
    // `specs` table. The run rows get spec_hash + spec_name pointers so
    // we can always look back at the exact spec that produced them.
    // Validation errors surface as 400 — misconfigured specs shouldn't
    // silently fall back to legacy mode.
    let rawSpec = null;
    let validatedSpec = null;
    if (specInput !== null && specInput !== undefined) {
      await registry.ensureLoaded();
      try {
        if (typeof specInput === 'string') {
          // Filename under strategies/. Reject absolute paths and
          // "../" traversal for safety — this is a server-side read.
          if (specInput.includes('..') || specInput.startsWith('/')) {
            return res.status(400).json({ error: `spec path rejected: ${specInput}` });
          }
          const path = resolve(process.cwd(), 'strategies', specInput);
          rawSpec = JSON.parse(await readFile(path, 'utf8'));
        } else if (typeof specInput === 'object') {
          rawSpec = specInput;
        } else {
          return res.status(400).json({ error: `spec must be a filename or object, got ${typeof specInput}` });
        }
        validatedSpec = validateSpec(rawSpec);
        await upsertSpec(validatedSpec);
      } catch (err) {
        return res.status(400).json({ error: `spec error: ${err.message}` });
      }
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
          minTrades, maxDrawdownPct: maxDrawdownPct / 100,
          knockoutMode, knockoutValueMode,
          // Spec-mode fields (null in legacy mode).
          //   spec      — raw spec JSON, consumed by runOptimization.
          //   specHash  — persisted to runs.spec_hash at completion.
          //   specName  — persisted to runs.spec_name (denormalized for UI listing).
          spec:     rawSpec,
          specHash: validatedSpec?.hash ?? null,
          specName: validatedSpec?.name ?? null,
        });
      }
    }

    const runIds = [];
    for (const rc of runConfigs) {
      // Phase 4.2b: persist the full GA config on the row so a later
      // claimNextRun can reconstruct runOptimization's args without any
      // in-memory sidecar. The spec itself is NOT inlined here — it's
      // already in the `specs` table, reachable via `spec_hash`.
      const configJson = JSON.stringify({
        populationSize: rc.populationSize, generations: rc.generations, mutationRate: rc.mutationRate,
        numIslands: rc.numIslands, numPlanets: rc.numPlanets,
        migrationInterval: rc.migrationInterval, migrationCount: rc.migrationCount, migrationTopology: rc.migrationTopology,
        spaceTravelInterval: rc.spaceTravelInterval, spaceTravelCount: rc.spaceTravelCount,
        minTrades: rc.minTrades, maxDrawdownPct: rc.maxDrawdownPct,
        endDate: rc.endDate,
        knockoutMode: rc.knockoutMode, knockoutValueMode: rc.knockoutValueMode,
        label: rc.label,
      }).replace(/'/g, "''");
      // Set spec_hash / spec_name at enqueue so even pending runs carry
      // the link — listings can show "spec: <name>" before the run starts.
      const specCols = rc.specHash
        ? `, spec_hash, spec_name`
        : '';
      const specVals = rc.specHash
        ? `, '${rc.specHash}', '${rc.specName.replace(/'/g, "''")}'`
        : '';
      await exec(`INSERT INTO runs (symbol, timeframe, start_date, status, config${specCols}) VALUES ('${rc.symbol}', ${rc.timeframe}, '${rc.startDate}', 'pending', '${configJson}'${specVals})`);
      const rows = await query('SELECT MAX(id) AS id FROM runs');
      const runId = rows[0].id;
      runIds.push(runId);
    }

    // Kick the drain loop. processQueue is idempotent — a second kick
    // while it's already draining is a no-op.
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

    const flatSizing = req.query.sizing === 'flat';
    const metrics = runStrategy(candles, run.best_gene, {
      tradingStartBar, collectTrades: true, collectEquity: true, flatSizing,
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
      sizing: flatSizing ? 'flat' : 'compounding',
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

router.post('/api/runs/:id/hypermutate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (activeRun?.runId !== id) {
    return res.status(404).json({ error: 'Run not active' });
  }
  hyperRequested = true;
  res.json({ status: 'triggered' });
});

router.post('/api/runs/:id/cancel', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  // Phase 4.2b cancel semantics:
  //   - If it's the active run: flip the in-process cancelRequested flag
  //     so the runner sees it via shouldCancel() and stops within the
  //     current generation. ALSO set runs.cancel_requested = TRUE via
  //     requestCancel so the DB is the source of truth (and future 4.2d
  //     cancel-propagation in the runner itself can use the same signal).
  //   - If it's a pending row: requestCancel flips the flag; the next
  //     claimNextRun sweeps it to 'cancelled' and moves on. No need to
  //     manually UPDATE status here.
  //   - If the row doesn't exist or is already terminal, requestCancel
  //     returns false and we 404.
  const flagged = await requestCancel(id);
  if (!flagged) return res.status(404).json({ error: 'Run not in queue or active' });

  if (activeRun?.runId === id) {
    cancelRequested = true;
    return res.json({ status: 'cancelling' });
  }
  // Kick the drain loop. claimNextRun's first action is to sweep any
  // pending rows with cancel_requested=TRUE to 'cancelled', so a single
  // processQueue() call promptly transitions this row (and any other
  // pending rows that were cancel-requested). Without this kick, cancel
  // on a pending run just flipped the flag — the status stayed 'pending'
  // indefinitely, until the next POST /api/runs happened to trigger
  // processQueue. Idempotent: if a drain is already in flight the call
  // is a no-op (processing guard). We fire-and-forget — the sweep runs
  // on the server event loop; the caller gets `cancel_requested` right
  // away and the next /api/queue read reflects the transition.
  processQueue();
  res.json({ status: 'cancel_requested' });
});

router.get('/api/queue', async (req, res) => {
  try {
    // Phase 4.2b: queue is DB-backed. listQueue returns pending + running
    // rows (cheap metadata, no big JSON payloads). We still surface the
    // active run via the in-process singleton so the UI gets the friendly
    // `label` we stashed on the config.
    const rows = await listQueue();
    const active = activeRun
      ? { runId: activeRun.runId, symbol: activeRun.symbol, timeframe: activeRun.timeframe, label: activeRun.label }
      : null;
    const pending = rows
      .filter(r => r.status === 'pending')
      .map(r => ({
        runId: r.id,
        symbol: r.symbol,
        timeframe: r.timeframe,
        priority: r.priority,
        specName: r.spec_name,
        // `label` lives in the config JSON — parse best-effort.
        label: (() => {
          try {
            const c = typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
            return c?.label ?? null;
          } catch { return null; }
        })(),
      }));
    res.json({ active, pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Phase 4.2c — ops endpoint for the CLI (`scripts/queue.js recover`).
 * One-shot sweep of stale `running` rows back to `pending`. Intended for
 * manual use when you suspect a wedged run (no heartbeat in a while).
 *
 * Body: `{ timeoutMs?: number }` — defaults to 60_000. Same semantics as
 * the boot-time recovery in server.js, but configurable.
 *
 * Protecting the active run: we bump the in-process active run's
 * heartbeat_at to NOW right before the sweep. The sweep only recovers
 * rows older than `timeoutMs`, so after the bump the active row is
 * guaranteed-fresh and cannot be recovered, even if the caller passed
 * `timeoutMs = 1_000`. This closes the race where an aggressive recover
 * call would yank the row the current process is still executing.
 *
 * If you genuinely want to abandon the active run, cancel it first
 * (POST /api/runs/:id/cancel), don't try to do it via recover.
 */
router.post('/api/queue/recover', async (req, res) => {
  try {
    const timeoutMs = Number.isFinite(req.body?.timeoutMs) ? req.body.timeoutMs : 60_000;
    if (timeoutMs <= 0) return res.status(400).json({ error: 'timeoutMs must be > 0' });
    if (activeRun) await heartbeat(activeRun.runId).catch(() => {});
    const recovered = await recoverStaleRuns({ timeoutMs });
    res.json({ recovered, timeoutMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Spec authoring (Phase 4.3a) ──────────────────────────
//
// Two read-only endpoints that feed the upcoming spec-authoring UI:
//
//   GET /api/specs   — enumerate strategy spec files on disk (strategies/*.json)
//   GET /api/blocks  — enumerate the in-memory block registry + their declared params
//
// Neither endpoint talks to the DB. Specs are file-based at authoring time; the
// `specs` table is a content-addressed archive of specs that have actually been
// used in a run (for run provenance), not the picker source. The UI picker
// should offer what's on disk so newly-authored-but-never-run specs are visible.
//
// Block enumeration goes through `registry.ensureLoaded()` which lazy-imports
// the library bundle on first call — that's free on a warm server, slightly
// more expensive (one import tree) on a cold one.

/**
 * GET /api/specs
 *
 * Enumerate all JSON files under `strategies/`. For each file we parse the
 * JSON (best-effort) and surface metadata the UI needs for a picker:
 * filename, name, description, byte size, mtime.
 *
 * Files that fail to parse, or that don't have the required `name` field,
 * are surfaced separately in `malformed[]` so the UI can show a warning
 * without losing visibility of the broken files. We do NOT run the full
 * `validateSpec()` here — that's expensive (loads the block library to check
 * references) and the picker only needs shape-level trust. Full validation
 * happens on POST /api/runs exactly like today.
 *
 * Response:
 *   {
 *     specs: [{ filename, name, description, sizeBytes, mtime }, ...],
 *     malformed: [{ filename, error }, ...]
 *   }
 */
router.get('/api/specs', async (req, res) => {
  try {
    const dir = resolve(process.cwd(), 'strategies');
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      // strategies/ missing is fine on a fresh checkout — just empty list.
      if (err.code === 'ENOENT') return res.json({ specs: [], malformed: [] });
      throw err;
    }

    const specs = [];
    const malformed = [];
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const path = resolve(dir, filename);
      let st, raw, parsed;
      try {
        st = await stat(path);
        if (!st.isFile()) continue;
        raw = await readFile(path, 'utf8');
        parsed = JSON.parse(raw);
      } catch (err) {
        malformed.push({ filename, error: err.message });
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') {
        malformed.push({ filename, error: 'missing or invalid "name" field' });
        continue;
      }
      // Truncate description for list view — full text is available by
      // re-fetching the file. 280 chars is generous but bounds payload size.
      const desc = typeof parsed.description === 'string'
        ? (parsed.description.length > 280
            ? parsed.description.slice(0, 280) + '…'
            : parsed.description)
        : null;
      specs.push({
        filename,
        name: parsed.name,
        description: desc,
        sizeBytes: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    // Newest first — matches the on-disk authoring flow ("show me what I just saved").
    specs.sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json({ specs, malformed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/blocks
 *
 * Dump the in-memory block registry so the UI can render a block picker
 * grouped by kind. For each block we surface enough metadata to build a
 * narrowing form (declaredParams gives min/max/step per param).
 *
 * The registry is the source of truth — no shadow JSON. If a new block is
 * added to engine/blocks/library/, it appears here automatically after the
 * next server restart.
 *
 * Response:
 *   {
 *     blocks: [
 *       {
 *         id, version, kind,
 *         direction: 'long'|'short'|'both'|null,  // null for regime/sizing
 *         exitSlot:  'hardStop'|'target'|'trail'|null,  // non-null only for exit
 *         sizingRequirements: ['stopDistance',...] | null,  // sizing-only
 *         params: [{ id, type, min, max, step }, ...]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Stable sort by (kind, id, version) so clients can diff responses.
 */
router.get('/api/blocks', async (req, res) => {
  try {
    await registry.ensureLoaded();
    const KIND_ORDER = { regime: 0, entry: 1, filter: 2, exit: 3, sizing: 4 };
    const blocks = registry.list().map(b => {
      let params = [];
      try {
        // declaredParams() takes no args (contract invariant), but defensively
        // treat a throw as "no declared params" rather than crashing the whole
        // endpoint. A broken block shouldn't poison the whole picker.
        const arr = typeof b.declaredParams === 'function' ? b.declaredParams() : [];
        if (Array.isArray(arr)) {
          params = arr.map(p => ({
            id: p.id, type: p.type, min: p.min, max: p.max, step: p.step,
          }));
        }
      } catch { /* params stays [] */ }

      let sizingRequirements = null;
      if (b.kind === 'sizing' && typeof b.sizingRequirements === 'function') {
        try {
          const r = b.sizingRequirements();
          if (Array.isArray(r)) sizingRequirements = r;
        } catch { /* stays null */ }
      }

      return {
        id: b.id,
        version: b.version,
        kind: b.kind,
        direction: b.direction ?? null,
        exitSlot:  b.exitSlot  ?? null,
        // Optional human-readable description surfaced in the spec-editor UI
        // so users don't have to remember what each block id means.
        description: typeof b.description === 'string' ? b.description : null,
        sizingRequirements,
        params,
      };
    });
    blocks.sort((a, b) => {
      const ka = KIND_ORDER[a.kind] ?? 99;
      const kb = KIND_ORDER[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      if (a.id !== b.id) return a.id.localeCompare(b.id);
      return a.version - b.version;
    });
    res.json({ blocks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/defaults — exposes the source-of-truth config defaults from
 * `engine/spec.js` so the UI "Reset to recommended" button is always in
 * lockstep with what the runner would fill in if the user omitted the
 * field. Phase 4.4 (fitness config panel).
 *
 * We surface two frozen constants:
 *   - fitness:     { weights, caps, gates }  — scoring config
 *   - walkForward: { nWindows, scheme }      — WF slicing config
 *
 * The walkForward shape is included even though 4.4 only puts UI on
 * fitness: future sub-chunks (and any consumer that wants "what are the
 * recommended defaults?" at runtime) can rely on this one endpoint
 * instead of hardcoding a mirror.
 *
 * Pure read of frozen objects — no I/O, no registry touch, safe to call
 * on every modal open. Deep-spread so downstream callers can't mutate
 * the module-level constants by mistake.
 */
router.get('/api/defaults', (_req, res) => {
  res.json({
    fitness: {
      weights: { ...DEFAULT_FITNESS.weights },
      caps:    { ...DEFAULT_FITNESS.caps },
      gates:   { ...DEFAULT_FITNESS.gates },
    },
    walkForward: { ...DEFAULT_WALK_FORWARD },
  });
});

/**
 * POST /api/specs — persist a user-authored spec to `strategies/<name>.json`.
 *
 * Phase 4.3e. Turns the spec-editor "Copy JSON" flow into a one-click save.
 *
 * Body: the full spec JSON object (same shape the spec editor builds into
 * the live preview). Validated authoritatively via `validateSpec()` so
 * every garbage shape, unknown block ref, out-of-bounds param override,
 * etc. is rejected BEFORE a file hits disk. The client-side editor
 * already clamps inputs, but that's advisory — this is the gate.
 *
 * Query: `?overwrite=1` opts into replacing an existing file. Without it,
 * POSTing a duplicate name returns 409 so the UI can prompt the user.
 *
 * Filename: `${spec.name}.json`. The name regex already restricts to a
 * kebab-safe alphabet, but `basename()` is a belt-and-braces guard so a
 * crafted name like `../evil` can't traverse out of `strategies/`.
 *
 * Atomicity: write to `<target>.tmp` then rename — interrupted writes
 * never leave a half-flushed JSON on disk that GET /api/specs would
 * then classify as malformed.
 *
 * Response:
 *   201 { ok: true, filename, name, overwritten: false }  — new file
 *   200 { ok: true, filename, name, overwritten: true  }  — replaced
 *   400 { ok: false, error }                              — validation failed
 *   409 { ok: false, error, filename }                    — duplicate, no overwrite
 *   500 { ok: false, error }                              — internal
 */
router.post('/api/specs', async (req, res) => {
  try {
    const spec = req.body;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return res.status(400).json({ ok: false, error: 'request body must be a JSON object' });
    }

    // Authoritative validation. Needs the registry so block refs resolve.
    await registry.ensureLoaded();
    let normalized;
    try {
      normalized = validateSpec(spec);
    } catch (err) {
      // validateSpec aggregates every violation into one newline-separated
      // Error message. Surface it verbatim — the UI renders line-by-line.
      return res.status(400).json({ ok: false, error: err.message });
    }

    // Normalized name is safe (regex-checked), but basename() belt-and-braces.
    const filename = basename(`${normalized.name}.json`);
    const dir = resolve(process.cwd(), 'strategies');
    const target = resolve(dir, filename);

    const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
    let existed = false;
    try {
      await stat(target);
      existed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (existed && !overwrite) {
      return res.status(409).json({
        ok: false,
        error: `A spec named "${filename}" already exists. Re-submit with ?overwrite=1 to replace it.`,
        filename,
      });
    }

    // Drop validator-attached derived fields before persisting; they're
    // recomputed on every load, so baking them in would just cause diff
    // noise in git.
    const { hash: _hash, ...persisted } = normalized;

    await mkdir(dir, { recursive: true });
    const tmp = target + '.tmp';
    await writeFile(tmp, JSON.stringify(persisted, null, 2) + '\n', 'utf8');
    try {
      await rename(tmp, target);
    } catch (err) {
      // Best-effort cleanup; if the rename fails we still surface the error.
      try { await unlink(tmp); } catch { /* swallow */ }
      throw err;
    }

    res.status(existed ? 200 : 201).json({
      ok: true,
      filename,
      name: normalized.name,
      overwritten: existed,
    });
  } catch (err) {
    console.error('POST /api/specs failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
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

// ─── Queue processor (Phase 4.2b — DB-backed) ──────────────

/**
 * Drain the run queue. Claims the highest-priority pending row via
 * `claimNextRun`, reconstructs `runOptimization` args from `runs.config`
 * + `specs.json`, runs the GA (with heartbeat pings), and persists the
 * result via `completeRun`.
 *
 * Idempotent — a second call while already draining is a no-op
 * (`processing` guard). Callers that enqueue should always kick this
 * function; it takes care of looping until the queue empties.
 *
 * Exported so tests can drive it without a running server (inject a
 * stubbed `runOptimization` via module mocking if needed).
 */
export async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (true) {
      const row = await claimNextRun({ workerId: WORKER_ID });
      if (!row) break; // queue empty

      const runId = row.id;

      // Rebuild the runOptimization args from persisted state. The DB row
      // carries symbol/timeframe/start_date as columns; everything else
      // lives in the `config` JSON (written at enqueue). The spec, if any,
      // is reached via spec_hash → specs.json.
      let cfg;
      try {
        cfg = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {});
      } catch (err) {
        await completeRun(runId, {
          status: 'failed',
          error: `config JSON parse error: ${err.message}`,
        });
        broadcast({ type: 'run_error', runId, error: `config JSON parse error: ${err.message}` });
        continue;
      }

      let spec = null;
      if (row.spec_hash) {
        try {
          const persisted = await getSpec(row.spec_hash);
          spec = persisted?.json ?? null;
          if (!spec) throw new Error(`spec not found for hash ${row.spec_hash}`);
        } catch (err) {
          await completeRun(runId, { status: 'failed', error: `spec load error: ${err.message}` });
          broadcast({ type: 'run_error', runId, error: `spec load error: ${err.message}` });
          continue;
        }
      }

      // Publish active-run state + start heartbeat interval. Heartbeat
      // failures are silent — recoverStaleRuns will catch a truly dead
      // runner on next server boot.
      activeRun = {
        runId,
        symbol: row.symbol,
        timeframe: row.timeframe,
        label: cfg.label ?? null,
        specHash: row.spec_hash ?? null,
        specName: row.spec_name ?? null,
      };
      cancelRequested = false;
      hyperRequested = false;
      heartbeatTimer = setInterval(() => {
        heartbeat(runId).catch(() => {});
      }, HEARTBEAT_MS);
      // Phase 4.2d: poll the DB for cancel_requested. One-shot latch —
      // once we see TRUE we stop polling (the flag is monotonic; there's
      // no un-cancel). The runner reads cancelRequested via shouldCancel
      // every generation, so setting it here propagates within the next
      // generation boundary.
      cancelPollTimer = setInterval(async () => {
        if (cancelRequested) return;   // HTTP path already flipped it
        try {
          const rows = await query(`SELECT cancel_requested FROM runs WHERE id = ${runId}`);
          if (rows[0]?.cancel_requested) {
            console.log(`[queue] cancel_requested flipped on DB for run ${runId}; propagating to runner`);
            cancelRequested = true;
          }
        } catch { /* transient DB error — try again next tick */ }
      }, CANCEL_POLL_MS);

      broadcast({
        type: 'run_started', runId,
        symbol: row.symbol, timeframe: row.timeframe, label: cfg.label ?? null,
      });

      try {
        const result = await runOptimization({
          symbol: row.symbol,
          timeframe: row.timeframe,
          startDate: row.start_date,
          endDate: cfg.endDate,
          populationSize: cfg.populationSize,
          generations:    cfg.generations,
          mutationRate:   cfg.mutationRate,
          numIslands:     cfg.numIslands,
          numPlanets:     cfg.numPlanets,
          migrationInterval: cfg.migrationInterval,
          migrationCount:    cfg.migrationCount,
          migrationTopology: cfg.migrationTopology,
          spaceTravelInterval: cfg.spaceTravelInterval,
          spaceTravelCount:    cfg.spaceTravelCount,
          minTrades:      cfg.minTrades,
          maxDrawdownPct: cfg.maxDrawdownPct,
          knockoutMode:   cfg.knockoutMode,
          knockoutValueMode: cfg.knockoutValueMode,
          spec,
          onProgress: (progress) => {
            if (progress.setup) {
              broadcast({ type: 'run_status', runId, phase: progress.phase, detail: progress.detail });
              return;
            }
            broadcast({ type: 'generation', runId, ...progress });
            if (progress.gen % 10 === 0) {
              exec(`UPDATE runs SET generations_completed = ${progress.gen}, total_evaluations = ${progress.evalCount} WHERE id = ${runId}`).catch(() => {});
            }
          },
          shouldCancel: () => cancelRequested,
          shouldHypermutate: () => {
            // Consume-once: flag flips false after the runner reads it true
            if (hyperRequested) { hyperRequested = false; return true; }
            return false;
          },
        });

        // Persist the result. completeRun handles all NULL-safe JSON
        // columns and terminal-status semantics. Spec-mode rows get the
        // fitness/regime/wf breakdowns; legacy rows leave them null.
        const specMode = Boolean(spec);
        await completeRun(runId, {
          status: cancelRequested ? 'cancelled' : 'completed',
          bestGene:      result.bestGene,
          bestMetrics:   result.bestMetrics,
          topResults:    result.topResults,
          generationLog: result.generationLog,
          fitnessBreakdownJson: specMode ? (result.bestMetrics?._fitness ?? null) : null,
          regimeBreakdownJson:  specMode ? (result.bestMetrics?.regimeBreakdown ?? null) : null,
          wfReportJson:         specMode ? (result.wfReport ?? null) : null,
          generationsCompleted: result.completedGens,
          totalEvaluations:     result.totalEvaluations,
        });

        broadcast({
          type: cancelRequested ? 'run_cancelled' : 'run_completed',
          runId,
          bestScore: result.bestScore,
          bestMetrics: result.bestMetrics,
          bestConfig: geneShort(result.bestGene),
          totalTimeMs: result.totalTimeMs,
        });
      } catch (err) {
        await completeRun(runId, { status: 'failed', error: err.message })
          .catch(() => {});
        broadcast({ type: 'run_error', runId, error: err.message });
      } finally {
        clearInterval(heartbeatTimer);
        clearInterval(cancelPollTimer);
        heartbeatTimer = null;
        cancelPollTimer = null;
        activeRun = null;
        cancelRequested = false;
        hyperRequested = false;
      }
    }
  } finally {
    processing = false;
  }
}

export default router;
