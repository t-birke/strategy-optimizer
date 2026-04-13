/**
 * GA optimization runner — multi-threaded island model using worker_threads.
 * Each island runs in its own thread for true CPU parallelism.
 *
 * Candle data is shared across workers via SharedArrayBuffer (zero-copy).
 * Migration is coordinated by the main thread between evolution batches.
 *
 * Island model informed by:
 *  - Frahnow & Kötzing (2018): ring topology preserves diversity via slow
 *    information propagation; complete topology kills diversity.
 *  - Lässig & Sudholt (2011): rare migration → exponential speedup;
 *    frequent migration → at most logarithmic speedup.
 *  - Chideme, Chen & Lin (2025): diverse migration strategies + heterogeneous
 *    island configurations for trading strategy optimization.
 */

import { Worker } from 'worker_threads';
import { loadCandles } from '../db/candles.js';
import { PARAMS, geneKey, geneShort } from './params.js';

const MIN_TRADES = 10;
const WORKER_URL = new URL('./island-worker.js', import.meta.url);

/**
 * Create and run a GA optimization using worker threads.
 *
 * @param {Object} config
 * @param {string} config.symbol
 * @param {number} config.timeframe — minutes (e.g., 240)
 * @param {string} config.startDate
 * @param {number} config.populationSize — per island (e.g., 80)
 * @param {number} config.generations — e.g., 80
 * @param {number} config.mutationRate — e.g., 0.4
 * @param {number} [config.numIslands=4] — number of islands (1 = single-pop in its own thread)
 * @param {number} [config.migrationInterval=0] — migrate every N gens (0 = auto: 25% of total)
 * @param {number} [config.migrationCount=3] — individuals to migrate per event
 * @param {string} [config.migrationTopology='ring'] — 'ring', 'torus', or 'random'
 * @param {Function} [config.onProgress]
 * @param {Function} [config.shouldCancel]
 * @returns {Object} results
 */
export async function runOptimization(config) {
  const {
    symbol, timeframe, startDate, endDate,
    populationSize = 80,
    generations = 80,
    mutationRate = 0.4,
    numIslands = 4,
    migrationInterval: migrationIntervalRaw = 0,
    migrationCount = 3,
    migrationTopology = 'ring',
    onProgress,
    shouldCancel,
  } = config;

  // Auto migration interval: 25% of generations (rare = better diversity)
  // Single island: one batch = all gens (no migration)
  const migrationInterval = numIslands > 1
    ? (migrationIntervalRaw > 0 ? migrationIntervalRaw : Math.max(5, Math.round(generations * 0.25)))
    : generations;

  // 1. Load candles once on main thread
  //    Load extra bars BEFORE startDate so indicators warm up before trading begins
  //    (matches PineScript behavior where historical data pre-seeds indicators).
  const startTs = new Date(startDate).getTime();
  const endTs = endDate ? new Date(endDate).getTime() : Infinity;
  const WARMUP_BARS = 200;
  const preloadTs = startTs - WARMUP_BARS * timeframe * 60000;
  let candles = await loadCandles(symbol, timeframe, preloadTs);

  // Trim candles to endDate if specified
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

  const len = candles.close.length;

  let tradingStartBar = 0;
  for (let i = 0; i < len; i++) {
    if (candles.ts[i] >= startTs) { tradingStartBar = i; break; }
  }

  if (len < 100) {
    throw new Error(`Insufficient data: ${len} bars for ${symbol} ${timeframe}min from ${startDate}`);
  }

  // 2. Create SharedArrayBuffer — zero-copy sharing with workers
  //    Layout: [open|high|low|close|volume] × len Float64s each
  const sab = new SharedArrayBuffer(len * 5 * 8);
  new Float64Array(sab, len * 0 * 8, len).set(candles.open);
  new Float64Array(sab, len * 1 * 8, len).set(candles.high);
  new Float64Array(sab, len * 2 * 8, len).set(candles.low);
  new Float64Array(sab, len * 3 * 8, len).set(candles.close);
  new Float64Array(sab, len * 4 * 8, len).set(candles.volume);

  console.log(`[runner] Loaded ${len} bars, tradingStartBar=${tradingStartBar} (pre-warmed ${tradingStartBar} bars before ${startDate})`);

  // 3. Spawn worker threads — one per island
  const workers = [];
  const readyPromises = [];

  for (let idx = 0; idx < numIslands; idx++) {
    const t = numIslands > 1 ? idx / (numIslands - 1) : 0.5;
    // Mutation spread: ±50% across islands for heterogeneity
    const islandMutRate = numIslands > 1 ? mutationRate * (0.5 + t) : mutationRate;
    // Per-gene mutation probability: varies 0.12..0.30 across islands
    const perGeneMut = 0.12 + t * 0.18;

    const worker = new Worker(WORKER_URL, {
      workerData: {
        candleBuffer: sab,
        candleLength: len,
        tradingStartBar,
        populationSize,
        mutationRate: Math.min(islandMutRate, 0.9),
        perGeneMut,
        islandIdx: idx,
      },
    });

    workers.push(worker);

    readyPromises.push(new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg.type === 'ready' && msg.islandIdx === idx) {
          worker.off('message', onMsg);
          worker.off('error', onErr);
          resolve();
        }
      };
      const onErr = (err) => {
        worker.off('message', onMsg);
        reject(err);
      };
      worker.on('message', onMsg);
      worker.once('error', onErr);
    }));
  }

  await Promise.all(readyPromises);

  // 4. Topology helper — determines migration targets for each island
  function getTargets(src) {
    if (migrationTopology === 'torus') {
      const cols = Math.max(2, Math.round(Math.sqrt(numIslands)));
      const rows = Math.ceil(numIslands / cols);
      const r = Math.floor(src / cols);
      const c = src % cols;
      const neighbours = new Set();
      neighbours.add(r * cols + (c + 1) % cols);
      neighbours.add(r * cols + (c - 1 + cols) % cols);
      neighbours.add(((r + 1) % rows) * cols + c);
      neighbours.add(((r - 1 + rows) % rows) * cols + c);
      neighbours.delete(src);
      return [...neighbours].filter(n => n < numIslands);
    }
    if (migrationTopology === 'random') {
      let target;
      do { target = Math.floor(Math.random() * numIslands); } while (target === src);
      return [target];
    }
    // Default: ring
    return [(src + 1) % numIslands];
  }

  // Pre-compute static edges for ring/torus (random is dynamic, shown as "?")
  function buildEdges() {
    if (migrationTopology === 'random') return []; // dynamic, can't pre-compute
    const edges = [];
    for (let i = 0; i < numIslands; i++) {
      for (const t of getTargets(i)) {
        edges.push([i, t]);
      }
    }
    return edges;
  }

  // 5. Run evolution in batches with migration between batches
  const generationLog = [];
  const startTime = Date.now();
  let completedGens = 0;
  let totalMigrations = 0;

  // Track per-island state for global best computation
  const islandBest = new Array(numIslands).fill(null);
  const islandGen = new Array(numIslands).fill(0);
  const workerEvals = new Array(numIslands).fill(0);
  const workerCaches = new Array(numIslands).fill(0);

  // Build batch boundaries
  const batches = [];
  for (let g = 1; g <= generations;) {
    const end = Math.min(g + migrationInterval - 1, generations);
    batches.push({ startGen: g, endGen: end });
    g = end + 1;
  }

  let cancelSent = false;

  for (const batch of batches) {
    if (shouldCancel?.()) {
      if (!cancelSent) {
        for (const w of workers) w.postMessage({ type: 'cancel' });
        cancelSent = true;
      }
      break;
    }

    // Send 'evolve' to all workers and collect results
    const batchDone = new Array(numIslands);
    const batchPromises = [];

    // Poll for cancel mid-batch — send cancel to workers immediately
    let cancelPoller = null;
    if (shouldCancel) {
      cancelPoller = setInterval(() => {
        if (!cancelSent && shouldCancel()) {
          cancelSent = true;
          for (const w of workers) w.postMessage({ type: 'cancel' });
          if (onProgress) {
            onProgress({
              gen: Math.max(...islandGen),
              totalGens: generations,
              aborting: true,
              abortStatus: 'Stopping workers — waiting for current generation to finish',
              abortIslands: islandGen.map((g, i) => ({ idx: i, gen: g })),
              best: Math.max(...islandBest.map(ib => ib?.fitness ?? -Infinity)),
              metrics: islandBest.reduce((best, ib) => (ib && ib.fitness > (best?.fitness ?? -Infinity)) ? ib : best, null)?.metrics,
              elapsedMs: Date.now() - startTime,
              numIslands,
            });
          }
        }
      }, 200);
    }

    for (let idx = 0; idx < numIslands; idx++) {
      const w = workers[idx];

      batchPromises.push(new Promise(resolve => {
        const handler = (msg) => {
          if (msg.islandIdx !== idx) return;

          if (msg.type === 'gen_progress') {
            // Update this island's best
            islandBest[idx] = {
              fitness: msg.bestFitness,
              gene: msg.bestGene,
              metrics: msg.metrics,
            };
            islandGen[idx] = msg.gen;
            workerEvals[idx] = msg.evalCount;
            workerCaches[idx] = msg.cacheSize;

            // Compute global best across all islands
            let globalBest = { fitness: -Infinity };
            for (const ib of islandBest) {
              if (ib && ib.fitness > globalBest.fitness) globalBest = ib;
            }

            completedGens = Math.max(...islandGen);

            // Log first report per generation
            if (!generationLog.find(e => e.gen === msg.gen)) {
              generationLog.push({
                gen: msg.gen,
                score: globalBest.fitness,
                gene: { ...globalBest.gene },
                metrics: globalBest.metrics,
                genTimeMs: 0,
              });
            }

            if (onProgress) {
              const minGen = Math.min(...islandGen.filter(g => g > 0));
              const maxGen = Math.max(...islandGen);
              const progressMsg = {
                gen: maxGen,
                minGen: isFinite(minGen) ? minGen : 0,
                maxGen,
                totalGens: generations,
                best: globalBest.fitness,
                metrics: globalBest.metrics,
                config: geneShort(globalBest.gene),
                evalCount: workerEvals.reduce((a, b) => a + b, 0),
                cacheSize: workerCaches.reduce((a, b) => a + b, 0),
                elapsedMs: Date.now() - startTime,
                genTimeMs: 0,
                numIslands,
                totalMigrations,
                topology: migrationTopology,
                islands: islandBest.map((ib, i) => ({
                  idx: i,
                  gen: islandGen[i],
                  profit: ib?.metrics?.netProfit ?? null,
                  trades: ib?.metrics?.trades ?? null,
                  pf: ib?.metrics?.pf ?? null,
                  evals: workerEvals[i],
                })),
                edges: numIslands > 1 ? buildEdges() : [],
              };

              // If aborting, add abort status
              if (cancelSent) {
                progressMsg.aborting = true;
                progressMsg.abortStatus = 'Stopping workers — finishing current generation';
                progressMsg.abortIslands = islandGen.map((g, i) => ({ idx: i, gen: g }));
              }

              onProgress(progressMsg);
            }
          } else if (msg.type === 'batch_done') {
            batchDone[idx] = msg;
            w.off('message', handler);
            resolve();
          }
        };

        w.on('message', handler);
      }));

      w.postMessage({
        type: 'evolve',
        startGen: batch.startGen,
        endGen: batch.endGen,
        migrationCount,
      });
    }

    await Promise.all(batchPromises);
    if (cancelPoller) clearInterval(cancelPoller);

    // Check cancel between batches
    if (shouldCancel?.()) {
      if (!cancelSent) {
        for (const w of workers) w.postMessage({ type: 'cancel' });
        cancelSent = true;
      }
      break;
    }

    // Migration (multi-island only, not after last batch)
    if (numIslands > 1 && batch.endGen < generations) {
      // Collect all migrants per target island (handles torus multi-source)
      const migrationsPerTarget = new Map();
      for (let i = 0; i < numIslands; i++) {
        const targets = getTargets(i);
        const srcTop = batchDone[i].top;
        for (const target of targets) {
          if (!migrationsPerTarget.has(target)) migrationsPerTarget.set(target, []);
          migrationsPerTarget.get(target).push(...srcTop);
        }
      }

      // Send one migrate message per target, capped at migrationCount best
      const migratePromises = [];
      for (const [target, allMigrants] of migrationsPerTarget) {
        allMigrants.sort((a, b) => b.score - a.score);
        const migrants = allMigrants.slice(0, migrationCount);

        migratePromises.push(new Promise(resolve => {
          const handler = (msg) => {
            if (msg.type === 'migrate_done' && msg.islandIdx === target) {
              workers[target].off('message', handler);
              resolve();
            }
          };
          workers[target].on('message', handler);
        }));

        workers[target].postMessage({ type: 'migrate', migrants });
      }

      await Promise.all(migratePromises);
      totalMigrations++;
    }
  }

  // 6. Collect final results from all workers
  if (cancelSent && onProgress) {
    onProgress({
      gen: Math.max(...islandGen),
      totalGens: generations,
      aborting: true,
      abortStatus: 'Collecting partial results from workers',
      elapsedMs: Date.now() - startTime,
      numIslands,
    });
  }

  const resultPromises = workers.map((w, idx) => new Promise(resolve => {
    const handler = (msg) => {
      if (msg.type === 'results' && msg.islandIdx === idx) {
        w.off('message', handler);
        resolve(msg);
      }
    };
    w.on('message', handler);
    w.postMessage({ type: 'get_results' });
  }));

  const finalResults = await Promise.all(resultPromises);

  if (cancelSent && onProgress) {
    onProgress({
      gen: Math.max(...islandGen),
      totalGens: generations,
      aborting: true,
      abortStatus: 'Terminating worker threads',
      elapsedMs: Date.now() - startTime,
      numIslands,
    });
  }

  // Terminate all workers
  await Promise.all(workers.map(w => w.terminate()));

  // 7. Merge results across all islands

  // Global best
  let finalBest = { fitness: -Infinity };
  for (const r of finalResults) {
    if (r.best.fitness > finalBest.fitness) finalBest = r.best;
  }

  // Merge + deduplicate top results from all worker caches
  const seen = new Set();
  const topResults = finalResults
    .flatMap(r => r.topResults)
    .sort((a, b) => b.fitness - a.fitness)
    .filter(r => {
      if (seen.has(r.key)) return false;
      seen.add(r.key);
      return true;
    })
    .slice(0, 20)
    .map(r => {
      const vals = r.key.split(',').map(Number);
      const gene = {};
      PARAMS.forEach((p, j) => gene[p.id] = vals[j]);
      return { gene, fitness: r.fitness, metrics: r.metrics };
    });

  const totalEvaluations = finalResults.reduce((sum, r) => sum + r.evalCount, 0);
  const totalCacheSize = finalResults.reduce((sum, r) => sum + r.cacheSize, 0);

  return {
    symbol,
    timeframe,
    startDate,
    bestGene: finalBest.gene,
    bestScore: finalBest.fitness,
    bestMetrics: finalBest.metrics || {},
    generationLog,
    topResults,
    completedGens,
    totalEvaluations,
    cacheSize: totalCacheSize,
    totalMigrations,
    totalTimeMs: Date.now() - startTime,
    candleBars: len,
    config: { populationSize, generations, mutationRate, numIslands, migrationInterval, migrationCount, migrationTopology },
  };
}
