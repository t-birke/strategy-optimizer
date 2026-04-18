/**
 * evaluate-gene-check — Phase 6.0.1 gate.
 *
 * Verifies the extraction of `evaluateGene()` from `island-worker.js`'s
 * `createIsland()` closure. Four concerns:
 *
 *   [1] Spec-mode identity: for a canonical spec + gene + bundle, the
 *       output `{fitness, metrics}` matches what the inline closure
 *       used to produce (same formula, same sentinels). We don't have
 *       the old closure to diff against directly — we verify the
 *       INVARIANTS that matter:
 *       - eliminated genes get fitness = -10000
 *       - non-eliminated genes get fitness = fit.score × 1000
 *       - metrics carry a `_fitness` sub-object with score/eliminated/
 *         gatesFailed/breakdown
 *       - crashing `runSpec` calls return fitness=-10000 + error metrics
 *
 *   [2] Legacy-mode identity: same invariants for the pre-Phase-2
 *       scoring formula:
 *       - trades < 3 → -5000
 *       - 3 ≤ trades < minTrades → -1000 + 10*trades
 *       - trades ≥ minTrades → profitScore × (1 − ddPenalty)
 *
 *   [3] `bundleOverride` actually swaps the bundle. Running the same
 *       gene on two DIFFERENT synthetic bundles produces different
 *       fitness values — sanity check that the override hook is
 *       connected end-to-end, not silently ignored.
 *
 *   [4] Stateless / idempotent. Calling evaluateGene twice with the
 *       same inputs returns identical results — no hidden state.
 *
 * This test runs on synthetic data (no DB, no workers) so it's safe
 * to include in CI regardless of what's holding the DuckDB lock.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { evaluateGene, FITNESS_SENTINELS } from '../optimizer/evaluate-gene.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import * as registry from '../engine/blocks/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}

function assertEq(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passCount++; console.log(`  ✓ ${label}`); }
  else    {
    failCount++;
    console.log(`  ✗ ${label}\n    actual:   ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
  }
}

// ─── Synthetic bundles (seeded, reproducible) ───────────────

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSyntheticBundle(seed, len = 2000) {
  const rng = mulberry32(seed);
  const ts     = new Float64Array(len);
  const open   = new Float64Array(len);
  const high   = new Float64Array(len);
  const low    = new Float64Array(len);
  const close  = new Float64Array(len);
  const volume = new Float64Array(len);
  const startTs = Date.UTC(2022, 0, 1, 0, 0, 0);
  const tfMs = 4 * 60 * 60 * 1000;
  let price = 30_000;
  for (let i = 0; i < len; i++) {
    ts[i] = startTs + i * tfMs;
    const drift = (rng() - 0.45) * 150;
    const jump  = (i % 73 === 0) ? (rng() > 0.5 ? 1500 : -1500) : 0;
    price = Math.max(100, price + drift + jump);
    const wick = 30 + rng() * 150;
    open[i]   = price;
    high[i]   = price + wick;
    low[i]    = price - wick * 0.8;
    close[i]  = price + (rng() - 0.5) * 20;
    volume[i] = (1000 + i * 0.3 + rng() * 200) * ((i % 29 === 0) ? 3.5 : 1.0);
  }
  return {
    symbol: 'BTCUSDT',
    baseTfMin: 240,
    baseTfMs: 240 * 60 * 1000,
    base: { ts, open, high, low, close, volume },
    htfs: {},
    tradingStartBar: 0,
    periodYears: (len * 240 * 60 * 1000) / (365.25 * 864e5),
  };
}

// ─── [1] Spec-mode identity ─────────────────────────────────

console.log('\n[1] Spec-mode evaluation invariants');

await registry.ensureLoaded();
const migrationSpecPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
const rawSpec = JSON.parse(readFileSync(migrationSpecPath, 'utf8'));
const spec = validateSpec(rawSpec);
const paramSpace = buildParamSpace(spec);
const bundle = buildSyntheticBundle(42);

// Build a random gene; clamp+constrain so it's a legal population member.
const gene = paramSpace.randomIndividual();
paramSpace.enforceConstraints(gene);

const specDeps = {
  specMode: true,
  spec, paramSpace,
  specBundle: bundle,
  specRunOpts: {},
};

const result1 = evaluateGene(gene, specDeps);

assertTrue('returns {fitness, metrics}',
  typeof result1?.fitness === 'number' && typeof result1?.metrics === 'object' && result1.metrics !== null);
assertTrue('metrics._fitness present',
  result1.metrics._fitness && typeof result1.metrics._fitness === 'object');
assertTrue('metrics._fitness has score',
  typeof result1.metrics._fitness.score === 'number');
assertTrue('metrics._fitness has eliminated flag',
  typeof result1.metrics._fitness.eliminated === 'boolean');
assertTrue('metrics._fitness has gatesFailed array',
  Array.isArray(result1.metrics._fitness.gatesFailed));
assertTrue('metrics._fitness has breakdown',
  result1.metrics._fitness.breakdown && typeof result1.metrics._fitness.breakdown === 'object');

// Fitness mapping: ELIMINATED or score × 1000
if (result1.metrics._fitness.eliminated) {
  assertTrue('eliminated → fitness = ELIMINATED sentinel',
    result1.fitness === FITNESS_SENTINELS.ELIMINATED);
} else {
  const expected = result1.metrics._fitness.score * FITNESS_SENTINELS.SCORE_SCALE;
  assertTrue('non-eliminated → fitness = score × 1000',
    Math.abs(result1.fitness - expected) < 1e-9,
    `fitness=${result1.fitness.toFixed(3)} expected=${expected.toFixed(3)}`);
}

// ─── Crash-handling: force runSpec to throw via a bundle with no candles ──
console.log('\n[1b] Spec-mode crash handling → ELIMINATED sentinel');
{
  // Pass a malformed bundle (empty base arrays). runSpec's indicator
  // pipeline should throw somewhere in prepare() when it tries to read
  // from zero-length typed arrays. The exact throw point is an
  // implementation detail; evaluateGene should swallow it regardless.
  const emptyBundle = {
    ...bundle,
    base: {
      ts:     new Float64Array(0),
      open:   new Float64Array(0),
      high:   new Float64Array(0),
      low:    new Float64Array(0),
      close:  new Float64Array(0),
      volume: new Float64Array(0),
    },
  };
  const r = evaluateGene(gene, { ...specDeps, specBundle: emptyBundle });
  assertTrue('crash / error path → fitness = ELIMINATED sentinel',
    r.fitness === FITNESS_SENTINELS.ELIMINATED);
  // We don't assert on the error message shape — runSpec may either
  // throw (→ metrics.error = msg) or return `{error: ...}` (→ metrics
  // has an error field) or return a metrics object with one of the
  // eliminated-by-gate sentinels. All three are ELIMINATED as far as
  // the fitness score is concerned.
}

// ─── [2] Legacy-mode identity ───────────────────────────────

console.log('\n[2] Legacy-mode evaluation invariants');

import('../optimizer/params.js').then(async (legacyParams) => {
  const legacyGene = legacyParams.randomIndividual();
  legacyParams.enforceConstraints(legacyGene);

  const legacyDeps = {
    specMode: false,
    candles: bundle.base,
    tradingStartBar: 0,
    minTrades: 30,
    maxDdPct: 0.5,
  };

  const r = evaluateGene(legacyGene, legacyDeps);

  assertTrue('returns {fitness, metrics}',
    typeof r?.fitness === 'number' && typeof r?.metrics === 'object' && r.metrics !== null);

  const t = r.metrics.trades;
  if (t == null || r.metrics.error) {
    assertTrue('error path → ELIMINATED sentinel',
      r.fitness === FITNESS_SENTINELS.ELIMINATED);
  } else if (t < 3) {
    assertEq('trades < 3 → TOO_FEW_TRADES sentinel',
      r.fitness, FITNESS_SENTINELS.TOO_FEW_TRADES);
  } else if (t < 30) {
    assertEq('3 ≤ trades < minTrades → under-min-trades band',
      r.fitness, FITNESS_SENTINELS.UNDER_MIN_TRADES + t * 10);
  } else {
    const profitScore = r.metrics.netProfitPct * 100;
    const ddRatio = r.metrics.maxDDPct > 0 ? Math.min(r.metrics.maxDDPct / 0.5, 1) : 0;
    const ddPenalty = 0.3 * ddRatio * ddRatio;
    const expected = profitScore * (1 - ddPenalty);
    assertTrue('trades ≥ minTrades → profit × (1 − dd-penalty)',
      Math.abs(r.fitness - expected) < 1e-9,
      `fitness=${r.fitness.toFixed(3)} expected=${expected.toFixed(3)}`);
  }

  // ─── [3] bundleOverride swaps the bundle (NTO hook) ─────────

  console.log('\n[3] bundleOverride actually swaps the bundle');

  // Two synthetic bundles with different seeds → different price paths
  // → different strategy backtest output. A random gene on random
  // synthetic data may produce 0 trades on both (→ fitness=ELIMINATED
  // on both), which would mask whether the override ever took effect.
  // So we assert on something that DOES differ regardless of gate
  // outcomes: the metrics object itself (trade counts, net profit, DD)
  // must reflect the different price series.
  const bundleA = buildSyntheticBundle(42);
  const bundleB = buildSyntheticBundle(999);

  const rA = evaluateGene(gene, { ...specDeps, specBundle: bundleA });
  const rB = evaluateGene(gene, { ...specDeps, specBundle: bundleA, bundleOverride: bundleB });

  // Compare metrics signatures. Two different price paths produce
  // measurably different trade counts and/or net profit — even if both
  // runs are eliminated, the metrics diverge.
  const sigA = `trades=${rA.metrics.trades}|net=${rA.metrics.netProfitPct}|dd=${rA.metrics.maxDDPct}`;
  const sigB = `trades=${rB.metrics.trades}|net=${rB.metrics.netProfitPct}|dd=${rB.metrics.maxDDPct}`;
  assertTrue('different bundles → different metrics signature',
    sigA !== sigB,
    `A=${sigA} B=${sigB}`);

  // Invariance: bundleOverride fully SHADOWS specBundle. If we set
  // specBundle to something unrelated (bundleB) but also pass
  // bundleOverride=bundleB, the result must match what we got when
  // specBundle=bundleA + bundleOverride=bundleB. Otherwise the
  // override isn't actually wired.
  const rB2 = evaluateGene(gene, { ...specDeps, specBundle: bundleB, bundleOverride: bundleB });
  const sigB2 = `trades=${rB2.metrics.trades}|net=${rB2.metrics.netProfitPct}|dd=${rB2.metrics.maxDDPct}`;
  assertTrue('bundleOverride wins over specBundle',
    sigB === sigB2,
    `B=${sigB} B2=${sigB2}`);

  // ─── [4] Statelessness ──────────────────────────────────────

  console.log('\n[4] Statelessness — same inputs twice → same output');

  const s1 = evaluateGene(gene, specDeps);
  const s2 = evaluateGene(gene, specDeps);
  assertEq('spec-mode: two calls → identical fitness', s1.fitness, s2.fitness);
  assertEq('spec-mode: two calls → identical _fitness breakdown',
    s1.metrics._fitness.breakdown, s2.metrics._fitness.breakdown);

  const l1 = evaluateGene(legacyGene, legacyDeps);
  const l2 = evaluateGene(legacyGene, legacyDeps);
  assertEq('legacy-mode: two calls → identical fitness', l1.fitness, l2.fitness);

  // ─── Summary ────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) { console.log('FAILED'); process.exit(1); }
  console.log('OK');
});
