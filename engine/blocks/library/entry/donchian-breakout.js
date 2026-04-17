/**
 * donchianBreakout — classic turtle-style breakout.
 *
 * Long:  close[i] >  highest(high, period)[i-1]   (break of prior N-bar high)
 * Short: close[i] <  lowest(low,   period)[i-1]    (break of prior N-bar low)
 *
 * Why `[i-1]` and not `[i]`: the standard Donchian breakout compares the
 * current bar's close to the N-bar high/low that EXCLUDES the current
 * bar. Using [i] would make the definition circular ("close is a new
 * high" == "close is higher than itself"). The one-bar shift is the
 * canonical Turtle implementation.
 *
 * Pre-compute shifted-by-1 highest/lowest arrays in prepare() so onBar
 * stays O(1).
 *
 * This is one of the most robust trend-following primitives — the
 * Turtles' rule #1 did ~85% of their multi-decade edge with just this.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'donchianBreakout', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'Classic Turtle-style breakout. Long on close above the prior N-bar high; short on close below the prior N-bar low. Period-N is the channel lookback (default 20). Robust trend-follower — works best with a wide target.',

  declaredParams() {
    return [
      { id: 'period', type: 'int', min: 10, max: 100, step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [
      { key: `base:highest:high:${params.period}`, tf: 'base', indicator: 'highest',
        source: 'high', args: { period: params.period } },
      { key: `base:lowest:low:${params.period}`,   tf: 'base', indicator: 'lowest',
        source: 'low',  args: { period: params.period } },
    ];
  },

  prepare(bundle, params, indicators, state) {
    state.hi    = indicators.get(`base:highest:high:${params.period}`);
    state.lo    = indicators.get(`base:lowest:low:${params.period}`);
    state.close = bundle.base.close;
  },

  onBar(_bundle, i, state, _params) {
    if (i < 1) return { long: 0, short: 0 };
    // Use the [i-1] values so the breakout reference doesn't include
    // the current bar's high/low — otherwise `close > hi[i]` would be
    // tautological whenever the bar is an inside/outside bar.
    const priorHi = state.hi[i - 1], priorLo = state.lo[i - 1];
    if (isNaN(priorHi) || isNaN(priorLo)) return { long: 0, short: 0 };
    const c = state.close[i];
    return {
      long:  c > priorHi ? 1 : 0,
      short: c < priorLo ? 1 : 0,
    };
  },

  pineTemplate(_params, paramRefs) {
    const { period } = paramRefs;
    const code = `
// ─── donchianBreakout ─────────────────────────────
donch_hi_${period}  = ta.highest(high, ${period})[1]
donch_lo_${period}  = ta.lowest(low,   ${period})[1]
donch_long_${period}  = close > donch_hi_${period}
donch_short_${period} = close < donch_lo_${period}
`.trim();
    return {
      code,
      long:  `donch_long_${period}`,
      short: `donch_short_${period}`,
    };
  },
};
