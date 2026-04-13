/**
 * JM Simple 3TP — bar-by-bar strategy simulation.
 * Mirrors the PineScript strategy logic from jm_simple_3tp.pine.
 *
 * Returns performance metrics matching TradingView's report format.
 */

import {
  sma, ema, rsi, stoch, atr, stdev, percentrank,
  crossover, crossunder,
} from './indicators.js';

const COMMISSION_PCT = 0.06 / 100; // 0.06% per side

/**
 * Run the JM Simple 3TP strategy on columnar candle data.
 *
 * @param {Object} candles — { open, high, low, close, volume, ts } Float64Arrays
 * @param {Object} params — strategy parameters (18 genes)
 *   minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
 *   bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
 *   tp1Pct, tp2Pct, riskPct, maxBars, emergencySlPct
 * @param {Object} [opts] — { initialCapital: 100000, leverage: 1 }
 * @returns {Object} metrics
 */
export function runStrategy(candles, params, opts = {}) {
  const {
    minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
    bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
    tp1Pct, tp2Pct, riskPct, maxBars,
  } = params;

  const emergencySlPct = params.emergencySlPct ?? 25;

  const initialCapital = opts.initialCapital ?? 100000;
  const leverage = opts.leverage ?? 1;
  const len = candles.close.length;

  // ─── Compute indicators ────────────────────────────────────
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

  // ─── Pre-compute per-bar signals ───────────────────────────
  // We need "squeeze in last 3 bars" so pre-compute squeeze flag
  const squeeze = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    squeeze[i] = bbPctRank[i] < 25 ? 1 : 0;
  }

  // ─── State machine ─────────────────────────────────────────
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDD = 0;
  let maxDDPct = 0;

  // Position state
  let posSize = 0;        // +units = long, -units = short, 0 = flat
  let entryPrice = 0;
  let entryBar = 0;
  let entryAtr = 0;
  let tp1Hit = false;
  let tp2Hit = false;
  let remainingUnits = 0;

  // Pending entry — signals on bar N, fill at bar N+1's open (matches TV)
  let pendingEntry = null;  // { isLong, atr }

  // Pending exits — all strategy.close() equivalents defer to next bar's open
  // to match PineScript's execution model where strategy.close() fills at next open.
  let pendingClose = null;  // { isLong } — structural, time, or SL exits

  // Close-based SL uses 2-step deferral matching Pine's slTriggered pattern:
  // Bar N: close crosses SL → slTriggered = true
  // Bar N+1: slTriggered → pendingClose set (strategy.close placed) → fills at bar N+2 open
  let slTriggered = false;

  // Metrics accumulators
  let totalTrades = 0;    // Each partial exit counts as a trade (matches TV)
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  // For Sharpe: track per-trade returns
  const tradeReturns = [];

  // ─── Helper: apply commission and update equity ────────────
  function closeTrade(units, exitPrice, isLong) {
    const entryCommission = Math.abs(units) * entryPrice * COMMISSION_PCT;
    const exitCommission = Math.abs(units) * exitPrice * COMMISSION_PCT;
    const pnl = isLong
      ? units * (exitPrice - entryPrice) - entryCommission - exitCommission
      : Math.abs(units) * (entryPrice - exitPrice) - entryCommission - exitCommission;

    equity += pnl;
    totalTrades++;

    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else {
      grossLoss += Math.abs(pnl);
    }

    tradeReturns.push(pnl / initialCapital);

    // DD tracking
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity - equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peakEquity > 0 ? dd / peakEquity : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;

    return units; // consumed units
  }

  // ─── Main loop — bar by bar ────────────────────────────────
  // Start from whichever is later: indicator warmup or trading start bar.
  // When pre-warmed data is loaded before the start date, tradingStartBar
  // will be >= warmup, so indicators are fully ready by the time we trade.
  const warmup = Math.max(stochLen + stochSmth * 2, rsiLen + 1, emaSlow, bbLen + 100, atrLen) + 5;
  const tradingStartBar = opts.tradingStartBar ?? 0;
  const startBar = Math.max(warmup, tradingStartBar);

  for (let i = startBar; i < len; i++) {
    const c = candles.close[i];
    const h = candles.high[i];
    const l = candles.low[i];
    const o = candles.open[i];

    // Skip if indicators are NaN
    if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

    // ─── Execute pending close at this bar's open ──────
    // Matches Pine's strategy.close() which fills at next bar's open.
    // Must execute BEFORE pending entry so reversals work:
    // close fills → position flat → entry fills (both at same bar's open).
    if (pendingClose && posSize !== 0) {
      closeTrade(Math.abs(remainingUnits), o, pendingClose.isLong);
      posSize = 0;
      remainingUnits = 0;
      pendingClose = null;
    }

    // ─── Execute pending entry at this bar's open ────────
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
        }
      }
    }

    // ─── slTriggered → place close order (2nd step of close-based SL) ──
    // Matches Pine: slTriggered set on bar N → strategy.close() on bar N+1 → fills bar N+2
    if (slTriggered && posSize !== 0) {
      pendingClose = { isLong: posSize > 0 };
      slTriggered = false;
    }
    if (posSize === 0) slTriggered = false;

    // ─── Exit checks ────────────────────────────────────
    if (posSize !== 0) {
      const isLong = posSize > 0;
      const ep = entryPrice;
      const barsHeld = i - entryBar;

      let fullExit = false;

      // --- 1. Emergency SL (intra-bar, fires on ANY bar including entry bar) ---
      // Hard circuit-breaker against catastrophic liquidity events.
      const emergencyPrice = isLong
        ? ep * (1 - emergencySlPct / 100)
        : ep * (1 + emergencySlPct / 100);

      if (isLong ? l <= emergencyPrice : h >= emergencyPrice) {
        closeTrade(Math.abs(remainingUnits), emergencyPrice, isLong);
        posSize = 0;
        remainingUnits = 0;
        fullExit = true;
      }

      // --- 2. TP checks (intra-bar, skip entry bar) ---
      if (!fullExit && barsHeld >= 1) {
        const tp1Price = isLong ? ep + entryAtr * tp1Mult : ep - entryAtr * tp1Mult;
        const tp2Price = isLong ? ep + entryAtr * tp2Mult : ep - entryAtr * tp2Mult;
        const tp3Price = isLong ? ep + entryAtr * tp3Mult : ep - entryAtr * tp3Mult;

        if (!tp1Hit) {
          const tp1Reached = isLong ? h >= tp1Price : l <= tp1Price;
          if (tp1Reached) {
            const tp1Units = Math.abs(remainingUnits) * tp1Pct / 100;
            closeTrade(tp1Units, tp1Price, isLong);
            remainingUnits = isLong
              ? remainingUnits - tp1Units
              : remainingUnits + tp1Units;
            tp1Hit = true;
          }
        }

        if (!tp2Hit && remainingUnits !== 0) {
          const tp2Reached = isLong ? h >= tp2Price : l <= tp2Price;
          if (tp2Reached) {
            const currentAbs = Math.abs(remainingUnits);
            const tp2Units = currentAbs * tp2Pct / 100;
            closeTrade(tp2Units, tp2Price, isLong);
            remainingUnits = isLong
              ? remainingUnits - tp2Units
              : remainingUnits + tp2Units;
            tp2Hit = true;
          }
        }

        if (remainingUnits !== 0) {
          const tp3Reached = isLong ? h >= tp3Price : l <= tp3Price;
          if (tp3Reached) {
            closeTrade(Math.abs(remainingUnits), tp3Price, isLong);
            remainingUnits = 0;
          }
        }

        posSize = remainingUnits;
        if (Math.abs(posSize) < 0.0001) {
          posSize = 0;
          remainingUnits = 0;
          fullExit = true;
        }
      }

      // --- 3. Time-based exit (deferred to next bar's open, matches Pine strategy.close()) ---
      if (!fullExit && posSize !== 0 && barsHeld >= maxBars) {
        pendingClose = { isLong };
        fullExit = true;
      }

      // --- 4. Structural exits (deferred to next bar's open, matches Pine strategy.close()) ---
      if (!fullExit && posSize !== 0) {
        let structuralExit = false;
        let oppSignalFired = false;
        if (isLong) {
          const stochExit = stochCrossDown[i] && stochK[i] > 60;
          const rsiExit = rsiArr[i] < 40 && i >= 3 && rsiArr[i - 3] > 55;
          oppSignalFired = computeShortScore(i) >= minEntry;
          structuralExit = stochExit || rsiExit || oppSignalFired;
        } else {
          const stochExit = stochCrossUp[i] && stochK[i] < 40;
          const rsiExit = rsiArr[i] > 60 && i >= 3 && rsiArr[i - 3] < 45;
          oppSignalFired = computeLongScore(i) >= minEntry;
          structuralExit = stochExit || rsiExit || oppSignalFired;
        }

        if (structuralExit) {
          pendingClose = { isLong };
          fullExit = true;

          // Pine reversal: entry("S") fires on same bar as close("L") when
          // goShort and position_size >= 0. Both fill at next bar's open.
          if (oppSignalFired) {
            pendingEntry = { isLong: !isLong, atr: atrArr[i] };
          }
        }
      }

      // --- 5. Close-based SL (2-step deferral matching Pine's slTriggered pattern) ---
      // Bar N: close crosses SL → slTriggered = true
      // Bar N+1: slTriggered → pendingClose (strategy.close) → fills bar N+2 open
      if (!fullExit && posSize !== 0 && barsHeld >= 1 && !slTriggered) {
        let slPrice;
        if (isLong) {
          slPrice = tp1Hit ? ep * 1.003 : ep - entryAtr * atrSL;
        } else {
          slPrice = tp1Hit ? ep * 0.997 : ep + entryAtr * atrSL;
        }

        if (isLong ? c <= slPrice : c >= slPrice) {
          slTriggered = true;
        }
      }
    }

    // ─── Entry checks (if flat and no pending close/entry/SL) ──
    if (posSize === 0 && !pendingEntry && !pendingClose && !slTriggered) {
      const longScore = computeLongScore(i);
      const shortScore = computeShortScore(i);

      if (longScore >= minEntry) {
        pendingEntry = { isLong: true, atr: atrArr[i] };
      } else if (shortScore >= minEntry) {
        pendingEntry = { isLong: false, atr: atrArr[i] };
      }
    }

    // DD tracking on equity curve even without trades
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity - equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peakEquity > 0 ? dd / peakEquity : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  // ─── Close any open position at last bar ──────────────────
  if (posSize !== 0) {
    const lastClose = candles.close[len - 1];
    closeTrade(Math.abs(remainingUnits), lastClose, posSize > 0);
    posSize = 0;
    pendingClose = null;
  }

  // ─── Compute final metrics ────────────────────────────────
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const netProfit = equity - initialCapital;
  const netProfitPct = netProfit / initialCapital;

  // Sharpe ratio (annualized, assuming ~365 trades/year as rough proxy)
  let sharpe = 0;
  if (tradeReturns.length > 1) {
    const mean = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
    const variance = tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (tradeReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(tradeReturns.length) : 0;
  }

  return {
    trades: totalTrades,
    wins,
    winRate,
    pf,
    netProfit,
    netProfitPct,
    maxDD,
    maxDDPct,
    sharpe,
    equity,
  };

  // ─── Signal scoring functions (closures over indicator arrays) ──
  function computeLongScore(bar) {
    let score = 0;
    // 1. Stoch bullish crossover: K crosses above D, K < 40
    if (stochCrossUp[bar] && stochK[bar] < 40) score++;
    // 2. EMA bull
    if (emaF[bar] > emaS[bar]) score++;
    // 3. BB squeeze in last 3 bars + close > basis
    const recentSqueeze = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (recentSqueeze && candles.close[bar] > bbBasis[bar]) score++;
    return score;
  }

  function computeShortScore(bar) {
    let score = 0;
    // 1. Stoch bearish crossover: K crosses below D, K > 60
    if (stochCrossDown[bar] && stochK[bar] > 60) score++;
    // 2. EMA bear
    if (emaF[bar] < emaS[bar]) score++;
    // 3. BB squeeze in last 3 bars + close < basis
    const recentSqueeze = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (recentSqueeze && candles.close[bar] < bbBasis[bar]) score++;
    return score;
  }
}
