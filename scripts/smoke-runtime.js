/**
 * Smoke test for engine/runtime.js — wires up a minimal spec with stub
 * blocks against synthetic candles, runs it, and checks invariants.
 *
 * No DB / no DuckDB / no real indicators — just enough to prove the
 * runtime loops correctly through entries, sizing, and exits.
 */

import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { runSpec } from '../engine/runtime.js';
import { KINDS, EXIT_SLOTS, DIRECTIONS } from '../engine/blocks/contract.js';

// ─── Reset registry & register stub blocks ──────────────────
registry.__resetForTests();

/** Entry: long every N bars when bar % N === 0; never short. */
const periodicLongEntry = {
  id: 'periodicLong', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.LONG,
  declaredParams() { return [{ id: 'period', type: 'int', min: 2, max: 100, step: 1 }]; },
  indicatorDeps()  { return []; },
  prepare()        {},
  onBar(bundle, i, _state, params) {
    return { long: (i % params.period === 0) ? 1 : 0, short: 0 };
  },
  pineTemplate()   { return '// stub'; },
};

/** Sizing: fixed 1 unit per trade. */
const oneUnitSizing = {
  id: 'oneUnit', version: 1, kind: KINDS.SIZING,
  declaredParams() { return [{ id: 'units', type: 'int', min: 1, max: 100, step: 1 }]; },
  indicatorDeps()  { return []; },
  computeSize(_ctx, _state, params) { return params.units; },
};

/** Hard stop: close 5% below entry, intra-bar (unrealistic but simple). */
const fivePctHardStop = {
  id: 'fivePctSL', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.HARD_STOP, direction: DIRECTIONS.BOTH,
  declaredParams() { return []; },
  indicatorDeps()  { return []; },
  prepare()        {},
  onPositionOpen(position, _params, _state, ctx) {
    position.state.fivePctSL_stop = ctx.isLong
      ? ctx.fillPrice * 0.95
      : ctx.fillPrice * 1.05;
  },
  onBar(bundle, i, _state, _params, position) {
    const sl = position.state.fivePctSL_stop;
    if (sl == null) return null;
    if (position.dir > 0 && bundle.base.low[i] <= sl) {
      return { action: 'closeIntraBar', fillPrice: sl, signal: 'SL' };
    }
    if (position.dir < 0 && bundle.base.high[i] >= sl) {
      return { action: 'closeIntraBar', fillPrice: sl, signal: 'SL' };
    }
    return null;
  },
};

/** Target: deferred close after N bars (proves closeNextBarOpen works). */
const timedExit = {
  id: 'timedExit', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.TARGET, direction: DIRECTIONS.BOTH,
  declaredParams() { return [{ id: 'maxBars', type: 'int', min: 1, max: 50, step: 1 }]; },
  indicatorDeps()  { return []; },
  prepare()        {},
  onBar(bundle, i, _state, params, position) {
    if (i - position.entryBar >= params.maxBars - 1) {
      return { action: 'closeNextBarOpen', signal: 'Time' };
    }
    return null;
  },
  pineTemplate()   { return '// stub'; },  // not actually required for exit blocks but harmless
};

[periodicLongEntry, oneUnitSizing, fivePctHardStop, timedExit].forEach(b => registry.register(b));

// ─── Build a minimal spec ──────────────────────────────────
const spec = validateSpec({
  name: '20260414-999-runtime-smoke',
  description: 'Smoke test for engine/runtime.js',
  entries: {
    mode: 'any',
    blocks: [
      { block: 'periodicLong', version: 1, instanceId: 'main',
        params: { period: { value: 10 } } },
    ],
  },
  exits: {
    hardStop: { block: 'fivePctSL', version: 1, instanceId: 'sl', params: {} },
    target:   { block: 'timedExit', version: 1, instanceId: 't',
                params: { maxBars: { value: 5 } } },
    trail:    null,
  },
  sizing: { block: 'oneUnit', version: 1, instanceId: 'sz',
            params: { units: { value: 1 } } },
});

const paramSpace = buildParamSpace(spec);
const gene = paramSpace.randomIndividual();

// ─── Synthetic candle bundle ────────────────────────────────
// 200 bars of a saw-tooth: price drifts up then snaps back. Enough motion
// to fire entries every 10 bars and let timed exits fire 5 bars later.
const N = 200;
const ts    = new Float64Array(N);
const open  = new Float64Array(N);
const high  = new Float64Array(N);
const low   = new Float64Array(N);
const close = new Float64Array(N);
const volume = new Float64Array(N);
for (let i = 0; i < N; i++) {
  ts[i] = 1700000000000 + i * 3600_000;
  const wave = 100 + (i % 20);          // 100..119, snaps back every 20 bars
  open[i]  = wave;
  close[i] = wave + 0.5;
  high[i]  = wave + 1.0;
  low[i]   = wave - 1.0;
  volume[i] = 1000;
}
const bundle = {
  symbol: 'TEST',
  baseTfMin: 60, baseTfMs: 60 * 60_000,
  base: { ts, open, high, low, close, volume },
  htfs: {},
  tradingStartBar: 0,
  periodYears: N / (365.25 * 24),
};

// ─── Run ─────────────────────────────────────────────────────
const m = runSpec({ spec, paramSpace, bundle, gene, opts: { collectTrades: true } });

let pass = true;
const fail = (msg) => { console.error('  ✗', msg); pass = false; };
const ok   = (msg) => console.log('  ✓', msg);

console.log('Runtime smoke test:');
console.log(`  trades=${m.trades}  wins=${m.wins}  pf=${m.pf.toFixed(3)}  netPct=${(m.netProfitPct*100).toFixed(2)}%  maxDD%=${(m.maxDDPct*100).toFixed(2)}`);

if (m.trades >= 5)              ok(`fired ${m.trades} trades (expected ≥5)`);
else                            fail(`expected ≥5 trades, got ${m.trades}`);
if (Number.isFinite(m.equity))  ok('equity is finite');
else                            fail(`equity is ${m.equity}`);
if (Array.isArray(m.tradeList) && m.tradeList.length === m.trades)
                                ok('tradeList length matches trades count');
else                            fail(`tradeList length mismatch`);

// Every trade should have a direction, signal, and entry/exit prices
const sample = m.tradeList?.[0];
if (sample && sample.direction === 'Long' && sample.signal && sample.entryPrice > 0 && sample.exitPrice > 0)
  ok(`first trade looks well-formed (signal=${sample.signal}, entry=${sample.entryPrice}, exit=${sample.exitPrice})`);
else
  fail(`first trade malformed: ${JSON.stringify(sample)}`);

// Signals should be 'Time' or 'SL' or 'End' — we configured no other exits
const validSignals = new Set(['Time', 'SL', 'End']);
const badSig = m.tradeList?.find(t => !validSignals.has(t.signal));
if (!badSig) ok('all trade signals are in {Time, SL, End}');
else         fail(`unexpected signal: ${badSig.signal}`);

console.log(pass ? '\nALL OK' : '\nFAILED');
process.exit(pass ? 0 : 1);
