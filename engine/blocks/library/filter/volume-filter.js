/**
 * volumeFilter — reject entries on low-participation bars.
 *
 * Passes when `volume[i] >= volMa * minMultiplier` where volMa is the
 * SMA of volume over `volLen` bars. Symmetric: both sides pass or
 * neither does.
 *
 * Different from `volumeSurge` (entry block): that one FIRES on a
 * surge. This one GATES out low-volume bars — typical use is to
 * require ≥ 0.8–1.2× average volume, not 2×+ surges. Low-volume bars
 * often produce unreliable breakouts that reverse once real flow
 * shows up on the next session's open.
 *
 * A minMultiplier < 1.0 is a "not too dead" floor; > 1.0 biases toward
 * active bars. Both are useful depending on strategy style.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'volumeFilter', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  description: 'Gate entries by minimum volume multiple of the rolling volume SMA. Passes when volume[i] ≥ minMultiplier × SMA(volume, volLen). Symmetric (both sides same verdict). Use minMultiplier ~0.8–1.2 as a floor; >1.2 biases toward active bars.',

  declaredParams() {
    return [
      { id: 'volLen',         type: 'int',   min: 5,   max: 100, step: 1 },
      { id: 'minMultiplier',  type: 'float', min: 0.3, max: 3.0, step: 0.1 },
    ];
  },

  indicatorDeps(params) {
    return [{
      key:       `base:sma:volume:${params.volLen}`,
      tf:        'base',
      indicator: 'sma',
      source:    'volume',
      args:      { period: params.volLen },
    }];
  },

  prepare(bundle, params, indicators, state) {
    state.volMa  = indicators.get(`base:sma:volume:${params.volLen}`);
    state.volume = bundle.base.volume;
    state.mult   = params.minMultiplier;
  },

  onBar(_bundle, i, state, _params) {
    const ma = state.volMa[i];
    if (isNaN(ma) || ma <= 0) return { long: false, short: false };
    const pass = state.volume[i] >= ma * state.mult;
    return { long: pass, short: pass };
  },

  pineTemplate(_params, paramRefs) {
    const { volLen, minMultiplier } = paramRefs;
    const code = `
// ─── volumeFilter ─────────────────────────────────
vfilt_ma_${volLen} = ta.sma(volume, ${volLen})
vfilt_pass_${volLen} = vfilt_ma_${volLen} > 0 and volume >= vfilt_ma_${volLen} * ${minMultiplier}
vfilt_long_${volLen}  = vfilt_pass_${volLen}
vfilt_short_${volLen} = vfilt_pass_${volLen}
`.trim();
    return {
      code,
      long:  `vfilt_long_${volLen}`,
      short: `vfilt_short_${volLen}`,
    };
  },
};
