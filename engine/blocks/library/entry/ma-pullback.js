/**
 * maPullback — pullback to the trend MA in an established trend.
 *
 * Identify a trend: fast EMA > slow EMA (uptrend) or fast EMA < slow EMA
 * (downtrend). Then wait for price to pull BACK to the fast EMA (a dip in
 * an uptrend, a rally in a downtrend) and rebound off it.
 *
 * Long:   (emaFast > emaSlow)  AND  low[i] <= emaFast[i]  AND  close[i] > emaFast[i]
 *         i.e. price touched/dipped under fast EMA this bar but closed above it
 * Short:  (emaFast < emaSlow)  AND  high[i] >= emaFast[i]  AND  close[i] < emaFast[i]
 *         i.e. price touched/poked above fast EMA this bar but closed below it
 *
 * This is a classic trend-continuation entry. Requires a trend regime to
 * work; pairs naturally with `htfTrendRegime` or `htfTrendFilter`.
 *
 * Constraint: emaFast < emaSlow (range-order). Same pattern emaTrend uses.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'maPullback', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'Pullback to the fast EMA during an established trend. Long when emaFast>emaSlow and price dips to emaFast but closes above it; short when the opposite. Classic trend-continuation primitive — pair with a trend regime.',

  declaredParams() {
    return [
      { id: 'emaFast', type: 'int', min: 5,  max: 60,  step: 1 },
      { id: 'emaSlow', type: 'int', min: 20, max: 200, step: 1 },
    ];
  },

  constraints(_params) {
    return [{ lhs: 'emaFast', op: '<', rhs: 'emaSlow', repair: 'clamp-lhs' }];
  },

  indicatorDeps(params) {
    return [
      { key: `base:ema:close:${params.emaFast}`, tf: 'base', indicator: 'ema',
        source: 'close', args: { period: params.emaFast } },
      { key: `base:ema:close:${params.emaSlow}`, tf: 'base', indicator: 'ema',
        source: 'close', args: { period: params.emaSlow } },
    ];
  },

  prepare(bundle, params, indicators, state) {
    state.emaF   = indicators.get(`base:ema:close:${params.emaFast}`);
    state.emaS   = indicators.get(`base:ema:close:${params.emaSlow}`);
    state.high   = bundle.base.high;
    state.low    = bundle.base.low;
    state.close  = bundle.base.close;
  },

  onBar(_bundle, i, state, _params) {
    const f = state.emaF[i], s = state.emaS[i];
    if (isNaN(f) || isNaN(s)) return { long: 0, short: 0 };
    const uptrend   = f > s;
    const downtrend = f < s;
    const l = state.low[i], h = state.high[i], c = state.close[i];
    const longSig  = (uptrend   && l <= f && c > f) ? 1 : 0;
    const shortSig = (downtrend && h >= f && c < f) ? 1 : 0;
    return { long: longSig, short: shortSig };
  },

  pineTemplate(_params, paramRefs) {
    const { emaFast, emaSlow } = paramRefs;
    const suffix = `${emaFast}_${emaSlow}`;
    const code = `
// ─── maPullback ───────────────────────────────────
ma_pb_fast_${emaFast} = ta.ema(close, ${emaFast})
ma_pb_slow_${emaSlow} = ta.ema(close, ${emaSlow})
ma_pb_up_${suffix}   = ma_pb_fast_${emaFast} > ma_pb_slow_${emaSlow}
ma_pb_down_${suffix} = ma_pb_fast_${emaFast} < ma_pb_slow_${emaSlow}
ma_pb_long_${suffix}  = ma_pb_up_${suffix}   and low  <= ma_pb_fast_${emaFast} and close > ma_pb_fast_${emaFast}
ma_pb_short_${suffix} = ma_pb_down_${suffix} and high >= ma_pb_fast_${emaFast} and close < ma_pb_fast_${emaFast}
`.trim();
    return {
      code,
      long:  `ma_pb_long_${suffix}`,
      short: `ma_pb_short_${suffix}`,
    };
  },
};
