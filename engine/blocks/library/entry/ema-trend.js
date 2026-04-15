/**
 * emaTrend — classic fast-EMA / slow-EMA trend gate.
 *
 * Long:  emaFast[i] > emaSlow[i]   (price trending up)
 * Short: emaFast[i] < emaSlow[i]   (price trending down)
 *
 * Used in the legacy JM Simple 3TP as one of three "score" contributions.
 * Not a cross; just a state vote — so this fires on every bar while the
 * trend is in force, letting other score contributors time the entry.
 *
 * The emaFast < emaSlow ordering constraint is declared here so the
 * optimizer never proposes emaFast=50, emaSlow=20 genomes.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'emaTrend', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,

  declaredParams() {
    return [
      { id: 'emaFast', type: 'int', min: 5,  max: 100, step: 1 },
      { id: 'emaSlow', type: 'int', min: 10, max: 400, step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [
      { key: `base:ema:close:${params.emaFast}`, tf: 'base', indicator: 'ema',
        source: 'close', args: { period: params.emaFast } },
      { key: `base:ema:close:${params.emaSlow}`, tf: 'base', indicator: 'ema',
        source: 'close', args: { period: params.emaSlow } },
    ];
  },

  constraints(params) {
    // Spec validator resolves the instance id; we just declare the local shape.
    // The runtime rewrites these to qualified ids at spec-load time.
    return [
      { lhs: 'emaFast', op: '<', rhs: 'emaSlow', repair: 'clamp-lhs' },
    ];
  },

  prepare(_bundle, params, indicators, state) {
    state.emaF = indicators.get(`base:ema:close:${params.emaFast}`);
    state.emaS = indicators.get(`base:ema:close:${params.emaSlow}`);
  },

  onBar(_bundle, i, state, _params) {
    const f = state.emaF[i], s = state.emaS[i];
    if (isNaN(f) || isNaN(s)) return { long: 0, short: 0 };
    return { long: f > s ? 1 : 0, short: f < s ? 1 : 0 };
  },

  pineTemplate(_params, paramRefs) {
    const { emaFast, emaSlow } = paramRefs;
    const suffix = `${emaFast}_${emaSlow}`;
    const code = `
// ─── emaTrend ─────────────────────────────────────
ema_fast_${emaFast} = ta.ema(close, ${emaFast})
ema_slow_${emaSlow} = ta.ema(close, ${emaSlow})
ema_long_${suffix}  = ema_fast_${emaFast} > ema_slow_${emaSlow}
ema_short_${suffix} = ema_fast_${emaFast} < ema_slow_${emaSlow}
`.trim();
    return {
      code,
      long:  `ema_long_${suffix}`,
      short: `ema_short_${suffix}`,
    };
  },
};
