/**
 * Comprehensive BTC diagnostic: JS backtester vs TradingView trade-by-trade.
 */
import { loadCandles } from '../db/candles.js';
import {
  sma, ema, rsi, stoch, atr, stdev, percentrank,
  crossover, crossunder,
} from '../engine/indicators.js';

BigInt.prototype.toJSON = function() { return Number(this); };

// BTC winner: E2 St39/6 R16 EMA14/135 BB40x3 ATR24 SL3.25 TP2.5/6/7 @10/10/80% R5% T25b
const PARAMS = {
  minEntry: 2, stochLen: 39, stochSmth: 6, rsiLen: 16,
  emaFast: 14, emaSlow: 135, bbLen: 40, bbMult: 3,
  atrLen: 24, atrSL: 3.25, tp1Mult: 2.5, tp2Mult: 6, tp3Mult: 7,
  tp1Pct: 10, tp2Pct: 10, riskPct: 5, maxBars: 25,
};

const SYMBOL = 'BTCUSDT';
const TF = 240;
const START = '2021-04-12';
const COMMISSION_PCT = 0.06 / 100;

async function main() {
  // 1. Load candles
  const startTs = new Date(START).getTime();
  const candles = await loadCandles(SYMBOL, TF, startTs);
  console.log(`Loaded ${candles.close.length} bars for ${SYMBOL} ${TF/60}H from ${START}`);
  console.log(`Date range: ${new Date(Number(candles.ts[0])).toISOString().slice(0,10)} to ${new Date(Number(candles.ts[candles.close.length-1])).toISOString().slice(0,10)}`);

  // 2. Run instrumented backtest (entry at close — current behavior)
  const tradesClose = runInstrumented(candles, PARAMS, { entryMode: 'close' });
  const summaryClose = summarize(tradesClose);

  // 3. Run with entry at next bar's open
  const tradesOpen = runInstrumented(candles, PARAMS, { entryMode: 'next_open' });
  const summaryOpen = summarize(tradesOpen);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Entry Mode Comparison                                       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Metric          │ Entry@Close    │ Entry@NextOpen │ TV      ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  printRow('Net Profit', `$${k(summaryClose.netProfit)}`, `$${k(summaryOpen.netProfit)}`, '$265,919');
  printRow('Trade Events', summaryClose.tradeCount, summaryOpen.tradeCount, '594');
  printRow('Unique Entries', summaryClose.uniqueEntries, summaryOpen.uniqueEntries, '~594?');
  printRow('Win Rate', pct(summaryClose.winRate), pct(summaryOpen.winRate), '58.1%');
  printRow('Profit Factor', summaryClose.pf.toFixed(2), summaryOpen.pf.toFixed(2), '1.37');
  printRow('Gross Profit', `$${k(summaryClose.grossProfit)}`, `$${k(summaryOpen.grossProfit)}`, '$988,575');
  printRow('Gross Loss', `$${k(summaryClose.grossLoss)}`, `$${k(summaryOpen.grossLoss)}`, '$722,657');
  printRow('Max DD %', pct(summaryClose.maxDDPct), pct(summaryOpen.maxDDPct), '24.8%');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 4. Exit type breakdown
  console.log('\n=== Exit Type Breakdown ===');
  for (const mode of ['close', 'next_open']) {
    const trades = mode === 'close' ? tradesClose : tradesOpen;
    const byType = {};
    for (const t of trades) {
      byType[t.exitType] = (byType[t.exitType] || 0) + 1;
    }
    console.log(`  ${mode === 'close' ? 'Entry@Close' : 'Entry@NextOpen'}:`, Object.entries(byType).map(([k,v]) => `${k}=${v}`).join(', '));
  }

  // 5. First 20 trades comparison
  console.log('\n=== First 20 Trades: Entry@Close vs Entry@NextOpen ===');
  console.log('  #  | Dir   | Entry@Close    | Entry@NextOpen | Diff      | Exit Type | PnL@Close  | PnL@NextOpen');
  for (let i = 0; i < Math.min(20, tradesClose.length); i++) {
    const tc = tradesClose[i];
    const to = tradesOpen[i];
    if (!tc || !to) break;
    const dir = tc.dir === 1 ? 'LONG ' : 'SHORT';
    const diff = to ? (to.entryPrice - tc.entryPrice).toFixed(2) : '-';
    const date = new Date(Number(candles.ts[tc.entryBar])).toISOString().slice(0,10);
    console.log(`  ${String(i+1).padStart(2)} | ${dir} | ${tc.entryPrice.toFixed(2).padStart(12)} ${date} | ${to ? to.entryPrice.toFixed(2).padStart(12) : '-'.padStart(12)} | ${String(diff).padStart(9)} | ${tc.exitType.padEnd(9)} | ${tc.pnl >= 0 ? '+' : ''}${tc.pnl.toFixed(0).padStart(9)} | ${to ? (to.pnl >= 0 ? '+' : '') + to.pnl.toFixed(0).padStart(9) : '-'}`);
  }

  // 6. Entry slippage analysis
  console.log('\n=== Entry Slippage: Close vs Next Open ===');
  let totalSlip = 0, slipCount = 0;
  const slippages = [];
  const entries = new Set();
  for (const t of tradesClose) {
    if (entries.has(t.entryBar)) continue; // only count each entry once
    entries.add(t.entryBar);
    const nextBar = t.entryBar + 1;
    if (nextBar < candles.close.length) {
      const closePrice = candles.close[t.entryBar];
      const nextOpenPrice = candles.open[nextBar];
      // Slippage: how much worse is next-open for this trade direction
      const slip = t.dir === 1
        ? (nextOpenPrice - closePrice) // long: higher next-open = worse
        : (closePrice - nextOpenPrice); // short: lower next-open = worse
      totalSlip += slip;
      slipCount++;
      slippages.push(slip);
    }
  }
  slippages.sort((a, b) => a - b);
  console.log(`  Entries analyzed: ${slipCount}`);
  console.log(`  Mean slippage: $${(totalSlip / slipCount).toFixed(2)} (+ = next-open is worse)`);
  console.log(`  Median slippage: $${slippages[Math.floor(slipCount/2)].toFixed(2)}`);
  console.log(`  P10/P90: $${slippages[Math.floor(slipCount*0.1)].toFixed(2)} / $${slippages[Math.floor(slipCount*0.9)].toFixed(2)}`);
  console.log(`  Max favorable: $${slippages[0].toFixed(2)}`);
  console.log(`  Max adverse: $${slippages[slipCount-1].toFixed(2)}`);

  // 7. Commission analysis
  console.log('\n=== Commission Impact ===');
  const tradesNoComm = runInstrumented(candles, PARAMS, { entryMode: 'next_open', commission: 0 });
  const summaryNoComm = summarize(tradesNoComm);
  console.log(`  With 0.06% commission: $${k(summaryOpen.netProfit)}`);
  console.log(`  Without commission:    $${k(summaryNoComm.netProfit)}`);
  console.log(`  Total commission paid: $${k(summaryNoComm.netProfit - summaryOpen.netProfit)}`);

  // 8. Position sizing analysis
  console.log('\n=== Position Sizing (first 10 entries) ===');
  const entryBars = new Set();
  for (const t of tradesClose) {
    if (entryBars.has(t.entryBar)) continue;
    entryBars.add(t.entryBar);
    if (entryBars.size > 10) break;
    const date = new Date(Number(candles.ts[t.entryBar])).toISOString().slice(0,10);
    console.log(`  Bar ${t.entryBar} (${date}): ${t.dir === 1 ? 'LONG' : 'SHORT'} ${t.units.toFixed(6)} units @ $${t.entryPrice.toFixed(2)} = $${(t.units * t.entryPrice).toFixed(0)} notional (equity ~$${t.equityBefore.toFixed(0)})`);
  }

  process.exit(0);
}

function runInstrumented(candles, params, opts = {}) {
  const {
    minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
    bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
    tp1Pct, tp2Pct, riskPct, maxBars,
  } = params;

  const entryMode = opts.entryMode || 'close';
  const commPct = opts.commission ?? COMMISSION_PCT;
  const initialCapital = 100000;
  const len = candles.close.length;

  // Indicators
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
  for (let i = 0; i < len; i++) squeeze[i] = bbPctRank[i] < 25 ? 1 : 0;

  const trades = [];
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDD = 0, maxDDPct = 0;
  let posSize = 0, entryPrice = 0, entryBar = 0, entryAtr = 0, tp1Hit = false, remainingUnits = 0;
  // Pending entry: when entryMode='next_open', we store the signal and enter next bar
  let pendingEntry = null;

  const warmup = Math.max(stochLen + stochSmth * 2, rsiLen + 1, emaSlow, bbLen + 100, atrLen) + 5;

  function logTrade(units, exitPrice, exitBar, isLong, exitType, equityBefore) {
    const entryComm = Math.abs(units) * entryPrice * commPct;
    const exitComm = Math.abs(units) * exitPrice * commPct;
    const pnl = isLong
      ? units * (exitPrice - entryPrice) - entryComm - exitComm
      : Math.abs(units) * (entryPrice - exitPrice) - entryComm - exitComm;
    equity += pnl;
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity - equity;
    if (dd > maxDD) maxDD = dd;
    const ddp = peakEquity > 0 ? dd / peakEquity : 0;
    if (ddp > maxDDPct) maxDDPct = ddp;
    trades.push({
      dir: isLong ? 1 : -1,
      entryBar, entryPrice, exitBar, exitPrice,
      units: Math.abs(units), pnl, exitType, equityBefore,
    });
  }

  function longScore(bar) {
    let s = 0;
    if (stochCrossUp[bar] && stochK[bar] < 40) s++;
    if (emaF[bar] > emaS[bar]) s++;
    const sq = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (sq && candles.close[bar] > bbBasis[bar]) s++;
    return s;
  }
  function shortScore(bar) {
    let s = 0;
    if (stochCrossDown[bar] && stochK[bar] > 60) s++;
    if (emaF[bar] < emaS[bar]) s++;
    const sq = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (sq && candles.close[bar] < bbBasis[bar]) s++;
    return s;
  }

  for (let i = warmup; i < len; i++) {
    const c = candles.close[i], h = candles.high[i], l = candles.low[i], o = candles.open[i];
    if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

    // Execute pending entry at this bar's open
    if (pendingEntry && posSize === 0) {
      const pe = pendingEntry;
      pendingEntry = null;
      const fillPrice = o; // fill at this bar's open
      const curAtr = pe.atr;
      const slDist = curAtr * atrSL;
      if (slDist > 0 && fillPrice > 0) {
        let units = (equity * riskPct / 100) / slDist;
        units = Math.min(units, equity / fillPrice);
        if (units > 0) {
          posSize = pe.isLong ? units : -units;
          remainingUnits = posSize;
          entryPrice = fillPrice;
          entryBar = i;
          entryAtr = curAtr;
          tp1Hit = false;
        }
      }
    }

    // Exits
    if (posSize !== 0) {
      const isLong = posSize > 0;
      const barsHeld = i - entryBar;
      const slPrice = isLong
        ? (tp1Hit ? entryPrice * 1.003 : entryPrice - entryAtr * atrSL)
        : (tp1Hit ? entryPrice * 0.997 : entryPrice + entryAtr * atrSL);
      const tp1Price = isLong ? entryPrice + entryAtr * tp1Mult : entryPrice - entryAtr * tp1Mult;
      const tp2Price = isLong ? entryPrice + entryAtr * tp2Mult : entryPrice - entryAtr * tp2Mult;
      const tp3Price = isLong ? entryPrice + entryAtr * tp3Mult : entryPrice - entryAtr * tp3Mult;

      let fullExit = false;

      if (barsHeld >= maxBars) {
        logTrade(Math.abs(remainingUnits), c, i, isLong, 'TIME', equity);
        posSize = 0; remainingUnits = 0; fullExit = true;
      }

      if (!fullExit) {
        let structExit = false;
        if (isLong) {
          structExit = (stochCrossDown[i] && stochK[i] > 60)
            || (rsiArr[i] < 40 && i >= 3 && rsiArr[i - 3] > 55)
            || (shortScore(i) >= minEntry);
        } else {
          structExit = (stochCrossUp[i] && stochK[i] < 40)
            || (rsiArr[i] > 60 && i >= 3 && rsiArr[i - 3] < 45)
            || (longScore(i) >= minEntry);
        }
        if (structExit) {
          logTrade(Math.abs(remainingUnits), c, i, isLong, 'STRUCT', equity);
          posSize = 0; remainingUnits = 0; fullExit = true;
        }
      }

      if (!fullExit && (isLong ? l <= slPrice : h >= slPrice)) {
        logTrade(Math.abs(remainingUnits), slPrice, i, isLong, 'SL', equity);
        posSize = 0; remainingUnits = 0; fullExit = true;
      }

      if (!fullExit) {
        if (!tp1Hit && (isLong ? h >= tp1Price : l <= tp1Price)) {
          const tp1Units = Math.abs(remainingUnits) * tp1Pct / 100;
          logTrade(tp1Units, tp1Price, i, isLong, 'TP1', equity);
          remainingUnits = isLong ? remainingUnits - tp1Units : remainingUnits + tp1Units;
          tp1Hit = true;
        }
        if (remainingUnits !== 0 && (isLong ? h >= tp2Price : l <= tp2Price)) {
          const currentAbs = Math.abs(remainingUnits);
          const tp2Units = currentAbs * tp2Pct / 100;
          logTrade(tp2Units, tp2Price, i, isLong, 'TP2', equity);
          remainingUnits = isLong ? remainingUnits - tp2Units : remainingUnits + tp2Units;
        }
        if (remainingUnits !== 0 && (isLong ? h >= tp3Price : l <= tp3Price)) {
          logTrade(Math.abs(remainingUnits), tp3Price, i, isLong, 'TP3', equity);
          remainingUnits = 0;
        }

        posSize = remainingUnits;
        if (Math.abs(posSize) < 0.0001) { posSize = 0; remainingUnits = 0; }
      }
    }

    // Entry signals (check even after exits — enables position flipping like TV)
    if (posSize === 0 && !pendingEntry) {
      const ls = longScore(i), ss = shortScore(i);
      if (ls >= minEntry || ss >= minEntry) {
        const isLong = ls >= minEntry;
        const curAtr = atrArr[i];

        if (entryMode === 'next_open') {
          pendingEntry = { isLong, atr: curAtr, signalBar: i };
        } else {
          // Entry at close (current behavior)
          const slDist = curAtr * atrSL;
          if (slDist <= 0 || c <= 0) continue;
          let units = (equity * riskPct / 100) / slDist;
          units = Math.min(units, equity / c);
          if (units <= 0) continue;
          posSize = isLong ? units : -units;
          remainingUnits = posSize;
          entryPrice = c;
          entryBar = i;
          entryAtr = curAtr;
          tp1Hit = false;
        }
      }
    }
  }
  return trades;
}

function summarize(trades) {
  let grossProfit = 0, grossLoss = 0, wins = 0;
  let equity = 100000, peak = 100000, maxDD = 0, maxDDPct = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (t.pnl > 0) { wins++; grossProfit += t.pnl; }
    else { grossLoss += Math.abs(t.pnl); }
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    const ddp = peak > 0 ? dd / peak : 0;
    if (ddp > maxDDPct) maxDDPct = ddp;
  }
  return {
    netProfit: equity - 100000,
    tradeCount: trades.length,
    uniqueEntries: new Set(trades.map(t => t.entryBar)).size,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : 0,
    grossProfit, grossLoss,
    maxDDPct,
  };
}

function k(v) { return Math.round(v).toLocaleString(); }
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function printRow(label, a, b, tv) {
  console.log(`║  ${label.padEnd(16)} │ ${String(a).padEnd(14)} │ ${String(b).padEnd(14)} │ ${String(tv).padEnd(7)} ║`);
}

main().catch(e => { console.error(e); process.exit(1); });
