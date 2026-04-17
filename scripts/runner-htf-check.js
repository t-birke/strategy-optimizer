/**
 * runner-htf-check — Phase 2.6 gate.
 *
 * Verifies the three pieces of multi-TF transport added in Phase 2.6:
 *
 *   [1] `packHtfPayload` / `unpackHtfPayloads` round-trip preserves
 *       candle arrays and htfBarIndex bit-for-bit (no TypedArray
 *       coercion bugs or byte-offset mistakes).
 *
 *   [2] `sliceHtfs` / `sliceBundle` correctly slice each HTF's
 *       `htfBarIndex` to the base slice length. Candle arrays on the
 *       HTF stay full. Lookups inside the slice return the same
 *       values as lookups on the unsliced bundle.
 *
 *   [3] An end-to-end bundle built by packing → unpacking → slicing
 *       produces the SAME htfBarIndex values at every base bar that a
 *       direct `makeHtfBarIndex` call would produce. This is the
 *       runner-worker-walkforward contract: the worker and the
 *       in-process walkforward see an HTF bundle indistinguishable
 *       from one built by `engine/data-bundle.js`.
 *
 * This gate is pure-JS: no DB, no workers, all synthetic data. An
 * end-to-end "runOptimization on a multi-TF spec" test will land when
 * Phase 3's first HTF-using block (e.g. `htfTrendFilter`) is added —
 * we can't meaningfully exercise the runner + worker pipeline until
 * some spec actually declares a non-base indicator dep.
 */

import { makeHtfBarIndex, HTF_NONE } from '../engine/data-bundle.js';
import {
  packHtfPayload,
  unpackHtfPayload,
  unpackHtfPayloads,
} from '../optimizer/htf-transport.js';
import {
  sliceBundle,
  sliceHtfs,
} from '../optimizer/walk-forward.js';

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

function assertArraysEq(label, a, b) {
  if (a.length !== b.length) {
    failCount++;
    console.log(`  ✗ ${label} — length mismatch: ${a.length} vs ${b.length}`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      failCount++;
      console.log(`  ✗ ${label} — first diff at ${i}: ${a[i]} vs ${b[i]}`);
      return;
    }
  }
  passCount++;
  console.log(`  ✓ ${label} (${a.length} elements)`);
}

// ─── Synthetic data fixtures ──────────────────────────────────
//
// Base TF: 4H = 240min. 30 bars over 120 hours (5 days).
//   Base bar i opens at ts = 1700000000000 + i * 4 * 3600 * 1000
//
// HTF TF: 1D = 1440min. Should be 5 bars spanning the same 5 days.
//   HTF bar j opens at day-start (UTC midnight of each day), closes 24h later.
//
// We build both deterministically, compute the expected htfBarIndex, and
// use these fixtures throughout the gate.

function buildBase(nBars, startTs, tfMin) {
  const tfMs = tfMin * 60 * 1000;
  const ts = new Float64Array(nBars);
  const open = new Float64Array(nBars);
  const high = new Float64Array(nBars);
  const low = new Float64Array(nBars);
  const close = new Float64Array(nBars);
  const volume = new Float64Array(nBars);
  for (let i = 0; i < nBars; i++) {
    ts[i] = startTs + i * tfMs;
    open[i]   = 100 + i;
    high[i]   = open[i] + 2;
    low[i]    = open[i] - 1;
    close[i]  = open[i] + 1;
    volume[i] = 1000 + i;
  }
  return { ts, open, high, low, close, volume };
}

function buildHtf(nBars, startTs, tfMin) {
  // Same shape as buildBase but different price + volume so we can detect
  // which TF a lookup actually landed on.
  const tfMs = tfMin * 60 * 1000;
  const ts = new Float64Array(nBars);
  const open = new Float64Array(nBars);
  const high = new Float64Array(nBars);
  const low = new Float64Array(nBars);
  const close = new Float64Array(nBars);
  const volume = new Float64Array(nBars);
  for (let i = 0; i < nBars; i++) {
    ts[i] = startTs + i * tfMs;
    open[i]   = 1000 + i * 10;
    high[i]   = open[i] + 20;
    low[i]    = open[i] - 10;
    close[i]  = open[i] + 5;
    volume[i] = 100000 + i * 100;
  }
  return { ts, open, high, low, close, volume };
}

// Fixture: 30 base 4H bars from a UTC midnight; 5 daily HTF bars starting
// at that same midnight so the first HTF bar has ONLY closed by base bar 6
// (since bar 0 opens at HTF-open, bar 5 opens at 20:00 same day, HTF bar 0
// closes at 24:00 = base bar 6's open).
const BASE_START_TS = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 00:00 UTC
const BASE_TF_MIN = 240;  // 4H
const HTF_TF_MIN  = 1440; // 1D
const BASE_LEN = 30;      // 5 days × 6 bars/day
const HTF_LEN  = 5;

const base = buildBase(BASE_LEN, BASE_START_TS, BASE_TF_MIN);
const htf  = buildHtf(HTF_LEN, BASE_START_TS, HTF_TF_MIN);

// Compute expected htfBarIndex directly so the tests are anchored to
// ground truth (not circular through pack/unpack).
const expectedHtfBarIndex = makeHtfBarIndex(
  base.ts,
  htf.ts,
  HTF_TF_MIN * 60 * 1000
);

// ═══════════════════════════════════════════════════════════════
// [1] Pack/unpack round-trip — bit-for-bit fidelity
// ═══════════════════════════════════════════════════════════════
console.log('\n[1] packHtfPayload / unpackHtfPayload round-trip');
{
  const payload = packHtfPayload({
    tfMin: HTF_TF_MIN,
    tfMs:  HTF_TF_MIN * 60 * 1000,
    candles: htf,
    htfBarIndex: expectedHtfBarIndex,
  });

  assertEq('payload.tfMin preserved', payload.tfMin, HTF_TF_MIN);
  assertEq('payload.tfMs preserved',  payload.tfMs,  HTF_TF_MIN * 60 * 1000);
  assertEq('payload.htfLen correct',  payload.htfLen, HTF_LEN);
  assertTrue('candleBuffer is SharedArrayBuffer',
    payload.candleBuffer instanceof SharedArrayBuffer);
  assertTrue('htfBarIndexBuffer is SharedArrayBuffer',
    payload.htfBarIndexBuffer instanceof SharedArrayBuffer);
  assertEq('candleBuffer size = htfLen * 6 cols * 8 bytes',
    payload.candleBuffer.byteLength, HTF_LEN * 6 * 8);
  assertEq('htfBarIndexBuffer size = baseLen * 4 bytes',
    payload.htfBarIndexBuffer.byteLength, BASE_LEN * 4);

  const unpacked = unpackHtfPayload(payload);

  assertEq('unpacked.tfMin', unpacked.tfMin, HTF_TF_MIN);
  assertEq('unpacked.tfMs',  unpacked.tfMs,  HTF_TF_MIN * 60 * 1000);
  assertTrue('unpacked.ts is Float64Array',      unpacked.ts instanceof Float64Array);
  assertTrue('unpacked.htfBarIndex is Uint32Array', unpacked.htfBarIndex instanceof Uint32Array);

  assertArraysEq('ts round-trips',     unpacked.ts,     htf.ts);
  assertArraysEq('open round-trips',   unpacked.open,   htf.open);
  assertArraysEq('high round-trips',   unpacked.high,   htf.high);
  assertArraysEq('low round-trips',    unpacked.low,    htf.low);
  assertArraysEq('close round-trips',  unpacked.close,  htf.close);
  assertArraysEq('volume round-trips', unpacked.volume, htf.volume);
  assertArraysEq('htfBarIndex round-trips', unpacked.htfBarIndex, expectedHtfBarIndex);

  // HTF_NONE sentinel should appear at least once — first few base bars
  // come before any HTF bar has closed.
  const firstClosedBar = [...unpacked.htfBarIndex].findIndex(v => v !== HTF_NONE);
  assertTrue('HTF_NONE sentinel present for pre-close bars',
    firstClosedBar > 0, `first closed at base bar ${firstClosedBar}`);
}

// ═══════════════════════════════════════════════════════════════
// [2] unpackHtfPayloads — dict keyed by tfMin
// ═══════════════════════════════════════════════════════════════
console.log('\n[2] unpackHtfPayloads (plural)');
{
  // Simulate two HTFs (1D and 1W, for example) on the same base.
  const htf2 = buildHtf(2, BASE_START_TS, 7 * 24 * 60); // weekly, 2 bars
  const htf2Idx = makeHtfBarIndex(base.ts, htf2.ts, 7 * 24 * 60 * 60 * 1000);

  const payloads = [
    packHtfPayload({
      tfMin: HTF_TF_MIN,
      tfMs:  HTF_TF_MIN * 60 * 1000,
      candles: htf,
      htfBarIndex: expectedHtfBarIndex,
    }),
    packHtfPayload({
      tfMin: 7 * 24 * 60,
      tfMs:  7 * 24 * 60 * 60 * 1000,
      candles: htf2,
      htfBarIndex: htf2Idx,
    }),
  ];

  const htfs = unpackHtfPayloads(payloads);
  const keys = Object.keys(htfs).map(Number).sort((a, b) => a - b);

  assertEq('two HTFs in result', keys, [HTF_TF_MIN, 7 * 24 * 60]);
  assertArraysEq('1D htfBarIndex intact', htfs[HTF_TF_MIN].htfBarIndex, expectedHtfBarIndex);
  assertArraysEq('1W htfBarIndex intact', htfs[7 * 24 * 60].htfBarIndex, htf2Idx);
  assertEq('1D tfMin stamped on unpacked', htfs[HTF_TF_MIN].tfMin, HTF_TF_MIN);
  assertEq('1W tfMin stamped on unpacked', htfs[7 * 24 * 60].tfMin, 7 * 24 * 60);

  // Empty / missing inputs
  assertEq('unpackHtfPayloads([]) = {}',    Object.keys(unpackHtfPayloads([])),    []);
  assertEq('unpackHtfPayloads(null) = {}',  Object.keys(unpackHtfPayloads(null)),  []);
  assertEq('unpackHtfPayloads(undef) = {}', Object.keys(unpackHtfPayloads()),      []);
}

// ═══════════════════════════════════════════════════════════════
// [3] sliceHtfs — slices each HTF's htfBarIndex to upperBar length
// ═══════════════════════════════════════════════════════════════
console.log('\n[3] sliceHtfs');
{
  const payload = packHtfPayload({
    tfMin: HTF_TF_MIN,
    tfMs:  HTF_TF_MIN * 60 * 1000,
    candles: htf,
    htfBarIndex: expectedHtfBarIndex,
  });
  const htfs = unpackHtfPayloads([payload]);

  // Slice to 12 bars (midway through day 2)
  const UPPER = 12;
  const sliced = sliceHtfs(htfs, UPPER);
  const slicedHtf = sliced[HTF_TF_MIN];

  assertEq('sliced htfBarIndex length = upperBar',
    slicedHtf.htfBarIndex.length, UPPER);
  assertTrue('sliced htfBarIndex is zero-copy view (same buffer)',
    slicedHtf.htfBarIndex.buffer === htfs[HTF_TF_MIN].htfBarIndex.buffer);

  // Values in [0, UPPER) should match the full array.
  let allMatch = true;
  for (let i = 0; i < UPPER; i++) {
    if (slicedHtf.htfBarIndex[i] !== expectedHtfBarIndex[i]) {
      allMatch = false;
      break;
    }
  }
  assertTrue('sliced values match full values in [0, upperBar)', allMatch);

  // HTF candle arrays remain full — they're indexed THROUGH htfBarIndex,
  // not via base-bar offset.
  assertEq('sliced HTF candle length unchanged', slicedHtf.close.length, HTF_LEN);
  assertEq('sliced HTF ts unchanged',             slicedHtf.ts.length,    HTF_LEN);

  // tfMin and tfMs are preserved on the sliced object.
  assertEq('sliced HTF tfMin preserved', slicedHtf.tfMin, HTF_TF_MIN);
  assertEq('sliced HTF tfMs preserved',  slicedHtf.tfMs,  HTF_TF_MIN * 60 * 1000);

  // Empty-input handling
  assertEq('sliceHtfs(undefined)', sliceHtfs(undefined, 10), undefined);
  assertEq('sliceHtfs({})', Object.keys(sliceHtfs({}, 10)), []);
}

// ═══════════════════════════════════════════════════════════════
// [4] sliceBundle with HTFs — end-to-end slice, lookup equivalence
// ═══════════════════════════════════════════════════════════════
console.log('\n[4] sliceBundle — base + HTFs sliced together');
{
  const payload = packHtfPayload({
    tfMin: HTF_TF_MIN,
    tfMs:  HTF_TF_MIN * 60 * 1000,
    candles: htf,
    htfBarIndex: expectedHtfBarIndex,
  });
  const bundle = {
    symbol: 'TEST',
    baseTfMin: BASE_TF_MIN,
    baseTfMs: BASE_TF_MIN * 60 * 1000,
    base,
    htfs: unpackHtfPayloads([payload]),
    tradingStartBar: 0,
    periodYears: 0,
  };

  const UPPER = 18;  // 3 days worth
  const sliced = sliceBundle(bundle, { upperBar: UPPER, tradingStartBar: 6 });

  assertEq('sliced base.close length = upperBar', sliced.base.close.length, UPPER);
  assertEq('sliced base.ts length = upperBar',    sliced.base.ts.length,    UPPER);
  assertTrue('sliced base is zero-copy view',
    sliced.base.close.buffer === base.close.buffer);
  assertEq('sliced tradingStartBar applied', sliced.tradingStartBar, 6);

  assertTrue('sliced bundle has htfs dict',
    sliced.htfs && typeof sliced.htfs === 'object');
  const slicedHtf = sliced.htfs[HTF_TF_MIN];
  assertEq('sliced HTF htfBarIndex length = upperBar',
    slicedHtf.htfBarIndex.length, UPPER);
  assertEq('sliced HTF candle arrays unchanged',
    slicedHtf.close.length, HTF_LEN);

  // ── Runtime-parity check ──
  // For any base-bar index i < UPPER, `slicedHtf.htfBarIndex[i]` must
  // return the SAME HTF-bar index as `expectedHtfBarIndex[i]` on the
  // full timeline — and dereferencing `slicedHtf.close[that index]`
  // must equal `htf.close[that index]`. This is exactly the lookup
  // indicator-cache.js → resolveTfCandles does at runtime.
  let parityOk = true;
  let firstFail = -1;
  for (let i = 0; i < UPPER; i++) {
    const hbi = slicedHtf.htfBarIndex[i];
    if (hbi !== expectedHtfBarIndex[i]) {
      parityOk = false; firstFail = i; break;
    }
    if (hbi !== HTF_NONE && slicedHtf.close[hbi] !== htf.close[hbi]) {
      parityOk = false; firstFail = i; break;
    }
  }
  assertTrue('HTF lookup parity: sliced vs full',
    parityOk, parityOk ? '' : `first diff at base bar ${firstFail}`);

  // periodYears recomputed from sliced base ts.
  assertTrue('sliced periodYears is finite', Number.isFinite(sliced.periodYears));
}

// ═══════════════════════════════════════════════════════════════
// [5] sliceBundle — no-HTF case (regression check for pre-Phase-2.6 specs)
// ═══════════════════════════════════════════════════════════════
console.log('\n[5] sliceBundle — base-TF-only bundle (no HTFs)');
{
  const bundle = {
    symbol: 'TEST',
    base,
    htfs: {},
    tradingStartBar: 0,
    periodYears: 0,
  };
  const sliced = sliceBundle(bundle, { upperBar: 20, tradingStartBar: 5 });
  assertEq('sliced.htfs is empty dict', Object.keys(sliced.htfs), []);
  assertEq('sliced.base.close length', sliced.base.close.length, 20);
  assertEq('sliced.tradingStartBar', sliced.tradingStartBar, 5);

  const bundleNoHtfs = { symbol: 'TEST', base, tradingStartBar: 0, periodYears: 0 };
  const slicedNoHtfs = sliceBundle(bundleNoHtfs, { upperBar: 20, tradingStartBar: 5 });
  assertTrue('bundle without htfs key is handled gracefully',
    slicedNoHtfs.htfs === undefined || Object.keys(slicedNoHtfs.htfs).length === 0);
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.log('FAILED');
  process.exit(1);
} else {
  console.log('OK');
}
