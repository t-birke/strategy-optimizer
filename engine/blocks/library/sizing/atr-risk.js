/**
 * atrRisk — Van Tharp risk-per-trade sizing.
 *
 *   size = (equity * riskPct/100) / stopDistance
 *
 * The hardStop block tells us (via its planStop() hook) how far the SL
 * is from the entry fill; we scale size so that a full SL costs exactly
 * riskPct of equity. Universal best-practice sizing for any strategy
 * with a defined stop.
 *
 * If `useInitialCapital` is true we measure risk against STARTING capital
 * instead of rolling equity — useful for "flat" comparisons.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'atrRisk', version: 1, kind: KINDS.SIZING,
  description: 'Van Tharp risk-per-trade sizing: size = (equity × riskPct) / stopDistance. Scales position so a full SL costs exactly riskPct of equity. Requires a hardStop block that implements planStop() — otherwise the entry is declined.',

  declaredParams() {
    return [
      { id: 'riskPct',           type: 'float', min: 0.1, max: 10,  step: 0.1 },
      { id: 'useInitialCapital', type: 'int',   min: 0,   max: 1,   step: 1 }, // 0|1 pseudo-bool
    ];
  },

  indicatorDeps() { return []; },

  sizingRequirements() { return ['stopDistance']; },

  computeSize(ctx, _state, params) {
    // If the hardStop didn't (or couldn't) plan a stop, decline the entry.
    // No secret fallback — the spec author picked this sizing block; a
    // silent default would hide a misconfiguration.
    if (!(ctx.stopDistance > 0)) return 0;
    const base = params.useInitialCapital ? ctx.initialCapital : ctx.equity;
    if (!(base > 0)) return 0;
    const riskUsd = base * (params.riskPct / 100);
    return riskUsd / ctx.stopDistance;
  },
};
