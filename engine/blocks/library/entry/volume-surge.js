/**
 * volumeSurge — entry on a volume spike with price confirmation.
 *
 * A volume surge alone is direction-ambiguous (big move up or big move
 * down both produce surges). We confirm with the bar's own close-vs-open
 * direction:
 *
 *   Long:  volume[i] >= volMa * multiplier  AND  close[i] > open[i]
 *   Short: volume[i] >= volMa * multiplier  AND  close[i] < open[i]
 *
 * where `volMa` is the SMA of volume over `volLen` bars.
 *
 * Common use: catches news-driven moves or institutional accumulation
 * bars. Best paired with a trend filter — a volume surge against the
 * prevailing trend is often a trap (exhaustion / shake-out) rather than
 * the start of a new move.
 *
 * Parameter note: `multiplier` of 1.5–2.5 is the sweet spot. Above 3x is
 * very rare and produces a sparse signal that may not pass minTrades.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'volumeSurge', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'Enter on a volume spike (≥ multiplier × rolling volume SMA) with price confirmation. Long if close>open on the surge bar; short if close<open. Catches news-driven / institutional bars. Pair with a trend filter to avoid exhaustion traps.',

  declaredParams() {
    return [
      { id: 'volLen',     type: 'int',   min: 5,   max: 50,  step: 1 },
      { id: 'multiplier', type: 'float', min: 1.2, max: 4.0, step: 0.1 },
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
    state.open   = bundle.base.open;
    state.close  = bundle.base.close;
    state.mult   = params.multiplier;
  },

  onBar(_bundle, i, state, _params) {
    const ma = state.volMa[i];
    if (isNaN(ma) || ma <= 0) return { long: 0, short: 0 };
    const v = state.volume[i];
    if (!(v >= ma * state.mult)) return { long: 0, short: 0 };
    const bullish = state.close[i] > state.open[i];
    const bearish = state.close[i] < state.open[i];
    return {
      long:  bullish ? 1 : 0,
      short: bearish ? 1 : 0,
    };
  },

  pineTemplate(_params, paramRefs) {
    const { volLen, multiplier } = paramRefs;
    const code = `
// ─── volumeSurge ──────────────────────────────────
vsurge_ma_${volLen}  = ta.sma(volume, ${volLen})
vsurge_hit_${volLen} = volume >= vsurge_ma_${volLen} * ${multiplier}
vsurge_long_${volLen}  = vsurge_hit_${volLen} and close > open
vsurge_short_${volLen} = vsurge_hit_${volLen} and close < open
`.trim();
    return {
      code,
      long:  `vsurge_long_${volLen}`,
      short: `vsurge_short_${volLen}`,
    };
  },
};
