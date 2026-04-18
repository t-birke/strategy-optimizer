/**
 * robustness-randomized-oos-check — gate for
 * `optimizer/robustness/randomizedOos.js`.
 *
 * The module builds a null distribution by resampling random 30% slices
 * of the dataset and computes where the observed OOS metric sits as a
 * percentile. This gate pins down:
 *
 *   [1] Determinism: same seed → same percentile, bit-for-bit.
 *   [2] Empty input: zero trades → neutral 50th percentile.
 *   [3] Input validation: missing `startTs` throws.
 *   [4] Median reading → percentile ≈ 50, inCentralBand = true.
 *   [5] Top-of-distribution reading → percentile ≈ 100, outside band.
 *   [6] Bottom-of-distribution reading → percentile ≈ 0, outside band.
 *   [7] Quartile ordering invariant: p25 ≤ p50 ≤ p75.
 *   [8] Slice geometry: a trade living inside exactly one 30-day window
 *       shows up only when that window is sampled — spot-check against
 *       a known single-trade bundle.
 *
 * Synthetic data: 100 trades evenly spaced across a 100-day span, with
 * pnlPct alternating +0.01 / −0.01 so the null distribution is tight
 * and symmetric. A 30% slice catches ~30 trades with a mean value near
 * zero — easy to reason about.
 *
 * Matches the style of other gates under `scripts/` (e.g.
 * `runner-spec-mode-check.js`): ✓/✗ console output, exit 1 on failure.
 */

import { randomizedOos } from '../optimizer/robustness/randomizedOos.js';

let passCount = 0;
let failCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  }
}

// ─── Synthetic data ─────────────────────────────────────────

const DAY_MS   = 86_400_000;
const startTs  = 0;
const endTs    = 100 * DAY_MS;

/**
 * 100 trades, one per day at i * DAY_MS, pnlPct alternating +0.01/−0.01.
 * Any 30% slice picks up ~30 consecutive trades and nets near zero.
 */
function buildEvenTrades() {
  const out = [];
  for (let i = 0; i < 100; i++) {
    out.push({
      direction:  i % 2 === 0 ? 'long' : 'short',
      entryTs:    i * DAY_MS,
      exitTs:     i * DAY_MS + 3600_000,
      signal:     'test',
      entryPrice: 100,
      exitPrice:  i % 2 === 0 ? 101 : 99,
      sizeAsset:  1,
      sizeUsdt:   100,
      riskUsdt:   10,
      pnl:        i % 2 === 0 ? 1 : -1,
      pnlPct:     i % 2 === 0 ? 0.01 : -0.01,
      regime:     'trend',
    });
  }
  return out;
}

const trades = buildEvenTrades();

// ─── [1] Determinism: same seed → identical percentile ──────

console.log('\n[1] Determinism');
{
  const r1 = randomizedOos(trades, 0.05, { startTs, endTs, seed: 42, nSamples: 500 });
  const r2 = randomizedOos(trades, 0.05, { startTs, endTs, seed: 42, nSamples: 500 });
  assertTrue('same seed → identical percentile',
    r1.percentile === r2.percentile,
    `p1=${r1.percentile.toFixed(4)} p2=${r2.percentile.toFixed(4)}`);
  assertTrue('same seed → identical p25/p50/p75',
    r1.p25 === r2.p25 && r1.p50 === r2.p50 && r1.p75 === r2.p75);

  // Different seed → different samples. With the symmetric alternating
  // trade list, all three quartiles land exactly at 0 regardless of
  // seed. So we probe seed sensitivity with a CLUSTERED trade list:
  // all winners packed into the first 30 days, nothing in days 30–100.
  // Now each slice's netPct depends on HOW MUCH OF THE CLUSTER it
  // catches, which depends on slice start — i.e. on the PRNG.
  const clustered = Array.from({ length: 30 }, (_, i) => ({
    entryTs: i * DAY_MS, pnlPct: 0.01,
  }));
  const r2b = randomizedOos(clustered, 0, { startTs, endTs, seed: 42, nSamples: 500 });
  const r3  = randomizedOos(clustered, 0, { startTs, endTs, seed: 7,  nSamples: 500 });
  assertTrue('different seed → at least one quartile differs',
    r2b.p25 !== r3.p25 || r2b.p50 !== r3.p50 || r2b.p75 !== r3.p75,
    `s42: [${r2b.p25},${r2b.p50},${r2b.p75}] s7: [${r3.p25},${r3.p50},${r3.p75}]`);
}

// ─── [2] Empty tradeList → neutral ──────────────────────────

console.log('\n[2] Empty tradeList');
{
  const r = randomizedOos([], 12.34, { startTs, endTs });
  assertTrue('empty → percentile = 50', r.percentile === 50);
  assertTrue('empty → inCentralBand = true', r.inCentralBand === true);
  assertTrue('empty → p25 = p50 = p75 = 0',
    r.p25 === 0 && r.p50 === 0 && r.p75 === 0);
  assertTrue('empty → metric echoed', r.metric === 'netPct');
  assertTrue('empty → nSamples echoed', r.nSamples === 1000);
}

// ─── [3] Missing startTs/endTs throws ──────────────────────

console.log('\n[3] Input validation');
{
  let threw = false;
  try {
    randomizedOos(trades, 0.05, { endTs });  // no startTs
  } catch (e) {
    threw = /startTs/.test(e.message);
  }
  assertTrue('missing startTs throws', threw);

  let threw2 = false;
  try {
    randomizedOos(trades, 0.05, { startTs });  // no endTs
  } catch (e) {
    threw2 = /endTs/.test(e.message);
  }
  assertTrue('missing endTs throws', threw2);
}

// ─── [4] Actual = median → percentile ≈ 50, in band ────────

console.log('\n[4] Actual ≈ median → central band');
{
  // Run once to learn the distribution's median, then ask where that
  // median sits. By construction (alternating ±0.01, uniform in time),
  // p50 is very close to 0.
  const r0 = randomizedOos(trades, 0, { startTs, endTs, seed: 42 });
  const r  = randomizedOos(trades, r0.p50, { startTs, endTs, seed: 42 });
  assertTrue('actual = p50 → percentile within [40, 60]',
    r.percentile >= 40 && r.percentile <= 60,
    `percentile=${r.percentile.toFixed(2)}, p50=${r0.p50.toFixed(4)}`);
  assertTrue('actual = p50 → inCentralBand = true', r.inCentralBand === true);
}

// ─── [5] Actual ≫ max → percentile ≈ 100, outside band ─────

console.log('\n[5] Actual above all samples → top of distribution');
{
  const r = randomizedOos(trades, 1e9, { startTs, endTs, seed: 42 });
  assertTrue('actual >> max → percentile = 100',
    r.percentile === 100, `percentile=${r.percentile}`);
  assertTrue('actual >> max → inCentralBand = false',
    r.inCentralBand === false);
}

// ─── [6] Actual ≪ min → percentile ≈ 0, outside band ───────

console.log('\n[6] Actual below all samples → bottom of distribution');
{
  const r = randomizedOos(trades, -1e9, { startTs, endTs, seed: 42 });
  assertTrue('actual << min → percentile = 0',
    r.percentile === 0, `percentile=${r.percentile}`);
  assertTrue('actual << min → inCentralBand = false',
    r.inCentralBand === false);
}

// ─── [7] Ordering invariant: p25 ≤ p50 ≤ p75 ───────────────

console.log('\n[7] Quartile ordering');
{
  const r = randomizedOos(trades, 0, { startTs, endTs, seed: 42 });
  assertTrue('p25 ≤ p50', r.p25 <= r.p50, `p25=${r.p25} p50=${r.p50}`);
  assertTrue('p50 ≤ p75', r.p50 <= r.p75, `p50=${r.p50} p75=${r.p75}`);
}

// ─── [8] Slice geometry spot-check ──────────────────────────
//
// Build a one-trade list with entryTs smack in the middle of the 100-day
// dataset. A 30% slice has span = 30 days. Many slices will include the
// trade, many won't — so the null distribution should show a mixture of
// {0, +0.01} values, not all zeros. That's proof the slicing math
// actually uses sliceFraction.

console.log('\n[8] Slice geometry — sliceFraction controls coverage');
{
  const singleTrade = [{
    direction: 'long',
    entryTs:   50 * DAY_MS,       // dead center
    exitTs:    50 * DAY_MS + 3600_000,
    signal:    'test',
    entryPrice: 100, exitPrice: 101,
    sizeAsset: 1, sizeUsdt: 100, riskUsdt: 10,
    pnl: 1, pnlPct: 0.02, regime: 'trend',
  }];

  // With sliceFraction=0.3 the slice is 30 days long. For the slice to
  // contain day 50, its start must be in (20, 50] days — that's 30 days
  // of start positions out of a total start range of 70 days. So ~42.8%
  // of samples should catch the trade and yield pnlPct = 0.02; the rest
  // yield 0. Hence p75 should be 0.02 (since > 25% of samples are 0.02)
  // and p25 should be 0. We check both.
  const r = randomizedOos(singleTrade, 0.02, {
    startTs, endTs, seed: 42, sliceFraction: 0.3, nSamples: 2000,
  });
  assertTrue('single-trade: p25 = 0 (slice usually misses)',
    r.p25 === 0, `p25=${r.p25}`);
  assertTrue('single-trade: p75 = 0.02 (slice sometimes catches)',
    Math.abs(r.p75 - 0.02) < 1e-12, `p75=${r.p75}`);

  // Tiny sliceFraction → slice rarely catches the trade. The 75th
  // percentile should now be 0 (since far less than 25% of samples
  // catch it). This confirms sliceFraction is an active knob.
  const rNarrow = randomizedOos(singleTrade, 0.02, {
    startTs, endTs, seed: 42, sliceFraction: 0.05, nSamples: 2000,
  });
  assertTrue('narrow slice (0.05): p75 = 0 (rare hit)',
    rNarrow.p75 === 0, `p75=${rNarrow.p75}`);
}

// ─── Summary ───────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.error('FAILED');
  process.exit(1);
}
console.log('OK');
process.exit(0);
