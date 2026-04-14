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
 * Fitness: single full-period evaluation with flat position sizing.
 * Flat sizing makes every trade independent of prior P&L, so metrics
 * like win rate, profit factor, and drawdown are inherently consistent
 * across any time slice — no window evaluation needed.
 *
 * Formula: profitFactor * sqrt(trades) * (1 - ddPenalty)
 */

import { parentPort, workerData } from 'worker_threads';
import { GaIsland, best } from 'ga-island';
import { runStrategy } from '../engine/strategy.js';
import {
  PARAMS, randomIndividual, crossover,
  enforceConstraints, clamp, geneKey, applyFrozen,
} from './params.js';

const {
  candleBuffer, candleLength, tradingStartBar,
  populationSize,
  islands: islandConfigs,   // [{ islandIdx, mutationRate, perGeneMut }, ...]
  minTrades,
  maxDrawdownPct,
  autoHyperEnabled = true,
} = workerData;

const MIN_TRADES = minTrades ?? 30;
const MAX_DD_PCT = maxDrawdownPct ?? 0.5;

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

// Reconstruct candle Float64Array views from SharedArrayBuffer (zero-copy)
const candles = {
  open:   new Float64Array(candleBuffer, 0, candleLength),
  high:   new Float64Array(candleBuffer, candleLength * 8, candleLength),
  low:    new Float64Array(candleBuffer, candleLength * 2 * 8, candleLength),
  close:  new Float64Array(candleBuffer, candleLength * 3 * 8, candleLength),
  volume: new Float64Array(candleBuffer, candleLength * 4 * 8, candleLength),
};

/**
 * Build an isolated island runtime: its own GaIsland, fitness cache,
 * eval counter, and mutation operator.
 */
function createIsland(cfg) {
  const fitnessCache = new Map();
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
      // One `results` message per owned island
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
