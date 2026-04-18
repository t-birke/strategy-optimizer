/**
 * paramStabilityCoV — per-parameter Coefficient of Variation across
 * walk-forward window winners.
 *
 *
 * ─── Why this exists ───────────────────────────────────────────────
 *
 * A gene can pass walk-forward on WFE (OOS PF ÷ IS PF stays healthy)
 * while the PARAMETERS the GA picks drift wildly from window to
 * window. E.g. window 1's winner has `emaLen = 12`, window 2 picks
 * `emaLen = 47`, window 3 picks `emaLen = 23`. That's a strategy
 * template whose "optimal" settings have no stable answer — a
 * classic curve-fit signature, even when the aggregate OOS number
 * happens to look fine.
 *
 * This module measures that drift directly. For each numeric param,
 * we compute the Coefficient of Variation (CoV = stdev / |mean|)
 * across the per-window winners, then aggregate to a strategy-level
 * mean CoV. Low CoV = the same-ish parameters work across all
 * windows = trustworthy fit. High CoV = every window disagrees about
 * what "optimal" means = overfit.
 *
 * This is a post-hoc test on an existing `wfReport` — no new
 * backtests are run. The input is the output of
 * `optimizer/walk-forward.js`; we just read
 * `wfReport.windows[i].gene` from each window.
 *
 *
 * ─── How this complements WFE ──────────────────────────────────────
 *
 * WFE asks: "does OOS performance degrade from IS?" It's a test on
 * the *output* (realized P&L) of the GA's per-window fit.
 *
 * CoV asks: "does the *way* to achieve OOS performance drift?" It's
 * a test on the *input* (the parameter vector) of the GA's
 * per-window fit.
 *
 * Both can pass (robust strategy), both can fail (broken strategy),
 * or you can get the interesting cases:
 *   - WFE passes, CoV high: the template is fragile — each window
 *     finds a completely different local optimum, and the average
 *     OOS PF is a lucky coincidence of those local optima.
 *   - WFE fails, CoV low: the template is stable but wrong — it
 *     picks similar params every time and those params underperform
 *     OOS consistently. Different failure mode; simpler to reason
 *     about.
 *
 * Backlog reference: see `docs/backlog.md` §6.1
 * (`paramStabilityCoV.js`). Part of the Phase 6.1 composite-robustness
 * multiplier suite, alongside bootstrap-P10, MC-DD-P95, adversarial
 * split, and random-OOS.
 *
 *
 * ─── Math ──────────────────────────────────────────────────────────
 *
 * For each paramId p observed across N windows with values v_1..v_N:
 *
 *   mean_p   = (1/N) Σ v_i
 *   stdev_p  = sqrt( (1/N) Σ (v_i − mean_p)² )   — population stdev,
 *              matching the `engine/indicators.js` stdev() convention
 *              (biased, divide by N not N-1).
 *   CoV_p    = stdev_p / max(|mean_p|, epsilon)
 *
 * We use `epsilon = 1e-9` so CoV is still finite for params whose
 * mean happens to be (near) zero — e.g. a signed offset that
 * averages out. Without the clamp we'd emit Infinity and poison any
 * downstream geomean.
 *
 * Strategy-level result:
 *   meanCoV  = (1/P) Σ CoV_p   over the P scored params
 *   worstCoV = max_p CoV_p
 *
 * Params whose windows all happen to have identical values (common
 * for integer-stepped params the GA locked onto) contribute CoV=0
 * to the mean — no special-case; they just honestly report "zero
 * drift on this axis."
 */

/**
 * Compute per-parameter CoV across walk-forward window winners.
 *
 * @param {Object} wfReport — output of `optimizer/walk-forward.js::walkForward`.
 *   The relevant shape is `wfReport.windows[i].gene` — each window
 *   has a `gene` object mapping paramId → numeric value (the gene
 *   the GA fit on that IS slice). See `walk-forward.js` lines
 *   ~82–100 for the full WindowReport typedef.
 * @param {Object} [opts]
 * @param {Array<string>} [opts.paramIds] — restrict scoring to these
 *   param IDs. Default: union of all paramIds present across all
 *   window genes. Useful for isolating a single axis ("is only emaLen
 *   drifting?") or for excluding params the caller knows are meta.
 * @param {number} [opts.minWindows=3] — below this, return a
 *   degenerate result. One or two windows cannot produce a meaningful
 *   stdev (a 2-sample stdev is just |Δ|/√2, telling us nothing about
 *   stability), and callers should not weight a single-window number
 *   as if it were a population statistic.
 *
 * @returns {{
 *   meanCoV:     number,
 *   worstParam:  string|null,
 *   worstCoV:    number,
 *   perParamCoV: Object<string, number>,
 *   windowsUsed: number,
 *   degenerate:  boolean,
 * }}
 *   - `meanCoV`: mean across per-param CoVs. Lower is more stable.
 *   - `worstParam`: paramId with the highest individual CoV, or null
 *     when no params were scored.
 *   - `worstCoV`: the highest individual CoV. 0 when degenerate or
 *     no params were scored.
 *   - `perParamCoV`: map from paramId to its CoV, for every scored
 *     param. Caller can inspect this to surface the worst offenders
 *     in a UI.
 *   - `windowsUsed`: count of windows that contributed a winner gene.
 *   - `degenerate`: true when windowsUsed < minWindows, or the
 *     report is missing/empty. In the degenerate case all numeric
 *     fields are 0 and worstParam is null — downstream geomean code
 *     should treat this as "no signal" not "perfectly stable."
 */
export function paramStabilityCoV(wfReport, opts = {}) {
  const minWindows = Number.isInteger(opts.minWindows) && opts.minWindows > 0
    ? opts.minWindows
    : 3;

  const degenerateResult = (windowsUsed = 0) => ({
    meanCoV:     0,
    worstParam:  null,
    worstCoV:    0,
    perParamCoV: {},
    windowsUsed,
    degenerate:  true,
  });

  // ── Input validation ──
  // Graceful degeneracy for every "no data" shape. This module is
  // expected to be wired into a geomean alongside other robustness
  // terms; throwing on a missing WF report would poison the whole
  // composite for callers who legitimately skip WF on tiny datasets.
  if (!wfReport || !Array.isArray(wfReport.windows) || wfReport.windows.length === 0) {
    return degenerateResult(0);
  }

  // ── Collect per-window genes ──
  // Per `optimizer/walk-forward.js` (lines ~154–168), each entry in
  // `wfReport.windows` has a `.gene` field — the gene the GA fit on
  // that window's IS slice. That's the per-window "winner" this CoV
  // is computed over. We skip windows where gene is missing or not
  // an object (defensive — a failed optimize callback could drop it).
  const genes = [];
  for (const w of wfReport.windows) {
    if (w && w.gene && typeof w.gene === 'object') {
      genes.push(w.gene);
    }
  }

  const windowsUsed = genes.length;
  if (windowsUsed < minWindows) {
    return degenerateResult(windowsUsed);
  }

  // ── Determine which paramIds to score ──
  // Default: union across every gene. A param missing from some
  // windows is skipped for those windows (its N shrinks) — this is
  // the right behavior for conditional/nested genes where a block
  // toggles on/off and its knobs only exist when active.
  let paramIds;
  if (Array.isArray(opts.paramIds) && opts.paramIds.length > 0) {
    paramIds = opts.paramIds.slice();
  } else {
    const set = new Set();
    for (const g of genes) {
      for (const k of Object.keys(g)) set.add(k);
    }
    paramIds = Array.from(set);
  }

  // ── Per-param CoV ──
  const EPSILON = 1e-9;
  const perParamCoV = {};
  let worstParam = null;
  let worstCoV   = 0;

  for (const pid of paramIds) {
    // Collect finite numeric values for this param across windows.
    // Non-numeric or NaN values are dropped — they'd poison the
    // mean/stdev. If too few windows contribute a real number, we
    // skip the param entirely rather than emit a bogus CoV.
    const values = [];
    for (const g of genes) {
      const v = g[pid];
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
    if (values.length < minWindows) continue;

    const n = values.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = values[i] - mean;
      sumSq += d * d;
    }
    // Population stdev — same convention as engine/indicators.js stdev().
    const stdev = Math.sqrt(sumSq / n);
    const cov   = stdev / Math.max(Math.abs(mean), EPSILON);

    perParamCoV[pid] = cov;
    if (cov > worstCoV) {
      worstCoV   = cov;
      worstParam = pid;
    }
  }

  // ── Aggregate to strategy-level mean ──
  // If none of the requested paramIds actually had enough numeric
  // windows to score, we report mean=0 / worstParam=null but NOT
  // degenerate — the WF report itself had enough windows; it just
  // happens no numeric param survived filtering. Caller can inspect
  // `perParamCoV` being empty to distinguish.
  const scoredIds = Object.keys(perParamCoV);
  let meanCoV = 0;
  if (scoredIds.length > 0) {
    let s = 0;
    for (const id of scoredIds) s += perParamCoV[id];
    meanCoV = s / scoredIds.length;
  }

  return {
    meanCoV,
    worstParam,
    worstCoV,
    perParamCoV,
    windowsUsed,
    degenerate: false,
  };
}
