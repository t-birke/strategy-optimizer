/**
 * fitness-check — hand-picked synthetic cases that exercise every
 * branch of `optimizer/fitness.js`. No backtest, no candles: pure
 * inputs → pure outputs. Run as:
 *
 *     node scripts/fitness-check.js
 *
 * Exits 0 on success, 1 on any assertion failure. Prints a readable
 * breakdown table so a reviewer can eyeball the math.
 *
 * This stands in for a proper Jest/Vitest suite because the repo
 * doesn't have one wired up (by convention — see scripts/parity-gate.js).
 * If/when a test runner lands, rehome these cases as-is.
 */

import {
  computeFitness,
  normalizePf,
  normalizeDd,
  normalizeRet,
  normalizeWeights,
  worstRegimePfWithSample,
  poolRegimeBreakdowns,
  MIN_REGIME_SAMPLE,
  ELIMINATED_SCORE,
} from '../optimizer/fitness.js';
import { DEFAULT_FITNESS } from '../engine/spec.js';

let failCount = 0;
let passCount = 0;

function assertClose(label, actual, expected, tol = 1e-9) {
  const diff = Math.abs(actual - expected);
  if (diff <= tol) {
    passCount++;
    console.log(`  ✓ ${label}: ${actual.toFixed(6)} (expected ${expected.toFixed(6)})`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}: ${actual} — expected ${expected} (diff ${diff})`);
  }
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}: ${JSON.stringify(actual)}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}: ${JSON.stringify(actual)} — expected ${JSON.stringify(expected)}`);
  }
}

function assertTrue(label, cond, details = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  }
}

// ─── 1. Normalizer primitives ────────────────────────────────
console.log('\n[1] normalizePf — PF capped at caps.pf');
assertClose('pf=0',        normalizePf(0,        4), 0);
assertClose('pf=2',        normalizePf(2,        4), 0.5);
assertClose('pf=4',        normalizePf(4,        4), 1.0);
assertClose('pf=10 clips', normalizePf(10,       4), 1.0);
assertClose('pf=Infinity', normalizePf(Infinity, 4), 1.0);
assertClose('pf=NaN',      normalizePf(NaN,      4), 0);
assertClose('pf=-1',       normalizePf(-1,       4), 0);

console.log('\n[2] normalizeDd — 1 - DD, clamped');
assertClose('dd=0',    normalizeDd(0),    1);
assertClose('dd=0.25', normalizeDd(0.25), 0.75);
assertClose('dd=1.0',  normalizeDd(1.0),  0);
assertClose('dd=1.5',  normalizeDd(1.5),  0);
assertClose('dd=NaN',  normalizeDd(NaN),  1);  // fallback: 0 DD

console.log('\n[3] normalizeRet — negative → 0, capped');
assertClose('ret=-0.5', normalizeRet(-0.5, 2), 0);
assertClose('ret=0',    normalizeRet(0,    2), 0);
assertClose('ret=1.0',  normalizeRet(1.0,  2), 0.5);
assertClose('ret=2.0',  normalizeRet(2.0,  2), 1.0);
assertClose('ret=5.0',  normalizeRet(5.0,  2), 1.0);

console.log('\n[4] normalizeWeights — sum to 1, handle all-zero');
let wN = normalizeWeights({ pf: 0.5, dd: 0.3, ret: 0.2 });
assertClose('weights already sum to 1: pf',  wN.pf,  0.5);
assertClose('weights already sum to 1: dd',  wN.dd,  0.3);
assertClose('weights already sum to 1: ret', wN.ret, 0.2);
wN = normalizeWeights({ pf: 5, dd: 3, ret: 2 });
assertClose('weights scaled: pf',  wN.pf,  0.5);
assertClose('weights scaled: dd',  wN.dd,  0.3);
assertClose('weights scaled: ret', wN.ret, 0.2);
wN = normalizeWeights({ pf: 0, dd: 0, ret: 0 });
assertClose('all-zero → equal thirds: pf',  wN.pf,  1 / 3);
assertClose('all-zero → equal thirds: dd',  wN.dd,  1 / 3);
assertClose('all-zero → equal thirds: ret', wN.ret, 1 / 3);
wN = normalizeWeights({ pf: 1, dd: -5, ret: 0 }); // negative coerced to 0
assertClose('negative coerced: pf',  wN.pf,  1.0);
assertClose('negative coerced: dd',  wN.dd,  0);
assertClose('negative coerced: ret', wN.ret, 0);

console.log('\n[5] worstRegimePfWithSample — samples gate');
assertEq('empty → null', worstRegimePfWithSample({}), null);
assertEq('null → null',  worstRegimePfWithSample(null), null);
assertClose('single regime, enough samples',
  worstRegimePfWithSample({ bull: { trades: 10, pf: 1.5 } }), 1.5);
assertClose('two regimes, worst wins',
  worstRegimePfWithSample({ bull: { trades: 10, pf: 2.0 }, bear: { trades: 10, pf: 0.8 } }), 0.8);
assertEq('tiny regime excluded → null if only one',
  worstRegimePfWithSample({ bear: { trades: 2, pf: 0.1 } }), null);
assertClose('tiny regime skipped, big one used',
  worstRegimePfWithSample({
    bull: { trades: 100, pf: 1.2 },
    bear: { trades: 2,   pf: 0.01 },  // below sample floor, ignored
  }), 1.2);
assertClose('Infinity PF doesn\'t count as worst',
  worstRegimePfWithSample({
    bull: { trades: 10, pf: Infinity },
    bear: { trades: 10, pf: 1.5 },
  }), 1.5);

// ─── 6. Full computeFitness happy path ──────────────────────
console.log('\n[6] computeFitness — happy path (BTC-winner-ish metrics)');
{
  const metrics = {
    trades: 1020,
    pf: 1.34,
    netProfitPct: 2.40,   // 240% return
    maxDDPct: 0.18,       // 18% DD
    regimeBreakdown: {
      bull: { trades: 400, pf: 1.5, net: 100000, wins: 240 },
      bear: { trades: 300, pf: 1.2, net:  20000, wins: 150 },
      chop: { trades: 320, pf: 1.1, net:   5000, wins: 160 },
    },
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS });
  assertTrue('not eliminated', !r.eliminated);
  assertEq('gatesFailed empty', r.gatesFailed, []);
  // normPf = 1.34/4.0 = 0.335
  // normDd = 1 - 0.18 = 0.82
  // normRet= min(2.40,2.0)/2.0 = 1.0
  // score  = 0.5*0.335 + 0.3*0.82 + 0.2*1.0 = 0.1675 + 0.246 + 0.2 = 0.6135
  assertClose('score',    r.score,               0.6135, 1e-4);
  assertClose('normPf',   r.breakdown.normPf,    0.335,  1e-4);
  assertClose('normDd',   r.breakdown.normDd,    0.82,   1e-4);
  assertClose('normRet',  r.breakdown.normRet,   1.0,    1e-4);
  assertClose('worstRegimePf', r.breakdown.worstRegimePf, 1.1, 1e-4);
}

// ─── 7. Gates: minTrades eliminates ─────────────────────────
console.log('\n[7] computeFitness — minTradesPerWindow gate');
{
  const metrics = {
    trades: 10, pf: 3.0, netProfitPct: 1.0, maxDDPct: 0.1,
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS });
  assertTrue('eliminated', r.eliminated);
  assertEq('gatesFailed = [trades]', r.gatesFailed, ['trades']);
  assertTrue('score = ELIMINATED_SCORE', r.score === ELIMINATED_SCORE);
  assertTrue('reason mentions trades', r.reason?.includes('trades='));
  console.log('    reason:', r.reason);
}

// ─── 8. Gates: worst-regime PF eliminates ────────────────────
console.log('\n[8] computeFitness — worstRegimePfFloor gate');
{
  const metrics = {
    trades: 200, pf: 2.0, netProfitPct: 0.8, maxDDPct: 0.12,
    regimeBreakdown: {
      bull: { trades: 100, pf: 3.0, net: 50, wins: 60 },
      bear: { trades:  80, pf: 0.5, net: -10, wins: 20 },  // below floor 1.0
    },
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS });
  assertTrue('eliminated', r.eliminated);
  assertTrue('worstRegime in failed', r.gatesFailed.includes('worstRegime'));
  assertClose('worstRegimePf', r.breakdown.worstRegimePf, 0.5, 1e-6);
  console.log('    reason:', r.reason);
}

// ─── 9. Gate skipped when regimes too small ─────────────────
console.log(`\n[9] computeFitness — worst-regime gate skips when no regime has ≥${MIN_REGIME_SAMPLE} samples`);
{
  const metrics = {
    trades: 200, pf: 2.0, netProfitPct: 0.8, maxDDPct: 0.12,
    regimeBreakdown: {
      bear: { trades: 2, pf: 0.01, net: -5, wins: 0 },  // below sample floor
    },
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS });
  assertTrue('NOT eliminated (small-sample regime ignored)', !r.eliminated);
}

// ─── 10. WFE gate when WF report present ────────────────────
console.log('\n[10] computeFitness — WFE gate');
{
  const metrics = {
    trades: 200, pf: 2.0, netProfitPct: 0.8, maxDDPct: 0.12,
    regimeBreakdown: { bull: { trades: 200, pf: 2.0, net: 50, wins: 120 } },
  };
  const r1 = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport: { wfe: 0.3 } });
  assertTrue('wfe=0.3 < 0.5: eliminated', r1.eliminated);
  assertTrue('wfe in failed', r1.gatesFailed.includes('wfe'));

  const r2 = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport: { wfe: 0.8 } });
  assertTrue('wfe=0.8 >= 0.5: not eliminated', !r2.eliminated);

  const r3 = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS }); // no WF report
  assertTrue('no WF report → WFE gate skipped', !r3.eliminated);
}

// ─── 11. Saturation corners ─────────────────────────────────
console.log('\n[11] computeFitness — saturation');
{
  const metrics = {
    trades: 1000, pf: Infinity, netProfitPct: 100, maxDDPct: 0,
    regimeBreakdown: { bull: { trades: 1000, pf: Infinity, net: 1e9, wins: 999 } },
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS });
  assertTrue('perfect inputs not eliminated', !r.eliminated);
  assertClose('score = 1 (max possible)', r.score, 1.0, 1e-6);
  assertClose('normPf saturates', r.breakdown.normPf, 1.0, 1e-6);
  assertClose('normDd saturates', r.breakdown.normDd, 1.0, 1e-6);
  assertClose('normRet saturates', r.breakdown.normRet, 1.0, 1e-6);
}

// ─── 12. Multi-gate failure lists all ────────────────────────
console.log('\n[12] computeFitness — multiple gates fail simultaneously');
{
  const metrics = {
    trades: 5, pf: 0.7, netProfitPct: -0.3, maxDDPct: 0.5,
    regimeBreakdown: { bear: { trades: 5, pf: 0.3, net: -10, wins: 1 } },
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport: { wfe: 0.1 } });
  assertTrue('eliminated', r.eliminated);
  assertTrue('trades failure listed',      r.gatesFailed.includes('trades'));
  assertTrue('worstRegime failure listed', r.gatesFailed.includes('worstRegime'));
  assertTrue('wfe failure listed',         r.gatesFailed.includes('wfe'));
  console.log('    reason:', r.reason);
}

// ─── 13. New fitness rewards risk-adjusted performers ───────
//
// The legacy optimizer scored by
//   score_legacy = netProfitPct * 100 * (1 - 0.3 · min(dd/0.30, 1)^2)
// which is almost purely return-driven with a soft DD penalty.
// The whole POINT of the new fitness is to reward PF + low DD too,
// not just raw return. This test pins down that design choice with
// a curated population so we notice if defaults drift later.
//
// Expected behavior with DEFAULT_FITNESS weights (pf:0.5, dd:0.3, ret:0.2):
//   - a "high-PF low-DD" gene (C) should beat a "high-return high-DD"
//     gene (B) even though B has the best raw return
//   - an "all-round good" gene (A) should be top-2
//   - the fragile-but-lucky "high-return high-DD" gene (B) should drop
//     at least one rank vs the legacy ordering
console.log('\n[13] design-intent ranking check (new fitness ≠ legacy fitness)');
{
  const MAX_DD_PCT_LEGACY = 0.30; // matches island-worker.js MAX_DD_PCT
  const pop = [
    { name: 'A-good',         trades: 500, pf: 1.8, netProfitPct: 2.0, maxDDPct: 0.15 },
    { name: 'B-highReturn',   trades: 500, pf: 1.3, netProfitPct: 3.0, maxDDPct: 0.25 },
    { name: 'C-highPFlowDD',  trades: 500, pf: 2.5, netProfitPct: 0.9, maxDDPct: 0.05 },
    { name: 'D-mediocre',     trades: 500, pf: 1.1, netProfitPct: 0.4, maxDDPct: 0.10 },
    { name: 'E-heavyDD',      trades: 500, pf: 2.0, netProfitPct: 2.5, maxDDPct: 0.35 },
  ];
  const legacyScore = m => {
    const ddR = m.maxDDPct > 0 ? Math.min(m.maxDDPct / MAX_DD_PCT_LEGACY, 1) : 0;
    const ddP = 0.3 * ddR * ddR;
    return m.netProfitPct * 100 * (1 - ddP);
  };
  const scored = pop.map(m => {
    const r = computeFitness({ metrics: m, fitnessConfig: DEFAULT_FITNESS });
    return { name: m.name, new: r.score, legacy: legacyScore(m) };
  });

  const legacyRanks = [...scored].sort((a, b) => b.legacy - a.legacy).map(x => x.name);
  const newRanks    = [...scored].sort((a, b) => b.new    - a.new   ).map(x => x.name);
  console.log('    legacy ranking:', legacyRanks.join(' > '));
  console.log('    new    ranking:', newRanks.join(' > '));

  assertTrue(
    'new top is a risk-adjusted gene (C-highPFlowDD or A-good)',
    ['C-highPFlowDD', 'A-good'].includes(newRanks[0]),
    `top="${newRanks[0]}"`,
  );
  assertTrue(
    'D-mediocre stays last',
    newRanks[newRanks.length - 1] === 'D-mediocre',
    `last="${newRanks[newRanks.length - 1]}"`,
  );
  assertTrue(
    'B-highReturn drops below its legacy rank (new fitness downranks fragile return)',
    newRanks.indexOf('B-highReturn') > legacyRanks.indexOf('B-highReturn'),
    `legacy rank ${legacyRanks.indexOf('B-highReturn') + 1}, new rank ${newRanks.indexOf('B-highReturn') + 1}`,
  );
}

// ─── 14. poolRegimeBreakdowns — correctness ─────────────────
console.log('\n[14] poolRegimeBreakdowns — sum gross P/L, recompute PF on the union');
{
  // Three windows. `bear` looks mediocre in each window individually
  // (PF 0.9, 1.2, 0.8) but the POOLED PF depends on gross-P/L sums,
  // not on a mean of PFs. With these numbers the pooled PF is
  //   (40+60+20) / (45+50+25) = 120/120 = 1.0
  // Trade-weighted PF average would give a different number, so this
  // also pins the semantics: we must sum grosses, not weight ratios.
  const windows = [
    {
      bull: { trades: 20, wins: 12, pf: 1.5,  net:  50, grossProfit: 150, grossLoss: 100 },
      bear: { trades: 10, wins:  4, pf: 0.89, net:  -5, grossProfit:  40, grossLoss:  45 },
    },
    {
      bull: { trades: 15, wins:  9, pf: 1.2,  net:  20, grossProfit: 120, grossLoss: 100 },
      bear: { trades: 12, wins:  6, pf: 1.2,  net:  10, grossProfit:  60, grossLoss:  50 },
    },
    {
      bull: { trades: 10, wins:  5, pf: 1.0,  net:   0, grossProfit: 100, grossLoss: 100 },
      bear: { trades:  8, wins:  2, pf: 0.8,  net:  -5, grossProfit:  20, grossLoss:  25 },
    },
  ];
  const pooled = poolRegimeBreakdowns(windows);

  assertClose('pooled bull trades', pooled.bull.trades, 45);
  assertClose('pooled bull wins',   pooled.bull.wins,   26);
  assertClose('pooled bull gross profit', pooled.bull.grossProfit, 370);
  assertClose('pooled bull gross loss',   pooled.bull.grossLoss,   300);
  assertClose('pooled bull PF = 370/300', pooled.bull.pf, 370 / 300, 1e-9);
  assertClose('pooled bull net = 370-300', pooled.bull.net, 70);

  assertClose('pooled bear trades', pooled.bear.trades, 30);
  assertClose('pooled bear wins',   pooled.bear.wins,   12);
  assertClose('pooled bear PF = 120/120 = 1.0', pooled.bear.pf, 1.0, 1e-9);
  assertClose('pooled bear net = 120-120 = 0',  pooled.bear.net, 0);

  assertEq('empty input → {}',  poolRegimeBreakdowns([]), {});
  assertEq('null input → {}',   poolRegimeBreakdowns(null), {});
  assertEq('nonsense → {}',     poolRegimeBreakdowns('nope'), {});

  // Fallback path: a window missing grossProfit/grossLoss falls back
  // to trade-weighted PF averaging for that label.
  const mixed = poolRegimeBreakdowns([
    { bull: { trades: 10, wins: 5, pf: 2.0 } },              // no gross P/L
    { bull: { trades: 20, wins: 10, pf: 1.0 } },             // no gross P/L
  ]);
  // Weighted avg PF = (10·2.0 + 20·1.0) / (10+20) = 40/30 = 1.333...
  assertClose('fallback weighted PF', mixed.bull.pf, 40 / 30, 1e-9);
  assertClose('fallback trades',      mixed.bull.trades, 30);
}

// ─── 15. WF-aware worst-regime gate — pooling elevates the gate ──
console.log('\n[15] computeFitness — pooled OOS regimes FAIL gate even though full-data passes');
{
  // Full-data regime says the gene is fine in every regime.
  const metrics = {
    trades: 500, pf: 1.5, netProfitPct: 1.2, maxDDPct: 0.15,
    regimeBreakdown: {
      bull: { trades: 300, pf: 1.8, net:  90, wins: 170, grossProfit: 200, grossLoss: 110 },
      bear: { trades: 200, pf: 1.3, net:  30, wins: 110, grossProfit: 130, grossLoss: 100 },
    },
  };
  // But OOS-pooled across WF windows reveals a losing bear regime:
  //   bear pooled: grossProfit=10+8+12=30, grossLoss=40+45+35=120 → PF=0.25
  const wfReport = {
    wfe: 0.8,  // WFE gate passes
    windows: [
      { oosRegimeBreakdown: {
        bull: { trades: 30, wins: 18, pf: 1.8, net:  40, grossProfit:  90, grossLoss: 50 },
        bear: { trades: 15, wins:  3, pf: 0.25, net: -30, grossProfit:  10, grossLoss: 40 },
      }},
      { oosRegimeBreakdown: {
        bull: { trades: 25, wins: 14, pf: 1.6, net:  30, grossProfit:  80, grossLoss: 50 },
        bear: { trades: 12, wins:  2, pf: 0.18, net: -37, grossProfit:   8, grossLoss: 45 },
      }},
      { oosRegimeBreakdown: {
        bull: { trades: 28, wins: 15, pf: 1.7, net:  35, grossProfit:  85, grossLoss: 50 },
        bear: { trades: 14, wins:  2, pf: 0.34, net: -23, grossProfit:  12, grossLoss: 35 },
      }},
    ],
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport });
  assertTrue('eliminated by pooled-OOS worst-regime', r.eliminated);
  assertTrue('gatesFailed has worstRegime', r.gatesFailed.includes('worstRegime'));
  assertEq('regimeSource = wf-oos-pooled', r.breakdown.regimeSource, 'wf-oos-pooled');
  // Pooled bear PF = 30/120 = 0.25
  assertClose('pooled worstRegimePf', r.breakdown.worstRegimePf, 30 / 120, 1e-9);
  console.log('    reason:', r.reason);
}

// ─── 16. WF-aware gate rescues a gene with one bad IS window ─────
console.log('\n[16] computeFitness — pooled OOS regimes PASS gate where full-data would fail');
{
  // Full-data regimeBreakdown makes bear look like a loser (PF=0.8),
  // enough to trip the 1.0 floor. But the WF OOS slices show bear
  // actually generalizing: pooled bear PF = (60+50+40)/(50+40+35) = 150/125 = 1.2
  const metrics = {
    trades: 500, pf: 1.5, netProfitPct: 1.2, maxDDPct: 0.15,
    regimeBreakdown: {
      bull: { trades: 300, pf: 1.8, net: 90, wins: 170, grossProfit: 200, grossLoss: 110 },
      bear: { trades: 200, pf: 0.8, net: -20, wins:  80, grossProfit: 80,  grossLoss: 100 },
    },
  };
  const wfReport = {
    wfe: 0.8,
    windows: [
      { oosRegimeBreakdown: {
        bear: { trades: 15, wins: 8, pf: 1.2, net: 10, grossProfit: 60, grossLoss: 50 },
      }},
      { oosRegimeBreakdown: {
        bear: { trades: 12, wins: 7, pf: 1.25, net: 10, grossProfit: 50, grossLoss: 40 },
      }},
      { oosRegimeBreakdown: {
        bear: { trades: 10, wins: 5, pf: 1.14, net:  5, grossProfit: 40, grossLoss: 35 },
      }},
    ],
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport });
  assertTrue('NOT eliminated (pooled OOS rescues the gene)', !r.eliminated);
  assertEq('regimeSource = wf-oos-pooled', r.breakdown.regimeSource, 'wf-oos-pooled');
  // pooled bear PF = 150/125 = 1.2
  assertClose('pooled worstRegimePf', r.breakdown.worstRegimePf, 150 / 125, 1e-9);
}

// ─── 17. WF report without oosRegimeBreakdown → fall back ───────
console.log('\n[17] computeFitness — WF windows without oosRegimeBreakdown fall back to full-data');
{
  const metrics = {
    trades: 500, pf: 1.5, netProfitPct: 1.2, maxDDPct: 0.15,
    regimeBreakdown: {
      bull: { trades: 300, pf: 1.8, net: 90, wins: 170, grossProfit: 200, grossLoss: 110 },
      bear: { trades: 200, pf: 1.3, net: 30, wins: 110, grossProfit: 130, grossLoss: 100 },
    },
  };
  const wfReport = {
    wfe: 0.8,
    // Windows present but no oosRegimeBreakdown — pool yields {} →
    // gate falls back to metrics.regimeBreakdown.
    windows: [{ isTrades: 100 }, { isTrades: 100 }],
  };
  const r = computeFitness({ metrics, fitnessConfig: DEFAULT_FITNESS, wfReport });
  assertTrue('NOT eliminated', !r.eliminated);
  assertEq('regimeSource = full-data (no OOS regime data in WF)', r.breakdown.regimeSource, 'full-data');
  assertClose('uses full-data bear PF', r.breakdown.worstRegimePf, 1.3, 1e-9);
}

// ─── Summary ────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('FAILED');
  process.exit(1);
}
console.log('OK');
