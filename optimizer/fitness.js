/**
 * Fitness function — composable scalar scoring for the GA.
 *
 * The GA wants ONE number per gene. This module turns runtime-produced
 * metrics + a spec's fitness config into that number, with two layers:
 *
 *   1. Hard gates (elimination). If any gate fails, `score = 0` and
 *      `eliminated = true`. A failing gene is removed from selection,
 *      not merely penalized. Gates encode the "non-negotiables":
 *        - minTradesPerWindow: a strategy with too few trades can't be
 *          evaluated meaningfully
 *        - worstRegimePfFloor: a strategy that loses money in any regime
 *          (with a meaningful sample) is fragile
 *        - wfeMin: a strategy whose OOS-over-IS efficiency is too low
 *          has overfit and won't generalize
 *
 *   2. Weighted composite. Three terms, each normalized to [0, 1] by
 *      explicit caps so the weights compose additively:
 *        pf  → min(PF, caps.pf)   / caps.pf
 *        dd  → clamp(1 - maxDDPct, 0, 1)
 *        ret → clamp(netPct / caps.ret, 0, 1)
 *      Final: Σ w_i · normalized_i, with weights normalized to sum 1.
 *
 * Design choices worth calling out:
 *
 *   • `netProfitPct < 0` → ret term = 0. Losing strategies never collect
 *     the return premium. We don't go negative because the weighted
 *     composite is meant to be bounded in [0, 1] for easy log-scale
 *     comparisons across generations.
 *
 *   • `PF = Infinity` (no losing trades) → clamped to caps.pf. Otherwise
 *     a one-trade winner would saturate the whole population.
 *
 *   • Regime gate uses a sample-size floor (MIN_REGIME_SAMPLE trades)
 *     so a 2-trade "bear" regime can't kill an otherwise strong gene.
 *     If *no* regime has enough samples, we skip the gate rather than
 *     fail-open (fitness eats the elimination, not the data noise).
 *
 *   • WFE gate only fires when a walk-forward report is supplied.
 *     Full-data fits (no WF yet) skip it. This matches the optimizer
 *     flow: we fit full-data, *then* walk-forward as a robustness check.
 *
 *   • **WF-aware regime gate.** When a `wfReport` with per-window
 *     `oosRegimeBreakdown` is supplied, the worst-regime gate is
 *     computed on the POOLED OOS regime stats across all windows —
 *     not on the full-data `metrics.regimeBreakdown`. Rationale:
 *     OOS is what must generalize, and pooling recovers the sample
 *     size that per-window slicing destroyed. Pooling is done
 *     correctly (summing grossProfit/grossLoss) rather than by
 *     trade-weighted PF averaging, which is why runtime emits those
 *     fields on each regime entry.
 *
 * The module is pure: no I/O, no time, no state. Feed it metrics +
 * config, get a deterministic result. That makes it trivial to test
 * and to diff across commits.
 */

/**
 * Minimum trade count a regime must have before its PF counts toward
 * the `worstRegimePfFloor` gate. Chosen conservatively — 5 trades is
 * still noisy, but a 2- or 3-trade regime PF is pure randomness.
 */
export const MIN_REGIME_SAMPLE = 5;

/**
 * Score assigned to genes eliminated by a hard gate. Must be strictly
 * less than any legitimate score. Legitimate scores are in [0, 1] by
 * construction, so 0 is used as the elimination sentinel; downstream
 * selection must treat `eliminated=true` as "below floor" explicitly
 * rather than inferring from the numeric score alone (because a
 * zero-return, zero-DD strategy could also legitimately score 0).
 */
export const ELIMINATED_SCORE = 0;

/**
 * Compute fitness for one gene.
 *
 * @param {Object}  opts
 * @param {Object}  opts.metrics         — runtime-produced metrics:
 *                                          { trades, pf, netProfitPct,
 *                                            maxDDPct, regimeBreakdown? }.
 *                                          `regimeBreakdown` maps label →
 *                                          { trades, pf, net, wins }.
 * @param {Object}  opts.fitnessConfig   — spec.fitness (already normalized
 *                                          by validateSpec → see
 *                                          DEFAULT_FITNESS in engine/spec.js).
 *                                          Shape:
 *                                            weights: { pf, dd, ret }
 *                                            caps:    { pf, ret }
 *                                            gates:   { minTradesPerWindow,
 *                                                        worstRegimePfFloor,
 *                                                        wfeMin }
 * @param {Object}  [opts.wfReport]      — optional walk-forward report:
 *                                          { wfe: 0..1,
 *                                            windows?: [{ oosRegimeBreakdown? }] }.
 *                                          When absent, the WFE gate is
 *                                          skipped and the worst-regime
 *                                          gate falls back to
 *                                          `metrics.regimeBreakdown`.
 *                                          When `windows[*].oosRegimeBreakdown`
 *                                          is present, those slices are
 *                                          POOLED (summing grossProfit/
 *                                          grossLoss) and the worst-regime
 *                                          gate uses the pooled stats
 *                                          instead of the full-data ones.
 *
 * @returns {{
 *   score:       number,  // [0, 1] when not eliminated; 0 when eliminated
 *   eliminated:  boolean,
 *   gatesFailed: string[],// subset of ['trades', 'worstRegime', 'wfe']
 *   breakdown: {
 *     normPf:   number,   // [0, 1]
 *     normDd:   number,   // [0, 1]
 *     normRet:  number,   // [0, 1]
 *     weightsN: { pf:number, dd:number, ret:number }, // normalized weights
 *     worstRegimePf?: number,
 *     regimeSource?:  'full-data' | 'wf-oos-pooled',
 *     wfe?:           number,
 *   },
 *   reason?: string,      // human-readable explanation when eliminated
 * }}
 */
export function computeFitness({ metrics, fitnessConfig, wfReport = null }) {
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('computeFitness: metrics is required');
  }
  if (!fitnessConfig || typeof fitnessConfig !== 'object') {
    throw new Error('computeFitness: fitnessConfig is required');
  }

  const weights = fitnessConfig.weights ?? {};
  const caps    = fitnessConfig.caps    ?? {};
  const gates   = fitnessConfig.gates   ?? {};

  // ─── Hard gates ────────────────────────────────────────────
  const gatesFailed = [];

  // 1. minTradesPerWindow — tradingless/near-tradingless genes out.
  //    The gate compares against totalPositions (full position opens)
  //    rather than sub-trade count (which inflates with multi-TP exits).
  //    This way "minTradesPerWindow: 30" means 30 actual entry decisions,
  //    regardless of how many TP tranches each position has.
  //    Falls back to metrics.trades for legacy runs lacking totalPositions.
  const positions = numberOr(metrics.totalPositions, metrics.trades);
  if (positions < (gates.minTradesPerWindow ?? 0)) {
    gatesFailed.push('trades');
  }

  // 2. worstRegimePfFloor — any regime with ≥ MIN_REGIME_SAMPLE trades
  //    and PF < floor eliminates the gene.
  //
  //    Source selection: when the WF report carries per-window OOS
  //    regime breakdowns, we POOL them across windows and use that as
  //    the gate input. Otherwise we fall back to the full-data
  //    `metrics.regimeBreakdown`. `regimeSource` is reported in the
  //    breakdown so downstream UI can distinguish the two cases.
  const pooledOosRegimes = wfReport && Array.isArray(wfReport.windows)
    ? poolRegimeBreakdowns(wfReport.windows.map(w => w?.oosRegimeBreakdown).filter(Boolean))
    : null;
  const regimeSource  = pooledOosRegimes && Object.keys(pooledOosRegimes).length > 0
    ? 'wf-oos-pooled'
    : 'full-data';
  const regimeForGate = pooledOosRegimes && Object.keys(pooledOosRegimes).length > 0
    ? pooledOosRegimes
    : metrics.regimeBreakdown;
  const worstRegimePf = worstRegimePfWithSample(regimeForGate);
  if (
    worstRegimePf !== null &&
    worstRegimePf < (gates.worstRegimePfFloor ?? 0)
  ) {
    gatesFailed.push('worstRegime');
  }

  // 3. WFE gate — only applied when a WF report is supplied.
  const wfe = wfReport && typeof wfReport.wfe === 'number' ? wfReport.wfe : null;
  if (wfe !== null && wfe < (gates.wfeMin ?? 0)) {
    gatesFailed.push('wfe');
  }

  // ─── Composite normalization ───────────────────────────────
  // Happens even for eliminated genes so the breakdown is observable —
  // useful for UI / debugging "why did this gene fail?".
  const normPf  = normalizePf(metrics.pf, caps.pf);
  const normDd  = normalizeDd(metrics.maxDDPct);
  const normRet = normalizeRet(metrics.netProfitPct, caps.ret);

  const weightsN = normalizeWeights(weights);
  const rawComposite =
    weightsN.pf  * normPf  +
    weightsN.dd  * normDd  +
    weightsN.ret * normRet;

  // ─── Trade frequency scaling ──────────────────────────────
  // Soft multiplier: strategies with fewer positions than the target
  // get proportionally reduced fitness. Encourages the GA to find
  // strategies that trade often enough to be statistically meaningful.
  // freq = min(1, positions / frequencyTarget).  Disabled when target ≤ 0.
  const freqTarget = numberOr(fitnessConfig.frequencyTarget, 0);
  const freqFactor = freqTarget > 0
    ? Math.min(1, positions / freqTarget)
    : 1;
  const composite = rawComposite * freqFactor;

  const breakdown = {
    normPf,
    normDd,
    normRet,
    weightsN,
    ...(freqTarget > 0 ? { freqFactor, freqTarget, positions } : {}),
    ...(worstRegimePf !== null ? { worstRegimePf, regimeSource } : {}),
    ...(wfe           !== null ? { wfe }           : {}),
  };

  if (gatesFailed.length > 0) {
    return {
      score: ELIMINATED_SCORE,
      eliminated: true,
      gatesFailed,
      breakdown,
      reason: formatReason(gatesFailed, { trades: positions, worstRegimePf, wfe, gates }),
    };
  }

  return {
    score: composite,
    eliminated: false,
    gatesFailed: [],
    breakdown,
  };
}

// ─── Normalization helpers (exported for testing) ───────────

/**
 * PF ∈ [0, caps.pf] → [0, 1]. Infinity (no losing trades) is clamped
 * to caps.pf so a single-trade winner can't saturate the population.
 */
export function normalizePf(pf, capPf) {
  const cap = numberOr(capPf, 4.0);
  if (!Number.isFinite(pf)) {
    return pf === Infinity ? 1 : 0; // NaN / -Infinity → 0
  }
  if (pf <= 0) return 0;
  return Math.min(pf, cap) / cap;
}

/**
 * 1 - maxDDPct, clamped to [0, 1]. maxDDPct is expected as a fraction
 * (0.25 = 25% DD), matching runtime.js output. DD ≥ 100% → 0.
 */
export function normalizeDd(maxDdPct) {
  const dd = numberOr(maxDdPct, 0);
  if (dd <= 0) return 1;     // no drawdown
  if (dd >= 1) return 0;     // total wipeout
  return 1 - dd;
}

/**
 * Net-profit fraction normalized by caps.ret. Negative net → 0 (losers
 * don't collect the return premium). caps.ret=2.0 means "a 200% return
 * saturates"; anything beyond is already maximum on this dimension.
 */
export function normalizeRet(netProfitPct, capRet) {
  const cap = numberOr(capRet, 2.0);
  const net = numberOr(netProfitPct, 0);
  if (net <= 0) return 0;
  return Math.min(net, cap) / cap;
}

/**
 * Weights → normalized weights summing to 1. Accepts any non-negative
 * weights; handles an all-zero edge case by defaulting to equal weights.
 */
export function normalizeWeights(weights) {
  const w = {
    pf:  Math.max(0, numberOr(weights?.pf,  0)),
    dd:  Math.max(0, numberOr(weights?.dd,  0)),
    ret: Math.max(0, numberOr(weights?.ret, 0)),
  };
  const sum = w.pf + w.dd + w.ret;
  if (sum <= 0) return { pf: 1 / 3, dd: 1 / 3, ret: 1 / 3 };
  return { pf: w.pf / sum, dd: w.dd / sum, ret: w.ret / sum };
}

/**
 * Pool regime breakdowns from multiple WF windows into a single merged
 * breakdown. Sums `trades`, `wins`, `grossProfit`, `grossLoss`, and
 * recomputes `pf` and `net` from the sums.
 *
 * This is mathematically correct — summing grossProfit and grossLoss is
 * equivalent to evaluating PF on the union of the OOS slices. Trade-
 * weighted averaging of per-window PF would *not* give the same answer
 * because PF is a ratio, not a mean.
 *
 * Breakdowns that lack grossProfit/grossLoss fields (older emitters,
 * or synthetic test fixtures) fall back to the trade-weighted PF path;
 * callers should prefer the first-class runtime emitter that includes
 * the gross-profit/loss fields.
 *
 * Returns `{}` for an empty input.
 */
export function poolRegimeBreakdowns(breakdowns) {
  if (!Array.isArray(breakdowns) || breakdowns.length === 0) return {};
  const pool = {};
  for (const bd of breakdowns) {
    if (!bd || typeof bd !== 'object') continue;
    for (const label of Object.keys(bd)) {
      const r = bd[label];
      if (!r || typeof r !== 'object') continue;
      if (!pool[label]) {
        pool[label] = {
          trades: 0, wins: 0, grossProfit: 0, grossLoss: 0,
          _pfWeightedSum: 0, _pfWeightTotal: 0, _hasGross: true,
        };
      }
      const p = pool[label];
      p.trades += numberOr(r.trades, 0);
      p.wins   += numberOr(r.wins,   0);
      if (Number.isFinite(r.grossProfit) && Number.isFinite(r.grossLoss)) {
        p.grossProfit += r.grossProfit;
        p.grossLoss   += r.grossLoss;
      } else {
        // Approximation fallback: weight PF by trades. Flag that this
        // label has at least one window without gross-P/L so we pick
        // the weighted-average path when computing the label's PF.
        p._hasGross = false;
        const w  = numberOr(r.trades, 0);
        const pf = Number.isFinite(r.pf) ? r.pf : 0;
        p._pfWeightedSum += w * pf;
        p._pfWeightTotal += w;
      }
    }
  }
  // Finalize: derive pf + net; strip the bookkeeping fields.
  const out = {};
  for (const label of Object.keys(pool)) {
    const p = pool[label];
    let pf, net;
    if (p._hasGross) {
      pf = p.grossLoss > 0
        ? p.grossProfit / p.grossLoss
        : p.grossProfit > 0 ? Infinity : 0;
      net = p.grossProfit - p.grossLoss;
    } else {
      pf  = p._pfWeightTotal > 0 ? p._pfWeightedSum / p._pfWeightTotal : 0;
      net = p.grossProfit - p.grossLoss; // 0 when _hasGross=false
    }
    out[label] = {
      trades:      p.trades,
      wins:        p.wins,
      pf,
      net,
      grossProfit: p.grossProfit,
      grossLoss:   p.grossLoss,
    };
  }
  return out;
}

/**
 * Worst regime PF among regimes with enough samples. Returns null if no
 * regime qualifies (caller should skip the gate in that case rather than
 * pretending to have a signal).
 */
export function worstRegimePfWithSample(regimeBreakdown, minSample = MIN_REGIME_SAMPLE) {
  if (!regimeBreakdown || typeof regimeBreakdown !== 'object') return null;
  let worst = null;
  for (const label of Object.keys(regimeBreakdown)) {
    const r = regimeBreakdown[label];
    if (!r || typeof r !== 'object') continue;
    const trades = numberOr(r.trades, 0);
    if (trades < minSample) continue;
    const pf = Number.isFinite(r.pf) ? r.pf : (r.pf === Infinity ? Infinity : 0);
    if (pf === Infinity) continue; // all-wins regime doesn't threaten the floor
    if (worst === null || pf < worst) worst = pf;
  }
  return worst;
}

// ─── Internals ─────────────────────────────────────────────

function numberOr(v, fallback) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
}

function formatReason(failed, ctx) {
  const parts = [];
  if (failed.includes('trades')) {
    parts.push(`positions=${ctx.trades} < minTradesPerWindow=${ctx.gates.minTradesPerWindow}`);
  }
  if (failed.includes('worstRegime')) {
    parts.push(
      `worstRegimePf=${ctx.worstRegimePf?.toFixed(3) ?? 'n/a'} ` +
      `< worstRegimePfFloor=${ctx.gates.worstRegimePfFloor}`
    );
  }
  if (failed.includes('wfe')) {
    parts.push(`wfe=${ctx.wfe?.toFixed(3) ?? 'n/a'} < wfeMin=${ctx.gates.wfeMin}`);
  }
  return `eliminated: ${parts.join('; ')}`;
}
