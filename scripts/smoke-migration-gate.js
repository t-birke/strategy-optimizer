/**
 * Migration-gate smoke — chunk 7 exit criterion.
 *
 * Loads the composable port of JM Simple 3TP, runs it end-to-end on a
 * synthetic candle stream, and sanity-checks the output shape.
 *
 * This is NOT the bit-for-bit parity test against engine/strategy.js —
 * that's chunk 8, which will use real BTCUSDT/1h data and compare trade
 * lists. This smoke answers a cheaper question:
 *
 *     Does the full spec (3 entry blocks + 3 exit blocks + atrRisk sizing)
 *     load, validate, size, trade, and exit without blowing up?
 *
 * We also hand-pin the "shared" params (atrLen across hardStop+target,
 * stochLen/stochSmth across entry+trail) to identical values so the two
 * instances line up — cross-block equality constraints are tracked in
 * backlog.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { runSpec } from '../engine/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, '..', 'strategies', '20260414-001-jm-simple-3tp-legacy.json');

let pass = true;
const fail = (msg) => { console.error('  ✗', msg); pass = false; };
const ok   = (msg) => console.log('  ✓', msg);

console.log('\n=== Chunk 7 smoke — JM Simple 3TP migration-gate spec ===\n');

// ─── 1. Register the library ────────────────────────────────
registry.__resetForTests();
await registry.ensureLoaded();
const registered = registry.list().map(b => `${b.id}@${b.version}`);
if (registered.length >= 14) ok(`registered ${registered.length} library blocks`);
else                         fail(`expected ≥14 blocks, got ${registered.length}: ${registered.join(', ')}`);

// ─── 2. Load + validate spec ────────────────────────────────
const rawJson = await readFile(specPath, 'utf8');
let spec;
try {
  spec = validateSpec(JSON.parse(rawJson), { sourcePath: specPath });
  ok(`spec validated (hash=${spec.hash.slice(0, 12)}…)`);
} catch (e) {
  fail(`spec validation threw: ${e.message}`);
  process.exit(1);
}

// ─── 3. Build param space ───────────────────────────────────
const paramSpace = buildParamSpace(spec);
if (paramSpace.PARAMS.length > 0) ok(`param space has ${paramSpace.PARAMS.length} genes`);
else                              fail(`expected >0 genes`);

// ─── 4. Hand-craft a gene that matches a known-good legacy seed ─
// These aren't the tuned best-fit values — they're a quick combo that
// fires trades on the synthetic data below. The chunk-8 parity test
// will use the actual tuned values on real BTC data.
const seed = paramSpace.randomIndividual();
const pin = (qid, val) => {
  if (Object.prototype.hasOwnProperty.call(seed, qid)) seed[qid] = val;
};
// Entry sides
pin('stochCross.main.stochLen',   14);
pin('stochCross.main.stochSmth',  3);
pin('emaTrend.main.emaFast',      20);
pin('emaTrend.main.emaSlow',      50);
pin('bbSqueezeBreakout.main.bbLen',  20);
pin('bbSqueezeBreakout.main.bbMult', 2.0);
// Exits — atrLen must match between hardStop and target
pin('atrHardStop.main.atrLen',        14);
pin('atrHardStop.main.atrSL',         2.0);
pin('atrHardStop.main.emergencySlPct', 25);
pin('atrScaleOutTarget.main.atrLen',  14);  // must match hardStop
pin('atrScaleOutTarget.main.tp1Mult', 1.5);
pin('atrScaleOutTarget.main.tp2Mult', 3.0);
pin('atrScaleOutTarget.main.tp3Mult', 6.0);
pin('atrScaleOutTarget.main.tp1Pct',  30);
pin('atrScaleOutTarget.main.tp2Pct',  30);
pin('atrScaleOutTarget.main.tp3Pct',  40);   // legacy "remainder" = 100-30-30 = 40
// Tranches 4-6 are pinned to pct=0 in the spec so they don't appear in the genome.
// Trail — stochLen/Smth must match entry
pin('structuralExit.main.stochLen',  14);
pin('structuralExit.main.stochSmth', 3);
pin('structuralExit.main.rsiLen',    14);
pin('structuralExit.main.maxBars',   30);
// Score threshold + sizing
pin('_meta.entries.threshold',     1);
pin('atrRisk.main.riskPct',        1.0);

// Constraint repair — in case the random starting values violated anything.
paramSpace.enforceConstraints(seed);

// ─── 5. Synthetic candle bundle ─────────────────────────────
// Long enough + volatile enough that all three entry conditions can fire
// and all three exit paths (TP, SL, time/structural) get exercised.
const N = 2000;
const ts = new Float64Array(N), open = new Float64Array(N), high = new Float64Array(N);
const low = new Float64Array(N), close = new Float64Array(N), volume = new Float64Array(N);
let prev = 100;
for (let i = 0; i < N; i++) {
  ts[i] = 1700000000000 + i * 3600_000;
  // Random-walk with a small trend + sinusoidal oscillation — gives both
  // trending stretches (emaTrend votes) and reversals (stoch + rsi fire).
  const drift = 0.02 * Math.sin(i / 80);
  const shock = (Math.sin(i * 1.3) + Math.cos(i * 0.7)) * 0.6;
  const nxt = Math.max(1, prev * (1 + drift / 100) + shock);
  open[i]  = prev;
  close[i] = nxt;
  high[i]  = Math.max(open[i], close[i]) + Math.abs(shock) * 0.5 + 0.2;
  low[i]   = Math.min(open[i], close[i]) - Math.abs(shock) * 0.5 - 0.2;
  volume[i] = 1000 + 50 * Math.sin(i / 11);
  prev = nxt;
}
const bundle = {
  symbol: 'TEST',
  baseTfMin: 60, baseTfMs: 60 * 60_000,
  base: { ts, open, high, low, close, volume },
  htfs: {},
  tradingStartBar: 150,  // give indicators time to warm up
  periodYears: N / (365.25 * 24),
};

// ─── 6. Run ─────────────────────────────────────────────────
let metrics;
try {
  metrics = runSpec({
    spec, paramSpace, bundle, gene: seed,
    opts: { collectTrades: true, collectEquity: false },
  });
  ok('runtime executed without throwing');
} catch (e) {
  fail(`runtime threw: ${e.message}\n${e.stack}`);
  console.log(pass ? '\nALL OK' : '\nFAILED');
  process.exit(1);
}

console.log(`\n  trades=${metrics.trades}  wins=${metrics.wins}  ` +
  `winRate=${(metrics.winRate*100).toFixed(1)}%  pf=${isFinite(metrics.pf) ? metrics.pf.toFixed(3) : metrics.pf}  ` +
  `netPct=${(metrics.netProfitPct*100).toFixed(2)}%  maxDD%=${(metrics.maxDDPct*100).toFixed(2)}\n`);

// ─── 7. Invariants ──────────────────────────────────────────
if (metrics.trades > 0)               ok(`fired ${metrics.trades} trades`);
else                                  fail(`zero trades — entries/exits not wiring up`);

if (Number.isFinite(metrics.equity) && metrics.equity >= 0)
  ok(`equity finite + non-negative (${metrics.equity.toFixed(2)})`);
else
  fail(`equity=${metrics.equity}`);

if (metrics.maxDDPct >= 0 && metrics.maxDDPct <= 1)
  ok(`maxDDPct in [0,1] (${(metrics.maxDDPct*100).toFixed(2)}%)`);
else
  fail(`maxDDPct=${metrics.maxDDPct}`);

if (Array.isArray(metrics.tradeList) && metrics.tradeList.length === metrics.trades)
  ok('trade list length matches trade count');
else
  fail(`trade list length mismatch`);

// Every trade signal should be one of the known block tags.
const validSignals = new Set([
  'TP1', 'TP2', 'TP3', 'SL', 'ESL', 'Time', 'Structural', 'Reversal', 'End', 'Close',
]);
const unknownSigs = new Set();
for (const t of metrics.tradeList ?? []) {
  if (!validSignals.has(t.signal)) unknownSigs.add(t.signal);
}
if (unknownSigs.size === 0) ok(`all trade signals are well-known (${Array.from(new Set((metrics.tradeList ?? []).map(t => t.signal))).sort().join(', ')})`);
else                        fail(`unknown signals: ${[...unknownSigs].join(', ')}`);

// Proof the 3-TP scale-out actually splits trades into tranches.
const tpHits = (metrics.tradeList ?? []).filter(t => ['TP1', 'TP2', 'TP3'].includes(t.signal));
if (tpHits.length > 0) ok(`saw ${tpHits.length} partial-TP fills (3-tier scale-out is wired)`);
else                   console.log(`  · (no TP fills this run — may happen on noisy seeds; not a failure)`);

// Proof hardStop fired at least once OR wasn't needed.
const slHits = (metrics.tradeList ?? []).filter(t => t.signal === 'SL' || t.signal === 'ESL');
console.log(`  · ${slHits.length} SL/ESL closes, ${tpHits.length} TP closes, ` +
  `${(metrics.tradeList ?? []).filter(t => t.signal === 'Time').length} time exits, ` +
  `${(metrics.tradeList ?? []).filter(t => t.signal === 'Structural').length} structural, ` +
  `${(metrics.tradeList ?? []).filter(t => t.signal === 'Reversal').length} reversal`);

console.log(pass ? '\nALL OK' : '\nFAILED');
process.exit(pass ? 0 : 1);
