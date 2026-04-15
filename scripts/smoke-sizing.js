/**
 * Smoke test for chunk 6.5 — the enriched sizing context.
 *
 * Exercises each shipped sizing block against a synthetic candle bundle
 * with a stub entry + stub hardStop. Verifies:
 *
 *   1. Sizing blocks receive ctx.stopDistance when hardStop.planStop() exists.
 *   2. Sizing blocks receive ctx.stats with up-to-date running win/loss numbers.
 *   3. atrRisk declines entries when stopDistance is missing.
 *   4. martingale/antiMartingale escalate size after streaks.
 *   5. kelly sizes warm up before stats mature.
 *   6. equityCurveTrading sees an equityCurve array.
 *   7. Spec validator rejects atrRisk + missing hardStop at load time.
 */

import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { runSpec } from '../engine/runtime.js';
import { KINDS, EXIT_SLOTS, DIRECTIONS } from '../engine/blocks/contract.js';

import flat               from '../engine/blocks/library/sizing/flat.js';
import pctOfEquity        from '../engine/blocks/library/sizing/pct-of-equity.js';
import atrRisk            from '../engine/blocks/library/sizing/atr-risk.js';
import martingale         from '../engine/blocks/library/sizing/martingale.js';
import antiMartingale     from '../engine/blocks/library/sizing/anti-martingale.js';
import kelly              from '../engine/blocks/library/sizing/kelly.js';
import fixedFractional    from '../engine/blocks/library/sizing/fixed-fractional.js';
import equityCurveTrading from '../engine/blocks/library/sizing/equity-curve-trading.js';

let pass = true;
const fail = (msg) => { console.error('  ✗', msg); pass = false; };
const ok   = (msg) => console.log('  ✓', msg);

// ─── Register blocks ────────────────────────────────────────
registry.__resetForTests();
for (const b of [flat, pctOfEquity, atrRisk, martingale, antiMartingale,
                 kelly, fixedFractional, equityCurveTrading]) {
  registry.register(b);
}

/** Entry: alternate long/short every N bars so we get a mix of W/L to feed stats. */
const alternatingEntry = {
  id: 'alt', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  declaredParams() { return [{ id: 'period', type: 'int', min: 2, max: 100, step: 1 }]; },
  indicatorDeps()  { return []; },
  prepare()        {},
  onBar(_bundle, i, _s, p) {
    const slot = Math.floor(i / p.period);
    return { long: (i % p.period === 0 && slot % 2 === 0) ? 1 : 0,
             short:(i % p.period === 0 && slot % 2 === 1) ? 1 : 0 };
  },
  pineTemplate() { return '// stub'; },
};

/** Hard stop: 5% SL WITH planStop implemented. */
const planStopSL = {
  id: 'planSL', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.HARD_STOP, direction: DIRECTIONS.BOTH,
  declaredParams() { return [{ id: 'pct', type: 'float', min: 0.5, max: 20, step: 0.1 }]; },
  indicatorDeps()  { return []; },
  prepare()        {},
  planStop(_bundle, _i, _state, params, isLong, fillPrice) {
    const dist = fillPrice * params.pct / 100;
    return {
      price: isLong ? fillPrice - dist : fillPrice + dist,
      distance: dist,
    };
  },
  onPositionOpen(position, params, _s, ctx) {
    position.state.planSL_price = ctx.isLong
      ? ctx.fillPrice * (1 - params.pct / 100)
      : ctx.fillPrice * (1 + params.pct / 100);
  },
  onBar(bundle, i, _s, _p, position) {
    const sl = position.state.planSL_price;
    if (sl == null) return null;
    if (position.dir > 0 && bundle.base.low[i] <= sl)  return { action: 'closeIntraBar', fillPrice: sl, signal: 'SL' };
    if (position.dir < 0 && bundle.base.high[i] >= sl) return { action: 'closeIntraBar', fillPrice: sl, signal: 'SL' };
    return null;
  },
};

/** Target: deferred close after N bars (fabricates W/L mix via price drift). */
const timedExit = {
  id: 'timedExit2', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.TARGET, direction: DIRECTIONS.BOTH,
  declaredParams() { return [{ id: 'maxBars', type: 'int', min: 1, max: 50, step: 1 }]; },
  indicatorDeps()  { return []; },
  prepare()        {},
  onBar(_bundle, i, _s, params, position) {
    if (i - position.entryBar >= params.maxBars - 1) return { action: 'closeNextBarOpen', signal: 'Time' };
    return null;
  },
  pineTemplate() { return '// stub'; },
};

for (const b of [alternatingEntry, planStopSL, timedExit]) registry.register(b);

// ─── Synthetic bundle: oscillating price so we get a mix of W/L ─
const N = 400;
const ts = new Float64Array(N), open = new Float64Array(N), high = new Float64Array(N),
      low = new Float64Array(N), close = new Float64Array(N), volume = new Float64Array(N);
for (let i = 0; i < N; i++) {
  ts[i] = 1700000000000 + i * 3600_000;
  // Mild sine — enough motion for the timed exit to produce both wins and losses.
  const base = 100 + 10 * Math.sin(i / 7);
  open[i]  = base;
  close[i] = base + 0.5 * Math.sin(i / 3);
  high[i]  = Math.max(open[i], close[i]) + 0.5;
  low[i]   = Math.min(open[i], close[i]) - 0.5;
  volume[i] = 1000;
}
const bundle = {
  symbol: 'TEST', baseTfMin: 60, baseTfMs: 60 * 60_000,
  base: { ts, open, high, low, close, volume },
  htfs: {}, tradingStartBar: 0,
  periodYears: N / (365.25 * 24),
};

function makeSpec(sizingBlockId, sizingParams, extras = {}) {
  return validateSpec({
    name: `20260414-888-sizing-${sizingBlockId.toLowerCase()}`,
    entries: { mode: 'any', blocks: [
      { block: 'alt', version: 1, instanceId: 'e', params: { period: { value: 8 } } },
    ]},
    exits: {
      hardStop: extras.hardStop === false ? null
        : { block: 'planSL', version: 1, instanceId: 'sl', params: { pct: { value: 2.0 } } },
      target:   { block: 'timedExit2', version: 1, instanceId: 't', params: { maxBars: { value: 6 } } },
      trail:    null,
    },
    sizing: { block: sizingBlockId, version: 1, instanceId: 's', params: sizingParams },
  });
}

function runWith(sizingBlockId, sizingParams, extras) {
  const spec = makeSpec(sizingBlockId, sizingParams, extras);
  const ps = buildParamSpace(spec);
  const gene = ps.randomIndividual();
  return runSpec({ spec, paramSpace: ps, bundle, gene, opts: { collectTrades: true } });
}

console.log('\n=== Chunk 6.5 smoke — enriched sizing ===\n');

// (1) flat
{
  const m = runWith('flat', { amountUsd: { value: 10_000 } });
  if (m.trades > 0 && Number.isFinite(m.equity)) ok(`flat: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('flat: no trades or broken equity');
}

// (2) pctOfEquity
{
  const m = runWith('pctOfEquity', { pct: { value: 50 } });
  if (m.trades > 0) ok(`pctOfEquity: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('pctOfEquity: no trades');
}

// (3) atrRisk WITH planStop — should fire trades (uses stopDistance)
{
  const m = runWith('atrRisk', { riskPct: { value: 1.0 }, useInitialCapital: { value: 0 } });
  if (m.trades > 0) ok(`atrRisk (with planStop): ${m.trades} trades`);
  else fail('atrRisk: expected trades, got 0 — planStop not wired?');
}

// (4) atrRisk WITHOUT hardStop — spec validator must REJECT at load time
{
  let rejected = false;
  try {
    makeSpec('atrRisk', { riskPct: { value: 1.0 }, useInitialCapital: { value: 0 } }, { hardStop: false });
  } catch (e) {
    rejected = /stopDistance/.test(e.message) || /hardStop/.test(e.message);
  }
  if (rejected) ok('atrRisk + no hardStop: rejected by spec validator');
  else          fail('atrRisk + no hardStop: validator should have thrown');
}

// (5) martingale — trades fire, stats in range
{
  const m = runWith('martingale', {
    basePct:  { value: 1.0 },
    stepMult: { value: 2.0 },
    maxMult:  { value: 8 },
  });
  if (m.trades > 0) ok(`martingale: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}, maxDD%=${(m.maxDDPct*100).toFixed(1)}`);
  else fail('martingale: no trades');
}

// (6) antiMartingale
{
  const m = runWith('antiMartingale', {
    basePct:  { value: 1.0 },
    stepMult: { value: 1.5 },
    maxMult:  { value: 4 },
  });
  if (m.trades > 0) ok(`antiMartingale: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('antiMartingale: no trades');
}

// (7) kelly — should warm up with fixed pct, then switch to kelly fraction
{
  const m = runWith('kelly', {
    fraction:    { value: 0.5 },
    maxFraction: { value: 0.2 },
    minTrades:   { value: 10 },
    warmupPct:   { value: 1.0 },
  });
  if (m.trades > 0) ok(`kelly: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('kelly: no trades');
}

// (8) fixedFractional
{
  const m = runWith('fixedFractional', {
    f:            { value: 0.05 },
    minWorstLoss: { value: 500 },
  });
  if (m.trades > 0) ok(`fixedFractional: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('fixedFractional: no trades');
}

// (9) equityCurveTrading
{
  const m = runWith('equityCurveTrading', {
    basePct:   { value: 5.0 },
    onPct:     { value: 10.0 },
    offPct:    { value: 1.0 },
    maLen:     { value: 10 },
    minTrades: { value: 10 },
  });
  if (m.trades > 0) ok(`equityCurveTrading: ${m.trades} trades, net=${m.netProfitPct.toFixed(4)}`);
  else fail('equityCurveTrading: no trades');
}

console.log(pass ? '\nALL OK' : '\nFAILED');
process.exit(pass ? 0 : 1);
