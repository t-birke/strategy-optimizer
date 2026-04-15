/**
 * pctOfEquity — deploy a fixed percentage of CURRENT equity per trade.
 *
 * Compounds naturally: wins grow the next bet; losses shrink it.
 * The canonical "fully invested" sizing for long-only swing strategies.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'pctOfEquity', version: 1, kind: KINDS.SIZING,
  description: 'Deploy a fixed percentage of CURRENT equity on every entry. Compounds naturally — wins grow the next bet, losses shrink it. The canonical "fully invested" sizing for long-only swing strategies.',

  declaredParams() {
    return [
      { id: 'pct', type: 'float', min: 1, max: 100, step: 1 },
    ];
  },

  indicatorDeps() { return []; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    const notional = ctx.equity * (params.pct / 100);
    return notional / ctx.fillPrice;
  },
};
