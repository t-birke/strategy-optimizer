/**
 * rsiPullback — oversold / overbought pullback entry.
 *
 * Long:  RSI[i] crosses UP through `longLevel` (default 30) — coming out
 *        of oversold, implying a dip-buy opportunity.
 * Short: RSI[i] crosses DOWN through `shortLevel` (default 70) — rolling
 *        off overbought, implying a rip-sell opportunity.
 *
 * Different from stochCross: here the signal IS the cross of the RSI line
 * itself through a fixed level, not a cross of two smoothed lines. This
 * fires more cleanly at extremes and is the classic "mean reversion"
 * primitive. Best used in a ranging regime (compose with `rangeRegime`).
 *
 * Design note — we detect the crossing explicitly via rsi[i-1] vs rsi[i]
 * rather than constructing a second series for level. That keeps the
 * indicator-cache footprint minimal (one RSI series per `rsiLen`).
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'rsiPullback', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'RSI crossing back out of oversold/overbought zones. Long on RSI crossing UP through longLevel (default 30); short on RSI crossing DOWN through shortLevel (default 70). Classic mean-reversion entry — pairs well with rangeRegime.',

  declaredParams() {
    return [
      { id: 'rsiLen',      type: 'int',   min: 5,  max: 40, step: 1 },
      { id: 'longLevel',   type: 'float', min: 10, max: 45, step: 1 },
      { id: 'shortLevel',  type: 'float', min: 55, max: 90, step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [{
      key:       `base:rsi:close:${params.rsiLen}`,
      tf:        'base',
      indicator: 'rsi',
      source:    'close',
      args:      { period: params.rsiLen },
    }];
  },

  prepare(_bundle, params, indicators, state) {
    state.rsi        = indicators.get(`base:rsi:close:${params.rsiLen}`);
    state.longLevel  = params.longLevel;
    state.shortLevel = params.shortLevel;
  },

  onBar(_bundle, i, state, _params) {
    if (i < 1) return { long: 0, short: 0 };
    const r = state.rsi[i], prev = state.rsi[i - 1];
    if (isNaN(r) || isNaN(prev)) return { long: 0, short: 0 };
    const longSig  = (prev <= state.longLevel  && r > state.longLevel)  ? 1 : 0;
    const shortSig = (prev >= state.shortLevel && r < state.shortLevel) ? 1 : 0;
    return { long: longSig, short: shortSig };
  },

  pineTemplate(_params, paramRefs) {
    const { rsiLen, longLevel, shortLevel } = paramRefs;
    const code = `
// ─── rsiPullback ──────────────────────────────────
rsi_pb_${rsiLen} = ta.rsi(close, ${rsiLen})
rsi_pb_long_${rsiLen}  = ta.crossover(rsi_pb_${rsiLen},  ${longLevel})
rsi_pb_short_${rsiLen} = ta.crossunder(rsi_pb_${rsiLen}, ${shortLevel})
`.trim();
    return {
      code,
      long:  `rsi_pb_long_${rsiLen}`,
      short: `rsi_pb_short_${rsiLen}`,
    };
  },
};
