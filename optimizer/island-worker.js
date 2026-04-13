/**
 * Island worker — runs a single GaIsland in its own thread.
 * Receives candle data as SharedArrayBuffer (zero-copy).
 * Communicates with main thread via message passing for
 * evolution batches, migration, and result collection.
 */

import { parentPort, workerData } from 'worker_threads';
import { GaIsland, best } from 'ga-island';
import { runStrategy } from '../engine/strategy.js';
import {
  PARAMS, randomIndividual, crossover,
  enforceConstraints, clamp, geneKey,
} from './params.js';

const {
  candleBuffer, candleLength, tradingStartBar,
  populationSize, mutationRate, perGeneMut,
  islandIdx,
} = workerData;

const MIN_TRADES = 10;

// Reconstruct candle Float64Array views from SharedArrayBuffer (zero-copy)
const candles = {
  open:   new Float64Array(candleBuffer, 0, candleLength),
  high:   new Float64Array(candleBuffer, candleLength * 8, candleLength),
  low:    new Float64Array(candleBuffer, candleLength * 2 * 8, candleLength),
  close:  new Float64Array(candleBuffer, candleLength * 3 * 8, candleLength),
  volume: new Float64Array(candleBuffer, candleLength * 4 * 8, candleLength),
};

// Local fitness cache
const fitnessCache = new Map();
let evalCount = 0;

function fitness(gene) {
  const key = geneKey(gene);
  if (fitnessCache.has(key)) return fitnessCache.get(key).fitness;

  evalCount++;
  const metrics = runStrategy(candles, gene, { tradingStartBar });
  let score;

  if (!metrics || metrics.error) score = -10000;
  else if (metrics.trades < 3) score = -5000;
  else if (metrics.trades < MIN_TRADES) score = -1000 + metrics.trades * 10;
  else score = metrics.netProfit;

  fitnessCache.set(key, { fitness: score, metrics });
  return score;
}

// Island-specific mutation with varied per-gene probability
const islandMutate = (input, output) => {
  for (const p of PARAMS) {
    if (Math.random() < perGeneMut) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      const magnitude = 1 + Math.floor(Math.random() * 3);
      output[p.id] = clamp(input[p.id] + dir * magnitude * p.step, p);
    } else {
      output[p.id] = input[p.id];
    }
  }
  enforceConstraints(output);
};

const ga = new GaIsland({
  populationSize,
  mutationRate,
  randomIndividual,
  mutate: islandMutate,
  crossover,
  fitness,
});

let cancelled = false;

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'evolve': {
      const { startGen, endGen, migrationCount } = msg;

      for (let gen = startGen; gen <= endGen; gen++) {
        if (cancelled) break;

        ga.evolve();

        const b = best(ga.options);
        const entry = fitnessCache.get(geneKey(b.gene));

        parentPort.postMessage({
          type: 'gen_progress',
          islandIdx,
          gen,
          bestFitness: b.fitness,
          bestGene: { ...b.gene },
          metrics: entry?.metrics || {},
          evalCount,
          cacheSize: fitnessCache.size,
        });

        // Yield every generation to process incoming messages (cancel)
        await new Promise(r => setImmediate(r));
      }

      // Return top individuals for migration
      const pop = ga.options.population;
      const scored = pop.map((gene, idx) => ({ gene: { ...gene }, idx, score: fitness(gene) }));
      scored.sort((a, b) => b.score - a.score);

      parentPort.postMessage({
        type: 'batch_done',
        islandIdx,
        top: scored.slice(0, migrationCount || 3).map(s => ({ gene: s.gene, score: s.score })),
        evalCount,
        cacheSize: fitnessCache.size,
      });
      break;
    }

    case 'migrate': {
      const { migrants } = msg;
      const pop = ga.options.population;

      // Find worst individuals
      const scored = pop.map((gene, idx) => ({ idx, score: fitness(gene) }));
      scored.sort((a, b) => a.score - b.score); // worst first

      // Elitist guard: only replace if migrant is strictly better
      for (let m = 0; m < migrants.length && m < scored.length; m++) {
        if (migrants[m].score <= scored[m].score) continue;
        const replaceIdx = scored[m].idx;
        for (const p of PARAMS) {
          pop[replaceIdx][p.id] = migrants[m].gene[p.id];
        }
      }

      parentPort.postMessage({ type: 'migrate_done', islandIdx });
      break;
    }

    case 'get_results': {
      const b = best(ga.options);
      const entry = fitnessCache.get(geneKey(b.gene));

      const topFromCache = [...fitnessCache.entries()]
        .map(([key, val]) => ({ key, ...val }))
        .filter(r => r.metrics && r.metrics.trades >= MIN_TRADES)
        .sort((a, b) => b.fitness - a.fitness)
        .slice(0, 20);

      parentPort.postMessage({
        type: 'results',
        islandIdx,
        best: { gene: { ...b.gene }, fitness: b.fitness, metrics: entry?.metrics || {} },
        topResults: topFromCache,
        evalCount,
        cacheSize: fitnessCache.size,
      });
      break;
    }

    case 'cancel': {
      cancelled = true;
      break;
    }
  }
});

parentPort.postMessage({ type: 'ready', islandIdx });
