/**
 * robustness-mc-dd-reshuffle-check — Phase 6.1 gate.
 *
 * Unit-test gate for `optimizer/robustness/mcDdReshuffle.js`. Verifies the
 * Monte Carlo drawdown reshuffle module against its contract:
 *
 *   [1] Determinism — same seed twice → identical P95 (required for fitness
 *       determinism; the GA will otherwise chase PRNG noise instead of edge).
 *   [2] Seed sensitivity — different seeds → different P95 (sanity; if the
 *       seed doesn't change anything, the RNG isn't wired).
 *   [3] Empty / invalid trade list → all-zero result (no crashes in the
 *       composition multiplier for pathological genes).
 *   [4] Monotonic-win series → near-zero P95 DD (shuffling all-positive
 *       pnl can't manufacture drawdown).
 *   [5] Big-loss pattern → measurable P95 DD (a single large loss produces
 *       a visible DD regardless of where it lands in the shuffle).
 *   [6] Ordering invariant — p50 ≤ p95 ≤ p99 (percentile monotonicity).
 *   [7] nSamples echoed back — contract field is populated correctly.
 *
 * Runs on synthetic trade lists — no DB, no workers, safe in any CI lane.
 */

import { mcDdReshuffle } from '../optimizer/robustness/mcDdReshuffle.js';

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  \u2713 ${label}${details ? ' \u2014 ' + details : ''}`); }
  else      { failCount++; console.log(`  \u2717 ${label}${details ? ' \u2014 ' + details : ''}`); }
}

function assertEq(label, a, b) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passCount++; console.log(`  \u2713 ${label}`); }
  else    {
    failCount++;
    console.log(`  \u2717 ${label}\n    actual:   ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
  }
}

// ─── Synthetic trade-list helpers ─────────────────────────────
//
// The module only reads `pnlPct`; other fields are included so the shape
// matches what runtime.js emits (runtime's trade objects carry direction,
// entryTs, exitTs, signal, entryPrice, exitPrice, sizeAsset, sizeUsdt,
// riskUsdt, pnl, pnlPct, regime). Using the full shape guards against
// accidental reliance on specific fields.

function mkTrade(pnlPct, i = 0) {
  return {
    direction: 'long',
    entryTs:   1_700_000_000_000 + i * 3_600_000,
    exitTs:    1_700_000_000_000 + (i + 1) * 3_600_000,
    signal:    'synthetic',
    entryPrice: 100,
    exitPrice:  100 * (1 + pnlPct),
    sizeAsset:  1,
    sizeUsdt:   100,
    riskUsdt:   1,
    pnl:        pnlPct * 100,
    pnlPct,
    regime:     'none',
  };
}

// A mixed realistic-ish series: mostly small wins with occasional small
// losses and one medium loss. 50 trades — long enough that shuffling
// produces meaningful reordering.
function buildMixedSeries() {
  const trades = [];
  const pattern = [
    +0.010, +0.015, +0.008, -0.012, +0.020, +0.005, -0.008, +0.018,
    +0.007, -0.005, +0.014, +0.022, -0.010, +0.006, +0.011, -0.030,
    +0.009, +0.016, -0.007, +0.013, +0.004, -0.015, +0.019, +0.008,
    +0.012, -0.009, +0.017, +0.006, -0.011, +0.021, +0.010, +0.003,
    -0.006, +0.014, +0.008, +0.015, -0.013, +0.011, +0.019, +0.007,
    -0.004, +0.016, +0.012, -0.008, +0.020, +0.005, +0.013, -0.010,
    +0.018, +0.009,
  ];
  for (let i = 0; i < pattern.length; i++) trades.push(mkTrade(pattern[i], i));
  return trades;
}

function buildMonotonicWinSeries(n = 30, step = 0.01) {
  const trades = [];
  for (let i = 0; i < n; i++) trades.push(mkTrade(step, i));
  return trades;
}

function buildBigLossSeries(n = 30) {
  // 29 small wins (+0.5% each ≈ +14.5% total) plus one big -15% loss.
  // Regardless of shuffle position, the big loss produces a DD in the
  // 10%+ range from whatever the running peak happens to be.
  const trades = [];
  for (let i = 0; i < n - 1; i++) trades.push(mkTrade(+0.005, i));
  trades.push(mkTrade(-0.15, n - 1));
  return trades;
}

// ─── [1] Determinism ──────────────────────────────────────────

console.log('\n[1] Determinism — same seed twice \u2192 identical output');

{
  const trades = buildMixedSeries();
  const a = mcDdReshuffle(trades, { nSamples: 1000, seed: 42 });
  const b = mcDdReshuffle(trades, { nSamples: 1000, seed: 42 });
  assertEq('seed=42 twice \u2192 identical p95', a.p95DdPct, b.p95DdPct);
  assertEq('seed=42 twice \u2192 identical full result', a, b);
}

// ─── [2] Seed sensitivity ─────────────────────────────────────

console.log('\n[2] Different seeds \u2192 different output');

{
  const trades = buildMixedSeries();
  const a = mcDdReshuffle(trades, { nSamples: 1000, seed: 42 });
  const b = mcDdReshuffle(trades, { nSamples: 1000, seed: 9999 });
  // Two independent 1000-sample MC runs on the same pnl set will produce
  // different p95 values; identical p95 would mean the seed isn't wired.
  assertTrue('seed=42 vs seed=9999 \u2192 different p95',
    a.p95DdPct !== b.p95DdPct,
    `p95@42=${a.p95DdPct.toFixed(6)} p95@9999=${b.p95DdPct.toFixed(6)}`);
}

// ─── [3] Empty / invalid trade list → all zero ────────────────

console.log('\n[3] Empty / invalid trade list \u2192 all-zero result');

{
  const z = { p50DdPct: 0, p95DdPct: 0, p99DdPct: 0, nSamples: 0 };
  assertEq('[] \u2192 zero result',          mcDdReshuffle([]),        z);
  assertEq('null \u2192 zero result',        mcDdReshuffle(null),      z);
  assertEq('undefined \u2192 zero result',   mcDdReshuffle(undefined), z);
  assertEq('non-array \u2192 zero result',   mcDdReshuffle({}),        z);

  // Trade list with no finite pnlPct values also returns zero —
  // otherwise NaN propagates through the equity curve and poisons
  // every sample's DD.
  const junk = [{ pnlPct: NaN }, { pnlPct: 'x' }, { pnl: 1 }]; // no valid pnlPct
  assertEq('all-invalid pnlPct \u2192 zero result', mcDdReshuffle(junk), z);
}

// ─── [4] Monotonic wins → near-zero P95 DD ────────────────────

console.log('\n[4] Monotonic-win series \u2192 near-zero P95 DD');

{
  // If every trade is a win, the equity curve is monotonically increasing
  // for ANY permutation — maxDD is zero by definition. P95 must also be
  // zero (not just small).
  const trades = buildMonotonicWinSeries(30, 0.01);
  const r = mcDdReshuffle(trades, { nSamples: 500, seed: 7 });
  assertTrue('all-wins \u2192 p95 \u2248 0',
    r.p95DdPct < 1e-12,
    `p95=${r.p95DdPct}`);
  assertTrue('all-wins \u2192 p99 \u2248 0',
    r.p99DdPct < 1e-12,
    `p99=${r.p99DdPct}`);
}

// ─── [5] Big-loss pattern → measurable P95 DD ─────────────────

console.log('\n[5] Known pattern with one big loss \u2192 measurable P95 DD');

{
  // Deterministic lower bound: the -15% trade produces a DD of AT LEAST
  // 15% / (1 + 0.005 * k) for k small wins preceding it in the shuffle.
  // When the big loss falls at position 0 → DD = 15% / 1.0 = 15%. When
  // it falls last (all 29 wins first) → equity peaks near 1.145, then
  // drops to 0.995 → DD ≈ (1.145 − 0.995) / 1.145 ≈ 13.1%. Either way,
  // the DD is in the ~13–15% band. P95 lives in that band.
  const trades = buildBigLossSeries(30);
  const r = mcDdReshuffle(trades, { nSamples: 1000, seed: 123 });
  assertTrue('big-loss series \u2192 p95 > 5%',
    r.p95DdPct > 0.05,
    `p95=${(r.p95DdPct * 100).toFixed(3)}%`);
  assertTrue('big-loss series \u2192 p95 < 20%',
    r.p95DdPct < 0.20,
    `p95=${(r.p95DdPct * 100).toFixed(3)}%`);
}

// ─── [6] Ordering invariant: p50 ≤ p95 ≤ p99 ──────────────────

console.log('\n[6] Percentile ordering invariant');

{
  const trades = buildMixedSeries();
  const r = mcDdReshuffle(trades, { nSamples: 1000, seed: 42 });
  assertTrue('p50 \u2264 p95',
    r.p50DdPct <= r.p95DdPct,
    `p50=${r.p50DdPct.toFixed(6)} p95=${r.p95DdPct.toFixed(6)}`);
  assertTrue('p95 \u2264 p99',
    r.p95DdPct <= r.p99DdPct,
    `p95=${r.p95DdPct.toFixed(6)} p99=${r.p99DdPct.toFixed(6)}`);
}

// ─── [7] nSamples echoed back ─────────────────────────────────

console.log('\n[7] nSamples field echoed back');

{
  const trades = buildMixedSeries();
  const r100 = mcDdReshuffle(trades, { nSamples: 100,  seed: 1 });
  const r500 = mcDdReshuffle(trades, { nSamples: 500,  seed: 1 });
  assertEq('nSamples=100 echoed', r100.nSamples, 100);
  assertEq('nSamples=500 echoed', r500.nSamples, 500);
}

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'\u2500'.repeat(60)}`);
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) { console.log('FAILED'); process.exit(1); }
console.log('OK');
