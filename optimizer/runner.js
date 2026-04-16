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

import os from 'os';
import { Worker } from 'worker_threads';
import { loadCandles } from '../db/candles.js';
import {
  PARAMS as LEGACY_PARAMS,
  geneKey as legacyGeneKey,
  geneShort as legacyGeneShort,
  randomParam as legacyRandomParam,
  frozenLabel as legacyFrozenLabel,
} from './params.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from './param-space.js';
import {
  computeDatasetId,
  loadCache,
  saveCache,
  mergeCaches,
} from './fitness-cache.js';
import { walkForward } from './walk-forward.js';
import { runSpec } from '../engine/runtime.js';

const MIN_TRADES = 10;
const WORKER_URL = new URL('./island-worker.js', import.meta.url);

// Reserve 2 logical threads for the OS, the main thread, and other apps
// (e.g. browser) so heavy optimizer runs don't freeze the machine.
const CORE_RESERVE = 2;

function getWorkerCap() {
  const logical = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, logical - CORE_RESERVE);
}

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
 * @param {Object}   [config.spec]    — when present, runs in **spec mode**:
 *                                       worker uses runSpec + computeFitness
 *                                       + dynamic param-space derived from
 *                                       this spec. Legacy `runStrategy` +
 *                                       static `params.js` path is bypassed.
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
    minTrades = 30,
    maxDrawdownPct = 0.5,
    autoHyperEnabled = true,
    // Gene knockout / ablation experiments:
    //   'none'    — every planet optimizes all genes (control run)
    //   'sweep'   — planet 0 is control; planet p ≥ 1 freezes a single gene
    //               drawn from PARAMS in order, so you can compare best
    //               fitness per planet and rank gene importance
    knockoutMode = 'none',
    // 'midpoint' — frozen value = midpoint of gene's min/max range
    // 'random'   — frozen value = random valid sample (drawn once at start)
    knockoutValueMode = 'midpoint',
    onProgress,
    shouldCancel,
    shouldHypermutate,  // consume-callback: returns true once to trigger
    spec: rawSpec,
  } = config;

  // ─── Spec-mode wiring ──────────────────────────────────────
  // When the caller passes a spec, we validate it once on the main thread
  // (cheap, deterministic — buildParamSpace is called again inside each
  // worker, which is fine because validateSpec produces the same hash).
  // The functions in paramSpace are NOT serializable across worker_threads,
  // so we ship the raw spec object and let the worker rebuild paramSpace.
  const specMode  = Boolean(rawSpec);
  const spec      = specMode ? validateSpec(rawSpec)   : null;
  const paramSpace = specMode ? buildParamSpace(spec) : null;
  if (specMode && spec.htfs && spec.htfs.length > 0) {
    throw new Error('runOptimization: spec.htfs not yet supported in runner integration (Phase 2.6 follow-up)');
  }

  // PARAMS-and-helpers shim. In spec mode they come from paramSpace; in
  // legacy mode from the static params.js. Everything below this line is
  // mode-agnostic.
  const PARAMS       = specMode ? paramSpace.PARAMS       : LEGACY_PARAMS;
  const randomParam  = specMode ? paramSpace.randomParam  : legacyRandomParam;
  const geneShort    = specMode
    ? (g) => Object.entries(g).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ')
    : legacyGeneShort;
  const frozenLabel  = specMode
    ? (fg) => Object.keys(fg).map(k => `${k}=${fg[k]}`).join(',')
    : legacyFrozenLabel;

  // Logical island count — preserved for GA quality (migration topology,
  // population diversity). Physical worker threads are capped separately
  // to avoid CPU oversubscription.
  const totalWorkers = numPlanets * numIslands;
  const workerCap = getWorkerCap();
  const workerCount = Math.min(totalWorkers, workerCap);

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

  // GA train/test split: fitnessStartBar marks where the OOS (scoring)
  // region begins.  Indicators compute on ALL bars; the bar loop runs
  // from tradingStartBar; but fitness metrics only accumulate for trades
  // whose exit bar >= fitnessStartBar.  Set gaOosRatio = 0 (or omit) to
  // disable the split and score on the full data.
  const gaOosRatio = specMode && spec?.fitness?.gaOosRatio > 0
    ? spec.fitness.gaOosRatio
    : 0;
  const tradingBars = len - tradingStartBar;
  const fitnessStartBar = gaOosRatio > 0
    ? tradingStartBar + Math.floor(tradingBars * (1 - gaOosRatio))
    : 0;

  if (len < 100) {
    throw new Error(`Insufficient data: ${len} bars for ${symbol} ${timeframe}min from ${startDate}`);
  }

  // Spec-mode persistent fitness cache: keyed by spec.hash + dataset
  // identity. Preload entries from disk so a re-run of the same spec on
  // the same data starts warm. Workers hydrate their in-memory caches
  // from this preload and report back at the end so we can persist the
  // merged result. `bars` and `lastTs` go into the dataset id so adding
  // candles to the DB invalidates the cache automatically.
  let datasetId = null;
  let cachePreload = null;
  let cachePath = null;
  if (specMode) {
    datasetId = computeDatasetId({
      symbol, timeframe, startDate, endDate: endDate || null,
      bars: len, lastTs: Number(candles.ts[len - 1]),
    });
    const loaded = await loadCache({ specHash: spec.hash, datasetId });
    cachePreload = loaded.entries;
    cachePath = loaded.path;
    console.log(`[runner] Fitness cache: ${loaded.count} entries preloaded from ${cachePath}`);
  }

  if (specMode) {
    console.log(`[runner] Spec mode: spec.hash=${spec.hash?.slice(0, 12)}, datasetId=${datasetId.slice(0, 12)}, ${PARAMS.length} genes from spec`);
    status('config', `Spec mode (computeFitness gates: ${JSON.stringify(spec.fitness?.gates ?? {})})`);
  } else {
    console.log(`[runner] Flat sizing fitness: minTrades=${minTrades}, maxDD=${maxDrawdownPct * 100}%`);
    status('config', `Flat sizing fitness: PF×√trades×(1-ddPenalty), min ${minTrades} trades, max DD ${maxDrawdownPct * 100}%`);
  }

  // 2. Create SharedArrayBuffer — zero-copy sharing with workers.
  //
  //    Legacy layout: [open|high|low|close|volume]            (5 cols × len Float64s)
  //    Spec layout:   [ts|open|high|low|close|volume]         (6 cols × len Float64s)
  //
  //    The extra `ts` column in spec mode is needed because runSpec uses
  //    bundle.base.ts for regime detection and period-year reporting; the
  //    legacy runStrategy never reads ts, so we don't pay for it there.
  const cols = specMode ? 6 : 5;
  const sab = new SharedArrayBuffer(len * cols * 8);
  if (specMode) {
    new Float64Array(sab, len * 0 * 8, len).set(candles.ts);
    new Float64Array(sab, len * 1 * 8, len).set(candles.open);
    new Float64Array(sab, len * 2 * 8, len).set(candles.high);
    new Float64Array(sab, len * 3 * 8, len).set(candles.low);
    new Float64Array(sab, len * 4 * 8, len).set(candles.close);
    new Float64Array(sab, len * 5 * 8, len).set(candles.volume);
  } else {
    new Float64Array(sab, len * 0 * 8, len).set(candles.open);
    new Float64Array(sab, len * 1 * 8, len).set(candles.high);
    new Float64Array(sab, len * 2 * 8, len).set(candles.low);
    new Float64Array(sab, len * 3 * 8, len).set(candles.close);
    new Float64Array(sab, len * 4 * 8, len).set(candles.volume);
  }

  const actualStartTs = candles.ts[tradingStartBar];
  const actualEndTs = candles.ts[len - 1];
  const periodYears = (actualEndTs - actualStartTs) / (365.25 * 24 * 60 * 60 * 1000);

  status('loaded', `${len.toLocaleString()} bars loaded (${periodYears.toFixed(1)}y). Preparing ${workerCount} workers for ${totalWorkers} islands (${numPlanets}p × ${numIslands}i)...`);
  console.log(`[runner] Loaded ${len} bars, tradingStartBar=${tradingStartBar}, planets=${numPlanets}, islands/planet=${numIslands}, islands=${totalWorkers}, workers=${workerCount} (cap=${workerCap}, reserve=${CORE_RESERVE})`);

  // 3. Per-planet random mutation factors — each planet picks its own
  //    mutation rate / per-gene probability within reasonable bounds for
  //    coarse-grained exploration diversity. All islands on the same planet
  //    share the planet's factors. With numPlanets = 1 we fall back to the
  //    deterministic per-island gradient to preserve island-level diversity.
  //
  // Bounds:
  //   mutationRate multiplier ∈ [0.5, 1.5]  — around user-supplied base
  //   perGeneMut              ∈ [0.10, 0.32] — similar range to old gradient
  const planetMutations = [];
  for (let p = 0; p < numPlanets; p++) {
    const mul = 0.5 + Math.random();                 // [0.5, 1.5)
    const perGeneMut = 0.10 + Math.random() * 0.22;  // [0.10, 0.32)
    planetMutations.push({
      planetIdx: p,
      mutationMul: mul,
      mutationRate: Math.min(mutationRate * mul, 0.9),
      perGeneMut,
    });
  }
  console.log(`[runner] Planet mutation factors: ` +
    planetMutations.map(pm => `p${pm.planetIdx}: ×${pm.mutationMul.toFixed(2)} (mut=${(pm.mutationRate * 100).toFixed(0)}%, gene=${(pm.perGeneMut * 100).toFixed(0)}%)`).join(', '));

  // 3b. Per-planet gene knockouts (ablation experiments).
  // Planet 0 is always the control (no knockouts). For each subsequent
  // planet we freeze one gene from PARAMS in a deterministic sweep order,
  // so with enough planets every gene is represented. All islands on a
  // planet share the same frozen set — within-planet migration is trivially
  // compatible. Cross-planet space travel uses graft repair (the recipient
  // worker overwrites the migrant's frozen-on-recipient slots with its own
  // frozen values) so mating on the recipient never sees conflicting genes.
  function pickFrozenValue(p) {
    if (knockoutValueMode === 'random') return randomParam(p);
    // 'midpoint': snap to the nearest step from the gene's midpoint
    const mid = (p.min + p.max) / 2;
    const steps = Math.round((mid - p.min) / p.step);
    const v = p.min + steps * p.step;
    return p.type === 'int' ? Math.round(v) : Math.round(v * 100) / 100;
  }

  const planetFrozen = [];
  if (knockoutMode === 'sweep' && numPlanets > 1) {
    for (let p = 0; p < numPlanets; p++) {
      if (p === 0) {
        planetFrozen.push({});           // control
      } else {
        const gene = PARAMS[(p - 1) % PARAMS.length];
        planetFrozen.push({ [gene.id]: pickFrozenValue(gene) });
      }
    }
  } else {
    for (let p = 0; p < numPlanets; p++) planetFrozen.push({});
  }
  if (knockoutMode !== 'none') {
    console.log(`[runner] Knockout sweep (${knockoutValueMode}): ` +
      planetFrozen.map((fg, p) => `p${p}: ${frozenLabel(fg) || 'control'}`).join(', '));
  }

  const islandConfigs = [];
  for (let idx = 0; idx < totalWorkers; idx++) {
    const planetIdx = Math.floor(idx / numIslands);

    let islandMutRate, perGeneMut;
    if (numPlanets > 1) {
      // Multi-planet: all islands on a planet share the planet's factors
      const pm = planetMutations[planetIdx];
      islandMutRate = pm.mutationRate;
      perGeneMut = pm.perGeneMut;
    } else {
      // Single planet: keep the deterministic island-level gradient
      const t = totalWorkers > 1 ? idx / (totalWorkers - 1) : 0.5;
      islandMutRate = totalWorkers > 1 ? mutationRate * (0.5 + t) : mutationRate;
      perGeneMut = 0.12 + t * 0.18;
    }

    islandConfigs.push({
      islandIdx: idx,
      mutationRate: Math.min(islandMutRate, 0.9),
      perGeneMut,
      frozenGenes: planetFrozen[planetIdx] || {},
    });
  }

  // 4. Distribute islands to workers round-robin. Each worker evolves its
  //    islands serially within a batch — islands on the same worker wait
  //    for their turn. Sync happens at migration boundaries (see batch loop).
  const islandsPerWorker = Array.from({ length: workerCount }, () => []);
  for (let idx = 0; idx < totalWorkers; idx++) {
    islandsPerWorker[idx % workerCount].push(islandConfigs[idx]);
  }

  const workers = [];
  const islandToWorker = new Array(totalWorkers); // global islandIdx -> Worker
  const readyPromises = [];

  for (let w = 0; w < workerCount; w++) {
    const myIslands = islandsPerWorker[w];
    const worker = new Worker(WORKER_URL, {
      workerData: {
        candleBuffer: sab,
        candleLength: len,
        candleCols: cols,
        tradingStartBar,
        fitnessStartBar,
        populationSize,
        islands: myIslands,
        minTrades,
        maxDrawdownPct,
        autoHyperEnabled,
        // Spec mode payload (null in legacy mode). The worker rebuilds
        // paramSpace itself — functions don't survive structured-clone.
        specMode,
        spec: specMode ? rawSpec : null,
        periodYears: specMode ? periodYears : null,
        // Persistent-cache preload (spec mode only). Plain object of
        // geneKey → { fitness, metrics }. Workers hydrate their in-mem
        // cache from this on startup. Each worker gets the SAME preload —
        // they may evaluate disjoint genes during the run, but on cache-hit
        // the answer is identical regardless of which worker serves it.
        fitnessCachePreload: specMode ? cachePreload : null,
      },
    });

    // Each hosted island attaches its own transient 'message' listener per
    // batch / migrate / get_results phase. With many islands per worker
    // (small core counts + many logical islands) we exceed Node's default
    // 10-listener soft cap. Disable the warning — listener count is
    // bounded by our own logic, not a runaway leak.
    worker.setMaxListeners(0);

    workers.push(worker);
    for (const cfg of myIslands) islandToWorker[cfg.islandIdx] = worker;

    readyPromises.push(new Promise((resolve, reject) => {
      const onMsg = (msg) => {
        if (msg.type === 'ready') {
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
  status('ready', `${workerCount} workers hosting ${totalWorkers} islands ready. Starting evolution (${generations} generations)...`);

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

  // Space travel: migrate best-of-planet to island(s) on other planets.
  // Topology applies at the planet level, mirroring getIslandTargets:
  //   - ring:   planet p → planet (p+1) % numPlanets
  //   - torus:  planet's 4 grid neighbours (with wrap)
  //   - random: one random peer planet
  // Within the destination planet, the recipient island is chosen at
  // random — island-level migration will then propagate the traveler
  // through that planet's topology.
  function getSpaceTravelTargets(fromPlanet) {
    if (numPlanets <= 1) return [];

    let targetPlanets;
    if (migrationTopology === 'torus') {
      const cols = Math.max(2, Math.round(Math.sqrt(numPlanets)));
      const rows = Math.ceil(numPlanets / cols);
      const r = Math.floor(fromPlanet / cols);
      const c = fromPlanet % cols;
      const neighbours = new Set();
      neighbours.add(r * cols + (c + 1) % cols);
      neighbours.add(r * cols + (c - 1 + cols) % cols);
      neighbours.add(((r + 1) % rows) * cols + c);
      neighbours.add(((r - 1 + rows) % rows) * cols + c);
      neighbours.delete(fromPlanet);
      targetPlanets = [...neighbours].filter(p => p < numPlanets);
    } else if (migrationTopology === 'random') {
      let toPlanet;
      do { toPlanet = Math.floor(Math.random() * numPlanets); } while (toPlanet === fromPlanet);
      targetPlanets = [toPlanet];
    } else {
      // Default: ring between planets
      targetPlanets = [(fromPlanet + 1) % numPlanets];
    }

    return targetPlanets.map(tp => {
      const toIsland = Math.floor(Math.random() * numIslands);
      return tp * numIslands + toIsland;
    });
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
  const islandHyperActive = new Array(totalWorkers).fill(0);
  const islandHyperSource = new Array(totalWorkers).fill(null);
  const islandHyperCount  = new Array(totalWorkers).fill(0);

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

    // Poll for manual hypermutate trigger — forward to all workers when fired
    let hyperPoller = null;
    if (shouldHypermutate) {
      hyperPoller = setInterval(() => {
        if (shouldHypermutate()) {
          const gen = Math.max(0, ...islandGen);
          for (const w of workers) w.postMessage({ type: 'hypermutate', gen });
          console.log(`[runner] Manual hypermutation triggered at gen ${gen}`);
        }
      }, 200);
    }

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
      const w = islandToWorker[idx];

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
            islandHyperActive[idx] = msg.hyperActive ?? 0;
            islandHyperSource[idx] = msg.hyperSource ?? null;
            islandHyperCount[idx]  = msg.hyperCount ?? 0;

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
                const pm = planetMutations[p];
                const pf = planetFrozen[p] || {};
                return {
                  idx: p,
                  profit: best.metrics?.netProfit ?? null,
                  trades: best.metrics?.trades ?? null,
                  pf: best.metrics?.pf ?? null,
                  score: best.metrics?._fitness?.score ?? null,
                  freqFactor: best.metrics?._fitness?.breakdown?.freqFactor ?? null,
                  mutationRate: pm?.mutationRate ?? null,
                  perGeneMut: pm?.perGeneMut ?? null,
                  mutationMul: pm?.mutationMul ?? null,
                  frozenGenes: Object.keys(pf).length ? pf : null,
                };
              });

              const progressMsg = {
                gen: maxGen,
                minGen: isFinite(minGen) ? minGen : 0,
                maxGen,
                totalGens: generations,
                best: globalBest.fitness,
                metrics: globalBest.metrics,
                gene: globalBest.gene ? { ...globalBest.gene } : null,
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
                  score: ib?.metrics?._fitness?.score ?? null,
                  evals: workerEvals[i],
                  hyperActive: islandHyperActive[i],
                  hyperSource: islandHyperSource[i],
                  hyperCount: islandHyperCount[i],
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
    }

    // One evolve per worker — worker iterates its owned islands serially
    for (const w of workers) {
      w.postMessage({
        type: 'evolve',
        startGen: batch.startGen,
        endGen: batch.endGen,
        migrationCount,
      });
    }

    await Promise.all(batchPromises);
    if (cancelPoller) clearInterval(cancelPoller);
    if (hyperPoller) clearInterval(hyperPoller);

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

        const tgtWorker = islandToWorker[target];
        migratePromises.push(new Promise(resolve => {
          const handler = (msg) => {
            if (msg.type === 'migrate_done' && msg.islandIdx === target) {
              tgtWorker.off('message', handler);
              resolve();
            }
          };
          tgtWorker.on('message', handler);
        }));

        tgtWorker.postMessage({ type: 'migrate', targetIslandIdx: target, migrants });
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
            const tgtWorker = islandToWorker[target];
            travelPromises.push(new Promise(resolve => {
              const handler = (msg) => {
                if (msg.type === 'migrate_done' && msg.islandIdx === target) {
                  tgtWorker.off('message', handler);
                  resolve();
                }
              };
              tgtWorker.on('message', handler);
            }));

            tgtWorker.postMessage({ type: 'migrate', targetIslandIdx: target, migrants: travelers });
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

  // One promise per ISLAND — each worker emits one `results` message per
  // owned island. Send one `get_results` per worker to trigger.
  const resultPromises = [];
  for (let idx = 0; idx < totalWorkers; idx++) {
    const w = islandToWorker[idx];
    resultPromises.push(new Promise(resolve => {
      const handler = (msg) => {
        if (msg.type === 'results' && msg.islandIdx === idx) {
          w.off('message', handler);
          resolve(msg);
        }
      };
      w.on('message', handler);
    }));
  }
  for (const w of workers) {
    w.postMessage({ type: 'get_results' });
  }

  const finalResults = await Promise.all(resultPromises);

  // Persist the merged fitness cache (spec mode only). We do this BEFORE
  // worker termination is awaited so a slow disk doesn't hold up release;
  // the writes are atomic (write-tmp + rename) so a crash mid-write can't
  // corrupt the file. Cancelled runs still persist what they computed —
  // partial results are useful for the next run.
  let cacheSaveInfo = null;
  if (specMode) {
    const snapshots = finalResults
      .map(r => r.cacheSnapshot)
      .filter(s => s && typeof s === 'object');
    const merged = mergeCaches(snapshots);
    try {
      cacheSaveInfo = await saveCache({
        specHash: spec.hash,
        datasetId,
        entries: merged,
      });
      console.log(`[runner] Fitness cache saved: ${cacheSaveInfo.count} entries → ${cacheSaveInfo.path}` +
        (cacheSaveInfo.dropped > 0 ? ` (${cacheSaveInfo.dropped} eliminated/over-cap dropped)` : ''));
    } catch (err) {
      // Cache persistence is best-effort. A failed save degrades the next
      // run's startup latency but doesn't invalidate this run's results.
      console.warn(`[runner] Fitness cache save failed: ${err.message}`);
    }
  }

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
  //
  // Build topResults from the CACHE (all evaluations ever), not just the
  // current GA population. The population can lose a good gene to
  // crossover/mutation, so the cache is the authoritative ranking.
  // finalBest is then picked from topResults[0] to guarantee consistency
  // between the stored winner and the ranking table.

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

  // Pick finalBest from topResults (cache-sourced) when available, falling
  // back to the population best for legacy mode or empty-cache edge cases.
  let finalBest = { fitness: -Infinity };
  if (topResults.length > 0) {
    finalBest = topResults[0];
  } else {
    for (const r of finalResults) {
      if (r.best.fitness > finalBest.fitness) finalBest = r.best;
    }
  }

  const totalEvaluations = finalResults.reduce((sum, r) => sum + r.evalCount, 0);
  const totalCacheSize = finalResults.reduce((sum, r) => sum + r.cacheSize, 0);

  // When a GA OOS split was active (fitnessStartBar > 0), the cached
  // metrics reflect only the OOS portion. Re-evaluate ALL top results on
  // the FULL data so the stored bestMetrics AND the ranking table show the
  // complete backtest. GA fitness scores (used for ranking) are kept from
  // the OOS run — only the display metrics change.
  if (specMode && fitnessStartBar > 0) {
    const fullBundle = { base: candles, tradingStartBar, periodYears: periodYears ?? 0 };
    for (const entry of topResults) {
      if (!entry.gene) continue;
      try {
        const fullMetrics = runSpec({ spec, paramSpace, bundle: fullBundle, gene: entry.gene });
        // Preserve the OOS fitness breakdown for display/diagnostics.
        fullMetrics._fitness = entry.metrics?._fitness ?? null;
        entry.metrics = fullMetrics;
      } catch (err) {
        console.warn(`[runner] Full-data re-eval failed for a top gene, keeping OOS metrics: ${err.message}`);
      }
    }
    // finalBest points into topResults[0], so it's already updated.
  }

  // ─── Phase 4.1b: post-GA walk-forward on the winner ─────────
  // Quantify how the shipped gene generalizes across time by freezing
  // the full-data winner and re-evaluating it on nWindows IS/OOS slices
  // (see optimizer/walk-forward.js for the design rationale). The
  // `optimize` callback returns the winner for every window — the WF
  // harness then runs `runSpec` on each IS + OOS slice to produce the
  // per-window PFs and aggregate WFE.
  //
  // Spec mode only: legacy mode doesn't have a validated spec/paramSpace
  // to hand to walkForward, and the UI surfaces for the WF report are
  // going to be spec-native anyway (Phase 4.5 results view).
  //
  // Best-effort: a failed WF step (e.g. insufficient bars for nWindows)
  // must not fail the whole run. We log a warning and return wfReport=null.
  //
  // Cancelled runs skip WF: the user asked us to stop, finishing with a
  // ~5×single-backtest coda would be hostile.
  let wfReport = null;
  if (specMode && !cancelSent && finalBest.gene) {
    try {
      const wfStart = Date.now();
      const bundle = {
        symbol,
        baseTfMin: timeframe,
        baseTfMs:  timeframe * 60_000,
        base:      candles,
        htfs:      {},
        tradingStartBar,
        periodYears,
        n:         len,
        warmup:    tradingStartBar,
      };
      wfReport = await walkForward({
        spec,
        paramSpace,
        bundle,
        optimize: () => finalBest.gene,
        scheme:   spec.walkForward?.scheme   ?? 'anchored',
        nWindows: spec.walkForward?.nWindows ?? 5,
      });
      console.log(
        `[runner] Walk-forward: ${wfReport.validWindows}/${wfReport.nWindows} valid windows, ` +
        `meanIsPf=${wfReport.meanIsPf.toFixed(3)}, meanOosPf=${wfReport.meanOosPf.toFixed(3)}, ` +
        `WFE=${Number.isFinite(wfReport.wfe) ? wfReport.wfe.toFixed(3) : 'NaN'} ` +
        `(${((Date.now() - wfStart) / 1000).toFixed(1)}s)`
      );
    } catch (err) {
      console.warn(`[runner] Walk-forward skipped: ${err.message}`);
      wfReport = null;
    }
  }

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
    config: { populationSize, generations, mutationRate, numIslands, numPlanets, migrationInterval, migrationCount, migrationTopology, spaceTravelInterval, spaceTravelCount, knockoutMode, knockoutValueMode },
    planetFrozen,
    // Spec-mode persistent-cache info (null in legacy mode):
    //   { datasetId, preloadCount, savedCount, droppedCount, path }
    fitnessCache: specMode ? {
      datasetId,
      preloadCount: cachePreload ? Object.keys(cachePreload).length : 0,
      savedCount:   cacheSaveInfo?.count   ?? 0,
      droppedCount: cacheSaveInfo?.dropped ?? 0,
      path:         cacheSaveInfo?.path ?? cachePath,
    } : null,
    // Spec-mode walk-forward report on the winning gene (null in legacy
    // mode, null if the WF step failed, null for cancelled runs).
    // Shape: WalkForwardReport — see optimizer/walk-forward.js.
    wfReport,
  };
}
