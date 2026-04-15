/**
 * flat — fixed dollar amount per trade.
 *
 * `amountUsd` of the account is deployed on every entry, regardless of
 * current equity. Position size = amountUsd / fillPrice (capped by
 * leverage × equity / fillPrice so a small account doesn't over-leverage).
 *
 * Use for: apples-to-apples strategy comparisons where you don't want
 * compounding to flatter the results.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'flat', version: 1, kind: KINDS.SIZING,
  description: 'Fixed dollar amount per trade regardless of current equity: size = amountUsd / fillPrice. Use for apples-to-apples strategy comparisons where you don\'t want compounding to flatter the results.',

  declaredParams() {
    return [
      { id: 'amountUsd', type: 'float', min: 100, max: 1_000_000, step: 100 },
    ];
  },

  indicatorDeps() { return []; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0)) return 0;
    return params.amountUsd / ctx.fillPrice;
  },
};
