/**
 * rangeRegime — classify each bar by trending vs ranging via ADX.
 *
 *   - 'trending' if adx[i] > adxThreshold   (default 25)
 *   - 'ranging'  if adx[i] < adxThreshold
 *   - null       during ADX warmup (2*period − 1 bars)
 *
 * Wilder's ADX measures trend STRENGTH (0–100), not direction.
 * Thresholds 20–25 are conventional "trend starts" markers; 40+ is very
 * strong trend territory. The GA tunes the threshold.
 *
 * Pairs well with:
 *  - regimeGate(allowedLong='trending', allowedShort='trending')
 *    for trend-follower strategies
 *  - regimeGate(allowedLong='ranging',  allowedShort='ranging')
 *    for mean-reversion strategies
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'rangeRegime', version: 1, kind: KINDS.REGIME,
  description: 'Label each bar trending / ranging based on ADX. trending when adx[i] > adxThreshold; ranging otherwise. Wilder\'s ADX measures trend STRENGTH (not direction). Default ADX(14) × threshold 25.',

  declaredParams() {
    return [
      { id: 'adxLen',       type: 'int',   min: 7,  max: 40, step: 1 },
      { id: 'adxThreshold', type: 'float', min: 15, max: 50, step: 1 },
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
    state.adx       = indicators.get(`base:adx:${params.adxLen}`);
    state.threshold = params.adxThreshold;
  },

  onBar(_bundle, i, state, _params) {
    const a = state.adx[i];
    if (isNaN(a)) return null;
    return a > state.threshold ? 'trending' : 'ranging';
  },

  pineTemplate(_params, paramRefs) {
    const { adxLen, adxThreshold } = paramRefs;
    // Pine's ta.adx(dilen, adxlen) takes two separate length params.
    // We use the same length for both to match our single-period JS
    // implementation.
    const code = `
// ─── rangeRegime ──────────────────────────────────
rreg_adx_${adxLen} = ta.adx(${adxLen}, ${adxLen})
rreg_label_${adxLen} = rreg_adx_${adxLen} > ${adxThreshold} ? "trending" : "ranging"
`.trim();
    return {
      code,
      regime: `rreg_label_${adxLen}`,
    };
  },
};
