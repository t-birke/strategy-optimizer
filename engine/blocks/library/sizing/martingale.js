/**
 * martingale — escalate size after losing streaks, reset on a win.
 *
 *   mult = min(stepMult ^ currentLossStreak, maxMult)
 *   size = (equity * basePct/100 * mult) / fillPrice
 *
 * Historically fatal if uncapped. The `maxMult` cap is MANDATORY — without
 * it one bad streak blows the account. The optimizer will find the maxMult
 * that balances expected recovery vs. ruin probability.
 *
 * Use with caution. The only reason this is even in the library is that
 * some traders use it successfully on strategies with a known mean-
 * reverting win/loss distribution (e.g., fade-the-fade scalps).
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'martingale', version: 1, kind: KINDS.SIZING,

  declaredParams() {
    return [
      { id: 'basePct',  type: 'float', min: 0.1, max: 10,  step: 0.1 },
      { id: 'stepMult', type: 'float', min: 1.1, max: 3.0, step: 0.1 },
      { id: 'maxMult',  type: 'float', min: 2,   max: 16,  step: 1 },
    ];
  },

  indicatorDeps() { return []; },

  sizingRequirements() { return ['tradeStats']; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    const streak = ctx.stats.currentStreak;
    const lossLen = streak.kind === 'L' ? streak.length : 0;
    const rawMult = Math.pow(params.stepMult, lossLen);
    const mult    = Math.min(rawMult, params.maxMult);
    const notional = ctx.equity * (params.basePct / 100) * mult;
    return notional / ctx.fillPrice;
  },
};
