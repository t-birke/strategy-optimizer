/**
 * Migration-gate parity test — chunk 8 exit criterion.
 *
 * Runs the tuned BTC 4H JM Simple 3TP configuration through BOTH engines:
 *   • Legacy:   engine/strategy.js (hardcoded), via runStrategy()
 *   • New:      engine/runtime.js (composable) + the migration-gate spec,
 *               via runSpec() with the 18 legacy params mapped to qids.
 *
 * Reports:
 *   • Summary totals (trades, wins, PF, net, maxDD) side-by-side with
 *     absolute and relative deltas.
 *   • Trade-by-trade diff for the first N divergences — directon, entry/
 *     exit timestamps, signals, prices, PnL — enough context to localize
 *     whatever's drifting.
 *
 * Zero arguments; just run. Bit-for-bit identity isn't expected on day one
 * (the two engines evaluate slots in subtly different orders and have
 * different reversal/SL interleaving) — the point is to SURFACE those
 * divergences concretely so we can fix them one by one.
 *
 * Reference baseline from TradingView on this same config:
 *     594 trades | 58.1% win | 1.37 PF | $265,919 net | 24.8% maxDD
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadCandles } from '../db/candles.js';
import { runStrategy } from '../engine/strategy.js';
import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { runSpec } from '../engine/runtime.js';

// ─── Config ────────────────────────────────────────────────
const SYMBOL = 'BTCUSDT';
const TF_MIN = 240;          // 4H
const START  = '2021-04-12';

// BTC winner (legacy's 18 tuned genes) — same values diagnose-btc.js uses
// to hit TV's 594-trade / 1.37 PF baseline.
const LEGACY_PARAMS = {
  minEntry: 2,
  stochLen: 39, stochSmth: 6,
  rsiLen: 16,
  emaFast: 14, emaSlow: 135,
  bbLen: 40, bbMult: 3,
  atrLen: 24, atrSL: 3.25,
  tp1Mult: 2.5, tp2Mult: 6, tp3Mult: 7,
  tp1Pct: 10, tp2Pct: 10,   // tp3Pct = implicit remainder (80)
  riskPct: 5,
  maxBars: 25,
  emergencySlPct: 25,
};

// How many divergent trades to show in the detail diff.
const DIVERGENCE_LIMIT = 20;

// ─── Build the new-framework gene from the legacy params ───
function buildNewGene(p, paramSpace) {
  // Start from a random seed so the genome is fully populated, then overwrite
  // every gene the legacy config pins.
  const g = paramSpace.randomIndividual();
  const set = (qid, v) => { if (Object.prototype.hasOwnProperty.call(g, qid)) g[qid] = v; };

  // Score threshold
  set('_meta.entries.threshold', p.minEntry);

  // stochCross (entry) — also defines the stoch params used by structuralExit.
  set('stochCross.main.stochLen',  p.stochLen);
  set('stochCross.main.stochSmth', p.stochSmth);
  // longLevel / shortLevel are pinned at 40/60 in the spec — not in genome.

  // emaTrend (entry)
  set('emaTrend.main.emaFast', p.emaFast);
  set('emaTrend.main.emaSlow', p.emaSlow);

  // bbSqueezeBreakout (entry); squeezePctile=25, lookbackBars=3 are pinned in spec.
  set('bbSqueezeBreakout.main.bbLen',  p.bbLen);
  set('bbSqueezeBreakout.main.bbMult', p.bbMult);

  // atrHardStop (hardStop)
  set('atrHardStop.main.atrLen',         p.atrLen);
  set('atrHardStop.main.atrSL',          p.atrSL);
  set('atrHardStop.main.emergencySlPct', p.emergencySlPct);

  // atrScaleOutTarget (target) — tp4..tp6 are pinned to pct=0 in spec, so
  // they aren't in the genome and don't produce subs at runtime.
  set('atrScaleOutTarget.main.atrLen',  p.atrLen);     // must equal hardStop's
  set('atrScaleOutTarget.main.tp1Mult', p.tp1Mult);
  set('atrScaleOutTarget.main.tp2Mult', p.tp2Mult);
  set('atrScaleOutTarget.main.tp3Mult', p.tp3Mult);
  set('atrScaleOutTarget.main.tp1Pct',  p.tp1Pct);
  set('atrScaleOutTarget.main.tp2Pct',  p.tp2Pct);
  // Legacy's u3 was `units - u1 - u2` (implicit remainder). The new block
  // normalizes pcts to 100%, so the math is identical when we pass the
  // explicit remainder here.
  set('atrScaleOutTarget.main.tp3Pct',  100 - p.tp1Pct - p.tp2Pct);

  // structuralExit (trail) — stoch params must match entry's stochCross.
  set('structuralExit.main.stochLen',  p.stochLen);
  set('structuralExit.main.stochSmth', p.stochSmth);
  set('structuralExit.main.rsiLen',    p.rsiLen);
  set('structuralExit.main.maxBars',   p.maxBars);

  // atrRisk (sizing) — useInitialCapital=0 pinned in spec (matches legacy
  // default where sizingBase = equity, not initialCapital).
  set('atrRisk.main.riskPct', p.riskPct);

  // We deliberately DO NOT call enforceConstraints — the legacy values
  // satisfy all spec constraints (emaFast<emaSlow, tp1Mult<=tp2Mult<=tp3Mult)
  // and any repair pass would change things we're trying to freeze.
  return g;
}

// ─── Helpers for pretty output ─────────────────────────────
function fmtUsd(v)    { return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(undefined, {maximumFractionDigits: 0}); }
function fmtPct(v)    { return (v * 100).toFixed(2) + '%'; }
function fmtPf(v)     { return Number.isFinite(v) ? v.toFixed(3) : String(v); }
function fmtTs(v)     { return v == null ? '—' : new Date(Number(v)).toISOString().replace('.000Z','Z').slice(0,16).replace('T',' '); }
function padR(s, n)   { const x = String(s); return x.length >= n ? x : x + ' '.repeat(n - x.length); }
function padL(s, n)   { const x = String(s); return x.length >= n ? x : ' '.repeat(n - x.length) + x; }

// Map legacy signal names to the new framework's equivalents so the diff
// doesn't flag expected naming differences. (Legacy 'TIME'/'STRUCT' in
// diagnose-btc.js is different from engine/strategy.js which uses
// 'Time'/'Structural' — we're comparing against strategy.js which already
// matches the new framework's naming, so this is a near-identity map.)
const SIGNAL_ALIASES = new Map([
  ['TIME',      'Time'],
  ['STRUCT',    'Structural'],
  ['REVERSAL',  'Reversal'],
]);
function canonSignal(s) { return SIGNAL_ALIASES.get(s) ?? s; }

// ─── Main ──────────────────────────────────────────────────
async function main() {
  console.log('\n=== Chunk 8 migration-gate parity test ===\n');

  // 1. Register blocks (the new framework needs the library).
  registry.__resetForTests();
  await registry.ensureLoaded();
  console.log(`• registered ${registry.list().length} blocks`);

  // 2. Load candles — shared by both engines.
  const startTs = new Date(START).getTime();
  const candles = await loadCandles(SYMBOL, TF_MIN, startTs);
  const n = candles.close.length;
  if (n === 0) { console.error(`No candles for ${SYMBOL} ${TF_MIN}min`); process.exit(1); }
  console.log(`• loaded ${n} ${TF_MIN}m bars (${new Date(Number(candles.ts[0])).toISOString().slice(0,10)} → ${new Date(Number(candles.ts[n-1])).toISOString().slice(0,10)})`);

  // 3. Compute the warmup both engines must use. Legacy computes this
  //    internally from its params; we replicate it here so we can pass the
  //    same tradingStartBar to both. (Without this, the engines diverge
  //    purely from starting on different bars.)
  const warmup = Math.max(
    LEGACY_PARAMS.stochLen + LEGACY_PARAMS.stochSmth * 2,
    LEGACY_PARAMS.rsiLen + 1,
    LEGACY_PARAMS.emaSlow,
    LEGACY_PARAMS.bbLen + 100,
    LEGACY_PARAMS.atrLen,
  ) + 5;
  console.log(`• shared warmup → tradingStartBar = ${warmup}\n`);

  // ── Legacy run ──
  console.log('• running legacy engine/strategy.js …');
  const tLegacy0 = Date.now();
  const legacy = runStrategy(candles, LEGACY_PARAMS, {
    tradingStartBar: warmup,
    collectTrades: true,
  });
  const tLegacy = Date.now() - tLegacy0;

  // ── New framework run ──
  console.log('• running new engine/runtime.js …');
  const here     = dirname(fileURLToPath(import.meta.url));
  const specPath = resolve(here, '..', 'strategies', '20260414-001-jm-simple-3tp-legacy.json');
  const spec     = validateSpec(JSON.parse(await readFile(specPath, 'utf8')), { sourcePath: specPath });
  const paramSpace = buildParamSpace(spec);
  const gene     = buildNewGene(LEGACY_PARAMS, paramSpace);

  const bundle = {
    symbol: SYMBOL,
    baseTfMin: TF_MIN, baseTfMs: TF_MIN * 60_000,
    base: candles,
    htfs: {},
    tradingStartBar: warmup,
    periodYears: (Number(candles.ts[n - 1]) - Number(candles.ts[warmup])) / (365.25 * 864e5),
  };

  const tNew0 = Date.now();
  const neu = runSpec({ spec, paramSpace, bundle, gene, opts: { collectTrades: true } });
  const tNew = Date.now() - tNew0;

  // ─── Summary table ────────────────────────────────────
  const rows = [
    ['metric',        'legacy',           'new',              'Δ abs',   'Δ %'],
    ['trades',        legacy.trades,      neu.trades,         neu.trades - legacy.trades, pctDelta(legacy.trades, neu.trades)],
    ['wins',          legacy.wins,        neu.wins,           neu.wins - legacy.wins,     pctDelta(legacy.wins, neu.wins)],
    ['win rate',      fmtPct(legacy.winRate), fmtPct(neu.winRate), fmtPct(neu.winRate - legacy.winRate), '—'],
    ['PF',            fmtPf(legacy.pf),   fmtPf(neu.pf),      (neu.pf - legacy.pf).toFixed(3), pctDelta(legacy.pf, neu.pf)],
    ['net profit',    fmtUsd(legacy.netProfit), fmtUsd(neu.netProfit), fmtUsd(neu.netProfit - legacy.netProfit), pctDelta(legacy.netProfit, neu.netProfit)],
    ['net %',         fmtPct(legacy.netProfitPct), fmtPct(neu.netProfitPct), fmtPct(neu.netProfitPct - legacy.netProfitPct), '—'],
    ['max DD',        fmtPct(legacy.maxDDPct), fmtPct(neu.maxDDPct), fmtPct(neu.maxDDPct - legacy.maxDDPct), '—'],
    ['final equity',  fmtUsd(legacy.equity - 100000), fmtUsd(neu.equity - 100000), fmtUsd(neu.equity - legacy.equity), pctDelta(legacy.equity, neu.equity)],
    ['runtime',       `${tLegacy}ms`,     `${tNew}ms`,        `${tNew - tLegacy}ms`, '—'],
  ];
  console.log('\n──── SUMMARY ────');
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
  for (const [i, r] of rows.entries()) {
    console.log('  ' + r.map((v, c) => c === 0 ? padR(v, widths[c]) : padL(v, widths[c])).join(' │ '));
    if (i === 0) console.log('  ' + widths.map(w => '─'.repeat(w)).join('─┼─'));
  }

  // ─── Exit-type breakdown ────────────────────────────
  console.log('\n──── EXIT-TYPE BREAKDOWN ────');
  const groupBySignal = (trades) => {
    const m = new Map();
    for (const t of trades) {
      const s = canonSignal(t.signal);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  };
  const legSigs = groupBySignal(legacy.tradeList ?? []);
  const newSigs = groupBySignal(neu.tradeList  ?? []);
  const allSigs = new Set([...legSigs.keys(), ...newSigs.keys()]);
  for (const s of [...allSigs].sort()) {
    const l = legSigs.get(s) ?? 0, nw = newSigs.get(s) ?? 0;
    const flag = l === nw ? '✓' : '✗';
    console.log(`  ${flag} ${padR(s, 12)} legacy=${padL(l, 4)}  new=${padL(nw, 4)}  Δ=${padL(nw - l, 4)}`);
  }

  // ─── Trade-by-trade diff (first N divergences) ─────
  console.log('\n──── TRADE-BY-TRADE DIFF ────');
  const diverged = diffTrades(legacy.tradeList ?? [], neu.tradeList ?? []);
  if (diverged.length === 0) {
    console.log('  ✓ all trades match bit-for-bit');
  } else {
    console.log(`  ✗ ${diverged.length} divergences (showing first ${Math.min(DIVERGENCE_LIMIT, diverged.length)})`);
    console.log('');
    console.log('  #  │ side  │ entry (legacy → new)               │ exit  (legacy → new)               │ signal        │ pnl legacy → new');
    console.log('  ───┼───────┼─────────────────────────────────────┼─────────────────────────────────────┼───────────────┼─────────────────────');
    for (const d of diverged.slice(0, DIVERGENCE_LIMIT)) {
      const l = d.legacy, nw = d.new;
      const side = (l?.direction ?? nw?.direction ?? '').padEnd(5);
      const entL = l ? fmtTs(l.entryTs) + ' @' + padL(l.entryPrice?.toFixed(2) ?? '-', 8) : padR('— (only new)', 30);
      const entN = nw ? fmtTs(nw.entryTs) + ' @' + padL(nw.entryPrice?.toFixed(2) ?? '-', 8) : padR('— (only legacy)', 30);
      const exL  = l ? fmtTs(l.exitTs) + ' @' + padL(l.exitPrice?.toFixed(2) ?? '-', 8) : padR('—', 30);
      const exN  = nw ? fmtTs(nw.exitTs) + ' @' + padL(nw.exitPrice?.toFixed(2) ?? '-', 8) : padR('—', 30);
      const sig  = padR(`${canonSignal(l?.signal ?? '-')} → ${canonSignal(nw?.signal ?? '-')}`, 13);
      const pnl  = `${fmtUsd(l?.pnl ?? 0)} → ${fmtUsd(nw?.pnl ?? 0)}`;
      console.log(`  ${padL(d.idx + 1, 3)} │ ${side} │ ${padR(entL + ' → ' + entN, 70)} │ ${padR(exL + ' → ' + exN, 70)} │ ${sig} │ ${pnl}`);
    }
  }

  // ─── Exit criterion ────────────────────────────────
  const TRADE_TOL = 0.005;  // ≤ 0.5 % trade-count delta
  const PF_TOL    = 0.02;   // ≤ 2 % PF delta
  const NET_TOL   = 0.02;   // ≤ 2 % net delta

  const tradeOk = Math.abs(pctDeltaNum(legacy.trades, neu.trades)) <= TRADE_TOL;
  const pfOk    = Math.abs(pctDeltaNum(legacy.pf,     neu.pf))     <= PF_TOL;
  const netOk   = Math.abs(pctDeltaNum(legacy.netProfit, neu.netProfit)) <= NET_TOL;

  console.log('\n──── GATE ────');
  console.log(`  trades within ±${TRADE_TOL * 100}% : ${tradeOk ? '✓' : '✗'}`);
  console.log(`  PF within ±${PF_TOL * 100}%     : ${pfOk ? '✓' : '✗'}`);
  console.log(`  net within ±${NET_TOL * 100}%    : ${netOk ? '✓' : '✗'}`);

  const pass = tradeOk && pfOk && netOk;
  console.log(pass ? '\nPARITY GATE: ✓ PASS\n' : '\nPARITY GATE: ✗ FAIL — investigate divergences above\n');
  process.exit(pass ? 0 : 1);
}

// Pair up trades in entry-time order, matching 1:1 where possible.
// Trades are considered the same "event" if they share entry timestamp AND
// exit signal position; anything that can't pair is flagged as a divergence.
function diffTrades(legacyList, newList) {
  const diverged = [];
  let i = 0, j = 0;
  let idx = 0;
  while (i < legacyList.length || j < newList.length) {
    const l = legacyList[i], nw = newList[j];
    if (!l && nw) { diverged.push({ idx, legacy: null, new: nw }); j++; idx++; continue; }
    if (!nw && l) { diverged.push({ idx, legacy: l, new: null }); i++; idx++; continue; }
    // Both defined
    const sameEntry = l.entryTs === nw.entryTs && l.direction === nw.direction;
    const sameSig   = canonSignal(l.signal) === canonSignal(nw.signal);
    const sameExit  = l.exitTs === nw.exitTs;
    const pnlClose  = Math.abs((l.pnl ?? 0) - (nw.pnl ?? 0)) < 0.01 * Math.max(1, Math.abs(l.pnl ?? 0));

    if (sameEntry && sameSig && sameExit && pnlClose) {
      // Matched; advance both
      i++; j++; idx++;
      continue;
    }
    if (sameEntry) {
      // Same entry, but exit / signal / pnl differs — flag the pair
      diverged.push({ idx, legacy: l, new: nw });
      i++; j++; idx++;
      continue;
    }
    // Different entries — whichever is earlier is an "unmatched" trade
    if ((l.entryTs ?? 0) < (nw.entryTs ?? 0)) {
      diverged.push({ idx, legacy: l, new: null });
      i++; idx++;
    } else {
      diverged.push({ idx, legacy: null, new: nw });
      j++; idx++;
    }
  }
  return diverged;
}

function pctDelta(a, b) {
  const d = pctDeltaNum(a, b);
  if (d === null) return '—';
  return (d * 100).toFixed(2) + '%';
}
function pctDeltaNum(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0 && b === 0) return 0;
  if (a === 0) return null;
  return (b - a) / Math.abs(a);
}

main().catch(e => { console.error(e); process.exit(1); });
