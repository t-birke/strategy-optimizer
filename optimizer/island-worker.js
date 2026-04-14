/**
 * Island worker — runs a single GaIsland in its own thread.
 * Receives candle data as SharedArrayBuffer (zero-copy).
 * Communicates with main thread via message passing for
 * evolution batches, migration, and result collection.
 *
 * When windowSize > 0, fitness is evaluated across overlapping windows
 * to reward strategies that perform consistently across market phases.
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
  windowSizeBars,    // window size in bars (0 = disabled, single full-period eval)
  windowStepBars,    // step between windows in bars (overlap = windowSize - step)
  consistencyWeight, // 0..1 — how aggressively to penalize variance across windows
} = workerData;

const MIN_TRADES = 10;
const MIN_TRADES_PER_WINDOW = 2;

// Reconstruct candle Float64Array views from SharedArrayBuffer (zero-copy)
const candles = {
  open:   new Float64Array(candleBuffer, 0, candleLength),
  high:   new Float64Array(candleBuffer, candleLength * 8, candleLength),
  low:    new Float64Array(candleBuffer, candleLength * 2 * 8, candleLength),
  close:  new Float64Array(candleBuffer, candleLength * 3 * 8, candleLength),
  volume: new Float64Array(candleBuffer, candleLength * 4 * 8, candleLength),
};

// ─── Precompute window boundaries ──────────────────────────
// Each window: { startBar, endBar } — indicator warmup data before startBar
// is still accessible since we pass the full candle array.
const windows = [];
if (windowSizeBars > 0 && windowStepBars > 0) {
  for (let start = tradingStartBar; start + windowSizeBars <= candleLength; start += windowStepBars) {
    windows.push({ startBar: start, endBar: start + windowSizeBars });
  }
  // If last window doesn't reach the end, add a final window anchored at the end
  if (windows.length > 0 && windows[windows.length - 1].endBar < candleLength) {
    const lastStart = candleLength - windowSizeBars;
    if (lastStart >= tradingStartBar && lastStart > windows[windows.length - 1].startBar) {
      windows.push({ startBar: lastStart, endBar: candleLength });
    }
  }
}
const useWindows = windows.length >= 2;

// Local fitness cache
const fitnessCache = new Map();
let evalCount = 0;

function median(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fitness(gene) {
  const key = geneKey(gene);
  if (fitnessCache.has(key)) return fitnessCache.get(key).fitness;

  evalCount++;

  // Always run full-period for reporting metrics
  const fullMetrics = runStrategy(candles, gene, { tradingStartBar });

  if (!fullMetrics || fullMetrics.error) {
    fitnessCache.set(key, { fitness: -10000, metrics: fullMetrics || {} });
    return -10000;
  }
  if (fullMetrics.trades < 3) {
    const score = -5000;
    fitnessCache.set(key, { fitness: score, metrics: fullMetrics });
    return score;
  }
  if (fullMetrics.trades < MIN_TRADES) {
    const score = -1000 + fullMetrics.trades * 10;
    fitnessCache.set(key, { fitness: score, metrics: fullMetrics });
    return score;
  }

  let score;

  if (!useWindows) {
    // Classic single-period fitness
    score = fullMetrics.netProfitPct * 100;
  } else {
    // ─── Window-based fitness ─────────────────────────────
    const windowScores = [];

    for (const w of windows) {
      const m = runStrategy(candles, gene, {
        tradingStartBar: w.startBar,
        tradingEndBar: w.endBar,
      });

      if (!m || m.error || m.trades < MIN_TRADES_PER_WINDOW) {
        windowScores.push(-100); // penalize windows with too few trades
      } else {
        windowScores.push(m.netProfitPct * 100);
      }
    }

    const med = median(windowScores);
    const mean = windowScores.reduce((s, v) => s + v, 0) / windowScores.length;
    const variance = windowScores.reduce((s, v) => s + (v - mean) ** 2, 0) / windowScores.length;
    const std = Math.sqrt(variance);
    const absMean = Math.abs(mean);

    // Coefficient of variation (capped to avoid blow-up when mean ≈ 0)
    const cv = absMean > 0.01 ? std / absMean : std * 10;

    // consistency penalty: cv * weight. At weight=0 we just use median.
    // At weight=1, a cv of 1.0 (std = mean) would halve the score.
    const penalty = 1 - Math.min(consistencyWeight * cv, 0.95);

    score = med * penalty;
  }

  fitnessCache.set(key, { fitness: score, metrics: fullMetrics });
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

parentPort.postMessage({
  type: 'ready',
  islandIdx,
  windowCount: useWindows ? windows.length : 0,
});
