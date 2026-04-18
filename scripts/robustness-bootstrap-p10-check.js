/**
 * robustness-bootstrap-p10-check — Phase 6.1 gate for `bootstrapP10.js`.
 *
 * Verifies the invariants of the bootstrap-with-replacement robustness
 * term on synthetic trade lists:
 *
 *   [1] Determinism — same seed → identical P10/P50/P90 across two calls.
 *   [2] Seed sensitivity — different seeds → different P10 (otherwise
 *       the PRNG isn't being reseeded).
 *   [3] Empty trade list → all-zero result (no throw).
 *   [4] All-positive returns → P10 > 0 (a uniformly-positive edge
 *       survives any resample; this is the "general effect" case).
 *   [5] Concentration catch — one huge winner carrying the total →
 *       P10 near zero (most samples miss the winner because one trade
 *       out of N gets drawn only with probability ~1/N per slot).
 *   [6] Ordering invariant — P10 ≤ P50 ≤ P90 on every realization.
 *   [7] Shape invariants — sampleSize mirrors trades.length, nSamples
 *       mirrors the option.
 *   [8] Median sanity — on a symmetric distribution, P50 should sit
 *       near the historical total net (bootstrap is unbiased in
 *       expectation).
 *
 * Synthetic-data only — no DB, no workers, no runtime. Safe in CI.
 */

import { bootstrapP10 } from '../optimizer/robustness/bootstrapP10.js';

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}

// ─── Synthetic trade-list builders ──────────────────────────

function tradesFromReturns(pnlPcts) {
  // Minimal shape — bootstrapP10 reads only pnlPct. Other fields are
  // omitted by design so this test doesn't drift with runtime shape.
  return pnlPcts.map((pnlPct, i) => ({
    direction:  i % 2 === 0 ? 'LONG' : 'SHORT',
    entryTs:    i,
    exitTs:     i + 1,
    signal:     'test',
    entryPrice: 100,
    exitPrice:  100 * (1 + pnlPct),
    sizeAsset:  1,
    sizeUsdt:   100,
    riskUsdt:   1,
    pnl:        pnlPct * 100,
    pnlPct,
    regime:     'unknown',
  }));
}

// ─── [1] Determinism — same seed → identical output ────────

console.log('\n[1] Determinism');
{
  const trades = tradesFromReturns([0.01, -0.005, 0.02, -0.01, 0.015, 0.008, -0.003, 0.012]);
  const a = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  const b = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  assertTrue('same seed → identical p10', a.p10NetPct === b.p10NetPct,
    `a=${a.p10NetPct} b=${b.p10NetPct}`);
  assertTrue('same seed → identical p50', a.p50NetPct === b.p50NetPct);
  assertTrue('same seed → identical p90', a.p90NetPct === b.p90NetPct);
}

// ─── [2] Seed sensitivity ──────────────────────────────────

console.log('\n[2] Seed sensitivity');
{
  // A sufficiently diverse return distribution so different resample
  // draws produce measurably different P10s (not just floating-point
  // noise). 40 distinct values prevents tied-rank collapse.
  const returns = Array.from({ length: 40 }, (_, i) =>
    (i % 4 === 0 ? -0.015 : 0.004) + (i * 0.0003) - 0.005
  );
  const trades = tradesFromReturns(returns);
  const a = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  const b = bootstrapP10(trades, { nSamples: 1000, seed: 99 });
  assertTrue('different seeds → different p10',
    Math.abs(a.p10NetPct - b.p10NetPct) > 1e-6,
    `seed42=${a.p10NetPct.toFixed(6)} seed99=${b.p10NetPct.toFixed(6)}`);
}

// ─── [3] Empty / invalid inputs ────────────────────────────

console.log('\n[3] Empty / invalid input');
{
  const empty = bootstrapP10([]);
  assertTrue('empty → p10=0', empty.p10NetPct === 0);
  assertTrue('empty → p50=0', empty.p50NetPct === 0);
  assertTrue('empty → p90=0', empty.p90NetPct === 0);
  assertTrue('empty → sampleSize=0', empty.sampleSize === 0);
  assertTrue('empty → nSamples=0', empty.nSamples === 0);

  const nullIn = bootstrapP10(null);
  assertTrue('null → all-zero result',
    nullIn.p10NetPct === 0 && nullIn.p50NetPct === 0 && nullIn.p90NetPct === 0);
}

// ─── [4] All-positive returns → P10 > 0 (general edge) ─────

console.log('\n[4] All-positive returns → p10 > 0');
{
  // 50 trades, each +0.5%. Every bootstrap sample is a sum of 50
  // positive numbers → the minimum possible is still well above zero.
  const trades = tradesFromReturns(Array.from({ length: 50 }, () => 0.005));
  const r = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  assertTrue('all-positive → p10 > 0',
    r.p10NetPct > 0,
    `p10=${r.p10NetPct.toFixed(4)}`);
  // Sanity — on a constant distribution, all samples sum to the same
  // total, so P10 = P50 = P90 = N × constant.
  assertTrue('constant returns → p10 ≈ p50 ≈ p90',
    Math.abs(r.p10NetPct - r.p50NetPct) < 1e-9 &&
    Math.abs(r.p50NetPct - r.p90NetPct) < 1e-9);
}

// ─── [5] Concentration catch — one huge winner ─────────────

console.log('\n[5] Concentration catch — one huge winner carries the total');
{
  // 50 trades: 49 tiny losers (-0.1% each = -4.9%) + 1 huge winner
  // (+10%). Historical net = +5.1%, clearly profitable. But the edge
  // is 100% carried by one specific trade: any bootstrap sample that
  // fails to draw that trade sums to ~-4.9%. The winner is drawn ≥1×
  // with probability 1 − (49/50)^50 ≈ 63.6%, so ~36% of samples miss
  // it entirely → P10 should land in the negative/near-zero region.
  const returns = Array.from({ length: 49 }, () => -0.001);
  returns.push(0.10);
  const trades = tradesFromReturns(returns);
  const r = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  const historicalNet = returns.reduce((a, b) => a + b, 0);
  assertTrue('historical net profitable but concentrated',
    historicalNet > 0,
    `net=${historicalNet.toFixed(4)}`);
  assertTrue('concentrated winner → p10 < historical net',
    r.p10NetPct < historicalNet,
    `p10=${r.p10NetPct.toFixed(4)} hist=${historicalNet.toFixed(4)}`);
  assertTrue('concentrated winner → p10 near zero or below',
    r.p10NetPct < 0.01,
    `p10=${r.p10NetPct.toFixed(4)}`);
}

// ─── [6] Ordering invariant ────────────────────────────────

console.log('\n[6] Ordering invariant — p10 ≤ p50 ≤ p90');
{
  // Mix of winners and losers, random-ish distribution.
  const returns = [
    0.012, -0.008, 0.02, -0.003, 0.015, 0.009, -0.011, 0.004,
    0.018, -0.006, 0.025, -0.014, 0.007, 0.011, -0.005, 0.016,
    -0.009, 0.013, 0.006, -0.002, 0.022, -0.017, 0.010, 0.003,
    -0.012, 0.019, 0.008, -0.007, 0.014, 0.005,
  ];
  const trades = tradesFromReturns(returns);
  for (const seed of [1, 42, 100, 7777]) {
    const r = bootstrapP10(trades, { nSamples: 1000, seed });
    assertTrue(`seed=${seed}: p10 ≤ p50 ≤ p90`,
      r.p10NetPct <= r.p50NetPct && r.p50NetPct <= r.p90NetPct,
      `p10=${r.p10NetPct.toFixed(4)} p50=${r.p50NetPct.toFixed(4)} p90=${r.p90NetPct.toFixed(4)}`);
  }
}

// ─── [7] Shape invariants ──────────────────────────────────

console.log('\n[7] Shape invariants — sampleSize, nSamples');
{
  const trades = tradesFromReturns([0.01, -0.005, 0.008, -0.002, 0.006]);
  const r = bootstrapP10(trades, { nSamples: 500, seed: 42 });
  assertTrue('sampleSize mirrors trades.length',
    r.sampleSize === trades.length,
    `sampleSize=${r.sampleSize} trades=${trades.length}`);
  assertTrue('nSamples mirrors option',
    r.nSamples === 500,
    `nSamples=${r.nSamples}`);
}

// ─── [8] Median sanity — unbiased in expectation ───────────

console.log('\n[8] Median sanity — p50 ≈ historical total');
{
  // Symmetric-ish distribution of 100 trades, approximate mean 0.3%.
  // The bootstrap mean converges to the historical mean × N; median
  // is near mean for roughly symmetric distributions. We allow a
  // generous tolerance because at N=100 trades × 1000 samples the
  // median will still wobble.
  const returns = Array.from({ length: 100 }, (_, i) =>
    0.003 + (i % 7 === 0 ? -0.01 : 0) + (i % 5 === 0 ? 0.008 : 0)
  );
  const trades = tradesFromReturns(returns);
  const historicalNet = returns.reduce((a, b) => a + b, 0);
  const r = bootstrapP10(trades, { nSamples: 1000, seed: 42 });
  const rel = Math.abs(r.p50NetPct - historicalNet) / Math.abs(historicalNet);
  assertTrue('p50 within 20% of historical net',
    rel < 0.2,
    `p50=${r.p50NetPct.toFixed(4)} hist=${historicalNet.toFixed(4)} rel=${rel.toFixed(3)}`);
}

// ─── Summary ────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) { console.log('FAILED'); process.exit(1); }
console.log('OK');
process.exit(0);
