/**
 * evaluateGene — run a single gene through the backtest + fitness pipeline.
 *
 * Stateless. Does NOT consult any fitness cache — cache policy is the
 * caller's responsibility. Exists as a seam so:
 *
 *   1. Phase 6.2 (Noise-Test During Optimization) can call this K times
 *      with different `bundleOverride` variants per gene, then median-
 *      aggregate the K+1 fitness values into a robust fitness.
 *
 *   2. Tests can exercise the fitness-evaluation path without spawning a
 *      Worker. Before this extraction the logic lived as a closure inside
 *      `island-worker.js`'s `createIsland()`, reachable only through a
 *      full GA run.
 *
 * Two modes, chosen by `deps.specMode`:
 *
 *   - **Spec mode** — `runSpec` + `computeFitness`. Maps the fitness
 *     score to the [-10000, 1000] scale the legacy island-worker used:
 *     eliminated genes get -10000; non-eliminated get `fit.score * 1000`.
 *     Returns metrics with `_fitness` diagnostics attached for the UI.
 *
 *   - **Legacy mode** — `runStrategy` + hand-coded scoring matching the
 *     pre-Phase-2 formula. Soft penalty below `minTrades`, flat-sizing
 *     profit × (1 − dd-ratio²) otherwise.
 *
 * Return shape: `{ fitness: number, metrics: Object }`. `fitness` is a
 * scalar the GA can compare with `>`; metrics is the full per-bar run
 * summary (plus `_fitness` sub-object in spec mode).
 *
 * Error handling: any thrown error from `runSpec` / `runStrategy` is
 * caught and mapped to `{ fitness: -10000, metrics: { error: msg } }`.
 * A buggy block or a gene that slips past constraints shouldn't crash
 * the island.
 */

import { runStrategy } from '../engine/strategy.js';
import { runSpec } from '../engine/runtime.js';
import { computeFitness } from './fitness.js';

// Fitness sentinels — duplicated from island-worker.js so evaluateGene
// is self-contained. Changes to either file must keep these in sync
// with the legacy soft-penalty band [-5000, -1000] so the relative
// ordering between eliminated genes, trades-below-minimum genes, and
// scored genes is preserved.
const ELIMINATED_SCORE       = -10000;  // spec-mode hard-gate fail, or either-mode error
const LEGACY_TOO_FEW_TRADES  = -5000;   // < 3 trades
const LEGACY_UNDER_MINTRADES = -1000;   // < minTrades but >= 3 (soft-penalty band)
const SPEC_SCORE_SCALE       = 1000;    // maps computeFitness's [0, 1] to [0, 1000]

/**
 * @param {Object} gene
 * @param {Object} deps
 * @param {boolean} deps.specMode                — switches execution mode
 *
 * Spec-mode deps:
 * @param {Object}  [deps.spec]                  — validated spec
 * @param {Object}  [deps.paramSpace]            — built paramSpace
 * @param {Object}  [deps.specBundle]            — default bundle (base + htfs)
 * @param {Object}  [deps.specRunOpts]           — extra `runSpec` opts (e.g. `fitnessStartBar`)
 * @param {Object}  [deps.bundleOverride]        — Phase 6.2 NTO hook; replaces specBundle for this call
 *
 * Legacy-mode deps:
 * @param {Object}  [deps.candles]               — pre-reconstructed Float64 views
 * @param {number}  [deps.tradingStartBar]       — warmup vs trading boundary
 * @param {number}  [deps.minTrades]             — soft-gate floor (≥ 3 required first)
 * @param {number}  [deps.maxDdPct]              — DD-ratio denom for dd penalty
 *
 * @returns {{ fitness: number, metrics: Object }}
 */
export function evaluateGene(gene, deps) {
  if (deps.specMode) return evaluateGeneSpec(gene, deps);
  return evaluateGeneLegacy(gene, deps);
}

function evaluateGeneSpec(gene, {
  spec, paramSpace, specBundle, specRunOpts,
  bundleOverride,
}) {
  if (!spec)       throw new Error('evaluateGene (spec mode): deps.spec is required');
  if (!paramSpace) throw new Error('evaluateGene (spec mode): deps.paramSpace is required');
  const bundle = bundleOverride ?? specBundle;
  if (!bundle)     throw new Error('evaluateGene (spec mode): deps.specBundle or deps.bundleOverride is required');

  let m;
  try {
    m = runSpec({ spec, paramSpace, bundle, gene, opts: specRunOpts ?? {} });
  } catch (err) {
    // A spec-eval crash (bad gene values that slip past constraints,
    // missing block prepare, etc.) is treated as the worst outcome
    // rather than killing the caller. Matches legacy island-worker
    // behavior.
    return { fitness: ELIMINATED_SCORE, metrics: { error: err.message } };
  }
  if (!m || m.error) {
    return { fitness: ELIMINATED_SCORE, metrics: m || {} };
  }

  const fit = computeFitness({ metrics: m, fitnessConfig: spec.fitness });

  // Stamp fitness diagnostics onto metrics so downstream UI / top-results
  // assembly can show which gate (if any) killed the gene.
  m._fitness = {
    score:        fit.score,
    eliminated:   fit.eliminated,
    gatesFailed:  fit.gatesFailed,
    breakdown:    fit.breakdown,
    ...(fit.reason ? { reason: fit.reason } : {}),
  };

  const score = fit.eliminated ? ELIMINATED_SCORE : fit.score * SPEC_SCORE_SCALE;
  return { fitness: score, metrics: m };
}

function evaluateGeneLegacy(gene, {
  candles, tradingStartBar, minTrades, maxDdPct,
}) {
  if (!candles)  throw new Error('evaluateGene (legacy mode): deps.candles is required');

  const m = runStrategy(candles, gene, { tradingStartBar, flatSizing: true });

  if (!m || m.error) {
    return { fitness: ELIMINATED_SCORE, metrics: m || {} };
  }

  if (m.trades < 3) {
    return { fitness: LEGACY_TOO_FEW_TRADES, metrics: m };
  }
  if (m.trades < (minTrades ?? 30)) {
    return { fitness: LEGACY_UNDER_MINTRADES + m.trades * 10, metrics: m };
  }

  const profitScore = m.netProfitPct * 100;
  const ddCap       = maxDdPct ?? 0.5;
  const ddRatio     = m.maxDDPct > 0 ? Math.min(m.maxDDPct / ddCap, 1) : 0;
  const ddPenalty   = 0.3 * ddRatio * ddRatio;
  const score       = profitScore * (1 - ddPenalty);

  return { fitness: score, metrics: m };
}

// Re-exported so tests can assert on specific sentinels rather than magic numbers.
export const FITNESS_SENTINELS = Object.freeze({
  ELIMINATED:       ELIMINATED_SCORE,
  TOO_FEW_TRADES:   LEGACY_TOO_FEW_TRADES,
  UNDER_MIN_TRADES: LEGACY_UNDER_MINTRADES,
  SCORE_SCALE:      SPEC_SCORE_SCALE,
});
