/**
 * Compare entry signals between JS engine and TradingView.
 *
 * Usage:
 *   node scripts/compare-entries.js [symbol] [tf_minutes]
 *
 * Defaults: BTCUSDT 240 (4H)
 *
 * What it does:
 *   1. Reads current TV strategy inputs via the CLI tool
 *   2. Loads candle data from DuckDB
 *   3. Runs the JS strategy in "trace" mode — recording every entry signal
 *   4. Pulls the TV trade list via eval
 *   5. Aligns by timestamp and prints a side-by-side diff
 */

import { execSync } from 'child_process';
import { loadCandles } from '../db/candles.js';
import {
  sma, ema, rsi, stoch, atr, stdev, percentrank,
  crossover, crossunder,
} from '../engine/indicators.js';

const TV_CLI = '/Users/tbirke/dev/trading/tradingview-mcp-jackson/src/cli/index.js';
const SYMBOL = process.argv[2] || 'BTCUSDT';
const TF_MIN = parseInt(process.argv[3] || '240');

function tvExec(args) {
  const out = execSync(`node ${TV_CLI} ${args}`, { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(out);
}

function tvEval(expr) {
  const escaped = expr.replace(/'/g, "'\\''");
  const res = tvExec(`ui eval '${escaped}'`);
  return typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
}

function fmtDate(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

// ─── Step 1: Get current TV inputs ─────────────────────────────
console.log('--- Step 1: Reading TradingView inputs ---');

const stateRes = tvExec('state');
console.log(`Chart: ${stateRes.symbol} @ ${stateRes.resolution}min`);

// Validate chart matches
const expectedSymbol = `BINANCE:${SYMBOL}`;
if (stateRes.symbol !== expectedSymbol) {
  console.error(`\nERROR: TradingView chart is on ${stateRes.symbol}, expected ${expectedSymbol}`);
  console.error(`Please switch to ${expectedSymbol} ${TF_MIN}min in TradingView and re-run.`);
  process.exit(1);
}
if (parseInt(stateRes.resolution) !== TF_MIN) {
  console.error(`\nERROR: TradingView timeframe is ${stateRes.resolution}min, expected ${TF_MIN}min`);
  process.exit(1);
}

const tvInputs = tvEval(`
JSON.stringify((function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value();
  var studies = chart.getAllStudies();
  var strat = null;
  for (var i = 0; i < studies.length; i++) {
    if (/JM|3TP/i.test(studies[i].name || studies[i].title || "")) { strat = studies[i]; break; }
  }
  if (!strat) return {error: "not found"};
  var study = chart.getStudyById(strat.id);
  var vals = study.getInputValues();
  var result = {};
  for (var j = 0; j < vals.length; j++) result[vals[j].id] = vals[j].value;
  return result;
})())
`);

const INPUT_TO_GENE = {
  in_2: 'minEntry', in_3: 'stochLen', in_4: 'stochSmth', in_5: 'rsiLen',
  in_6: 'emaFast', in_7: 'emaSlow', in_8: 'bbLen', in_9: 'bbMult',
  in_10: 'atrLen', in_11: 'atrSL', in_12: 'tp1Mult', in_13: 'tp2Mult',
  in_14: 'tp3Mult', in_15: 'tp1Pct', in_16: 'tp2Pct', in_17: 'riskPct',
  in_18: 'maxBars', in_19: 'leverage', in_20: 'emergencySlPct',
};

if (tvInputs.error) { console.error('ERROR:', tvInputs.error); process.exit(1); }

const params = {};
for (const [inputId, geneName] of Object.entries(INPUT_TO_GENE)) {
  if (tvInputs[inputId] !== undefined) params[geneName] = tvInputs[inputId];
}

console.log('Params from TV:', JSON.stringify(params, null, 2));

const {
  minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
  bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
  tp1Pct, tp2Pct, riskPct, maxBars,
} = params;
const emergencySlPct = params.emergencySlPct ?? 25;

// ─── Step 2: Get TV entries ─────────────────────────────────────
console.log('\n--- Step 2: Extracting TradingView trades ---');

// Compact extraction: [ts, dir_flag, price] arrays to stay under shell limits
const tvTrades = tvEval(`
JSON.stringify((function() {
  var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
  var sources = chart.model().model().dataSources();
  var strat = null;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    var meta = s.metaInfo ? s.metaInfo() : null;
    if (meta && meta.description && /JM Simple 3TP/i.test(meta.description)) { strat = s; break; }
  }
  if (!strat) return {e: "strategy not found"};
  var rd = typeof strat.reportData === "function" ? strat.reportData() : strat.reportData;
  if (rd && typeof rd.value === "function") rd = rd.value();
  var trades = rd.trades;
  if (!trades) return {e: "no trades"};
  var r = [];
  for (var t = 0; t < trades.length; t++) {
    r.push([trades[t].e.tm, trades[t].e.tp === "le" ? 1 : 0, trades[t].e.p]);
  }
  return {n: trades.length, r: r};
})())
`);
if (tvTrades.e) { console.error('TV ERROR:', tvTrades.e); process.exit(1); }

// Expand compact format
tvTrades.total = tvTrades.n;
tvTrades.entries = tvTrades.r.map(([ts, dirFlag, price]) => ({
  ts, dir: dirFlag === 1 ? 'LONG' : 'SHORT', price
}));

console.log(`TV trades: ${tvTrades.total}`);

// Group TV trades into "positions" — consecutive entries at the same timestamp
// are partial fills of the same entry. The first trade per timestamp is the entry.
const tvEntries = [];
const tvSeen = new Set();
for (const t of tvTrades.entries) {
  const key = `${t.ts}_${t.dir}`;
  if (!tvSeen.has(key)) {
    tvSeen.add(key);
    tvEntries.push(t);
  }
}
console.log(`TV unique entry signals: ${tvEntries.length}`);

// ─── Step 3: Run JS strategy in trace mode ─────────────────────
console.log('\n--- Step 3: Running JS engine ---');

const startTs = typeof tvInputs.in_0 === 'number' ? tvInputs.in_0 : new Date('2021-04-11').getTime();
const endTs = typeof tvInputs.in_1 === 'number' ? tvInputs.in_1 : Infinity;
console.log(`Start date from TV: ${fmtDate(startTs)}`);

// Load extra bars before start date for indicator warmup (matching PineScript behavior)
const WARMUP_BARS = 200;
const preloadTs = startTs - WARMUP_BARS * TF_MIN * 60000;
const candles = await loadCandles(SYMBOL, TF_MIN, preloadTs);
const len = candles.close.length;

// Find the first bar at or after the requested start date
let tradingStartBar = 0;
for (let i = 0; i < len; i++) {
  if (candles.ts[i] >= startTs) { tradingStartBar = i; break; }
}
console.log(`Candles loaded: ${len} bars from ${fmtDate(candles.ts[0])} to ${fmtDate(candles.ts[len - 1])}`);
console.log(`Trading starts at bar ${tradingStartBar} (${fmtDate(candles.ts[tradingStartBar])})`);

// Compute indicators
const stochRaw = stoch(candles.close, candles.high, candles.low, stochLen);
const stochK = sma(stochRaw, stochSmth);
const stochD = sma(stochK, stochSmth);

const rsiArr = rsi(candles.close, rsiLen);

const emaF = ema(candles.close, emaFast);
const emaS = ema(candles.close, emaSlow);

const bbBasis = sma(candles.close, bbLen);
const bbStd = stdev(candles.close, bbLen);
const bbUpper = new Float64Array(len);
const bbLower = new Float64Array(len);
const bbWidth = new Float64Array(len);
for (let i = 0; i < len; i++) {
  bbUpper[i] = bbBasis[i] + bbMult * bbStd[i];
  bbLower[i] = bbBasis[i] - bbMult * bbStd[i];
  bbWidth[i] = bbBasis[i] > 0 ? (bbUpper[i] - bbLower[i]) / bbBasis[i] * 100 : 0;
}
const bbPctRank = percentrank(bbWidth, 100);

const atrArr = atr(candles.high, candles.low, candles.close, atrLen);

const stochCrossUp = crossover(stochK, stochD);
const stochCrossDown = crossunder(stochK, stochD);

const squeeze = new Uint8Array(len);
for (let i = 0; i < len; i++) {
  squeeze[i] = bbPctRank[i] < 25 ? 1 : 0;
}

function computeLongScore(bar) {
  let score = 0;
  if (stochCrossUp[bar] && stochK[bar] < 40) score++;
  if (emaF[bar] > emaS[bar]) score++;
  const sq = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
  if (sq && candles.close[bar] > bbBasis[bar]) score++;
  return score;
}

function computeShortScore(bar) {
  let score = 0;
  if (stochCrossDown[bar] && stochK[bar] > 60) score++;
  if (emaF[bar] < emaS[bar]) score++;
  const sq = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
  if (sq && candles.close[bar] < bbBasis[bar]) score++;
  return score;
}

// Run full strategy simulation, tracing entries
const leverage = params.leverage ?? 1;
let equity = 100000;
let posSize = 0;
let entryPrice = 0;
let entryBar = 0;
let entryAtr = 0;
let tp1Hit = false;
let tp2Hit = false;
let remainingUnits = 0;
let pendingEntry = null;
let pendingClose = null;
let slTriggered = false;

const jsEntries = [];

const warmup = Math.max(stochLen + stochSmth * 2, rsiLen + 1, emaSlow, bbLen + 100, atrLen) + 5;
const startBar = Math.max(warmup, tradingStartBar);
console.log(`Indicator warmup: ${warmup} bars, startBar: ${startBar}`);

for (let i = startBar; i < len; i++) {
  const c = candles.close[i];
  const h = candles.high[i];
  const l = candles.low[i];
  const o = candles.open[i];

  if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

  // Execute pending close at this bar's open (matches Pine strategy.close())
  // Must execute BEFORE pending entry so reversals work.
  if (pendingClose && posSize !== 0) {
    const pnl = pendingClose.isLong
      ? Math.abs(remainingUnits) * (o - entryPrice)
      : Math.abs(remainingUnits) * (entryPrice - o);
    equity += pnl;
    posSize = 0;
    remainingUnits = 0;
    pendingClose = null;
  }

  // Execute pending entry at this bar's open
  if (pendingEntry && posSize === 0) {
    const pe = pendingEntry;
    pendingEntry = null;
    const fillPrice = o;
    const slDist = pe.atr * atrSL;
    if (slDist > 0 && fillPrice > 0) {
      const riskAmt = equity * riskPct / 100;
      let units = riskAmt / slDist;
      const maxUnits = equity * leverage / fillPrice;
      units = Math.min(units, maxUnits);
      if (units > 0) {
        posSize = pe.isLong ? units : -units;
        remainingUnits = posSize;
        entryPrice = fillPrice;
        entryBar = i;
        entryAtr = pe.atr;
        tp1Hit = false;
        tp2Hit = false;

        jsEntries.push({
          signalBar: pe.signalBar,
          signalTs: pe.signalTs,
          fillBar: i,
          fillTs: candles.ts[i],
          dir: pe.isLong ? 'LONG' : 'SHORT',
          fillPrice,
          score: pe.score,
          conditions: pe.conditions,
        });
      }
    }
  }

  // slTriggered → pendingClose (2nd step of close-based SL, matches Pine)
  if (slTriggered && posSize !== 0) {
    pendingClose = { isLong: posSize > 0 };
    slTriggered = false;
  }
  if (posSize === 0) slTriggered = false;

  // Exit checks
  if (posSize !== 0) {
    const isLong = posSize > 0;
    const ep = entryPrice;
    const barsHeld = i - entryBar;
    let fullExit = false;

    // Emergency SL
    const emergPrice = isLong ? ep * (1 - emergencySlPct / 100) : ep * (1 + emergencySlPct / 100);
    if (isLong ? l <= emergPrice : h >= emergPrice) {
      equity += isLong
        ? Math.abs(remainingUnits) * (emergPrice - ep)
        : Math.abs(remainingUnits) * (ep - emergPrice);
      posSize = 0; remainingUnits = 0; fullExit = true;
    }

    // TPs
    if (!fullExit && barsHeld >= 1) {
      const tp1Price = isLong ? ep + entryAtr * tp1Mult : ep - entryAtr * tp1Mult;
      const tp2Price = isLong ? ep + entryAtr * tp2Mult : ep - entryAtr * tp2Mult;
      const tp3Price = isLong ? ep + entryAtr * tp3Mult : ep - entryAtr * tp3Mult;

      if (!tp1Hit && (isLong ? h >= tp1Price : l <= tp1Price)) {
        const u = Math.abs(remainingUnits) * tp1Pct / 100;
        equity += isLong ? u * (tp1Price - ep) : u * (ep - tp1Price);
        remainingUnits = isLong ? remainingUnits - u : remainingUnits + u;
        tp1Hit = true;
      }
      if (!tp2Hit && remainingUnits !== 0 && (isLong ? h >= tp2Price : l <= tp2Price)) {
        const u = Math.abs(remainingUnits) * tp2Pct / 100;
        equity += isLong ? u * (tp2Price - ep) : u * (ep - tp2Price);
        remainingUnits = isLong ? remainingUnits - u : remainingUnits + u;
        tp2Hit = true;
      }
      if (remainingUnits !== 0 && (isLong ? h >= tp3Price : l <= tp3Price)) {
        equity += isLong
          ? Math.abs(remainingUnits) * (tp3Price - ep)
          : Math.abs(remainingUnits) * (ep - tp3Price);
        remainingUnits = 0;
      }

      posSize = remainingUnits;
      if (Math.abs(posSize) < 0.0001) { posSize = 0; remainingUnits = 0; fullExit = true; }
    }

    // Time exit (deferred to next bar's open)
    if (!fullExit && posSize !== 0 && barsHeld >= maxBars) {
      pendingClose = { isLong };
      fullExit = true;
    }

    // Structural exits (deferred to next bar's open)
    if (!fullExit && posSize !== 0) {
      let se = false;
      let oppSignal = false;
      if (isLong) {
        oppSignal = computeShortScore(i) >= minEntry;
        se = (stochCrossDown[i] && stochK[i] > 60) || (rsiArr[i] < 40 && i >= 3 && rsiArr[i - 3] > 55) || oppSignal;
      } else {
        oppSignal = computeLongScore(i) >= minEntry;
        se = (stochCrossUp[i] && stochK[i] < 40) || (rsiArr[i] > 60 && i >= 3 && rsiArr[i - 3] < 45) || oppSignal;
      }
      if (se) {
        pendingClose = { isLong };
        fullExit = true;

        // Pine reversal: opposite entry fires on same bar as structural close
        if (oppSignal) {
          const revLong = !isLong;
          const revScore = revLong ? computeLongScore(i) : computeShortScore(i);
          pendingEntry = {
            isLong: revLong, atr: atrArr[i], signalBar: i, signalTs: candles.ts[i],
            score: revScore,
            conditions: {
              stochX: revLong ? (stochCrossUp[i] && stochK[i] < 40 ? 1 : 0) : (stochCrossDown[i] && stochK[i] > 60 ? 1 : 0),
              emaTrend: revLong ? (emaF[i] > emaS[i] ? 1 : 0) : (emaF[i] < emaS[i] ? 1 : 0),
              bbSetup: revLong
                ? ((squeeze[i] || (i > 0 && squeeze[i - 1]) || (i > 1 && squeeze[i - 2])) && candles.close[i] > bbBasis[i] ? 1 : 0)
                : ((squeeze[i] || (i > 0 && squeeze[i - 1]) || (i > 1 && squeeze[i - 2])) && candles.close[i] < bbBasis[i] ? 1 : 0),
              stochK: +stochK[i].toFixed(2),
              stochD: +stochD[i].toFixed(2),
              rsi: +rsiArr[i].toFixed(2),
              bbPR: +bbPctRank[i].toFixed(2),
            },
          };
        }
      }
    }

    // Close-based SL (2-step deferral matching Pine's slTriggered pattern)
    if (!fullExit && posSize !== 0 && barsHeld >= 1 && !slTriggered) {
      let slPrice;
      if (isLong) slPrice = tp1Hit ? ep * 1.003 : ep - entryAtr * atrSL;
      else slPrice = tp1Hit ? ep * 0.997 : ep + entryAtr * atrSL;

      if (isLong ? c <= slPrice : c >= slPrice) {
        slTriggered = true;
      }
    }
  }

  // Entry checks
  if (posSize === 0 && !pendingEntry && !pendingClose && !slTriggered) {
    const longScore = computeLongScore(i);
    const shortScore = computeShortScore(i);

    if (longScore >= minEntry) {
      pendingEntry = {
        isLong: true, atr: atrArr[i], signalBar: i, signalTs: candles.ts[i],
        score: longScore,
        conditions: {
          stochX: stochCrossUp[i] && stochK[i] < 40 ? 1 : 0,
          emaTrend: emaF[i] > emaS[i] ? 1 : 0,
          bbSetup: (squeeze[i] || (i > 0 && squeeze[i - 1]) || (i > 1 && squeeze[i - 2])) && candles.close[i] > bbBasis[i] ? 1 : 0,
          stochK: +stochK[i].toFixed(2),
          stochD: +stochD[i].toFixed(2),
          rsi: +rsiArr[i].toFixed(2),
          bbPR: +bbPctRank[i].toFixed(2),
        },
      };
    } else if (shortScore >= minEntry) {
      pendingEntry = {
        isLong: false, atr: atrArr[i], signalBar: i, signalTs: candles.ts[i],
        score: shortScore,
        conditions: {
          stochX: stochCrossDown[i] && stochK[i] > 60 ? 1 : 0,
          emaTrend: emaF[i] < emaS[i] ? 1 : 0,
          bbSetup: (squeeze[i] || (i > 0 && squeeze[i - 1]) || (i > 1 && squeeze[i - 2])) && candles.close[i] < bbBasis[i] ? 1 : 0,
          stochK: +stochK[i].toFixed(2),
          stochD: +stochD[i].toFixed(2),
          rsi: +rsiArr[i].toFixed(2),
          bbPR: +bbPctRank[i].toFixed(2),
        },
      };
    }
  }
}

console.log(`JS entries: ${jsEntries.length}`);

// ─── Step 4: Compare ────────────────────────────────────────────
console.log('\n--- Step 4: Comparing entries ---');

// Build lookup maps by fill timestamp
const tvByTs = new Map();
for (const e of tvEntries) tvByTs.set(e.ts, e);

const jsByTs = new Map();
for (const e of jsEntries) jsByTs.set(e.fillTs, e);

// Collect all timestamps
const allTs = new Set([...tvByTs.keys(), ...jsByTs.keys()]);
const sorted = [...allTs].sort((a, b) => a - b);

let matched = 0, jsOnly = 0, tvOnly = 0, dirMismatch = 0;
const mismatches = [];

for (const ts of sorted) {
  const tv = tvByTs.get(ts);
  const js = jsByTs.get(ts);

  if (tv && js) {
    if (tv.dir === js.dir) {
      matched++;
    } else {
      dirMismatch++;
      mismatches.push({ ts, type: 'DIR_MISMATCH', date: fmtDate(ts), tvDir: tv.dir, jsDir: js.dir, tvPrice: tv.price, jsPrice: js.fillPrice });
    }
  } else if (js && !tv) {
    jsOnly++;
    if (mismatches.length < 200) {
      mismatches.push({ ts, type: 'JS_ONLY', date: fmtDate(js.fillTs), dir: js.dir, price: js.fillPrice, score: js.score, cond: js.conditions });
    }
  } else if (tv && !js) {
    tvOnly++;
    if (mismatches.length < 200) {
      mismatches.push({ ts, type: 'TV_ONLY', date: fmtDate(tv.ts), dir: tv.dir, price: tv.price });
    }
  }
}

console.log(`\n========== ENTRY COMPARISON ==========`);
console.log(`Matched (same ts + dir): ${matched}`);
console.log(`Direction mismatch:      ${dirMismatch}`);
console.log(`JS only (not in TV):     ${jsOnly}`);
console.log(`TV only (not in JS):     ${tvOnly}`);
console.log(`Total JS entries:        ${jsEntries.length}`);
console.log(`Total TV entries:        ${tvEntries.length}`);

if (mismatches.length > 0) {
  console.log(`\n--- First ${Math.min(50, mismatches.length)} mismatches ---`);
  for (const m of mismatches.slice(0, 50)) {
    if (m.type === 'JS_ONLY') {
      console.log(`  ${m.date}  JS_ONLY  ${m.dir.padEnd(5)}  price=${m.price.toFixed(2)}  score=${m.score}  stochX=${m.cond.stochX} ema=${m.cond.emaTrend} bb=${m.cond.bbSetup}  K=${m.cond.stochK} D=${m.cond.stochD} RSI=${m.cond.rsi} bbPR=${m.cond.bbPR}`);
    } else if (m.type === 'TV_ONLY') {
      console.log(`  ${m.date}  TV_ONLY  ${m.dir.padEnd(5)}  price=${m.price.toFixed(2)}`);
    } else {
      console.log(`  ${m.date}  DIR_MISMATCH  tv=${m.tvDir} js=${m.jsDir}  tvP=${m.tvPrice} jsP=${m.jsPrice}`);
    }
  }
}

// Show chronological first 20 trades side by side
console.log(`\n--- First 20 entries chronologically ---`);
console.log(`${'Date'.padEnd(17)} ${'TV'.padEnd(8)} ${'JS'.padEnd(8)} ${'TV Price'.padEnd(12)} ${'JS Price'.padEnd(12)} Match`);
for (const ts of sorted.slice(0, 20)) {
  const tv = tvByTs.get(ts);
  const js = jsByTs.get(ts);
  const tvDir = tv?.dir || '-';
  const jsDir = js?.dir || '-';
  const tvP = tv ? tv.price.toFixed(2) : '-';
  const jsP = js ? js.fillPrice.toFixed(2) : '-';
  const match = tv && js && tv.dir === js.dir ? 'OK' : tv && js ? 'DIR!' : tv ? 'TV' : 'JS';
  console.log(`${fmtDate(ts).padEnd(17)} ${tvDir.padEnd(8)} ${jsDir.padEnd(8)} ${String(tvP).padEnd(12)} ${String(jsP).padEnd(12)} ${match}`);
}

process.exit(0);
