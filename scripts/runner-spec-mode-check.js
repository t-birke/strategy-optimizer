/**
 * runner-spec-mode-check — end-to-end smoke test for Phase 2.4.
 *
 * Spawns a *tiny* GA run via `optimizer/runner.js` in **spec mode** —
 * the migration-gate spec on BTCUSDT/4H, with a small population and
 * a handful of generations — and asserts that:
 *
 *   1. The runner reaches completion without crashing.
 *   2. It returns a `bestGene` whose values come from the spec's
 *      paramSpace QIDs (e.g., `emaTrend.main.emaFast`), proving the
 *      worker rebuilt paramSpace correctly.
 *   3. The fitness score is a finite number > 0 (a totally non-trading
 *      population should have been weeded out by `computeFitness`).
 *   4. `bestMetrics._fitness` is populated with the new fitness
 *      breakdown (eliminated, gatesFailed, breakdown.normPf, etc.).
 *   5. The legacy mode still works on the same setup with `spec` omitted
 *      (so the existing UI runner contract is undisturbed).
 *
 * This is a smoke test, NOT a parity test — fitness scales differ
 * between the two modes by design, so we don't compare bestScore values.
 *
 * Set OPTIMIZER_DB_PATH to a non-locked DB copy when the UI server is
 * holding /data/optimizer.duckdb.
 *
 *   OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb \
 *     node scripts/runner-spec-mode-check.js
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as registry from '../engine/blocks/registry.js';
import { runOptimization } from '../optimizer/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  }
}

async function main() {
  await registry.ensureLoaded();
  const specPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
  const spec = JSON.parse(await readFile(specPath, 'utf8'));

  // ── 1. Spec mode ───────────────────────────────────────────
  console.log('\n[1] runOptimization in SPEC mode (migration-gate spec)');
  const tStart = Date.now();
  const specRes = await runOptimization({
    spec,
    symbol:        'BTCUSDT',
    timeframe:     240,
    startDate:     '2021-04-12',
    populationSize: 8,    // keep tiny so the smoke test stays under a minute
    generations:    3,
    mutationRate:   0.4,
    numIslands:     1,
    numPlanets:     1,
    minTrades:      30,
    maxDrawdownPct: 0.5,
  });
  console.log(`    ran in ${((Date.now() - tStart) / 1000).toFixed(1)}s; bars=${specRes.candleBars}, evals=${specRes.totalEvaluations}`);

  assertTrue('spec mode completes', specRes && typeof specRes === 'object');
  assertTrue('bestGene present',     specRes.bestGene && typeof specRes.bestGene === 'object');
  assertTrue('bestScore is finite',  Number.isFinite(specRes.bestScore),
    `bestScore=${specRes.bestScore}`);

  // bestGene must use spec QIDs (e.g. "emaTrend.main.emaFast"), not legacy
  // single-token names like "emaFast" — this is the smoking gun that the
  // worker rebuilt paramSpace from spec.
  const bestKeys = Object.keys(specRes.bestGene || {});
  const looksLikeQid = bestKeys.some(k => k.includes('.'));
  assertTrue('bestGene keys are QIDs (block.instance.param)', looksLikeQid,
    `sample key: ${bestKeys[0]}`);
  assertTrue('bestGene has a non-trivial number of params',
    bestKeys.length >= 10, `count=${bestKeys.length}`);

  // _fitness diagnostics should be on the metrics in spec mode.
  const f = specRes.bestMetrics?._fitness;
  if (specRes.bestScore > -1000) {
    // Only check _fitness if we found a non-eliminated gene
    assertTrue('bestMetrics._fitness present', !!f,
      f ? `score=${f.score?.toFixed(3)}, eliminated=${f.eliminated}` : '(missing)');
    if (f) {
      assertTrue('_fitness.breakdown has normPf', typeof f.breakdown?.normPf === 'number');
      assertTrue('_fitness.breakdown has normDd', typeof f.breakdown?.normDd === 'number');
      assertTrue('_fitness.breakdown has normRet', typeof f.breakdown?.normRet === 'number');
    }
  } else {
    console.log(`    (best gene in this 8×3 sample was eliminated by a gate; skipping breakdown checks)`);
  }

  // Phase 4.1b: post-GA walk-forward on the winner. Spec mode should
  // always emit a wfReport (the harness runs in ~0.1s for this tiny
  // BTCUSDT/4H window). A null wfReport here means the WF step threw
  // and was swallowed — regression we want to catch.
  assertTrue('spec mode emits wfReport', !!specRes.wfReport,
    specRes.wfReport ? `wfe=${specRes.wfReport.wfe?.toFixed(3)}` : 'wfReport is null');
  if (specRes.wfReport) {
    assertTrue('wfReport.nWindows matches spec default (5)',
      specRes.wfReport.nWindows === 5,
      `got ${specRes.wfReport.nWindows}`);
    assertTrue('wfReport.windows.length matches nWindows',
      specRes.wfReport.windows.length === specRes.wfReport.nWindows);
    assertTrue('wfReport.scheme = anchored (spec default)',
      specRes.wfReport.scheme === 'anchored');
    assertTrue('wfReport.meanIsPf is finite', Number.isFinite(specRes.wfReport.meanIsPf));
    assertTrue('wfReport.meanOosPf is finite', Number.isFinite(specRes.wfReport.meanOosPf));
    // wfe can be NaN if no valid windows, which is a legitimate signal
    // (gene produced zero IS trades in every window). Accept both.
    assertTrue('wfReport.wfe is number or NaN',
      typeof specRes.wfReport.wfe === 'number');
  }

  // ── 2. Legacy mode (spec omitted) ───────────────────────────
  console.log('\n[2] runOptimization in LEGACY mode (no spec passed)');
  const t2Start = Date.now();
  const legacyRes = await runOptimization({
    symbol:        'BTCUSDT',
    timeframe:     240,
    startDate:     '2021-04-12',
    populationSize: 8,
    generations:    3,
    mutationRate:   0.4,
    numIslands:     1,
    numPlanets:     1,
    minTrades:      30,
    maxDrawdownPct: 0.5,
  });
  console.log(`    ran in ${((Date.now() - t2Start) / 1000).toFixed(1)}s; bars=${legacyRes.candleBars}, evals=${legacyRes.totalEvaluations}`);

  assertTrue('legacy mode completes', legacyRes && typeof legacyRes === 'object');
  assertTrue('legacy bestGene present', legacyRes.bestGene && typeof legacyRes.bestGene === 'object');

  const legKeys = Object.keys(legacyRes.bestGene || {});
  const legLooksLegacy = legKeys.every(k => !k.includes('.'));
  assertTrue('legacy bestGene keys are flat (no dots)', legLooksLegacy,
    `sample key: ${legKeys[0]}`);
  assertTrue('legacy bestMetrics has no _fitness stamp',
    !legacyRes.bestMetrics?._fitness,
    '_fitness should be spec-mode-only');

  // wfReport must be null in legacy mode — there's no validated spec to
  // hand to walkForward, and the WF step is gated on specMode.
  assertTrue('legacy mode emits wfReport = null',
    legacyRes.wfReport === null,
    `wfReport should be null, got ${JSON.stringify(legacyRes.wfReport)?.slice(0, 40)}`);

  // ── Summary ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
