/**
 * equityCurveTrading — meta-sizing: bigger when the equity curve is
 * in an "on" regime (above its moving average), smaller (or zero) when "off".
 *
 *   equity snapshot taken at every closed trade (not every bar)
 *   ma = mean of the last `maLen` equity points
 *   regime = equity[last] > ma ? 'on' : 'off'
 *   size = (equity * (regime == 'on' ? onPct : offPct) / 100) / fillPrice
 *
 * Set `offPct` = 0 to literally skip trades during equity drawdowns.
 * Works best with N-of-many-trades strategies — too few samples and the MA
 * is noise. During warmup we use `basePct`.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'equityCurveTrading', version: 1, kind: KINDS.SIZING,
  description: 'Meta-sizing: bigger when the equity curve is above its moving average ("on" regime), smaller — or zero — when below ("off"). Set offPct=0 to literally skip trades during strategy drawdowns.',

  declaredParams() {
    return [
      { id: 'basePct',   type: 'float', min: 1,  max: 100, step: 1 },
      { id: 'onPct',     type: 'float', min: 1,  max: 100, step: 1 },
      { id: 'offPct',    type: 'float', min: 0,  max: 100, step: 1 }, // 0 = skip in drawdown
      { id: 'maLen',     type: 'int',   min: 5,  max: 50,  step: 1 },
      { id: 'minTrades', type: 'int',   min: 5,  max: 50,  step: 1 },
    ];
  },

  indicatorDeps() { return []; },

  sizingRequirements() { return ['tradeStats', 'equityCurve']; },

  computeSize(ctx, _state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    const curve = ctx.equityCurve; // array of { ts, equity }
    const have = curve?.length ?? 0;

    // Warmup — not enough curve history to make a regime call.
    if (ctx.stats.tradeCount < params.minTrades || have < params.maLen) {
      return ctx.equity * (params.basePct / 100) / ctx.fillPrice;
    }

    let sum = 0;
    for (let k = have - params.maLen; k < have; k++) sum += curve[k].equity;
    const ma = sum / params.maLen;

    const on = curve[have - 1].equity > ma;
    const pct = on ? params.onPct : params.offPct;
    if (pct <= 0) return 0;
    return ctx.equity * (pct / 100) / ctx.fillPrice;
  },
};
