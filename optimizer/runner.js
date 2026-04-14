/**
 * GA optimization runner — multi-threaded island model using worker_threads.
 * Each island runs in its own thread for true CPU parallelism.
 *
 * Candle data is shared across workers via SharedArrayBuffer (zero-copy).
 * Migration is coordinated by the main thread between evolution batches.
 *
 * Hierarchy (when numPlanets > 1):
 *   Planets → Islands → Population
 *   - Island migration: ring/torus/random within each planet
 *   - Space travel: rare cross-planet migration of top individuals
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
 * @param {number} [config.numIslands=4] — islands per planet
 * @param {number} [config.numPlanets=1] — number of planets (1 = no planet layer)
 * @param {number} [config.migrationInterval=0] — island migrate every N gens (0 = auto: 25% of total)
 * @param {number} [config.migrationCount=3] — individuals per island migration event
 * @param {string} [config.migrationTopology='ring'] — 'ring', 'torus', or 'random'
 * @param {number} [config.spaceTravelInterval=2] — space travel every N island migrations (numPlanets>1 only)
 * @param {number} [config.spaceTravelCount=1] — individuals per space travel event
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
    numPlanets = 1,
    migrationInterval: migrationIntervalRaw = 0,
    migrationCount = 3,
    migrationTopology = 'ring',
    spaceTravelInterval = 2,
    spaceTravelCount = 1,
    windowSizeDays = 0,
    consistencyWeight = 0.5,
    onProgress,
    shouldCancel,
  } = config;

  const totalWorkers = numPlanets * numIslands;

  // Status callback — sends UI updates during setup phases
  const status = (phase, detail) => {
    if (onProgress) onProgress({ phase, detail, setup: true });
  };

  // Auto migration interval: 25% of generations (rare = better diversity)
  // Single island: one batch = all gens (no migration)
  const migrationInterval = totalWorkers > 1
    ? (migrationIntervalRaw > 0 ? migrationIntervalRaw : Math.max(5, Math.round(generations * 0.25)))
    : generations;

  // 1. Load candles once on main thread
  //    Load extra bars BEFORE startDate so indicators warm up before trading begins
  //    (matches PineScript behavior where historical data pre-seeds indicators).
  status('loading', `Loading ${symbol} ${timeframe}min candles...`);
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

  // Window-based fitness: convert days → bars, 50% overlap
  const barsPerDay = (24 * 60) / timeframe;
  const windowSizeBars = windowSizeDays > 0 ? Math.round(windowSizeDays * barsPerDay) : 0;
  const windowStepBars = windowSizeBars > 0 ? Math.round(windowSizeBars / 2) : 0;
  const tradingBars = len - tradingStartBar;
  const windowCount = windowSizeBars > 0 && windowStepBars > 0
    ? Math.floor((tradingBars - windowSizeBars) / windowStepBars) + 1
    : 0;

  if (windowSizeBars > 0) {
    console.log(`[runner] Window fitness: ${windowSizeDays}d = ${windowSizeBars} bars, step=${windowStepBars}, ~${windowCount} windows, consistency=${consistencyWeight}`);
    status('config', `Window fitness: ${windowCount} × ${windowSizeDays}d windows, consistency=${consistencyWeight}`);
  }

  // 2. Create SharedArrayBuffer — zero-copy sharing with workers
  //    Layout: [open|high|low|close|volume] × len Float64s each
  const sab = new SharedArrayBuffer(len * 5 * 8);
  new Float64Array(sab, len * 0 * 8, len).set(candles.open);
  new Float64Array(sab, len * 1 * 8, len).set(candles.high);
  new Float64Array(sab, len * 2 * 8, len).set(candles.low);
  new Float64Array(sab, len * 3 * 8, len).set(candles.close);
  new Float64Array(sab, len * 4 * 8, len).set(candles.volume);

  const actualStartTs = candles.ts[tradingStartBar];
  const actualEndTs = candles.ts[len - 1];
  const periodYears = (actualEndTs - actualStartTs) / (365.25 * 24 * 60 * 60 * 1000);

  status('loaded', `${len.toLocaleString()} bars loaded (${periodYears.toFixed(1)}y). Preparing ${totalWorkers} workers (${numPlanets}p × ${numIslands}i)...`);
  console.log(`[runner] Loaded ${len} bars, tradingStartBar=${tradingStartBar}, planets=${numPlanets}, islands/planet=${numIslands}, total workers=${totalWorkers}`);

  // 3. Spawn worker threads — one per island across all planets
  //    Mutation rate varies across all workers globally for maximum diversity
  const workers = [];
  const readyPromises = [];

  for (let idx = 0; idx < totalWorkers; idx++) {
    const t = totalWorkers > 1 ? idx / (totalWorkers - 1) : 0.5;
    // Mutation spread: ±50% across all workers for heterogeneity
    const islandMutRate = totalWorkers > 1 ? mutationRate * (0.5 + t) : mutationRate;
    // Per-gene mutation probability: varies 0.12..0.30 across workers
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
        windowSizeBars,
        windowStepBars,
        consistencyWeight,
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
  status('ready', `All ${totalWorkers} workers ready. Starting evolution (${generations} generations)...`);

  // 4. Topology helpers

  // Island migration: targets are within the same planet only
  function getIslandTargets(globalIdx) {
    const planet = Math.floor(globalIdx / numIslands);
    const local = globalIdx % numIslands;
    const base = planet * numIslands;

    if (migrationTopology === 'torus') {
      const cols = Math.max(2, Math.round(Math.sqrt(numIslands)));
      const rows = Math.ceil(numIslands / cols);
      const r = Math.floor(local / cols);
      const c = local % cols;
      const neighbours = new Set();
      neighbours.add(r * cols + (c + 1) % cols);
      neighbours.add(r * cols + (c - 1 + cols) % cols);
      neighbours.add(((r + 1) % rows) * cols + c);
      neighbours.add(((r - 1 + rows) % rows) * cols + c);
      neighbours.delete(local);
      return [...neighbours].filter(n => n < numIslands).map(n => base + n);
    }
    if (migrationTopology === 'random') {
      let target;
      do { target = Math.floor(Math.random() * numIslands); } while (target === local);
      return [base + target];
    }
    // Default: ring within planet
    return [base + (local + 1) % numIslands];
  }

  // Space travel: pick a random island on a different planet
  function getSpaceTravelTargets(fromPlanet) {
    if (numPlanets <= 1) return [];
    let toPlanet;
    do { toPlanet = Math.floor(Math.random() * numPlanets); } while (toPlanet === fromPlanet);
    const toIsland = Math.floor(Math.random() * numIslands);
    return [toPlanet * numIslands + toIsland];
  }

  // Pre-compute static island edges for progress display
  function buildEdges() {
    if (migrationTopology === 'random') return [];
    const edges = [];
    for (let i = 0; i < totalWorkers; i++) {
      for (const t of getIslandTargets(i)) {
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
  let totalSpaceTravels = 0;

  // Track per-worker state
  const islandBest = new Array(totalWorkers).fill(null);
  const islandGen = new Array(totalWorkers).fill(0);
  const workerEvals = new Array(totalWorkers).fill(0);
  const workerCaches = new Array(totalWorkers).fill(0);

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
    const batchDone = new Array(totalWorkers);
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
              numPlanets,
            });
          }
        }
      }, 200);
    }

    for (let idx = 0; idx < totalWorkers; idx++) {
      const w = workers[idx];

      batchPromises.push(new Promise(resolve => {
        const handler = (msg) => {
          if (msg.islandIdx !== idx) return;

          if (msg.type === 'gen_progress') {
            islandBest[idx] = {
              fitness: msg.bestFitness,
              gene: msg.bestGene,
              metrics: msg.metrics,
            };
            islandGen[idx] = msg.gen;
            workerEvals[idx] = msg.evalCount;
            workerCaches[idx] = msg.cacheSize;

            // Compute global best across all workers
            let globalBest = { fitness: -Infinity };
            for (const ib of islandBest) {
              if (ib && ib.fitness > globalBest.fitness) globalBest = ib;
            }

            completedGens = Math.max(...islandGen);

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

              // Per-planet best for progress display
              const planetStats = Array.from({ length: numPlanets }, (_, p) => {
                let best = { fitness: -Infinity };
                for (let i = p * numIslands; i < (p + 1) * numIslands; i++) {
                  if (islandBest[i] && islandBest[i].fitness > best.fitness) best = islandBest[i];
                }
                return {
                  idx: p,
                  profit: best.metrics?.netProfit ?? null,
                  trades: best.metrics?.trades ?? null,
                  pf: best.metrics?.pf ?? null,
                };
              });

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
                periodYears,
                numIslands,
                numPlanets,
                totalMigrations,
                totalSpaceTravels,
                topology: migrationTopology,
                islands: islandBest.map((ib, i) => ({
                  idx: i,
                  planetIdx: Math.floor(i / numIslands),
                  gen: islandGen[i],
                  profit: ib?.metrics?.netProfit ?? null,
                  trades: ib?.metrics?.trades ?? null,
                  pf: ib?.metrics?.pf ?? null,
                  evals: workerEvals[i],
                })),
                planets: numPlanets > 1 ? planetStats : undefined,
                edges: totalWorkers > 1 ? buildEdges() : [],
              };

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

    if (shouldCancel?.()) {
      if (!cancelSent) {
        for (const w of workers) w.postMessage({ type: 'cancel' });
        cancelSent = true;
      }
      break;
    }

    // Island migration (within each planet, not after last batch)
    if (totalWorkers > 1 && batch.endGen < generations) {
      const migrationsPerTarget = new Map();
      for (let i = 0; i < totalWorkers; i++) {
        const targets = getIslandTargets(i);
        const srcTop = batchDone[i].top;
        for (const target of targets) {
          if (!migrationsPerTarget.has(target)) migrationsPerTarget.set(target, []);
          migrationsPerTarget.get(target).push(...srcTop);
        }
      }

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

      // Space travel: cross-planet migration, every spaceTravelInterval island migrations
      if (numPlanets > 1 && totalMigrations % spaceTravelInterval === 0) {
        const travelPromises = [];

        for (let p = 0; p < numPlanets; p++) {
          // Find best individual(s) on this planet
          const planetWorkers = Array.from({ length: numIslands }, (_, i) => p * numIslands + i);
          const allTop = planetWorkers.flatMap(wi => batchDone[wi].top);
          allTop.sort((a, b) => b.score - a.score);
          const travelers = allTop.slice(0, spaceTravelCount);

          if (travelers.length === 0) continue;

          // Send to random island on a different planet
          const targets = getSpaceTravelTargets(p);
          for (const target of targets) {
            travelPromises.push(new Promise(resolve => {
              const handler = (msg) => {
                if (msg.type === 'migrate_done' && msg.islandIdx === target) {
                  workers[target].off('message', handler);
                  resolve();
                }
              };
              workers[target].on('message', handler);
            }));

            workers[target].postMessage({ type: 'migrate', migrants: travelers });
          }
        }

        await Promise.all(travelPromises);
        totalSpaceTravels++;
        console.log(`[runner] Space travel #${totalSpaceTravels} after migration #${totalMigrations}`);
      }
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
      numPlanets,
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
      numPlanets,
    });
  }

  // Terminate all workers
  await Promise.all(workers.map(w => w.terminate()));

  // 7. Merge results across all workers

  let finalBest = { fitness: -Infinity };
  for (const r of finalResults) {
    if (r.best.fitness > finalBest.fitness) finalBest = r.best;
  }

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
    totalSpaceTravels,
    totalTimeMs: Date.now() - startTime,
    candleBars: len,
    config: { populationSize, generations, mutationRate, numIslands, numPlanets, migrationInterval, migrationCount, migrationTopology, spaceTravelInterval, spaceTravelCount },
  };
}
