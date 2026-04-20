/**
 * adxFilter — bidirectional ADX range-pass filter.
 *
 * ADX measures trend STRENGTH regardless of direction (0–100). This block
 * passes only when ADX sits in the range `[minAdx, maxAdx]`, making it a
 * generic "only trade in strength-X conditions" gate.
 *
 * Typical uses:
 *   - Trend-follower: `minAdx = 25, maxAdx = 100` — only take entries
 *     when the market IS trending (strongly).
 *   - Counter-intuitive breakout: `minAdx = 0, maxAdx = 25` — only take
 *     breakout entries FROM quiet markets, catching the start of new
 *     trends rather than chasing mature ones (per Quantified Strategies'
 *     BTC Donchian research).
 *   - Mean-reversion: `minAdx = 0, maxAdx = 20` — only take RSI/BB
 *     reversion entries in confirmed ranging conditions.
 *
 * Symmetric: both long and short pass or both fail. Direction is determined
 * by the entry block; this filter only decides whether any entry is allowed
 * in the current ADX regime.
 *
 * Complements rangeRegime + regimeGate: rangeRegime emits a discrete label
 * ('trending' / 'ranging'), which is useful when the spec has multiple
 * regime-dependent branches. adxFilter is simpler — direct numeric range
 * pass — and lets the GA tune the cutoff continuously.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'adxFilter', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  description: 'Pass entries only when ADX sits in [minAdx, maxAdx]. Symmetric (both sides pass or both fail). Use minAdx=25/maxAdx=100 for trend-followers; minAdx=0/maxAdx=25 for counter-intuitive breakouts from quiet markets; minAdx=0/maxAdx=20 for mean-reversion in range.',

  declaredParams() {
    return [
      { id: 'adxLen', type: 'int',   min: 7,  max: 40,  step: 1 },
      { id: 'minAdx', type: 'float', min: 0,  max: 50,  step: 1 },
      { id: 'maxAdx', type: 'float', min: 10, max: 100, step: 1 },
    ];
  },

  constraints(_params) {
    // Range must be non-empty. Clamp minAdx down if it ever exceeds maxAdx
    // (rather than the usual clamp-rhs) because maxAdx is the more
    // semantically-meaningful cap in most use cases.
    return [
      { lhs: 'minAdx', op: '<=', rhs: 'maxAdx', repair: 'clamp-lhs' },
    ];
  },

  indicatorDeps(params) {
    return [{
      key:       `base:adx:${params.adxLen}`,
      tf:        'base',
      indicator: 'adx',
      args:      { period: params.adxLen },
    }];
  },

  prepare(_bundle, params, indicators, state) {
    state.adx    = indicators.get(`base:adx:${params.adxLen}`);
    state.minAdx = params.minAdx;
    state.maxAdx = params.maxAdx;
  },

  onBar(_bundle, i, state, _params) {
    const a = state.adx[i];
    if (!Number.isFinite(a)) return { long: false, short: false };
    const pass = a >= state.minAdx && a <= state.maxAdx;
    return { long: pass, short: pass };
  },

  pineTemplate(_params, paramRefs) {
    const { adxLen, minAdx, maxAdx } = paramRefs;
    // Pine's ta.adx(dilen, adxlen) takes two separate length params —
    // use the same value for both to match our single-period JS ADX.
    const code = `
// ─── adxFilter ────────────────────────────────────
adxf_${adxLen} = ta.adx(${adxLen}, ${adxLen})
adxf_pass_${adxLen} = adxf_${adxLen} >= ${minAdx} and adxf_${adxLen} <= ${maxAdx}
adxf_long_${adxLen}  = adxf_pass_${adxLen}
adxf_short_${adxLen} = adxf_pass_${adxLen}
`.trim();
    return {
      code,
      long:  `adxf_long_${adxLen}`,
      short: `adxf_short_${adxLen}`,
    };
  },
};
