/**
 * volatilityFloor — reject entries in dead-market bars.
 *
 * ATR-based: only allow entries when `atr[i] / close[i] * 100 >= minAtrPct`.
 * i.e. the bar's average true range must be at least `minAtrPct` percent
 * of price. Dead-flat periods produce tiny ATRs and unreliable
 * breakouts.
 *
 * Symmetric: passes / rejects both long and short the same way.
 *
 * Rule-of-thumb: 0.3–0.8 for BTC 4H; lower for traditional FX pairs,
 * higher for meme coins / small caps. The GA is free to tune this;
 * we just expose a wide range.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'volatilityFloor', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  description: 'Reject entries when ATR is too small relative to price. Passes when atr[i]/close[i]*100 ≥ minAtrPct. Symmetric: both long and short pass or both fail. Dead-market bars produce unreliable breakouts; this block prunes them.',

  declaredParams() {
    return [
      { id: 'atrLen',     type: 'int',   min: 5,    max: 40,  step: 1 },
      { id: 'minAtrPct',  type: 'float', min: 0.05, max: 3.0, step: 0.05 },
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

  prepare(bundle, params, indicators, state) {
    state.atr       = indicators.get(`base:atr:${params.atrLen}`);
    state.close     = bundle.base.close;
    state.minAtrPct = params.minAtrPct;
  },

  onBar(_bundle, i, state, _params) {
    const a = state.atr[i], c = state.close[i];
    if (isNaN(a) || !(c > 0)) return { long: false, short: false };
    const pass = (a / c * 100) >= state.minAtrPct;
    return { long: pass, short: pass };
  },

  pineTemplate(_params, paramRefs) {
    const { atrLen, minAtrPct } = paramRefs;
    const code = `
// ─── volatilityFloor ──────────────────────────────
vfloor_atr_${atrLen} = ta.atr(${atrLen})
vfloor_pass_${atrLen} = close > 0 and (vfloor_atr_${atrLen} / close * 100) >= ${minAtrPct}
vfloor_long_${atrLen}  = vfloor_pass_${atrLen}
vfloor_short_${atrLen} = vfloor_pass_${atrLen}
`.trim();
    return {
      code,
      long:  `vfloor_long_${atrLen}`,
      short: `vfloor_short_${atrLen}`,
    };
  },
};
