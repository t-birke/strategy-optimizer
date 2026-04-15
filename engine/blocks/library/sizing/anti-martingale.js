/**
 * antiMartingale — escalate size after WINNING streaks, reset on a loss.
 *
 *   mult = min(stepMult ^ currentWinStreak, maxMult)
 *   size = (equity * basePct/100 * mult) / fillPrice
 *
 * Press winners; give back less on eventual losers. Philosophically the
 * opposite of martingale and arguably more defensible — a strategy "in the
 * zone" has a higher short-term hit rate, so pyramiding into that zone is
 * rational.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'antiMartingale', version: 1, kind: KINDS.SIZING,

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
    const winLen = streak.kind === 'W' ? streak.length : 0;
    const rawMult = Math.pow(params.stepMult, winLen);
    const mult    = Math.min(rawMult, params.maxMult);
    const notional = ctx.equity * (params.basePct / 100) * mult;
    return notional / ctx.fillPrice;
  },
};
