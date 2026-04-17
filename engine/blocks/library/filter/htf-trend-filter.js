/**
 * htfTrendFilter — only allow trades in the higher-timeframe trend direction.
 *
 * Long-eligible  if HTF close[htfIdx] > HTF ma[htfIdx]
 * Short-eligible if HTF close[htfIdx] < HTF ma[htfIdx]
 *
 * "Don't short in an uptrend, don't long in a downtrend." Classic
 * multi-timeframe gate — the base-TF entry picks the timing, the HTF
 * trend picks the direction. Direction is always 'both' because the
 * block produces per-side eligibility on every bar; `aggregateFilters`
 * in the runtime AND-gates these onto entry signals.
 *
 * HTF resolution uses the bundle's last-closed index mapping:
 *   `bundle.htfs[tfMin].htfBarIndex[i]` → last-closed HTF bar idx
 * When no HTF bar has closed yet at base bar i (pre-warmup), we permit
 * both sides (no-opinion = no veto).
 *
 * Defaults tuned for a 4H base + 1D HTF (`tfMin: 1440`) + 50-period EMA.
 * For 15m/1H bases, tfMin=60 (1H) or 240 (4H) are more common HTFs.
 */

import { KINDS, DIRECTIONS } from '../../contract.js';
import { HTF_NONE } from '../../../data-bundle.js';

export default {
  id: 'htfTrendFilter', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  description: 'Gate entries by higher-timeframe trend: long-eligible when HTF close > HTF MA, short-eligible when HTF close < HTF MA. Base-TF entry picks the timing, HTF trend picks the direction. Default 1D (tfMin=1440) × 50-EMA.',

  declaredParams() {
    return [
      // HTF resolution in minutes. Common aliases:
      //   60 = 1H · 240 = 4H · 1440 = 1D · 10080 = 1W
      { id: 'htfTfMin', type: 'int', min: 60,  max: 10080, step: 60 },
      { id: 'maLen',    type: 'int', min: 10,  max: 200,   step: 1  },
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
    state.ma       = indicators.get(`htf:${params.htfTfMin}:ema:close:${params.maLen}`);
    state.htf      = bundle.htfs?.[params.htfTfMin];
    if (!state.htf) {
      throw new Error(`htfTrendFilter: bundle.htfs[${params.htfTfMin}] missing. ` +
        `Check that computeDataRequirements(spec) saw this dep.`);
    }
    state.htfClose = state.htf.close;
    state.htfIdx   = state.htf.htfBarIndex;
  },

  onBar(_bundle, i, state, _params) {
    const hbi = state.htfIdx[i];
    if (hbi === HTF_NONE) return { long: true, short: true }; // no HTF bar yet → no opinion
    const ma = state.ma[hbi];
    const c  = state.htfClose[hbi];
    if (isNaN(ma) || isNaN(c)) return { long: true, short: true };
    return { long: c > ma, short: c < ma };
  },

  pineTemplate(_params, paramRefs) {
    const { htfTfMin, maLen } = paramRefs;
    // Convert tfMin to a Pine timeframe string: 60→"60", 240→"240",
    // 1440→"D", 10080→"W". We prefer the numeric form because it works
    // for arbitrary minutes; the callable literal letters (D/W) are
    // only for the common presets.
    // (Pine accepts "60" as an alias for "1h" etc. — using the minute
    // string uniformly keeps the template generic.)
    const pineTf = `str.tostring(${htfTfMin})`;
    // We use request.security with lookahead_off for parity with the
    // engine's last-closed-bar semantics.
    const code = `
// ─── htfTrendFilter ───────────────────────────────
htf_tf_${htfTfMin} = ${pineTf}
htf_close_${htfTfMin} = request.security(syminfo.tickerid, htf_tf_${htfTfMin}, close, lookahead=barmerge.lookahead_off)
htf_ma_${htfTfMin}_${maLen} = request.security(syminfo.tickerid, htf_tf_${htfTfMin}, ta.ema(close, ${maLen}), lookahead=barmerge.lookahead_off)
htf_long_${htfTfMin}_${maLen}  = htf_close_${htfTfMin} > htf_ma_${htfTfMin}_${maLen}
htf_short_${htfTfMin}_${maLen} = htf_close_${htfTfMin} < htf_ma_${htfTfMin}_${maLen}
`.trim();
    return {
      code,
      long:  `htf_long_${htfTfMin}_${maLen}`,
      short: `htf_short_${htfTfMin}_${maLen}`,
    };
  },
};
