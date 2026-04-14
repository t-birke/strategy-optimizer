/**
 * JM Simple 3TP — bar-by-bar strategy simulation.
 * Mirrors the PineScript strategy logic from jm_simple_3tp.pine.
 *
 * Each position is split into 3 sub-entries (TP1/TP2/TP3 tiers), matching
 * Pine's 3-entry approach with pyramiding=2. Each sub-position has its own
 * TP level and is independently closed by its limit exit. SL/Time/Structural
 * exits close all remaining sub-positions.
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
  const collectTrades = opts.collectTrades ?? false;
  const collectEquity = opts.collectEquity ?? false;
  // Slippage: matches TradingView standard (slippage=2 ticks, mintick=$0.01).
  // Applied to market/stop fills (entries, close exits, ESL) but NOT to limit fills (TPs).
  const SLIPPAGE_TICKS = 2;
  const MINTICK        = 0.01;
  const slippage       = SLIPPAGE_TICKS * MINTICK;
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
  const squeeze = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    squeeze[i] = bbPctRank[i] < 25 ? 1 : 0;
  }

  // ─── State machine ─────────────────────────────────────────
  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDD = 0;
  let maxDDPct = 0;

  // Position state — 3 sub-positions per trade
  let posDir = 0;          // +1 long, -1 short, 0 flat
  let subs = [];           // [{units, tpMult, closed}] — 3 sub-entries per position
  let entryPrice = 0;
  let entryBar = 0;
  let entryAtr = 0;
  let tp1Hit = false;      // Used for breakeven SL calculation
  let tp1HitBar = -1;      // Bar on which TP1 filled (1-bar delay matching Pine's detection)

  // Pending entry — signals on bar N, fill at bar N+1's open (matches TV)
  let pendingEntry = null;  // { isLong, atr }

  // Pending exits — all strategy.close() equivalents defer to next bar's open
  let pendingClose = null;  // { isLong, signal } — structural, time, or SL exits

  // Close-based SL uses 2-step deferral matching Pine's slTriggered pattern
  let slTriggered = false;

  // Metrics accumulators
  let totalTrades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const tradeReturns = [];
  const tradeList = collectTrades ? [] : null;
  const equityHistory = collectEquity ? [] : null;

  // ─── Helper: close one sub-position and update equity ──────
  function closeSub(subUnits, exitPrice, isLong, signal, exitBar) {
    const entryComm = subUnits * entryPrice * COMMISSION_PCT;
    const exitComm = subUnits * exitPrice * COMMISSION_PCT;
    const pnl = isLong
      ? subUnits * (exitPrice - entryPrice) - entryComm - exitComm
      : subUnits * (entryPrice - exitPrice) - entryComm - exitComm;

    equity += pnl;
    totalTrades++;

    if (pnl > 0) { wins++; grossProfit += pnl; }
    else { grossLoss += Math.abs(pnl); }

    tradeReturns.push(pnl / initialCapital);

    if (collectTrades) {
      tradeList.push({
        direction: isLong ? 'Long' : 'Short',
        entryTs:   candles.ts ? Number(candles.ts[entryBar]) : null,
        exitTs:    candles.ts ? Number(candles.ts[exitBar ?? entryBar]) : null,
        signal:    signal ?? 'Close',
        entryPrice,
        exitPrice,
        sizeAsset: subUnits,
        sizeUsdt:  subUnits * exitPrice,
        pnl,
        pnlPct:    pnl / initialCapital,
      });
    }

    // DD tracking
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity - equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peakEquity > 0 ? dd / peakEquity : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  // ─── Helper: close ALL remaining sub-positions ─────────────
  function closeAllSubs(exitPrice, isLong, signal, exitBar) {
    for (const sub of subs) {
      if (!sub.closed) {
        closeSub(sub.units, exitPrice, isLong, signal, exitBar);
        sub.closed = true;
      }
    }
    posDir = 0;
    subs = [];
  }

  // ─── Helper: check if all subs are closed ──────────────────
  function allSubsClosed() {
    return subs.length === 0 || subs.every(s => s.closed);
  }

  // ─── Main loop — bar by bar ────────────────────────────────
  const warmup = Math.max(stochLen + stochSmth * 2, rsiLen + 1, emaSlow, bbLen + 100, atrLen) + 5;
  const tradingStartBar = opts.tradingStartBar ?? 0;
  const tradingEndBar = opts.tradingEndBar ?? len;
  const startBar = Math.max(warmup, tradingStartBar);
  const endBar = Math.min(len, tradingEndBar);

  for (let i = startBar; i < endBar; i++) {
    const c = candles.close[i];
    const h = candles.high[i];
    const l = candles.low[i];
    const o = candles.open[i];

    if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

    // ─── Execute pending close at this bar's open ──────
    // Matches Pine's strategy.close() which fills at next bar's open.
    // Must execute BEFORE pending entry so reversals work.
    if (pendingClose && posDir !== 0) {
      const isLong = posDir > 0;
      const closeSlip = isLong ? o - slippage : o + slippage;
      closeAllSubs(closeSlip, isLong, pendingClose.signal, i);
      pendingClose = null;
    } else if (pendingClose && posDir === 0) {
      // Stale pending close — position was already closed by intra-bar exit
      pendingClose = null;
    }

    // ─── Execute pending entry at this bar's open ────────
    if (pendingEntry && posDir === 0) {
      const pe = pendingEntry;
      pendingEntry = null;
      const fillPrice = pe.isLong ? o + slippage : o - slippage;
      const slDist = pe.atr * atrSL;
      if (slDist > 0 && fillPrice > 0) {
        const riskAmt = equity * riskPct / 100;
        let units = riskAmt / slDist;
        const maxUnits = equity * leverage / fillPrice;
        units = Math.min(units, maxUnits);
        if (units > 0) {
          const u1 = units * tp1Pct / 100;
          const u2 = units * tp2Pct / 100;
          const u3 = units - u1 - u2;  // Remainder avoids rounding gap
          posDir = pe.isLong ? 1 : -1;
          subs = [
            { units: u1, tpMult: tp1Mult, closed: false },
            { units: u2, tpMult: tp2Mult, closed: false },
            { units: u3, tpMult: tp3Mult, closed: false },
          ];
          entryPrice = fillPrice;
          entryBar = i;
          entryAtr = pe.atr;
          tp1Hit = false;
          tp1HitBar = -1;
        }
      }
    }

    // ─── slTriggered → place close order (2nd step of close-based SL) ──
    if (slTriggered && posDir !== 0) {
      pendingClose = { isLong: posDir > 0, signal: 'SL' };
      slTriggered = false;
    }
    if (posDir === 0) slTriggered = false;

    // ─── Exit checks ────────────────────────────────────
    if (posDir !== 0) {
      const isLong = posDir > 0;
      const ep = entryPrice;
      const barsHeld = i - entryBar;

      let fullExit = false;

      // --- 1. Emergency SL (intra-bar, fires on ANY bar including entry bar) ---
      const emergencyPrice = isLong
        ? ep * (1 - emergencySlPct / 100)
        : ep * (1 + emergencySlPct / 100);

      if (isLong ? l <= emergencyPrice : h >= emergencyPrice) {
        const eslFill = isLong ? emergencyPrice - slippage : emergencyPrice + slippage;
        closeAllSubs(eslFill, isLong, 'ESL', i);
        fullExit = true;
      }

      // --- 2. TP checks (intra-bar, skip entry bar) ---
      // Each sub-position checks its own TP level independently.
      if (!fullExit && barsHeld >= 1) {
        const tpSignals = ['TP1', 'TP2', 'TP3'];

        for (let s = 0; s < subs.length; s++) {
          if (subs[s].closed) continue;
          const tpPrice = isLong
            ? ep + entryAtr * subs[s].tpMult
            : ep - entryAtr * subs[s].tpMult;
          const tpReached = isLong ? h >= tpPrice : l <= tpPrice;
          if (tpReached) {
            closeSub(subs[s].units, tpPrice, isLong, tpSignals[s], i);
            subs[s].closed = true;
            // Record TP1 fill bar for breakeven SL with 1-bar delay
            if (s === 0) tp1HitBar = i;
          }
        }

        // Pine detects TP1 via position_size change on NEXT bar
        if (tp1HitBar >= 0 && i > tp1HitBar) tp1Hit = true;

        // Check if all subs closed by TPs
        if (allSubsClosed()) {
          posDir = 0;
          subs = [];
          fullExit = true;
        }
      }

      // --- 3. Time-based exit (deferred to next bar's open) ---
      if (!fullExit && posDir !== 0 && !pendingClose && barsHeld >= maxBars - 1) {
        pendingClose = { isLong, signal: 'Time' };
        fullExit = true;
      }

      // --- 4. Structural exits (deferred to next bar's open) ---
      if (!fullExit && posDir !== 0 && !pendingClose) {
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
          pendingClose = { isLong, signal: oppSignalFired ? 'Reversal' : 'Structural' };
          fullExit = true;

          if (oppSignalFired) {
            pendingEntry = { isLong: !isLong, atr: atrArr[i] };
          }
        }
      }

      // --- 5. Close-based SL (2-step deferral matching Pine's slTriggered pattern) ---
      if (posDir !== 0 && !slTriggered) {
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
    if (posDir === 0 && !pendingEntry && !pendingClose && !slTriggered) {
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

    // Record per-bar equity for charting
    if (collectEquity) {
      // Mark-to-market: equity + unrealized PnL of open subs
      let mtm = equity;
      if (posDir !== 0) {
        for (const sub of subs) {
          if (sub.closed) continue;
          const unrealized = posDir > 0
            ? sub.units * (c - entryPrice)
            : sub.units * (entryPrice - c);
          mtm += unrealized;
        }
      }
      equityHistory.push({ ts: Number(candles.ts[i]), equity: mtm });
    }
  }

  // ─── Close any open position at last bar ──────────────────
  if (posDir !== 0) {
    const lastBar = endBar - 1;
    const lastClose = candles.close[lastBar];
    const isLong = posDir > 0;
    closeAllSubs(lastClose, isLong, 'End', lastBar);
    pendingClose = null;
  }

  // ─── Compute final metrics ────────────────────────────────
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const netProfit = equity - initialCapital;
  const netProfitPct = netProfit / initialCapital;

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
    ...(collectTrades ? { tradeList } : {}),
    ...(collectEquity ? { equityHistory } : {}),
  };

  // ─── Signal scoring functions (closures over indicator arrays) ──
  function computeLongScore(bar) {
    let score = 0;
    if (stochCrossUp[bar] && stochK[bar] < 40) score++;
    if (emaF[bar] > emaS[bar]) score++;
    const recentSqueeze = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (recentSqueeze && candles.close[bar] > bbBasis[bar]) score++;
    return score;
  }

  function computeShortScore(bar) {
    let score = 0;
    if (stochCrossDown[bar] && stochK[bar] > 60) score++;
    if (emaF[bar] < emaS[bar]) score++;
    const recentSqueeze = squeeze[bar] || (bar > 0 && squeeze[bar - 1]) || (bar > 1 && squeeze[bar - 2]);
    if (recentSqueeze && candles.close[bar] < bbBasis[bar]) score++;
    return score;
  }
}
