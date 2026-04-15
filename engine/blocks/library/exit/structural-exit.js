/**
 * structuralExit — the legacy "graceful" exit: time-out, stoch/RSI
 * structural break, OR opposite-side entry signal (reversal).
 *
 * All three deferred via `closeNextBarOpen` — they represent "the thesis
 * is broken, get out at the next open" rather than a hard risk stop. The
 * runtime applies market slippage at the deferred fill, same as Pine's
 * `strategy.close()`.
 *
 * Signals (long position shown; shorts are mirrored):
 *
 *   (a) Time:       barsHeld >= maxBars - 1
 *   (b) StochExit:  stoch %K crossed DOWN through %D while %K > 60
 *   (c) RsiExit:    rsi[i] < 40 AND rsi[i-3] > 55 (fresh weakness after strength)
 *   (d) Reversal:   opposite-side entry signal fired THIS bar (via runtimeCtx)
 *
 * On (d), the runtime's reversal-eligible check automatically queues the
 * opposite-direction pending entry. We just need to emit a close with the
 * right signal tag so the post-hoc trade log can distinguish reversals.
 *
 * For migration-gate parity, the stoch length/smoothing params MUST match
 * the entry block (stochCross) — the spec pins both to the same literals.
 * A future refactor will express this via a cross-block constraint or a
 * shared-indicator alias; noted in docs/backlog.md.
 */

import { KINDS, DIRECTIONS, EXIT_SLOTS } from '../../contract.js';
import { sma, crossover, crossunder } from '../../../indicators.js';

// Legacy hardcoded thresholds — kept as named constants here so the
// block's behavior stays explicitly tied to the legacy implementation.
// Expose as params in a v2 if/when we want to tune them.
const STOCH_EXIT_OVERBOUGHT = 60;  // long exits when %K > this on cross-down
const STOCH_EXIT_OVERSOLD   = 40;  // short exits when %K < this on cross-up
const RSI_LONG_EXIT_LEVEL   = 40;  // rsi[i] < this for long exit
const RSI_LONG_PRIOR_LEVEL  = 55;  // rsi[i-3] > this (was-strong-now-weak)
const RSI_SHORT_EXIT_LEVEL  = 60;  // rsi[i] > this for short exit
const RSI_SHORT_PRIOR_LEVEL = 45;  // rsi[i-3] < this
const RSI_LOOKBACK          = 3;   // bars to look back for prior level

export default {
  id: 'structuralExit', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.TRAIL,
  direction: DIRECTIONS.BOTH,
  description: 'Legacy "graceful" exit: time-out, stoch/RSI structural break, or opposite-side entry signal (reversal). All signals defer to the next-bar open — "the thesis is broken, get out gracefully" rather than a hard risk stop.',

  declaredParams() {
    return [
      { id: 'stochLen',  type: 'int', min: 5,  max: 40,  step: 1 },
      { id: 'stochSmth', type: 'int', min: 1,  max: 8,   step: 1 },
      { id: 'rsiLen',    type: 'int', min: 5,  max: 40,  step: 1 },
      { id: 'maxBars',   type: 'int', min: 5,  max: 200, step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [
      { key: `base:stoch:${params.stochLen}`, tf: 'base', indicator: 'stoch',
        args: { period: params.stochLen } },
      { key: `base:rsi:close:${params.rsiLen}`, tf: 'base', indicator: 'rsi',
        source: 'close', args: { period: params.rsiLen } },
    ];
  },

  prepare(_bundle, params, indicators, state) {
    const raw = indicators.get(`base:stoch:${params.stochLen}`);
    const K = sma(raw, params.stochSmth);
    const D = sma(K,   params.stochSmth);
    state.K = K;
    state.crossUp   = crossover(K, D);
    state.crossDown = crossunder(K, D);
    state.rsi     = indicators.get(`base:rsi:close:${params.rsiLen}`);
    state.maxBars = params.maxBars;
  },

  onBar(_bundle, i, state, _params, position, runtimeCtx) {
    if (!position) return null;
    const isLong = position.dir > 0;
    const barsHeld = i - position.entryBar;

    // --- (a) Time exit ---
    if (barsHeld >= state.maxBars - 1) {
      return { action: 'closeNextBarOpen', signal: 'Time' };
    }

    // NOTE: structural & reversal are evaluated on the ENTRY bar too —
    // matches legacy engine/strategy.js which runs exit checks immediately
    // after pendingEntry resolves on the same bar. A same-bar structural
    // exit still defers the fill to next bar's open, so there's no
    // zero-hold-time trade concern.
    const k = state.K[i];
    const rsiNow  = state.rsi[i];
    const rsiBack = i >= RSI_LOOKBACK ? state.rsi[i - RSI_LOOKBACK] : NaN;

    // --- (b) + (c) Structural signals ---
    let structural = false;
    if (isLong) {
      const stochExit = state.crossDown[i] && k > STOCH_EXIT_OVERBOUGHT;
      const rsiExit   = rsiNow < RSI_LONG_EXIT_LEVEL && rsiBack > RSI_LONG_PRIOR_LEVEL;
      structural = stochExit || rsiExit;
    } else {
      const stochExit = state.crossUp[i] && k < STOCH_EXIT_OVERSOLD;
      const rsiExit   = rsiNow > RSI_SHORT_EXIT_LEVEL && rsiBack < RSI_SHORT_PRIOR_LEVEL;
      structural = stochExit || rsiExit;
    }

    // --- (d) Reversal: opposite-side entry signal this bar ---
    const entrySignals = runtimeCtx?.entrySignals ?? { long: false, short: false };
    const filterSignals = runtimeCtx?.filterSignals ?? { long: true, short: true };
    const oppSignal = isLong
      ? (entrySignals.short && filterSignals.short)
      : (entrySignals.long  && filterSignals.long);

    if (oppSignal) {
      // Signal tag lets the trade log separate reversal exits from
      // garden-variety structural exits. Runtime's reversalEligible
      // path will queue the opposite-direction pendingEntry.
      return { action: 'closeNextBarOpen', signal: 'Reversal' };
    }
    if (structural) {
      return { action: 'closeNextBarOpen', signal: 'Structural' };
    }
    return null;
  },

  // No pineTemplate — trail is backtest-only.
};
