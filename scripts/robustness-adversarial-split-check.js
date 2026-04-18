/**
 * robustness-adversarial-split-check — exercise every branch of
 * `optimizer/robustness/adversarialSplit.js` against synthetic trade
 * lists. No backtest, no candles: pure inputs → pure outputs. Run as:
 *
 *     node scripts/robustness-adversarial-split-check.js
 *
 * Exits 0 on success, 1 on any assertion failure.
 *
 * Covers: determinism, seed sensitivity, empty / single-trade edge
 * cases, the "diffuse edge → low concentration" property, and the
 * "whale winner → high concentration" property. See `docs/backlog.md`
 * §6.1 term 5 for the semantics.
 *
 * Matches the synthetic-case style of `scripts/fitness-check.js` and
 * `scripts/walk-forward-check.js` — same assert helpers, same log
 * formatting, same exit convention.
 */

import { adversarialSplit } from '../optimizer/robustness/adversarialSplit.js';

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

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Build a list of N trades with small +/- pnlPct values drawn from a
 * deterministic hash — roughly 60% winners, all of similar magnitude.
 * This is the "diffuse edge" shape: no single trade dominates the net,
 * and the pnl sequence has no correlation with trade index (so a
 * random 50/50 split can't systematically over-sample large pnl in one
 * group).
 */
function diffuseTrades(n, base = 0.01) {
  // Small deterministic PRNG so trades look i.i.d. but tests stay
  // reproducible.
  let s = 0x9E3779B9;
  const rand = () => {
    s = Math.imul(s ^ (s >>> 16), 2246822507) | 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) | 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const sign = rand() < 0.6 ? 1 : -1;        // ~60% winners
    const mag  = base * (0.8 + 0.4 * rand());  // magnitude in [0.8, 1.2] * base
    out.push({ pnlPct: sign * mag });
  }
  return out;
}

/** Build a trade list where one giant winner dwarfs all losers. */
function whaleTrades({ nLosers = 20, loserPnl = -0.005, whalePnl = 1.0 } = {}) {
  const out = [];
  for (let i = 0; i < nLosers; i++) out.push({ pnlPct: loserPnl });
  out.push({ pnlPct: whalePnl });
  return out;
}

// ═══════════════════════════════════════════════════════════
// [1] Determinism — same seed → identical result
// ═══════════════════════════════════════════════════════════
console.log('\n[1] determinism: same seed → identical output');
{
  const trades = diffuseTrades(200);
  const r1 = adversarialSplit(trades, { seed: 42 });
  const r2 = adversarialSplit(trades, { seed: 42 });
  assertEq('full result identical on repeat', r1, r2);
  assertClose('gap identical',           r1.gap,           r2.gap);
  assertClose('concentration identical', r1.concentration, r2.concentration);
}

// ═══════════════════════════════════════════════════════════
// [2] Seed sensitivity — different seeds → different splits
// ═══════════════════════════════════════════════════════════
console.log('\n[2] seed sensitivity: different seeds diverge');
{
  const trades = diffuseTrades(200);
  const rA = adversarialSplit(trades, { seed: 1 });
  const rB = adversarialSplit(trades, { seed: 2 });
  // With 200 independent Bernoullis, the chance of two different seeds
  // landing on IDENTICAL sizeA is vanishingly small — assert they differ.
  assertTrue('different seeds → different sizeA',
    rA.sizeA !== rB.sizeA,
    `seed1.sizeA=${rA.sizeA} vs seed2.sizeA=${rB.sizeA}`);
  // Conservation still holds for both.
  assertEq('seed 1: sizeA + sizeB = N', rA.sizeA + rA.sizeB, 200);
  assertEq('seed 2: sizeA + sizeB = N', rB.sizeA + rB.sizeB, 200);
}

// ═══════════════════════════════════════════════════════════
// [3] Empty trade list
// ═══════════════════════════════════════════════════════════
console.log('\n[3] empty tradeList → all zeros');
{
  const r = adversarialSplit([]);
  assertEq('full zero object', r, {
    netA: 0, netB: 0, netTotal: 0, gap: 0, concentration: 0, sizeA: 0, sizeB: 0,
  });
  // Also accept a null/undefined list defensively.
  const rN = adversarialSplit(null);
  assertEq('null list → same zeros', rN, {
    netA: 0, netB: 0, netTotal: 0, gap: 0, concentration: 0, sizeA: 0, sizeB: 0,
  });
}

// ═══════════════════════════════════════════════════════════
// [4] Single trade → maximally concentrated
// ═══════════════════════════════════════════════════════════
console.log('\n[4] single trade → sizeA=1, sizeB=0, concentration=1');
{
  const r = adversarialSplit([{ pnlPct: 0.25 }]);
  assertEq('sizeA=1',         r.sizeA, 1);
  assertEq('sizeB=0',         r.sizeB, 0);
  assertClose('netA = pnl',   r.netA, 0.25);
  assertClose('netB = 0',     r.netB, 0);
  assertClose('netTotal = pnl', r.netTotal, 0.25);
  assertClose('gap = 1',      r.gap, 1);
  assertClose('concentration = 1', r.concentration, 1);

  // Negative single trade — same concentration.
  const rNeg = adversarialSplit([{ pnlPct: -0.1 }]);
  assertClose('negative single: concentration=1', rNeg.concentration, 1);
}

// ═══════════════════════════════════════════════════════════
// [5] Diffuse edge → low concentration
// ═══════════════════════════════════════════════════════════
console.log('\n[5] 1000 small +/- pnl trades → low concentration (< 0.2)');
{
  const trades = diffuseTrades(1000);
  const r = adversarialSplit(trades, { seed: 42 });
  console.log(`    sizeA=${r.sizeA}, sizeB=${r.sizeB}, netA=${r.netA.toFixed(4)}, ` +
              `netB=${r.netB.toFixed(4)}, netTotal=${r.netTotal.toFixed(4)}, ` +
              `gap=${r.gap.toFixed(4)}, concentration=${r.concentration.toFixed(4)}`);
  assertTrue('diffuse edge → concentration < 0.2',
    r.concentration < 0.2,
    `concentration=${r.concentration.toFixed(4)}`);
  // Sanity: sizes should be roughly balanced (|sizeA − 500| not huge).
  assertTrue('diffuse: sizes roughly balanced',
    Math.abs(r.sizeA - 500) < 60,
    `sizeA=${r.sizeA} (expected ~500 ± 60 for Bernoulli(0.5, 1000))`);
}

// ═══════════════════════════════════════════════════════════
// [6] Whale winner → high concentration
// ═══════════════════════════════════════════════════════════
console.log('\n[6] one whale winner + small losers → high concentration (> 0.5)');
{
  const trades = whaleTrades({ nLosers: 20, loserPnl: -0.005, whalePnl: 1.0 });
  // Run across several seeds; a random 50/50 split will MOSTLY put the
  // whale in one group, making the per-group nets wildly unequal. Assert
  // the MEDIAN concentration is clearly above the diffuse-edge level.
  const concentrations = [];
  for (let s = 1; s <= 20; s++) {
    const r = adversarialSplit(trades, { seed: s });
    concentrations.push(r.concentration);
  }
  concentrations.sort((a, b) => a - b);
  const median = concentrations[Math.floor(concentrations.length / 2)];
  console.log(`    seeds 1..20 median concentration = ${median.toFixed(4)}`);
  console.log(`    min=${concentrations[0].toFixed(4)}, max=${concentrations[concentrations.length - 1].toFixed(4)}`);
  assertTrue('whale: median concentration > 0.5',
    median > 0.5,
    `median=${median.toFixed(4)}`);
  // Stronger comparison: whale runs should clear diffuse-edge runs by a
  // wide margin. Diffuse-edge concentration above was < 0.2; whale median
  // should be well above that.
  assertTrue('whale clearly more concentrated than diffuse',
    median > 0.3,
    `whale-median=${median.toFixed(4)}`);
}

// ═══════════════════════════════════════════════════════════
// [7] Reproducibility across 5 back-to-back calls
// ═══════════════════════════════════════════════════════════
console.log('\n[7] reproducibility: 5 calls with same seed → identical');
{
  const trades = diffuseTrades(500);
  const baseline = adversarialSplit(trades, { seed: 777 });
  let allMatch = true;
  for (let i = 0; i < 5; i++) {
    const r = adversarialSplit(trades, { seed: 777 });
    if (JSON.stringify(r) !== JSON.stringify(baseline)) {
      allMatch = false;
      break;
    }
  }
  assertTrue('5 back-to-back calls identical', allMatch);
}

// ═══════════════════════════════════════════════════════════
// [8] Conservation: sizeA + sizeB = tradeList.length
// ═══════════════════════════════════════════════════════════
console.log('\n[8] conservation: sizeA + sizeB = N, netA + netB = netTotal');
{
  const sizes = [2, 17, 100, 1000];
  for (const n of sizes) {
    const trades = diffuseTrades(n);
    const r = adversarialSplit(trades, { seed: n * 13 });
    assertEq(`n=${n}: sizeA + sizeB = n`, r.sizeA + r.sizeB, n);
    assertClose(`n=${n}: netA + netB = netTotal`, r.netA + r.netB, r.netTotal, 1e-12);
  }
}

// ═══════════════════════════════════════════════════════════
// [9] Default seed is 42 (reproducible unit tests)
// ═══════════════════════════════════════════════════════════
console.log('\n[9] default seed = 42');
{
  const trades = diffuseTrades(100);
  const rDefault = adversarialSplit(trades);
  const rExplicit = adversarialSplit(trades, { seed: 42 });
  assertEq('omitted seed equals seed=42', rDefault, rExplicit);
}

// ═══════════════════════════════════════════════════════════
// [10] concentration is always in [0, 1]
// ═══════════════════════════════════════════════════════════
console.log('\n[10] concentration always in [0, 1]');
{
  // Run on a zoo of trade shapes to make sure clipping works.
  const shapes = [
    diffuseTrades(100),
    whaleTrades(),
    whaleTrades({ nLosers: 5, loserPnl: -0.9, whalePnl: 5 }),
    [{ pnlPct: 0 }, { pnlPct: 0 }, { pnlPct: 0 }],       // all-zero
    [{ pnlPct: 1 }, { pnlPct: -1 }],                      // netTotal near 0
  ];
  let allInRange = true;
  let worst = { concentration: -1, seed: -1, n: -1 };
  for (const trades of shapes) {
    for (let s = 1; s <= 5; s++) {
      const r = adversarialSplit(trades, { seed: s });
      if (!(r.concentration >= 0 && r.concentration <= 1)) {
        allInRange = false;
        worst = { concentration: r.concentration, seed: s, n: trades.length };
      }
    }
  }
  assertTrue('concentration clipped to [0, 1] across all shapes',
    allInRange,
    allInRange ? '' : `violating case: ${JSON.stringify(worst)}`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('FAILED');
  process.exit(1);
}
console.log('OK');
