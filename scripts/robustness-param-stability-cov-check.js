/**
 * robustness-param-stability-cov-check — Phase 6.1 gate for
 * `optimizer/robustness/paramStabilityCoV.js`.
 *
 * Verifies the per-parameter Coefficient of Variation (CoV) measure
 * across walk-forward window winners. The module is deterministic
 * math on an already-collected `wfReport` — no backtests, no RNG,
 * so this gate is pure synthetic data with no DB or worker deps.
 *
 * Backlog reference: `docs/backlog.md` §6.1 — "paramStabilityCoV.js".
 *
 * Coverage:
 *   [1] Null / undefined wfReport → degenerate
 *   [2] Empty / missing `windows` → degenerate
 *   [3] Single-window report → degenerate
 *   [4] Identical winners across 5 windows → meanCoV=0, worstCoV=0
 *   [5] Drift on one param (emaLen) with others stable → meanCoV>0,
 *       worstParam='emaLen'
 *   [6] `opts.paramIds` restriction only scores the listed ids
 *   [7] `minWindows` respected — 5-window report with minWindows=10
 *       is degenerate
 *
 * Usage:
 *   node scripts/robustness-param-stability-cov-check.js
 *
 * Exits 0 on success, 1 on any assertion failure.
 */

import { paramStabilityCoV } from '../optimizer/robustness/paramStabilityCoV.js';

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

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
}

function assertApproxEq(label, actual, expected, tol = 1e-9) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${actual}`);
    console.log(`    expected: ${expected} (± ${tol})`);
  }
}

// Build a fake wfReport shape that matches `optimizer/walk-forward.js`'s
// output: `windows: [{ index, isStart, ..., gene: {paramId: value} }, ...]`.
// Only `gene` is read by paramStabilityCoV; the other fields are
// included for realism so the test inputs look like real reports.
function makeReport(genes) {
  return {
    windows: genes.map((gene, i) => ({
      index:    i,
      isStart:  0,
      isEnd:    100 + i * 10,
      oosEnd:   110 + i * 10,
      isTrades: 10,
      isPf:     1.5,
      oosTrades: 5,
      oosPf:    1.2,
      gene,
    })),
  };
}

// ═══════════════════════════════════════════════════════════
// [1] Null / undefined wfReport → degenerate
// ═══════════════════════════════════════════════════════════

console.log('\n[1] null / undefined wfReport');
{
  const r1 = paramStabilityCoV(null);
  assertTrue('null: degenerate=true',     r1.degenerate === true);
  assertEq  ('null: meanCoV=0',           r1.meanCoV, 0);
  assertEq  ('null: worstParam=null',     r1.worstParam, null);
  assertEq  ('null: worstCoV=0',          r1.worstCoV, 0);
  assertEq  ('null: perParamCoV empty',   r1.perParamCoV, {});
  assertEq  ('null: windowsUsed=0',       r1.windowsUsed, 0);

  const r2 = paramStabilityCoV(undefined);
  assertTrue('undefined: degenerate=true', r2.degenerate === true);
  assertEq  ('undefined: windowsUsed=0',   r2.windowsUsed, 0);
}

// ═══════════════════════════════════════════════════════════
// [2] Empty / missing windows → degenerate
// ═══════════════════════════════════════════════════════════

console.log('\n[2] empty / missing windows');
{
  const empty = paramStabilityCoV({ windows: [] });
  assertTrue('empty windows: degenerate=true', empty.degenerate === true);
  assertEq  ('empty windows: windowsUsed=0',   empty.windowsUsed, 0);

  const noWindowsField = paramStabilityCoV({ scheme: 'anchored' });
  assertTrue('missing windows field: degenerate=true',
    noWindowsField.degenerate === true);
}

// ═══════════════════════════════════════════════════════════
// [3] 1 window → degenerate (can't compute stdev)
// ═══════════════════════════════════════════════════════════

console.log('\n[3] single-window report');
{
  const r = paramStabilityCoV(makeReport([
    { emaLen: 20, rsiLen: 14 },
  ]));
  assertTrue('1 window: degenerate=true',  r.degenerate === true);
  assertEq  ('1 window: windowsUsed=1',    r.windowsUsed, 1);
  assertEq  ('1 window: meanCoV=0',        r.meanCoV, 0);
}

// ═══════════════════════════════════════════════════════════
// [4] 5 windows with identical winners → meanCoV=0, worstCoV=0
// ═══════════════════════════════════════════════════════════

console.log('\n[4] identical winners across 5 windows');
{
  const gene = { emaLen: 20, rsiLen: 14, atrMult: 2.5 };
  const r = paramStabilityCoV(makeReport([gene, gene, gene, gene, gene]));
  assertTrue('identical: degenerate=false', r.degenerate === false);
  assertEq  ('identical: windowsUsed=5',    r.windowsUsed, 5);
  assertEq  ('identical: meanCoV=0',        r.meanCoV, 0);
  assertEq  ('identical: worstCoV=0',       r.worstCoV, 0);
  // When everything is tied at 0, any param could be reported as
  // "worst"; the module only updates worstParam on strict >, so it
  // stays null in the all-zero case. Either null or one of the ids
  // would be acceptable, but we assert the stricter contract:
  assertEq  ('identical: worstParam=null',  r.worstParam, null);
  assertTrue('identical: all per-param CoVs = 0',
    Object.values(r.perParamCoV).every(v => v === 0),
    `got ${JSON.stringify(r.perParamCoV)}`);
}

// ═══════════════════════════════════════════════════════════
// [5] 5 windows with large drift on emaLen, others stable
//     → meanCoV > 0, worstParam = 'emaLen'
// ═══════════════════════════════════════════════════════════

console.log('\n[5] drift on one param');
{
  const emaLenValues = [12, 47, 23, 55, 13];
  const genes = emaLenValues.map(v => ({
    emaLen:  v,
    rsiLen:  14,     // stable
    atrMult: 2.5,    // stable
  }));
  const r = paramStabilityCoV(makeReport(genes));

  assertTrue('drift: degenerate=false',    r.degenerate === false);
  assertEq  ('drift: windowsUsed=5',       r.windowsUsed, 5);
  assertEq  ('drift: worstParam=emaLen',   r.worstParam, 'emaLen');
  assertTrue('drift: worstCoV > 0',        r.worstCoV > 0, `got ${r.worstCoV}`);
  assertTrue('drift: meanCoV > 0',         r.meanCoV > 0,  `got ${r.meanCoV}`);

  // Explicit math for emaLen: mean=30, population variance =
  // ((12-30)^2 + (47-30)^2 + (23-30)^2 + (55-30)^2 + (13-30)^2) / 5
  // = (324 + 289 + 49 + 625 + 289) / 5 = 1576 / 5 = 315.2
  // stdev = sqrt(315.2) ≈ 17.7538..., CoV = 17.7538... / 30 ≈ 0.59179...
  const expectedEmaCoV = Math.sqrt(315.2) / 30;
  assertApproxEq('drift: emaLen CoV matches hand calc',
    r.perParamCoV.emaLen, expectedEmaCoV, 1e-9);
  assertEq('drift: rsiLen CoV = 0 (stable)',  r.perParamCoV.rsiLen, 0);
  assertEq('drift: atrMult CoV = 0 (stable)', r.perParamCoV.atrMult, 0);
}

// ═══════════════════════════════════════════════════════════
// [6] opts.paramIds restriction
// ═══════════════════════════════════════════════════════════

console.log('\n[6] opts.paramIds restriction');
{
  const genes = [
    { emaLen: 12, rsiLen: 10, atrMult: 2.0 },
    { emaLen: 47, rsiLen: 20, atrMult: 3.5 },
    { emaLen: 23, rsiLen: 14, atrMult: 2.5 },
    { emaLen: 55, rsiLen: 18, atrMult: 3.0 },
    { emaLen: 13, rsiLen: 12, atrMult: 2.2 },
  ];
  const r = paramStabilityCoV(makeReport(genes), { paramIds: ['emaLen'] });

  assertEq  ('restricted: only emaLen in perParamCoV',
    Object.keys(r.perParamCoV), ['emaLen']);
  assertEq  ('restricted: worstParam=emaLen', r.worstParam, 'emaLen');
  assertTrue('restricted: emaLen CoV > 0',    r.perParamCoV.emaLen > 0);
  // When only one param is scored, meanCoV === that param's CoV.
  assertApproxEq('restricted: meanCoV === emaLen CoV',
    r.meanCoV, r.perParamCoV.emaLen, 1e-12);
}

// ═══════════════════════════════════════════════════════════
// [7] minWindows respected
// ═══════════════════════════════════════════════════════════

console.log('\n[7] minWindows respected');
{
  const genes = [
    { emaLen: 12 }, { emaLen: 47 }, { emaLen: 23 },
    { emaLen: 55 }, { emaLen: 13 },
  ];
  const r = paramStabilityCoV(makeReport(genes), { minWindows: 10 });
  assertTrue('minWindows=10 on 5-window report: degenerate=true',
    r.degenerate === true);
  assertEq  ('minWindows=10: windowsUsed=5 (count still reported)',
    r.windowsUsed, 5);
  assertEq  ('minWindows=10: meanCoV=0',    r.meanCoV, 0);
  assertEq  ('minWindows=10: perParamCoV empty', r.perParamCoV, {});

  // Sanity: minWindows=3 (default) on the same report is not degenerate.
  const rOk = paramStabilityCoV(makeReport(genes));
  assertTrue('default minWindows=3 on 5-window report: degenerate=false',
    rOk.degenerate === false);
}

// ═══════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('FAILED');
  process.exit(1);
}
console.log('OK');
