/**
 * fixedFractional — Ralph Vince sizing anchored to the worst historical loss.
 *
 *   size = (equity * f) / max(biggestLoss, minWorstLoss)
 *
 * Sensible intuition: "no single future loss should hurt me more than the
 * worst loss has hurt me historically, scaled by f". `minWorstLoss` is a
 * floor so early trades (before any loss has occurred) don't blow up from
 * a tiny denominator.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'fixedFractional', version: 1, kind: KINDS.SIZING,
  description: 'Ralph Vince sizing anchored to the worst historical loss: size = (equity × f) / max(biggestLoss, minWorstLoss). Intuition: "no single future loss should hurt me more than the worst historical loss has, scaled by f".',

  declaredParams() {
    return [
      { id: 'f',             type: 'float', min: 0.01, max: 0.5,    step: 0.01 },
      { id: 'minWorstLoss',  type: 'float', min: 100,  max: 10_000, step: 100 }, // USD floor
    ];
  },

  indicatorDeps() { return []; },

  sizingRequirements() { return ['tradeStats']; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    const denom = Math.max(ctx.stats.biggestLoss, params.minWorstLoss);
    const notional = (ctx.equity * params.f * ctx.fillPrice) / denom;
    // Guard against degenerate denominators — return 0 rather than explode.
    if (!Number.isFinite(notional) || notional <= 0) return 0;
    return notional / ctx.fillPrice;
  },
};
