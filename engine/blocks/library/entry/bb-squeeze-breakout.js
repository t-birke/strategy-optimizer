/**
 * bbSqueezeBreakout — Bollinger squeeze followed by a directional break of basis.
 *
 * "Squeeze" = BB width (as %-of-basis) is in the bottom `squeezePctile`
 * percentile over the last 100 bars. A breakout is registered when a
 * recent-squeeze bar closes on one side of the basis:
 *
 *   Long:  close > basis  AND recent-squeeze within last `lookbackBars`
 *   Short: close < basis  AND recent-squeeze within last `lookbackBars`
 *
 * The legacy JM Simple 3TP used lookbackBars=3 and squeezePctile=25 hard-
 * coded — this block exposes both as params. Basis is an SMA of close
 * (standard Pine BB, same as the legacy implementation).
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

export default {
  id: 'bbSqueezeBreakout', version: 1, kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,
  description: 'Bollinger squeeze followed by a directional break of basis. A squeeze is a BB-width percentile in the bottom `squeezePctile`%; breakout fires when a recent-squeeze bar closes on one side of the basis within `lookbackBars`.',

  declaredParams() {
    return [
      { id: 'bbLen',         type: 'int',   min: 5,   max: 100, step: 1 },
      { id: 'bbMult',        type: 'float', min: 1.0, max: 4.0, step: 0.1 },
      { id: 'squeezePctile', type: 'float', min: 5,   max: 50,  step: 1 },
      { id: 'lookbackBars',  type: 'int',   min: 1,   max: 10,  step: 1 },
    ];
  },

  indicatorDeps(params) {
    return [
      // Basis (SMA of close) — shared with anyone else needing sma(close, bbLen).
      { key: `base:sma:close:${params.bbLen}`, tf: 'base', indicator: 'sma',
        source: 'close', args: { period: params.bbLen } },
      // Std-dev — used to derive upper/lower bands + width.
      { key: `base:stdev:close:${params.bbLen}`, tf: 'base', indicator: 'stdev',
        source: 'close', args: { period: params.bbLen } },
    ];
  },

  prepare(bundle, params, indicators, state) {
    const basis = indicators.get(`base:sma:close:${params.bbLen}`);
    const sd    = indicators.get(`base:stdev:close:${params.bbLen}`);
    const len   = basis.length;

    // BB width as % of basis, then percentile-rank over trailing 100 bars.
    const bbWidth = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const b = basis[i];
      bbWidth[i] = b > 0 && !isNaN(sd[i]) ? (2 * params.bbMult * sd[i]) / b * 100 : NaN;
    }
    // Inline percentrank(bbWidth, 100) — can't route through the indicator
    // cache here because the input isn't a price source. Cheap regardless.
    const prank = new Float64Array(len);
    const PR_PERIOD = 100;
    for (let i = 0; i < len; i++) {
      if (i < PR_PERIOD || isNaN(bbWidth[i])) { prank[i] = NaN; continue; }
      let below = 0, total = 0;
      const cur = bbWidth[i];
      for (let j = i - PR_PERIOD + 1; j <= i; j++) {
        if (!isNaN(bbWidth[j])) {
          total++;
          if (bbWidth[j] < cur) below++;
        }
      }
      prank[i] = total > 0 ? (below / total) * 100 : NaN;
    }

    // Squeeze = bbWidth percentile < squeezePctile
    const squeeze = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      squeeze[i] = !isNaN(prank[i]) && prank[i] < params.squeezePctile ? 1 : 0;
    }

    state.basis   = basis;
    state.squeeze = squeeze;
    state.close   = bundle.base.close;
    state.lookback = params.lookbackBars;
  },

  onBar(_bundle, i, state, _params) {
    const b = state.basis[i];
    if (isNaN(b)) return { long: 0, short: 0 };

    // Recent squeeze within lookbackBars (inclusive of current bar).
    let recent = false;
    const start = Math.max(0, i - state.lookback + 1);
    for (let j = start; j <= i; j++) {
      if (state.squeeze[j]) { recent = true; break; }
    }
    if (!recent) return { long: 0, short: 0 };

    const c = state.close[i];
    return {
      long:  c > b ? 1 : 0,
      short: c < b ? 1 : 0,
    };
  },

  pineTemplate(_params, paramRefs) {
    const { bbLen, bbMult, squeezePctile, lookbackBars } = paramRefs;
    const suffix = `${bbLen}_${lookbackBars}`;
    const code = `
// ─── bbSqueezeBreakout ────────────────────────────
bb_basis_${bbLen} = ta.sma(close, ${bbLen})
bb_std_${bbLen}   = ta.stdev(close, ${bbLen})
bb_width_${bbLen} = bb_basis_${bbLen} > 0 ? (2 * ${bbMult} * bb_std_${bbLen}) / bb_basis_${bbLen} * 100 : na
bb_prank_${bbLen} = ta.percentrank(bb_width_${bbLen}, 100)
bb_squeeze_${bbLen} = bb_prank_${bbLen} < ${squeezePctile}
bb_recent_sqz_${suffix} = false
for i_bb_${suffix} = 0 to ${lookbackBars} - 1
    if nz(bb_squeeze_${bbLen}[i_bb_${suffix}], false)
        bb_recent_sqz_${suffix} := true
        break
bb_long_${suffix}  = bb_recent_sqz_${suffix} and close > bb_basis_${bbLen}
bb_short_${suffix} = bb_recent_sqz_${suffix} and close < bb_basis_${bbLen}
`.trim();
    return {
      code,
      long:  `bb_long_${suffix}`,
      short: `bb_short_${suffix}`,
    };
  },
};
