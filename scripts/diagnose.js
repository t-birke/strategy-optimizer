/**
 * Diagnostic: compare JS backtester trades vs TradingView trade-by-trade.
 * Outputs first N trades from JS engine and from TV for side-by-side analysis.
 */
import { loadCandles } from '../db/candles.js';
import { runStrategy } from '../engine/strategy.js';
import {
  sma, ema, rsi, stoch, atr, stdev, percentrank,
  crossover, crossunder,
} from '../engine/indicators.js';

BigInt.prototype.toJSON = function() { return Number(this); };

const PARAMS = {
  minEntry: 1, stochLen: 25, stochSmth: 5, rsiLen: 21,
  emaFast: 24, emaSlow: 130, bbLen: 31, bbMult: 1,
  atrLen: 30, atrSL: 1, tp1Mult: 2.5, tp2Mult: 4, tp3Mult: 4.5,
  tp1Pct: 10, tp2Pct: 40, riskPct: 5, maxBars: 5,
};

const SYMBOL = 'SOLUSDT';
const TF = 240;
const START = '2021-04-12';

async function main() {
  // 1. Load candles
  const startTs = new Date(START).getTime();
  const candles = await loadCandles(SYMBOL, TF, startTs);
  console.log(`Loaded ${candles.close.length} bars for ${SYMBOL} ${TF/60}H from ${START}`);

  // 2. Run standard backtest for summary
  const metrics = runStrategy(candles, PARAMS);
  console.log('\n=== JS Backtester Summary ===');
  console.log(`Net Profit: $${Math.round(metrics.netProfit).toLocaleString()}`);
  console.log(`Trades: ${metrics.trades}`);
  console.log(`Win Rate: ${(metrics.winRate * 100).toFixed(1)}%`);
  console.log(`PF: ${metrics.pf?.toFixed(2)}`);
  console.log(`Max DD: ${(metrics.maxDDPct * 100).toFixed(1)}%`);

  // 3. Run instrumented version that logs every trade
  console.log('\n=== First 30 Trades (JS) ===');
  console.log('Dir  | Entry Bar | Entry Price | Exit Bar | Exit Price | Type     | PnL');
  console.log('-----|-----------|-------------|----------|------------|----------|--------');
  const trades = runInstrumented(candles, PARAMS);
  trades.slice(0, 30).forEach(t => {
    const dir = t.dir === 1 ? 'LONG ' : 'SHORT';
    const pnl = t.pnl >= 0 ? `+${t.pnl.toFixed(2)}` : t.pnl.toFixed(2);
    console.log(`${dir} | ${String(t.entryBar).padStart(9)} | ${t.entryPrice.toFixed(4).padStart(11)} | ${String(t.exitBar).padStart(8)} | ${t.exitPrice.toFixed(4).padStart(10)} | ${t.exitType.padEnd(8)} | ${pnl}`);
  });

  console.log(`\nTotal trade events: ${trades.length}`);
  console.log(`Unique entries: ${new Set(trades.map(t => t.entryBar)).size}`);

  // 4. Check entry timing issue
  console.log('\n=== Entry Price Analysis ===');
  let entryAtClose = 0, entryAtNextOpen = 0;
  for (const t of trades.slice(0, 50)) {
    const nextBar = t.entryBar + 1;
    if (nextBar < candles.close.length) {
      const closeDiff = Math.abs(t.entryPrice - candles.close[t.entryBar]);
      const openDiff = Math.abs(t.entryPrice - candles.open[nextBar]);
      if (closeDiff < openDiff) entryAtClose++;
      else entryAtNextOpen++;
    }
  }
  console.log(`Entry matches current close: ${entryAtClose}`);
  console.log(`Entry matches next open: ${entryAtNextOpen}`);
  console.log('NOTE: TradingView strategy.entry() fills at NEXT bar open, not current close!');

  // 5. Simulate "entry at next open" impact
  console.log('\n=== Impact of entry-at-next-open ===');
  const metricsNextOpen = runStrategy(candles, PARAMS, { entryAtNextOpen: true });
  // Won't work yet, but show the diff in entry prices
  let totalSlippage = 0;
  for (const t of trades.slice(0, 100)) {
    const nextBar = t.entryBar + 1;
    if (nextBar < candles.close.length) {
      const slip = candles.open[nextBar] - candles.close[t.entryBar];
      totalSlippage += t.dir === 1 ? slip : -slip; // positive = worse fill for longs
    }
  }
  console.log(`Avg entry slippage (close→next open, first 100 trades): $${(totalSlippage / Math.min(trades.length, 100)).toFixed(4)}`);
  console.log(`Direction: positive = next-open is worse for the trade`);

  // 6. Check if multiple TPs fire on same bar
  let sameBars = 0;
  const byEntry = new Map();
  for (const t of trades) {
    if (!byEntry.has(t.entryBar)) byEntry.set(t.entryBar, []);
    byEntry.get(t.entryBar).push(t);
  }
  for (const [, group] of byEntry) {
    const exitBars = new Set(group.map(t => t.exitBar));
    if (group.length > 1) {
      for (const bar of exitBars) {
        const count = group.filter(t => t.exitBar === bar).length;
        if (count > 1) sameBars++;
      }
    }
  }
  console.log(`\nMultiple TPs on same bar: ${sameBars} occurrences`);

  process.exit(0);
}

/**
 * Instrumented strategy that logs every trade event.
 */
function runInstrumented(candles, params) {
  const {
    minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
    bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
    tp1Pct, tp2Pct, riskPct, maxBars,
  } = params;

  const initialCapital = 100000;
  const len = candles.close.length;
  const COMMISSION_PCT = 0.06 / 100;

  // Indicators (same as strategy.js)
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
  let posSize = 0, entryPrice = 0, entryBar = 0, entryAtr = 0, tp1Hit = false, remainingUnits = 0;

  const warmup = Math.max(stochLen + stochSmth * 2, rsiLen + 1, emaSlow, bbLen + 100, atrLen) + 5;

  function logTrade(units, exitPrice, exitBar, isLong, exitType) {
    const entryComm = Math.abs(units) * entryPrice * COMMISSION_PCT;
    const exitComm = Math.abs(units) * exitPrice * COMMISSION_PCT;
    const pnl = isLong
      ? units * (exitPrice - entryPrice) - entryComm - exitComm
      : Math.abs(units) * (entryPrice - exitPrice) - entryComm - exitComm;
    equity += pnl;
    trades.push({
      dir: isLong ? 1 : -1,
      entryBar, entryPrice, exitBar, exitPrice,
      units: Math.abs(units), pnl, exitType,
      equityAfter: equity,
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
    const c = candles.close[i], h = candles.high[i], l = candles.low[i];
    if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

    if (posSize !== 0) {
      const isLong = posSize > 0;
      const barsHeld = i - entryBar;
      let slPrice = isLong
        ? (tp1Hit ? entryPrice * 1.003 : entryPrice - entryAtr * atrSL)
        : (tp1Hit ? entryPrice * 0.997 : entryPrice + entryAtr * atrSL);
      const tp1Price = isLong ? entryPrice + entryAtr * tp1Mult : entryPrice - entryAtr * tp1Mult;
      const tp2Price = isLong ? entryPrice + entryAtr * tp2Mult : entryPrice - entryAtr * tp2Mult;
      const tp3Price = isLong ? entryPrice + entryAtr * tp3Mult : entryPrice - entryAtr * tp3Mult;

      if (barsHeld >= maxBars) {
        logTrade(Math.abs(remainingUnits), c, i, isLong, 'TIME');
        posSize = 0; remainingUnits = 0; continue;
      }

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
        logTrade(Math.abs(remainingUnits), c, i, isLong, 'STRUCT');
        posSize = 0; remainingUnits = 0; continue;
      }

      if (isLong ? l <= slPrice : h >= slPrice) {
        logTrade(Math.abs(remainingUnits), slPrice, i, isLong, 'SL');
        posSize = 0; remainingUnits = 0; continue;
      }

      if (!tp1Hit && (isLong ? h >= tp1Price : l <= tp1Price)) {
        const tp1Units = Math.abs(remainingUnits) * tp1Pct / 100;
        logTrade(tp1Units, tp1Price, i, isLong, 'TP1');
        remainingUnits = isLong ? remainingUnits - tp1Units : remainingUnits + tp1Units;
        tp1Hit = true;
      }
      if (remainingUnits !== 0 && (isLong ? h >= tp2Price : l <= tp2Price)) {
        const currentAbs = Math.abs(remainingUnits);
        const tp2Units = currentAbs * tp2Pct / 100;
        logTrade(tp2Units, tp2Price, i, isLong, 'TP2');
        remainingUnits = isLong ? remainingUnits - tp2Units : remainingUnits + tp2Units;
      }
      if (remainingUnits !== 0 && (isLong ? h >= tp3Price : l <= tp3Price)) {
        logTrade(Math.abs(remainingUnits), tp3Price, i, isLong, 'TP3');
        remainingUnits = 0;
      }

      posSize = remainingUnits;
      if (Math.abs(posSize) < 0.0001) { posSize = 0; remainingUnits = 0; }
    }

    if (posSize === 0) {
      const ls = longScore(i), ss = shortScore(i);
      if (ls >= minEntry || ss >= minEntry) {
        const isLong = ls >= minEntry;
        const curAtr = atrArr[i];
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

  return trades;
}

main().catch(e => { console.error(e); process.exit(1); });
