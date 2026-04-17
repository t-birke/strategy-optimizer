/**
 * volTargetSizing — size inversely proportional to realized bar volatility.
 *
 *   targetVolUsd = equity × targetVolPct / 100          (dollars/bar we accept)
 *   units        = targetVolUsd / atr[signalBar]        (scale to expected $-move)
 *
 * Classical volatility targeting. Low-vol instruments / periods get
 * bigger positions; high-vol get smaller. The idea is to make every
 * trade's dollar risk-per-bar roughly comparable regardless of whether
 * the market is sleepy or manic — stabilizes the equity-curve variance.
 *
 * Caveat: this is a per-bar proxy, not a strict portfolio-vol target.
 * True portfolio vol requires correlation-aware multi-instrument math;
 * for a single-instrument strategy ATR-scaled sizing is the standard
 * approximation and matches classic CTA practice (AQR, Man AHL, etc.).
 *
 * The `hardCapPct` parameter is a safety floor: if the ATR collapses to
 * near zero (e.g. exchange outage, halted asset), sizing would blow up
 * to infinity. Capping at N% of equity notional prevents that.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'volTargetSizing', version: 1, kind: KINDS.SIZING,
  description: 'Size inversely proportional to ATR so each bar\'s expected $-move is ~ targetVolPct of equity. Classic volatility-targeting CTA sizing. `hardCapPct` prevents runaway sizing when ATR collapses.',

  declaredParams() {
    return [
      { id: 'targetVolPct', type: 'float', min: 0.2, max: 5.0,  step: 0.1 },
      { id: 'atrLen',       type: 'int',   min: 5,   max: 50,   step: 1 },
      { id: 'hardCapPct',   type: 'float', min: 10,  max: 100,  step: 5 },
    ];
  },

  indicatorDeps(params) {
    return [{
      key:       `base:atr:${params.atrLen}`,
      tf:        'base',
      indicator: 'atr',
      args:      { period: params.atrLen },
    }];
  },

  prepare(_bundle, params, indicators, state) {
    state.atr = indicators.get(`base:atr:${params.atrLen}`);
  },

  computeSize(ctx, state, params) {
    if (!(ctx.fillPrice > 0) || !(ctx.equity > 0)) return 0;
    // Use atr[signalBar] = atr[i-1] at the fill bar — same convention
    // atr-hard-stop.js uses for entryAtr. Matches the "ATR at the
    // decision point, not the fill bar" semantic.
    const a = ctx.i >= 1 ? state.atr[ctx.i - 1] : NaN;
    if (!(a > 0) || isNaN(a)) return 0;

    const targetVolUsd = ctx.equity * (params.targetVolPct / 100);
    const rawUnits     = targetVolUsd / a;

    // Hard cap: rawUnits × fillPrice ≤ equity × hardCapPct/100.
    const maxUnits = (ctx.equity * (params.hardCapPct / 100)) / ctx.fillPrice;
    return Math.min(rawUnits, maxUnits);
  },
};
