/**
 * volRegime — classify each bar by volatility percentile.
 *
 * Compares current ATR to its percentile rank over the last `rankLen` bars.
 *   - 'high'   if rank > highThreshold   (default 70 — top 30% of recent vol)
 *   - 'low'    if rank < lowThreshold    (default 30 — bottom 30%)
 *   - 'normal' otherwise
 *
 * Useful for strategies that behave differently in calm vs choppy
 * markets — e.g. breakouts work in high vol, mean reversion in low vol.
 *
 * Percentile rank is the share of past `rankLen` bars where ATR was
 * STRICTLY LESS than the current ATR — the standard Pine percentile
 * semantic (ta.percentrank). High ATR on a trend-continuation bar gets a
 * high rank; a fresh dead-market bar gets a low rank.
 */

import { KINDS } from '../../contract.js';

export default {
  id: 'volRegime', version: 1, kind: KINDS.REGIME,
  description: 'Label each bar high / low / normal by ATR percentile rank over rankLen bars. high if rank > highThreshold, low if rank < lowThreshold, normal otherwise. Default ATR(14), 100-bar rank, 70/30 thresholds.',

  declaredParams() {
    return [
      { id: 'atrLen',         type: 'int',   min: 5,  max: 40,  step: 1 },
      { id: 'rankLen',        type: 'int',   min: 20, max: 500, step: 10 },
      { id: 'highThreshold',  type: 'float', min: 50, max: 95,  step: 1 },
      { id: 'lowThreshold',   type: 'float', min: 5,  max: 50,  step: 1 },
    ];
  },

  constraints(_params) {
    return [
      { lhs: 'lowThreshold', op: '<', rhs: 'highThreshold', repair: 'clamp-lhs' },
    ];
  },

  indicatorDeps(params) {
    return [
      { key: `base:atr:${params.atrLen}`,
        tf:  'base', indicator: 'atr', args: { period: params.atrLen } },
      { key: `base:percentrank:atr_${params.atrLen}:${params.rankLen}`,
        tf:  'base', indicator: 'percentrank',
        // atr isn't a price source — we emit percentrank on the ATR series
        // directly in prepare(). Declaring the dep is just so warmup-bar
        // math knows about the rankLen lookback.
        source: 'close', args: { period: params.rankLen } },
    ];
  },

  prepare(_bundle, params, indicators, state) {
    state.atr        = indicators.get(`base:atr:${params.atrLen}`);
    state.rankLen    = params.rankLen;
    state.highT      = params.highThreshold;
    state.lowT       = params.lowThreshold;
    // Compute percentile rank OF THE ATR series manually. The cached
    // percentrank dep above runs on close — we don't read it. Reasoning:
    // the indicator-cache dispatcher dedups by `source`, not by arbitrary
    // inputs, so requesting percentrank-of-atr from the cache would
    // require extending the contract. Computing it here is O(n*rankLen)
    // which is fine for Phase 3 sizing (~11k bars × 100 rank = 1.1M ops).
    const len = state.atr.length;
    state.rank = new Float64Array(len);
    state.rank.fill(NaN);
    for (let i = state.rankLen; i < len; i++) {
      const cur = state.atr[i];
      if (isNaN(cur)) continue;
      let count = 0;
      for (let j = i - state.rankLen; j < i; j++) {
        if (!isNaN(state.atr[j]) && state.atr[j] < cur) count++;
      }
      state.rank[i] = count / state.rankLen * 100;
    }
  },

  onBar(_bundle, i, state, _params) {
    const r = state.rank[i];
    if (isNaN(r)) return null;
    if (r > state.highT) return 'high';
    if (r < state.lowT)  return 'low';
    return 'normal';
  },

  pineTemplate(_params, paramRefs) {
    const { atrLen, rankLen, highThreshold, lowThreshold } = paramRefs;
    const suffix = `${atrLen}_${rankLen}`;
    const code = `
// ─── volRegime ────────────────────────────────────
vreg_atr_${atrLen} = ta.atr(${atrLen})
vreg_rank_${suffix} = ta.percentrank(vreg_atr_${atrLen}, ${rankLen})
vreg_label_${suffix} = vreg_rank_${suffix} > ${highThreshold} ? "high" : vreg_rank_${suffix} < ${lowThreshold} ? "low" : "normal"
`.trim();
    return {
      code,
      regime: `vreg_label_${suffix}`,
    };
  },
};
