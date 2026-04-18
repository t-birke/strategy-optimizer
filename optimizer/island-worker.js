/**
 * Island worker — hosts one or more GaIslands in a single thread.
 * Receives candle data as SharedArrayBuffer (zero-copy).
 *
 * To prevent CPU oversubscription when the user configures more logical
 * islands than physical cores permit, each worker may own several islands
 * and evolve them *serially* within a batch. All islands converge at
 * migration boundaries, where the main thread synchronizes them before
 * starting the next batch.
 *
 * Two fitness paths:
 *
 *  - **Legacy mode** (default, unchanged): single full-period evaluation
 *    with flat position sizing using the hand-coded `runStrategy`.
 *    Score = `profitScore * (1 - ddPenalty)` after a soft trade-count
 *    penalty. Used by the existing UI runner contract.
 *
 *  - **Spec mode** (when `workerData.spec` is supplied): runs `runSpec`
 *    on the spec + a freshly-built paramSpace, then `computeFitness`
 *    on the resulting metrics + the spec's `fitness` config. Score is
 *    `fit.score * 1000` (or `-1000` when eliminated by a hard gate),
 *    keeping it in roughly the same magnitude as the legacy fitness so
 *    elite-preservation heuristics behave the same.
 */

import { parentPort, workerData } from 'worker_threads';
import { GaIsland, best } from 'ga-island';
import { runStrategy } from '../engine/strategy.js';
import { runSpec } from '../engine/runtime.js';
import { computeFitness } from './fitness.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from './param-space.js';
import { unpackHtfPayloads } from './htf-transport.js';
import * as registry from '../engine/blocks/registry.js';
import * as legacyParams from './params.js';

const {
  candleBuffer, candleLength, candleCols, tradingStartBar,
  fitnessStartBar = 0,
  populationSize,
  islands: islandConfigs,   // [{ islandIdx, mutationRate, perGeneMut }, ...]
  minTrades,
  maxDrawdownPct,
  autoHyperEnabled = true,
  // Spec-mode payload. When `specMode` is true the worker rebuilds the
  // paramSpace from `spec` and uses runSpec + computeFitness. Otherwise
  // it falls through to the legacy runStrategy path verbatim.
  specMode = false,
  spec: rawSpec = null,
  periodYears = null,
  baseTfMin = null,
  // Phase 2.6 — HTF payloads from the runner. Each entry is
  // { tfMin, tfMs, htfLen, candleBuffer, htfBarIndexBuffer } where
  // candleBuffer is a 6-col Float64 SAB [ts|open|high|low|close|volume]
  // and htfBarIndexBuffer is a Uint32 SAB of length candleLength (base).
  htfPayloads = [],
  // Persistent fitness-cache preload (spec mode only). Plain object of
  // geneKey → { fitness, metrics }. Each island hydrates its own Map
  // from this on startup so a re-run of the same spec on the same data
  // starts warm.
  fitnessCachePreload = null,
} = workerData;

const MIN_TRADES = minTrades ?? 30;
const MAX_DD_PCT = maxDrawdownPct ?? 0.5;

// ─── Mode-dependent param-space + ops ──────────────────────
// Both branches expose the same shape so the rest of the file (mutation,
// crossover, hypermutation, frozen-gene handling) is mode-agnostic.
let spec = null;
let paramSpace = null;
let PARAMS, randomIndividual, crossover, enforceConstraints, clamp, geneKey, applyFrozen;

if (specMode) {
  if (!rawSpec) throw new Error('island-worker: specMode=true requires workerData.spec');
  // Each Worker has a fresh module graph, so the block registry is empty
  // even if the runner already populated its own copy on the main thread.
  // Load it here BEFORE validateSpec — otherwise every block reference
  // in the spec fails the "block not registered" check.
  await registry.ensureLoaded();
  spec       = validateSpec(rawSpec);
  paramSpace = buildParamSpace(spec);
  ({ PARAMS, randomIndividual, crossover, enforceConstraints, clamp, geneKey, applyFrozen } = paramSpace);
} else {
  ({ PARAMS, randomIndividual, crossover, enforceConstraints, clamp, geneKey, applyFrozen } = legacyParams);
}

// ─── Hypermutation tuning ──────────────────────────────────
// A "catastrophe" mechanism that fights premature convergence:
//   - Replace bottom X% with fresh random individuals (preserve top elites)
//   - Boost mutation rate + per-gene probability for N generations
//   - Revert to planet's normal factors after N gens
// Auto-triggered when population gene diversity collapses, or manually
// via a 'hypermutate' message from the main thread.
const HYPER_DURATION        = 5;     // generations with boosted mutation
const HYPER_COOLDOWN        = 15;    // min gens between events per island
const HYPER_MUT_MUL         = 2.5;   // multiplier on island's base mutationRate
const HYPER_GENE_MUT        = 0.45;  // boosted per-gene mutation probability
const HYPER_ELITE_COUNT     = 3;     // top individuals preserved
const HYPER_IMMIGRANT_PCT   = 0.25;  // bottom % replaced with random
const DIVERSITY_THRESHOLD   = 0.04;  // below this (normalized stdev) → auto-trigger

// Reconstruct candle Float64Array views from SharedArrayBuffer (zero-copy).
//
// Layout depends on mode:
//   legacy (5 cols): [open|high|low|close|volume]
//   spec   (6 cols): [ts|open|high|low|close|volume]
//
// The spec-mode runtime needs `ts` for regime detection / period reporting;
// the legacy runtime never reads ts so we don't pay for it there.
const cols = candleCols ?? (specMode ? 6 : 5);
const colOff = (i) => candleLength * i * 8;
const candles = specMode
  ? {
      ts:     new Float64Array(candleBuffer, colOff(0), candleLength),
      open:   new Float64Array(candleBuffer, colOff(1), candleLength),
      high:   new Float64Array(candleBuffer, colOff(2), candleLength),
      low:    new Float64Array(candleBuffer, colOff(3), candleLength),
      close:  new Float64Array(candleBuffer, colOff(4), candleLength),
      volume: new Float64Array(candleBuffer, colOff(5), candleLength),
    }
  : {
      open:   new Float64Array(candleBuffer, colOff(0), candleLength),
      high:   new Float64Array(candleBuffer, colOff(1), candleLength),
      low:    new Float64Array(candleBuffer, colOff(2), candleLength),
      close:  new Float64Array(candleBuffer, colOff(3), candleLength),
      volume: new Float64Array(candleBuffer, colOff(4), candleLength),
    };

// Phase 2.6 — Reassemble HTF candles + htfBarIndex from SAB payloads into
// the `bundle.htfs[tfMin]` shape `engine/data-bundle.js` produces. Views
// are zero-copy over the SABs; the runtime reads from them directly.
const specHtfs = specMode ? unpackHtfPayloads(htfPayloads) : {};

// Spec-mode bundle is built once and shared across every fitness call.
// runSpec only reads from `bundle.base` / `bundle.htfs` arrays (no
// mutation), so reuse is safe. tradingStartBar tells the engine which
// bar marks "actual trading start" — earlier bars are warmup-only.
const specBundle = specMode
  ? {
      base: candles,
      htfs: specHtfs,
      tradingStartBar,
      periodYears: periodYears ?? 0,
      baseTfMin:   baseTfMin ?? undefined,
      baseTfMs:    baseTfMin != null ? baseTfMin * 60_000 : undefined,
    }
  : null;

// GA train/test split: fitnessStartBar is passed via opts to runSpec.
// When > 0, fitness metrics accumulate only for trades exiting after this bar.
const specRunOpts = fitnessStartBar > 0 ? { fitnessStartBar } : {};

/**
 * Build an isolated island runtime: its own GaIsland, fitness cache,
 * eval counter, and mutation operator.
 */
function createIsland(cfg) {
  const fitnessCache = new Map();
  // Hydrate from the persistent cache preload (spec mode only). The
  // preload is an Object<geneKey, {fitness, metrics}>; we copy it into
  // the per-island Map so cache hits work the same as freshly-evaluated
  // entries. Identical entries land in every island on this worker —
  // that's intentional: islands are independent populations and may
  // evaluate disjoint genes, but on cache-hit the answer is identical.
  if (specMode && fitnessCachePreload && typeof fitnessCachePreload === 'object') {
    for (const [k, v] of Object.entries(fitnessCachePreload)) {
      if (v && typeof v === 'object' && typeof v.fitness === 'number') {
        fitnessCache.set(k, v);
      }
    }
  }
  // Gene-knockout mask for this island. All islands on the same planet
  // share one mask (set in runner.js). Frozen genes are held constant
  // for every individual here — random init, mutation, crossover, and
  // hypermutation all re-apply the mask as their final step.
  const frozenGenes = cfg.frozenGenes || {};
  const frozenKeys = Object.keys(frozenGenes);
  const isFrozen = new Set(frozenKeys);
  const hasFrozen = frozenKeys.length > 0;

  const state = {
    evalCount: 0,
    // Hypermutation state
    hyperActive: 0,            // gens remaining with boosted mutation (0 = normal)
    hyperSource: null,         // 'manual' | 'auto' | null
    lastHyperEndGen: -Infinity,// last gen a hyper event ended (for cooldown)
    hyperCount: 0,             // total hyper events on this island
    // Currently effective rates — mutate() reads currentPerGeneMut each call;
    // ga.options.mutationRate is swapped directly on trigger/revert.
    currentPerGeneMut: cfg.perGeneMut,
  };

  function fitness(gene) {
    const key = geneKey(gene);
    if (fitnessCache.has(key)) return fitnessCache.get(key).fitness;

    state.evalCount++;

    // ── Spec mode: runSpec + computeFitness ──
    if (specMode) {
      let m;
      try {
        m = runSpec({ spec, paramSpace, bundle: specBundle, gene, opts: specRunOpts });
      } catch (err) {
        // A spec-eval crash (bad gene values that slip past constraints,
        // missing block prepare, etc.) is treated as the worst possible
        // outcome rather than killing the worker.
        const score = -10000;
        fitnessCache.set(key, { fitness: score, metrics: { error: err.message } });
        return score;
      }
      if (!m || m.error) {
        fitnessCache.set(key, { fitness: -10000, metrics: m || {} });
        return -10000;
      }
      const fit = computeFitness({ metrics: m, fitnessConfig: spec.fitness });
      // Map computeFitness's [0, 1] to [0, 1000] so it lives in roughly
      // the same magnitude as the legacy fitness, keeping ga-island's
      // elite-preservation heuristics behaving the same. Eliminated genes
      // get a strongly-negative sentinel so they sort below every legitimate
      // gene without colliding with the legacy soft-penalty band ([-5000,
      // -1000]).
      const score = fit.eliminated ? -10000 : fit.score * 1000;
      // Stamp fitness diagnostics onto the metrics for the runner's later
      // top-results assembly (so UIs can show "eliminated by which gate").
      m._fitness = {
        score:        fit.score,
        eliminated:   fit.eliminated,
        gatesFailed:  fit.gatesFailed,
        breakdown:    fit.breakdown,
        ...(fit.reason ? { reason: fit.reason } : {}),
      };
      fitnessCache.set(key, { fitness: score, metrics: m });
      return score;
    }

    // ── Legacy mode (unchanged) ──
    const m = runStrategy(candles, gene, { tradingStartBar, flatSizing: true });

    if (!m || m.error) {
      fitnessCache.set(key, { fitness: -10000, metrics: m || {} });
      return -10000;
    }

    if (m.trades < 3) {
      const score = -5000;
      fitnessCache.set(key, { fitness: score, metrics: m });
      return score;
    }
    if (m.trades < MIN_TRADES) {
      const score = -1000 + m.trades * 10;
      fitnessCache.set(key, { fitness: score, metrics: m });
      return score;
    }

    const profitScore = m.netProfitPct * 100;
    const ddRatio = m.maxDDPct > 0 ? Math.min(m.maxDDPct / MAX_DD_PCT, 1) : 0;
    const ddPenalty = 0.3 * ddRatio * ddRatio;
    const score = profitScore * (1 - ddPenalty);

    fitnessCache.set(key, { fitness: score, metrics: m });
    return score;
  }

  const mutate = (input, output) => {
    // Read perGeneMut from state so hypermutation boost takes effect
    // without reconstructing the GaIsland.
    const perGene = state.currentPerGeneMut;
    for (const p of PARAMS) {
      if (hasFrozen && isFrozen.has(p.id)) {
        // Knockout-frozen gene — copy through without mutation.
        // (applyFrozen below re-asserts the canonical value if anything
        // drifted via enforceConstraints.)
        output[p.id] = input[p.id];
      } else if (Math.random() < perGene) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const magnitude = 1 + Math.floor(Math.random() * 3);
        output[p.id] = clamp(input[p.id] + dir * magnitude * p.step, p);
      } else {
        output[p.id] = input[p.id];
      }
    }
    enforceConstraints(output);
    if (hasFrozen) applyFrozen(output, frozenGenes);
  };

  // Knockout-aware wrappers around the plain params operators. Frozen genes
  // are re-asserted AFTER enforceConstraints has run, so constraint repair
  // only shifts non-frozen genes. With planet-level single-gene knockouts
  // this cannot create infeasible pairs (a single gene alone doesn't
  // violate 2-gene constraints like emaFast < emaSlow).
  const frozenRandomIndividual = hasFrozen
    ? () => {
        const g = randomIndividual();
        applyFrozen(g, frozenGenes);
        enforceConstraints(g);
        applyFrozen(g, frozenGenes);  // win over constraint-repair rewrites
        return g;
      }
    : randomIndividual;

  const frozenCrossover = hasFrozen
    ? (a, b, child) => {
        crossover(a, b, child);           // already calls enforceConstraints
        applyFrozen(child, frozenGenes);
      }
    : crossover;

  const ga = new GaIsland({
    populationSize,
    mutationRate: cfg.mutationRate,
    randomIndividual: frozenRandomIndividual,
    mutate,
    crossover: frozenCrossover,
    fitness,
  });

  return { cfg, ga, fitnessCache, state, fitness, frozenGenes };
}

// Build one island runtime per configured island
const islands = new Map();  // islandIdx -> island runtime
for (const cfg of islandConfigs) {
  islands.set(cfg.islandIdx, createIsland(cfg));
}

// ─── Diversity metric ──────────────────────────────────────
// Average per-gene normalized standard deviation across the population.
// 0 = fully converged (all individuals identical), ~0.3+ = high diversity.
// Used to decide when to auto-trigger hypermutation.
function computeDiversity(population) {
  if (!population.length) return 0;
  let sum = 0;
  let counted = 0;
  for (const p of PARAMS) {
    const range = p.max - p.min;
    if (range <= 0) continue;
    let mean = 0;
    for (const ind of population) mean += ind[p.id];
    mean /= population.length;
    let variance = 0;
    for (const ind of population) {
      const d = ind[p.id] - mean;
      variance += d * d;
    }
    variance /= population.length;
    sum += Math.sqrt(variance) / range;
    counted++;
  }
  return counted > 0 ? sum / counted : 0;
}

// ─── Hypermutation trigger / decay ─────────────────────────
function triggerHypermutation(island, gen, source) {
  const { ga, state, cfg, fitness, frozenGenes } = island;
  const pop = ga.options.population;
  const popSize = pop.length;
  const hasFrozen = frozenGenes && Object.keys(frozenGenes).length > 0;

  // Sort by fitness worst→best so we replace the worst individuals.
  // (Elites — top HYPER_ELITE_COUNT — are naturally preserved by this.)
  const scored = pop.map((gene, idx) => ({ idx, score: fitness(gene) }));
  scored.sort((a, b) => a.score - b.score);

  const replaceCount = Math.min(
    Math.floor(popSize * HYPER_IMMIGRANT_PCT),
    Math.max(0, popSize - HYPER_ELITE_COUNT)
  );
  for (let i = 0; i < replaceCount; i++) {
    const replaceIdx = scored[i].idx;
    const fresh = randomIndividual();
    if (hasFrozen) applyFrozen(fresh, frozenGenes);
    for (const p of PARAMS) pop[replaceIdx][p.id] = fresh[p.id];
  }

  // Boost mutation for HYPER_DURATION gens
  state.hyperActive = HYPER_DURATION;
  state.hyperSource = source;
  state.hyperCount++;
  state.currentPerGeneMut = HYPER_GENE_MUT;
  ga.options.mutationRate = Math.min(cfg.mutationRate * HYPER_MUT_MUL, 0.95);
}

function decayHypermutation(island, gen) {
  const { ga, state, cfg } = island;
  if (state.hyperActive > 0) {
    state.hyperActive--;
    if (state.hyperActive === 0) {
      // Revert to planet's normal factors
      state.currentPerGeneMut = cfg.perGeneMut;
      ga.options.mutationRate = cfg.mutationRate;
      state.lastHyperEndGen = gen;
      state.hyperSource = null;
    }
  }
}

let cancelled = false;

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'evolve': {
      const { startGen, endGen, migrationCount } = msg;

      // Evolve each owned island serially for the full batch window.
      // Islands on the same worker do not interleave — one completes its
      // batch before the next begins. This yields better fitness-cache
      // locality and avoids scheduler overhead.
      //
      // IMPORTANT: we do NOT break out of the outer loop on cancel. The main
      // thread awaits exactly one `batch_done` per island per evolve message
      // (Promise.all in runner.js); if we skip any island's batch_done the
      // abort flow hangs forever. The inner generation loop breaks on cancel,
      // so we fall straight through and still emit batch_done for the
      // island's current population.
      for (const [islandIdx, island] of islands) {
        for (let gen = startGen; gen <= endGen; gen++) {
          if (cancelled) break;

          // Auto-trigger check: only if no hyper active, out of cooldown,
          // and diversity has collapsed below threshold.
          if (autoHyperEnabled
              && island.state.hyperActive === 0
              && gen - island.state.lastHyperEndGen > HYPER_COOLDOWN) {
            const div = computeDiversity(island.ga.options.population);
            if (div < DIVERSITY_THRESHOLD) {
              triggerHypermutation(island, gen, 'auto');
            }
          }

          island.ga.evolve();

          // Decay AFTER evolve so the boosted rates apply to this gen
          decayHypermutation(island, gen);

          const b = best(island.ga.options);
          const entry = island.fitnessCache.get(geneKey(b.gene));

          parentPort.postMessage({
            type: 'gen_progress',
            islandIdx,
            gen,
            bestFitness: b.fitness,
            bestGene: { ...b.gene },
            metrics: entry?.metrics || {},
            evalCount: island.state.evalCount,
            cacheSize: island.fitnessCache.size,
            hyperActive: island.state.hyperActive,
            hyperSource: island.state.hyperSource,
            hyperCount: island.state.hyperCount,
          });

          // Yield every generation so incoming messages (cancel/hypermutate)
          // can process between generations.
          await new Promise(r => setImmediate(r));
        }

        // Emit this island's batch_done as soon as it finishes, so the main
        // thread can start staging migrants while we run later islands.
        const pop = island.ga.options.population;
        const scored = pop.map((gene, idx) => ({ gene: { ...gene }, idx, score: island.fitness(gene) }));
        scored.sort((a, b) => b.score - a.score);

        parentPort.postMessage({
          type: 'batch_done',
          islandIdx,
          top: scored.slice(0, migrationCount || 3).map(s => ({ gene: s.gene, score: s.score })),
          evalCount: island.state.evalCount,
          cacheSize: island.fitnessCache.size,
        });
      }
      break;
    }

    case 'migrate': {
      const { targetIslandIdx, migrants } = msg;
      const island = islands.get(targetIslandIdx);
      if (!island) {
        // Shouldn't happen — main thread routes by islandToWorker map.
        parentPort.postMessage({ type: 'migrate_done', islandIdx: targetIslandIdx });
        break;
      }

      const pop = island.ga.options.population;
      const scored = pop.map((gene, idx) => ({ idx, score: island.fitness(gene) }));
      scored.sort((a, b) => a.score - b.score); // worst first

      // Graft repair for cross-knockout migration: if the migrant came from
      // a planet with a different knockout mask, its values for OUR frozen
      // genes are alien. Overwrite those slots with our frozen values so
      // mating (crossover) on this island stays compatible. Genes the
      // migrant actively optimized that we also optimize flow through
      // untouched — that's the whole point of the migration.
      const frozenGenes = island.frozenGenes;
      const hasFrozen = frozenGenes && Object.keys(frozenGenes).length > 0;

      // Elitist guard: only replace if migrant is strictly better.
      // Note: the migrant's .score was computed on the sender's island
      // (possibly with different frozen genes), so this comparison is a
      // heuristic, not a strict ordering. Still good enough to avoid
      // replacing strong recipients with dud aliens.
      for (let m = 0; m < migrants.length && m < scored.length; m++) {
        if (migrants[m].score <= scored[m].score) continue;
        const replaceIdx = scored[m].idx;
        for (const p of PARAMS) {
          pop[replaceIdx][p.id] = migrants[m].gene[p.id];
        }
        if (hasFrozen) applyFrozen(pop[replaceIdx], frozenGenes);
      }

      parentPort.postMessage({ type: 'migrate_done', islandIdx: targetIslandIdx });
      break;
    }

    case 'get_results': {
      // One `results` message per owned island (without cache snapshot —
      // the per-worker delta is sent separately below to avoid OOM).
      for (const [islandIdx, island] of islands) {
        const b = best(island.ga.options);
        const entry = island.fitnessCache.get(geneKey(b.gene));

        const topFromCache = [...island.fitnessCache.entries()]
          .map(([key, val]) => ({ key, ...val }))
          .filter(r => r.metrics && r.metrics.trades >= MIN_TRADES)
          .sort((a, b) => b.fitness - a.fitness)
          .slice(0, 20);

        parentPort.postMessage({
          type: 'results',
          islandIdx,
          best: { gene: { ...b.gene }, fitness: b.fitness, metrics: entry?.metrics || {} },
          topResults: topFromCache,
          evalCount: island.state.evalCount,
          cacheSize: island.fitnessCache.size,
        });
      }

      // Spec mode: merge all islands' NEW entries (not in the preload)
      // into ONE delta snapshot per worker. The old approach sent a full
      // cache snapshot per island — with a 50K-entry preload and 96
      // islands that's ~3.8 GB of structured-clone data hitting the main
      // thread's heap simultaneously, causing an OOM crash. Sending only
      // the delta keeps the message size proportional to actual new work.
      if (specMode) {
        const delta = {};
        for (const [, island] of islands) {
          for (const [k, v] of island.fitnessCache.entries()) {
            if (!fitnessCachePreload || !(k in fitnessCachePreload)) {
              delta[k] = v;
            }
          }
        }
        parentPort.postMessage({ type: 'cache_delta', delta });
      }
      break;
    }

    case 'hypermutate': {
      // Manual trigger — fire on all owned islands that aren't already
      // in a hyper event. Ignore cooldown for manual triggers.
      const { gen } = msg;
      for (const island of islands.values()) {
        if (island.state.hyperActive === 0) {
          triggerHypermutation(island, gen ?? 0, 'manual');
        }
      }
      parentPort.postMessage({ type: 'hypermutate_ack', count: islands.size });
      break;
    }

    case 'cancel': {
      cancelled = true;
      break;
    }
  }
});

parentPort.postMessage({ type: 'ready' });
