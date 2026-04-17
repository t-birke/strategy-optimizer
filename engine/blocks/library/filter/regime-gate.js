/**
 * regimeGate — gate entries by the regime slot's current label.
 *
 * The regime slot (one block per spec) emits a string label per bar like
 * 'bull' / 'chop' / 'bear', or 'low' / 'normal' / 'high' for vol regimes,
 * or 'asia' / 'london' / 'ny' for session regimes. `regimeGate` lets the
 * author declare WHICH labels are long-eligible and WHICH are short-
 * eligible, independently.
 *
 * Long pass  ⇔ currentRegimeLabel ∈ allowedLong
 * Short pass ⇔ currentRegimeLabel ∈ allowedShort
 *
 * Params are two comma-separated strings of allowed labels. Either can be
 * '*' to mean "any label passes" or '' (empty) to mean "no label
 * passes" (= veto that side entirely).
 *
 * Example: trend-follower that only longs in bull regime, only shorts in
 * bear regime:
 *    regimeGate.allowedLong  = 'bull'
 *    regimeGate.allowedShort = 'bear'
 *
 * Example: mean-reverter that only trades during choppy regime:
 *    regimeGate.allowedLong  = 'chop'
 *    regimeGate.allowedShort = 'chop'
 *
 * Note — this block has no numeric params, so the GA doesn't tune it.
 * Use pinned literal values in the spec. The `declaredParams()` shape is
 * empty; the two string settings live on `params` directly (spec sets
 * them as `allowedLong: { value: 'bull,chop' }`).
 */

import { KINDS, DIRECTIONS } from '../../contract.js';

function parseSet(str) {
  if (str == null) return null;
  const trimmed = String(str).trim();
  if (trimmed === '' || trimmed === '*') return trimmed; // sentinels
  return new Set(trimmed.split(',').map(s => s.trim()).filter(Boolean));
}

function membership(set, label) {
  if (set === '*')   return true;                                  // any
  if (set === '')    return false;                                 // veto
  if (set == null)   return true;                                  // not specified → permit
  if (label == null) return false;                                 // no regime running → veto
  return set.has(label);
}

export default {
  id: 'regimeGate', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  description: 'Gate entries by the regime slot\'s current label. allowedLong / allowedShort are comma-separated label sets (or "*" for any, "" for veto). Requires a regime block to be active — if none, both sides pass.',

  // String params aren't GA-tuneable; we declare nothing here and pin
  // values via the spec. The optimizer never sees these — they're
  // author-set literals.
  declaredParams() {
    return [];
  },

  indicatorDeps() {
    return [];
  },

  prepare(_bundle, params, _indicators, state) {
    state.allowedLong  = parseSet(params.allowedLong  ?? '*');
    state.allowedShort = parseSet(params.allowedShort ?? '*');
  },

  onBar(_bundle, _i, state, _params, ctx) {
    const label = ctx?.regimeLabel ?? null;
    return {
      long:  membership(state.allowedLong,  label),
      short: membership(state.allowedShort, label),
    };
  },

  // Pine codegen: emit a permissive no-op. Pine doesn't have access to
  // our regime state machine (regime blocks don't yet have a universal
  // pineTemplate either — they'd each have to emit their own regime-
  // detection code). Rather than throwing or silently excluding the
  // filter, emit a `true`-constant so the Pine alert indicator doesn't
  // suppress any entries due to this filter.
  //
  // If/when regime blocks grow Pine templates, revisit this to emit
  // real gating against the regime's Pine label.
  pineTemplate(_params, _paramRefs) {
    const code = `
// ─── regimeGate (Pine-no-op — regime state not exported to Pine) ───
rgate_long  = true
rgate_short = true
`.trim();
    return {
      code,
      long:  'rgate_long',
      short: 'rgate_short',
    };
  },
};
