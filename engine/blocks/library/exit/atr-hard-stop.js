/**
 * atrHardStop — ATR-anchored stop-loss with Pine's 2-bar close-based deferral
 * plus a fixed-% emergency intra-bar stop.
 *
 * Two independent protection layers:
 *
 *   (A) Close-based SL — bar N's close pierces `entryPrice ± entryAtr*atrSL`
 *       → mark triggered; bar N+1 emits `closeNextBarOpen`; bar N+2 fills at
 *       open. This replicates Pine's `if close <= slPrice \n strategy.close()`
 *       pattern where position_size changes on the bar AFTER the close check.
 *
 *   (B) Emergency SL (ESL) — intra-bar hard floor at a fixed % (`emergencySlPct`)
 *       below/above entry. Fires immediately, same bar, with market slippage
 *       applied by the block. Protects against gap-through scenarios where
 *       the 2-bar deferral would lose far more than planned.
 *
 * TP1 → breakeven interaction: once the target block records
 * `position.state.tp1HitBar`, this block shifts the close-based SL to
 * `entryPrice * 1.003` (long) / `0.997` (short) — a tight breakeven-plus
 * lock matching the legacy strategy. We derive `tp1Hit` locally from
 * position.state with a 1-bar delay so slot evaluation order doesn't matter.
 *
 * `planStop()` is implemented so atrRisk sizing can size to this block's
 * planned SL distance.
 */

import { KINDS, DIRECTIONS, EXIT_SLOTS } from '../../contract.js';
import { SLIPPAGE } from '../../../execution-costs.js';

// Breakeven-plus SL multipliers once TP1 has filled (Pine-parity with legacy).
const BE_PLUS_LONG  = 1.003;
const BE_PLUS_SHORT = 0.997;

export default {
  id: 'atrHardStop', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.HARD_STOP,
  direction: DIRECTIONS.BOTH,
  description: 'ATR-anchored stop-loss with Pine\'s 2-bar close-based deferral plus a fixed-% emergency intra-bar stop. Tightens to breakeven-plus once TP1 fills. Implements planStop() so risk-based sizing can size to its planned distance.',

  declaredParams() {
    return [
      { id: 'atrLen',          type: 'int',   min: 5,   max: 50,  step: 1 },
      // step=0.05 — fine enough for tuning, and 0.25 is a valid multiple so
      // legacy-parity specs can use the coarser JM Simple 3TP grid directly.
      { id: 'atrSL',           type: 'float', min: 0.5, max: 6.0, step: 0.05 },
      { id: 'emergencySlPct',  type: 'float', min: 5,   max: 50,  step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [{
      key: `base:atr:${params.atrLen}`,
      tf: 'base',
      indicator: 'atr',
      args: { period: params.atrLen },
    }];
  },

  prepare(bundle, params, indicators, state) {
    state.atr   = indicators.get(`base:atr:${params.atrLen}`);
    state.high  = bundle.base.high;
    state.low   = bundle.base.low;
    state.close = bundle.base.close;
  },

  /**
   * Called pre-open so atrRisk sizing can compute units from stop distance.
   * Uses atr[i-1] to match the legacy `entryAtr` (captured at signal bar,
   * which is the bar BEFORE the fill). Returns null on first bar or while
   * ATR is still warming up — sizing block falls back to its declared
   * default (or declines the entry if it has no fallback).
   *
   * Runtime guarantees prepare() has run before planStop(), so state.atr
   * is populated.
   */
  planStop(_bundle, i, state, params, isLong, fillPrice) {
    if (!state.atr || i < 1) return null;
    const a = state.atr[i - 1];
    if (!(a > 0) || isNaN(a)) return null;
    const dist = a * params.atrSL;
    if (!(dist > 0)) return null;
    return {
      price: isLong ? fillPrice - dist : fillPrice + dist,
      distance: dist,
    };
  },

  onPositionOpen(position, params, state, ctx) {
    // Capture entry ATR so intra-position SL uses a stable anchor even as
    // market ATR drifts. Use atr[i-1] to match legacy `entryAtr`.
    const atr = state.atr;
    const a = ctx.i >= 1 ? atr[ctx.i - 1] : NaN;
    const pkey = `atrHardStop.entryAtr`;
    position.state[pkey] = isFinite(a) ? a : NaN;
    // Per-instance scratch: close-based SL 2-step flag.
    position.state[`atrHardStop.triggered`] = false;
  },

  onBar(bundle, i, state, params, position, runtimeCtx) {
    if (!position) return null;
    const isLong = position.dir > 0;
    const ep = position.entryPrice;
    const entryAtr = position.state['atrHardStop.entryAtr'];
    if (!isFinite(entryAtr) || !(entryAtr > 0)) return null;

    const h = state.high[i], l = state.low[i], c = state.close[i];

    // --- (B) Emergency SL (intra-bar, fires on ANY bar including entry) ---
    const eslPrice = isLong
      ? ep * (1 - params.emergencySlPct / 100)
      : ep * (1 + params.emergencySlPct / 100);
    if (isLong ? l <= eslPrice : h >= eslPrice) {
      // Block applies its own slippage — runtime won't re-add it for closeMarket.
      const slip = runtimeCtx?.slippage ?? SLIPPAGE;
      const fill = isLong ? eslPrice - slip : eslPrice + slip;
      return { action: 'closeMarket', fillPrice: fill, signal: 'ESL' };
    }

    // --- (A) Close-based SL with 2-bar deferral ---
    // Step 2: if triggered last bar, emit deferred close NOW.
    if (position.state['atrHardStop.triggered']) {
      position.state['atrHardStop.triggered'] = false;
      return { action: 'closeNextBarOpen', signal: 'SL' };
    }

    // Step 1: check cross. Legacy engine/strategy.js evaluates this on the
    // entry bar too — the close-based SL is a price check, not a fill; it
    // just arms a flag that deferred-closes on the bar AFTER next. No
    // barsHeld guard here.

    // TP1-hit detection with 1-bar delay (matches Pine's position_size on
    // next-bar detection). Slot evaluation order-independent: we read the
    // bar stamped by the target block, not a flag.
    const tp1HitBar = position.state['tp1HitBar'];
    const tp1Hit = Number.isInteger(tp1HitBar) && i > tp1HitBar;

    let slPrice;
    if (isLong) {
      slPrice = tp1Hit ? ep * BE_PLUS_LONG  : ep - entryAtr * params.atrSL;
    } else {
      slPrice = tp1Hit ? ep * BE_PLUS_SHORT : ep + entryAtr * params.atrSL;
    }

    if (isLong ? c <= slPrice : c >= slPrice) {
      position.state['atrHardStop.triggered'] = true;
      // No action this bar — triggered flag will cause closeNextBarOpen next bar.
    }
    return null;
  },

  // No pineTemplate — hardStop blocks are backtest-only. The alerting
  // indicator fires on entries; Pine users add their own stop-loss handling
  // inside TradingView's strategy tester. (See docs/spec-guide.md §7.)
};
