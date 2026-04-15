/**
 * kelly — Kelly-fraction sizing driven by the running win/loss distribution.
 *
 *   b = avgWin / avgLoss                   (odds)
 *   f = (b * winRate − (1 − winRate)) / b  (Kelly fraction)
 *   size = (equity * min(max(f * fraction, 0), maxFraction)) / fillPrice
 *
 * Full Kelly is notoriously aggressive; `fraction` (typ. 0.25 – 0.5) gives
 * you half-Kelly or quarter-Kelly. `maxFraction` is a hard cap.
 *
 * During warmup (tradeCount < minTrades) we don't have a meaningful edge
 * estimate, so we fall back to a fixed `warmupPct` of equity per trade.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'kelly', version: 1, kind: KINDS.SIZING,

  declaredParams() {
    return [
      { id: 'fraction',    type: 'float', min: 0.1, max: 1.0, step: 0.05 },
      { id: 'maxFraction', type: 'float', min: 0.05, max: 0.5, step: 0.05 },
      { id: 'minTrades',   type: 'int',   min: 5,   max: 50,  step: 1 },
      { id: 'warmupPct',   type: 'float', min: 0.5, max: 10,  step: 0.5 },
    ];
  },

  indicatorDeps() { return []; },

  sizingRequirements() { return ['tradeStats']; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    const s = ctx.stats;

    // Warmup: not enough history to estimate edge.
    if (s.tradeCount < params.minTrades || s.avgLoss <= 0) {
      return ctx.equity * (params.warmupPct / 100) / ctx.fillPrice;
    }

    const b = s.avgWin / s.avgLoss;
    const f = (b * s.winRate - (1 - s.winRate)) / b;

    // Negative Kelly → no edge → skip the trade.
    if (f <= 0) return 0;

    const fractional = Math.min(f * params.fraction, params.maxFraction);
    return ctx.equity * fractional / ctx.fillPrice;
  },
};
