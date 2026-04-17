/**
 * pctOfInitial — deploy a fixed percentage of STARTING capital per trade.
 *
 * Non-compounding counterpart to pctOfEquity. Bet size stays constant
 * regardless of current equity — wins don't grow the bet; losses don't
 * shrink it. Each trade sees the same dollar exposure.
 *
 * Use when you want strategy comparisons that aren't distorted by
 * compounding dynamics (a high-DD strategy can look great because its
 * early wins let it size up; this sizing neutralizes that). Also useful
 * for live trading with a fixed strategy allocation that shouldn't
 * respond to short-term P/L.
 *
 * Relationship to pctOfEquity:
 *   - pctOfEquity  → notional = currentEquity   × pct/100
 *   - pctOfInitial → notional = initialCapital  × pct/100
 *
 * At strategy start, when currentEquity == initialCapital, they match.
 * They diverge once the equity curve moves.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'pctOfInitial', version: 1, kind: KINDS.SIZING,
  description: 'Deploy a fixed percentage of STARTING capital on every entry (non-compounding). Bet size stays constant regardless of current equity. Good for strategy comparisons where compounding distortion matters, or for fixed-allocation live trading.',

  declaredParams() {
    return [
      { id: 'pct', type: 'float', min: 1, max: 100, step: 1 },
    ];
  },

  indicatorDeps() { return []; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.initialCapital > 0)) return 0;
    const notional = ctx.initialCapital * (params.pct / 100);
    return notional / ctx.fillPrice;
  },
};
