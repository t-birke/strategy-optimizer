/**
 * stochCross — smoothed Stochastic %K / %D cross, gated by oversold/overbought.
 *
 * Long:  %K crosses UP through %D while %K < longLevel  (default 40 — oversold zone)
 * Short: %K crosses DOWN through %D while %K > shortLevel (default 60 — overbought zone)
 *
 * This is the bread-and-butter entry of the legacy JM Simple 3TP strategy.
 * The "smoothed" part is Pine's default `stoch(14).sma(3).sma(3)` pattern —
 * two SMAs of length `stochSmth` applied to raw stoch %K to calm the line.
 *
 * We pre-compute K, D, and the cross arrays in prepare() so onBar is O(1).
 * Raw stoch is fetched from the indicator cache (dedup-safe across blocks).
 * The SMA smoothing can't hit the cache (its input is a computed array, not
 * a price source), so each instance does it locally — still cheap.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';
import { sma, crossover, crossunder } from '../../../indicators.js';

export default {
  id: 'stochCross', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'Smoothed Stochastic %K/%D cross gated by oversold/overbought zones. Long on an upward cross while %K < longLevel; short on a downward cross while %K > shortLevel. Bread-and-butter entry of the legacy JM Simple 3TP.',

  declaredParams() {
    return [
      { id: 'stochLen',    type: 'int',   min: 5,  max: 40, step: 1 },
      { id: 'stochSmth',   type: 'int',   min: 1,  max: 8,  step: 1 },
      { id: 'longLevel',   type: 'float', min: 10, max: 50, step: 1 },  // oversold threshold
      { id: 'shortLevel',  type: 'float', min: 50, max: 90, step: 1 },  // overbought threshold
    ];
  },

  indicatorDeps(params) {
    return [{
      key: `base:stoch:${params.stochLen}`,
      tf: 'base',
      indicator: 'stoch',
      args: { period: params.stochLen },
    }];
  },

  prepare(_bundle, params, indicators, state) {
    const raw = indicators.get(`base:stoch:${params.stochLen}`);
    const K = sma(raw, params.stochSmth);
    const D = sma(K,   params.stochSmth);
    state.K = K;
    state.D = D;
    state.crossUp   = crossover(K, D);
    state.crossDown = crossunder(K, D);
    state.longLevel  = params.longLevel;
    state.shortLevel = params.shortLevel;
  },

  onBar(_bundle, i, state, _params) {
    const k = state.K[i];
    if (isNaN(k)) return { long: 0, short: 0 };
    const longSig  = state.crossUp[i]   && k < state.longLevel  ? 1 : 0;
    const shortSig = state.crossDown[i] && k > state.shortLevel ? 1 : 0;
    return { long: longSig, short: shortSig };
  },

  pineTemplate(_params, paramRefs) {
    const { stochLen, stochSmth, longLevel, shortLevel } = paramRefs;
    // Variable suffix uses the raw refs so literal-mode emits `stoch_long_30_8`
    // and input-mode emits `stoch_long_i_stochLen_i_stochSmth` (ugly but unique).
    // The emitted `long`/`short` names below match the assigned vars in `code`.
    const suffix = `${stochLen}_${stochSmth}`;
    const code = `
// ─── stochCross ───────────────────────────────────
stoch_raw_${suffix} = ta.stoch(close, high, low, ${stochLen})
stoch_k_${suffix}   = ta.sma(stoch_raw_${suffix}, ${stochSmth})
stoch_d_${suffix}   = ta.sma(stoch_k_${suffix}, ${stochSmth})
stoch_long_${suffix}  = ta.crossover(stoch_k_${suffix}, stoch_d_${suffix})  and stoch_k_${suffix} < ${longLevel}
stoch_short_${suffix} = ta.crossunder(stoch_k_${suffix}, stoch_d_${suffix}) and stoch_k_${suffix} > ${shortLevel}
`.trim();
    return {
      code,
      long:  `stoch_long_${suffix}`,
      short: `stoch_short_${suffix}`,
    };
  },
};
