/**
 * htfTrendRegime — classify each bar by higher-timeframe trend direction.
 *
 * Reads the HTF MA slope over `slopeLookback` HTF bars and emits:
 *   - 'bull' if slope > +slopeThreshold
 *   - 'bear' if slope < −slopeThreshold
 *   - 'chop' otherwise
 *
 * Slope is normalized: `(ma[hbi] − ma[hbi − slopeLookback]) / ma[hbi]`,
 * so `slopeThreshold` is dimensionless (a pct-change fraction, e.g. 0.01
 * = 1% drift across the lookback window).
 *
 * Returns `null` during HTF warmup — the runtime tolerates null labels
 * (regime slot on the bar is recorded as null; downstream filters see
 * "no regime" and usually treat it as permissive).
 *
 * Pairs naturally with `regimeGate` (long in bull only, short in bear
 * only) or `maPullback` (trend-continuation).
 */

import { KINDS } from '../../contract.js';
import { HTF_NONE } from '../../../data-bundle.js';

export default {
  id: 'htfTrendRegime', version: 1, kind: KINDS.REGIME,
  description: 'Label each bar bull / bear / chop based on HTF MA slope. slope = (ma[now] − ma[now − lookback]) / ma[now]. Above +slopeThreshold → bull; below −slopeThreshold → bear; otherwise chop. Default 1D × 50-EMA × 20-bar slope × 1% threshold.',

  declaredParams() {
    return [
      { id: 'htfTfMin',       type: 'int',   min: 60,    max: 10080, step: 60 },
      { id: 'maLen',          type: 'int',   min: 10,    max: 200,   step: 1  },
      { id: 'slopeLookback',  type: 'int',   min: 3,     max: 60,    step: 1  },
      { id: 'slopeThreshold', type: 'float', min: 0.001, max: 0.05,  step: 0.001 },
    ];
  },

  indicatorDeps(params) {
    return [{
      key:       `htf:${params.htfTfMin}:ema:close:${params.maLen}`,
      tf:        params.htfTfMin,
      indicator: 'ema',
      source:    'close',
      args:      { period: params.maLen },
    }];
  },

  prepare(bundle, params, indicators, state) {
    state.ma   = indicators.get(`htf:${params.htfTfMin}:ema:close:${params.maLen}`);
    const htf  = bundle.htfs?.[params.htfTfMin];
    if (!htf) throw new Error(`htfTrendRegime: bundle.htfs[${params.htfTfMin}] missing`);
    state.hbi       = htf.htfBarIndex;
    state.lookback  = params.slopeLookback;
    state.threshold = params.slopeThreshold;
  },

  onBar(_bundle, i, state, _params) {
    const hbi = state.hbi[i];
    if (hbi === HTF_NONE || hbi < state.lookback) return null;
    const now  = state.ma[hbi];
    const past = state.ma[hbi - state.lookback];
    if (isNaN(now) || isNaN(past) || !(now > 0)) return null;
    const slope = (now - past) / now;
    if (slope >  state.threshold) return 'bull';
    if (slope < -state.threshold) return 'bear';
    return 'chop';
  },

  // Pine: emit the label expression passively. The codegen currently
  // doesn't USE the regime label for anything (regimeGate filter is
  // no-oped in Pine), but emitting a compile-clean label lets Pine
  // codegen finish without throwing.
  pineTemplate(_params, paramRefs) {
    const { htfTfMin, maLen, slopeLookback, slopeThreshold } = paramRefs;
    const suffix = `${htfTfMin}_${maLen}_${slopeLookback}`;
    const code = `
// ─── htfTrendRegime ───────────────────────────────
htr_tf_${suffix} = str.tostring(${htfTfMin})
htr_close_${suffix} = request.security(syminfo.tickerid, htr_tf_${suffix}, close, lookahead=barmerge.lookahead_off)
htr_ma_${suffix}    = request.security(syminfo.tickerid, htr_tf_${suffix}, ta.ema(close, ${maLen}), lookahead=barmerge.lookahead_off)
htr_slope_${suffix} = htr_ma_${suffix} > 0 ? (htr_ma_${suffix} - htr_ma_${suffix}[${slopeLookback}]) / htr_ma_${suffix} : 0.0
htr_label_${suffix} = htr_slope_${suffix} > ${slopeThreshold} ? "bull" : htr_slope_${suffix} < -${slopeThreshold} ? "bear" : "chop"
`.trim();
    return {
      code,
      regime: `htr_label_${suffix}`,
    };
  },
};
