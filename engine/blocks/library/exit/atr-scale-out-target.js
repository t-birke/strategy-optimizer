/**
 * atrScaleOutTarget — generic N-tier scale-out target (up to 6 tranches).
 *
 * One block covers everything from single-TP exits to full 6-tier scale-outs.
 * Active tranches are declared in the spec by giving them `tpNPct > 0`;
 * unused tranches pin `tpNPct: { "value": 0 }` and vanish from both the
 * genome and the runtime (zero overhead for unused tiers).
 *
 * At open-time, the block:
 *   1. Collects tranches with pct > 0 (ignores disabled ones).
 *   2. Sorts them by tpMult ascending — so TPs fire in natural nearest-first
 *      order regardless of how the genome happens to name them.
 *   3. Normalizes their pcts to sum to 100% (block-internal, so the GA
 *      doesn't need sum-expression constraints; any non-negative combination
 *      is valid).
 *   4. Builds `position.subs[]`, each tranche carrying its locked TP price
 *      in `meta.tpPrice` so onBar is a simple O(tranches) scan.
 *
 * TP1 (the first-firing tranche, i.e. lowest mult) stamps
 * `position.state.tp1HitBar = i` when it closes, so atrHardStop can shift
 * to breakeven with a 1-bar delay. "TP1" is defined as first-fired, NOT
 * "the one labeled tp1Mult in the genome" — those match when the spec
 * puts tranches in the obvious order, but we don't require it.
 *
 * TPs are limit fills — intra-bar, NO slippage, matches Pine's
 * `strategy.exit(..., limit=...)` fill-at-exact-price semantics.
 */

import { KINDS, DIRECTIONS, EXIT_SLOTS } from '../../contract.js';

const MAX_TRANCHES = 6;

export default {
  id: 'atrScaleOutTarget', version: 1, kind: KINDS.EXIT, exitSlot: EXIT_SLOTS.TARGET,
  direction: DIRECTIONS.BOTH,
  description: 'Generic N-tier scale-out target (up to 6 tranches). Unused tranches pin pct=0 and vanish from both the genome and the runtime. Tranches are TP-price-sorted and auto-normalized to sum to 100%.',

  declaredParams() {
    const params = [
      { id: 'atrLen', type: 'int', min: 5, max: 50, step: 1 },
    ];
    // Per-tranche params: tpNMult (distance in ATR) + tpNPct (size share).
    // Uniform ranges — spec-level narrowing is where per-tranche targeting
    // happens (e.g., tranche 1 gets [1.5, 3.0], tranche 6 gets [8, 20]).
    for (let n = 1; n <= MAX_TRANCHES; n++) {
      params.push({ id: `tp${n}Mult`, type: 'float', min: 0.5, max: 30,  step: 0.05 });
      // min=0 so unused tranches can be pinned to zero. step=5 matches the
      // legacy JM Simple 3TP's tp1Pct/tp2Pct grid.
      params.push({ id: `tp${n}Pct`,  type: 'float', min: 0,   max: 100, step: 5 });
    }
    return params;
  },

  indicatorDeps(params) {
    return [{
      key: `base:atr:${params.atrLen}`,
      tf: 'base',
      indicator: 'atr',
      args: { period: params.atrLen },
    }];
  },

  prepare(bundle, params, indicators, state) {
    state.atr  = indicators.get(`base:atr:${params.atrLen}`);
    state.high = bundle.base.high;
    state.low  = bundle.base.low;
  },

  /**
   * Split the main position into N TP tranches (N ≤ 6) at open-time.
   * No-op if no tranche has pct > 0 OR if entry-bar ATR is unavailable
   * (e.g., first bar) — the untouched "main" sub remains, so hardStop
   * and trail still function.
   */
  onPositionOpen(position, params, state, ctx) {
    // Use atr[i-1] (signal bar) to match legacy `entryAtr` semantics.
    const a = ctx.i >= 1 ? state.atr[ctx.i - 1] : NaN;
    if (!(a > 0) || isNaN(a)) return;

    // Collect active tranches.
    const active = [];
    for (let n = 1; n <= MAX_TRANCHES; n++) {
      const pct  = params[`tp${n}Pct`];
      const mult = params[`tp${n}Mult`];
      if (!(pct > 0) || !(mult > 0)) continue;
      active.push({ n, pct, mult });
    }
    if (active.length === 0) return;   // no tranches configured

    // Sort by mult ascending so "first-to-fire" equals "lowest TP price"
    // (i.e., natural near-to-far ordering) regardless of genome labeling.
    active.sort((x, y) => x.mult - y.mult);

    // Normalize pct so the active tranches sum to 100% of total units.
    const pctSum = active.reduce((s, t) => s + t.pct, 0);
    if (!(pctSum > 0)) return;

    const totalUnits = position.subs.reduce(
      (s, sub) => s + (sub.closed ? 0 : sub.units), 0);
    if (!(totalUnits > 0)) return;

    const ep = position.entryPrice;
    const isLong = position.dir > 0;
    const tpPrice = (mult) => isLong ? ep + a * mult : ep - a * mult;

    // Build subs — use a running "remaining" so the LAST tranche gets the
    // exact remainder (avoids rounding gap that would leave dust behind).
    const newSubs = [];
    let remaining = totalUnits;
    for (let idx = 0; idx < active.length; idx++) {
      const t = active[idx];
      const isLast = idx === active.length - 1;
      const units = isLast ? remaining : totalUnits * (t.pct / pctSum);
      remaining -= units;
      newSubs.push({
        units,
        closed: false,
        meta: {
          tag:       `TP${idx + 1}`,   // positional label (first-firing = TP1)
          tpPrice:   tpPrice(t.mult),
          tpMult:    t.mult,
          trancheN:  t.n,              // original genome slot for debugging
        },
      });
    }

    position.subs = newSubs;
    position.state.tp1HitBar = null;
  },

  onBar(_bundle, i, state, _params, position) {
    if (!position) return null;

    // Legacy guard: skip the entry bar (Pine doesn't evaluate TPs on the
    // bar the position opens because position_size update is same-bar).
    if (i <= position.entryBar) return null;

    const isLong = position.dir > 0;
    const h = state.high[i], l = state.low[i];

    const closes = [];
    for (let s = 0; s < position.subs.length; s++) {
      const sub = position.subs[s];
      if (sub.closed) continue;
      const tpPrice = sub.meta?.tpPrice;
      if (!(tpPrice > 0) || isNaN(tpPrice)) continue;
      const hit = isLong ? h >= tpPrice : l <= tpPrice;
      if (hit) {
        closes.push({
          subIndex: s,
          fillPrice: tpPrice,  // limit fill — exact, no slippage
          signal: sub.meta?.tag ?? `TP${s + 1}`,
        });
        // The first sub (lowest mult → fires first) stamps tp1HitBar so
        // atrHardStop can shift its SL to breakeven-plus after a 1-bar delay.
        if (s === 0) position.state.tp1HitBar = i;
      }
    }

    return closes.length > 0 ? { action: 'closeSubs', closes } : null;
  },

  // No pineTemplate — target is backtest-only; alerts fire on entries.
};
