/**
 * Walk-forward harness — robustness gate for the optimizer.
 *
 * The harness slices a bundle's timeline into N IS/OOS windows, asks the
 * caller to optimize a gene on each IS slice, evaluates that frozen gene
 * on the corresponding OOS slice, and reports Walk-Forward Efficiency
 * (WFE = mean(OOS_PF) / mean(IS_PF)).
 *
 *
 * ─── Key design decisions ──────────────────────────────────────────
 *
 * 1. **Shipped params come from the full-data fit, not from WF.**
 *    WF is a *gate* — it answers "does this strategy generalize?" It
 *    does NOT produce the gene you ship. The caller runs a full-data
 *    optimize and, separately, calls `walkForward(...)` to attach a
 *    robustness score (WFE) to that gene.
 *
 * 2. **No runtime changes.** Sub-bundles are built by truncating the
 *    base typed arrays with `.subarray(0, end)` (zero-copy) and setting
 *    `tradingStartBar` for the window. All indicator math stays causal
 *    because indicators only read base[0..i] during bar i; truncating
 *    the array at `end` is equivalent to "the timeline ends at `end`".
 *
 * 3. **Two schemes:**
 *      - `anchored`: IS start pinned at `warmup`, IS end expands with
 *        each window. This is the standard Pardo-style walk-forward.
 *      - `rolling`:  IS is a fixed-width window that slides forward.
 *        Better for non-stationary processes where older data hurts.
 *
 * 4. **OOS region = tail fraction of the series.** The caller sets
 *    `oosFractionTotal` (default 0.2 = last 20% of the data). That
 *    region is divided into `nWindows` equal slices; each OOS slice
 *    pairs with an IS slice whose shape depends on the scheme.
 *
 * 5. **WFE formula:** `mean(OOS_PF) / mean(IS_PF)`, matching the
 *    backlog spec. Windows with zero IS trades are dropped from the
 *    mean (they'd produce IS_PF=0 and blow up the ratio). Windows
 *    with zero OOS trades contribute OOS_PF=0 to the mean (the gene
 *    didn't trade OOS — that IS the signal, a legitimately bad
 *    outcome, not a divide-by-zero).
 *
 *
 * ─── What this module does NOT do ──────────────────────────────────
 *
 *   - It does not run a GA. `optimize` is a user-supplied callback:
 *     `(isBundle) => Promise<gene> | gene`. This keeps the harness
 *     independent of the GA; Phase 2.4 wires the real optimizer in.
 *
 *   - It does not evaluate the shipped gene on the full data. Callers
 *     already have `runSpec(fullBundle, gene)` for that.
 *
 *   - It does not do regime stratification. That lives in fitness.js.
 *
 * HTF handling (Phase 2.6): each HTF in `bundle.htfs[tfMin]` carries its
 * own `htfBarIndex` of length `baseLen` — the precomputed mapping from
 * base-bar index to last-closed HTF-bar index. When we slice the base to
 * `upperBar`, we need the HTF's `htfBarIndex` sliced to the same length so
 * `htfBarIndex[baseIdx]` stays valid for every baseIdx < upperBar. The HTF
 * candle arrays themselves (ts/open/high/low/close/volume) stay full — they
 * are referenced by index through the sliced `htfBarIndex`, never by the
 * slice length. This is safe because `htfBarIndex[i]` was computed against
 * the full base `ts` array, and the ts values at indices 0..upperBar-1 are
 * identical in the full base and the sliced base.
 */

import { runSpec } from '../engine/runtime.js';

/**
 * Run a walk-forward analysis.
 *
 * @param {Object}   opts
 * @param {Object}   opts.spec         — validated spec
 * @param {Object}   opts.paramSpace   — from buildParamSpace(spec)
 * @param {Object}   opts.bundle       — full-timeline data bundle
 * @param {Function} opts.optimize     — `(isBundle) => gene | Promise<gene>`
 * @param {string}   [opts.scheme='anchored']      — 'anchored' | 'rolling'
 * @param {number}   [opts.nWindows=5]
 * @param {number}   [opts.oosFractionTotal=0.2]   — tail fraction reserved for OOS
 * @param {Object}   [opts.runOpts={}]             — passed to runSpec (both IS and OOS)
 * @returns {Promise<WalkForwardReport>}
 *
 * @typedef {Object} WindowReport
 * @property {number} index          — 0..nWindows-1
 * @property {number} isStart        — base-bar index (inclusive)
 * @property {number} isEnd          — base-bar index (exclusive) = oosStart
 * @property {number} oosEnd         — base-bar index (exclusive)
 * @property {number} isTrades
 * @property {number} isPf           — IS profit factor from the fit gene
 * @property {number} isNetPct
 * @property {number} oosTrades
 * @property {number} oosPf
 * @property {number} oosNetPct
 * @property {Object} [isRegimeBreakdown]   — per-regime stats on IS slice
 * @property {Object} [oosRegimeBreakdown]  — per-regime stats on OOS slice
 * @property {Object} gene           — gene that was fit on this IS window
 *
 * @typedef {Object} WalkForwardReport
 * @property {string}         scheme
 * @property {number}         nWindows
 * @property {number}         warmup
 * @property {WindowReport[]} windows
 * @property {number}         meanIsPf
 * @property {number}         meanOosPf
 * @property {number}         meanIsNetPct
 * @property {number}         meanOosNetPct
 * @property {number}         wfe       — mean(OOS_PF) / mean(IS_PF); NaN if no valid windows
 * @property {number}         validWindows  — windows contributing to WFE
 */
export async function walkForward({
  spec,
  paramSpace,
  bundle,
  optimize,
  scheme           = 'anchored',
  nWindows         = 5,
  oosFractionTotal = 0.2,
  runOpts          = {},
}) {
  if (!spec)       throw new Error('walkForward: spec is required');
  if (!paramSpace) throw new Error('walkForward: paramSpace is required');
  if (!bundle || !bundle.base) throw new Error('walkForward: bundle.base is required');
  if (typeof optimize !== 'function') throw new Error('walkForward: optimize callback is required');
  if (!['anchored', 'rolling'].includes(scheme)) {
    throw new Error(`walkForward: scheme must be 'anchored' or 'rolling', got ${scheme}`);
  }
  if (!Number.isInteger(nWindows) || nWindows < 1) {
    throw new Error(`walkForward: nWindows must be a positive integer, got ${nWindows}`);
  }
  if (oosFractionTotal <= 0 || oosFractionTotal >= 1) {
    throw new Error(`walkForward: oosFractionTotal must be in (0, 1), got ${oosFractionTotal}`);
  }

  const windows = computeWindows({
    totalLen:   bundle.base.close.length,
    warmup:     bundle.tradingStartBar ?? 0,
    scheme,
    nWindows,
    oosFractionTotal,
  });

  const reports = [];
  for (const w of windows) {
    // ── IS fit + eval ──
    const isBundle  = sliceBundle(bundle, { upperBar: w.isEnd, tradingStartBar: w.isStart });
    const gene      = await optimize(isBundle);
    const isResult  = runSpec({ spec, paramSpace, bundle: isBundle, gene, opts: runOpts });

    // ── OOS eval with the frozen gene ──
    // Note tradingStartBar=w.isEnd: base bars [0, w.isEnd) act purely
    // as indicator warmup; the strategy only trades from isEnd onward.
    const oosBundle = sliceBundle(bundle, { upperBar: w.oosEnd, tradingStartBar: w.isEnd });
    const oosResult = runSpec({ spec, paramSpace, bundle: oosBundle, gene, opts: runOpts });

    reports.push({
      index:              w.index,
      isStart:            w.isStart,
      isEnd:              w.isEnd,
      oosEnd:             w.oosEnd,
      isTrades:           isResult.trades ?? 0,
      isPf:               Number.isFinite(isResult.pf) ? isResult.pf : 0,
      isNetPct:           isResult.netProfitPct ?? 0,
      oosTrades:          oosResult.trades ?? 0,
      oosPf:              Number.isFinite(oosResult.pf) ? oosResult.pf : 0,
      oosNetPct:          oosResult.netProfitPct ?? 0,
      isRegimeBreakdown:  isResult.regimeBreakdown  ?? null,
      oosRegimeBreakdown: oosResult.regimeBreakdown ?? null,
      gene,
    });
  }

  // Aggregate. Exclude windows with zero IS trades from WFE — they'd
  // give IS_PF=0 and poison the divisor. OOS=0 is kept; zero-OOS is a
  // legitimate "gene stopped trading" signal.
  const validForWfe = reports.filter(r => r.isTrades > 0 && r.isPf > 0);
  const meanIsPf      = mean(validForWfe.map(r => r.isPf));
  const meanOosPf     = mean(validForWfe.map(r => r.oosPf));
  const meanIsNetPct  = mean(reports.map(r => r.isNetPct));
  const meanOosNetPct = mean(reports.map(r => r.oosNetPct));
  const wfe = (validForWfe.length > 0 && meanIsPf > 0)
    ? meanOosPf / meanIsPf
    : NaN;

  return {
    scheme,
    nWindows,
    warmup:         bundle.tradingStartBar ?? 0,
    windows:        reports,
    meanIsPf,
    meanOosPf,
    meanIsNetPct,
    meanOosNetPct,
    wfe,
    validWindows:   validForWfe.length,
  };
}

// ─── Window boundary math (exported for testing) ────────────

/**
 * Compute [isStart, isEnd, oosEnd) triples for each window.
 *
 * `totalLen` is the length of the base array; `warmup` is the first bar
 * at which the strategy is allowed to trade. Usable bars are
 * `[warmup, totalLen)`, which we partition into an IS region and an
 * OOS region of size `oosFractionTotal * usable`.
 *
 * Anchored: IS starts at warmup and grows with each window.
 *   W_i:  IS = [warmup, warmup + isBase + i·oosStep)
 *         OOS = [isEnd, isEnd + oosStep)
 *
 * Rolling: IS has fixed width = isBase.
 *   W_i:  IS = [warmup + i·oosStep, warmup + i·oosStep + isBase)
 *         OOS = [isEnd, isEnd + oosStep)
 */
export function computeWindows({ totalLen, warmup, scheme, nWindows, oosFractionTotal }) {
  const usable = totalLen - warmup;
  if (usable < nWindows * 2) {
    throw new Error(
      `walkForward: usable bars (${usable}) too small for ${nWindows} windows ` +
      `(need ≥ ${nWindows * 2} after warmup=${warmup})`,
    );
  }
  const oosRegion = Math.floor(usable * oosFractionTotal);
  const oosStep   = Math.floor(oosRegion / nWindows);
  if (oosStep < 1) {
    throw new Error(
      `walkForward: OOS window size too small (${oosStep} bars). ` +
      `Increase oosFractionTotal or decrease nWindows.`,
    );
  }
  const isBase = usable - oosRegion;
  if (isBase < 1) {
    throw new Error(
      `walkForward: IS region empty (oosFractionTotal=${oosFractionTotal} leaves no IS). ` +
      `Use a smaller oosFractionTotal.`,
    );
  }

  const windows = [];
  for (let i = 0; i < nWindows; i++) {
    let isStart, isEnd, oosEnd;
    if (scheme === 'anchored') {
      isStart = warmup;
      isEnd   = warmup + isBase + i * oosStep;
      oosEnd  = isEnd + oosStep;
    } else { // rolling
      isStart = warmup + i * oosStep;
      isEnd   = isStart + isBase;
      oosEnd  = isEnd + oosStep;
    }
    // Clamp the last OOS end to totalLen in case of rounding.
    if (oosEnd > totalLen) oosEnd = totalLen;
    windows.push({ index: i, isStart, isEnd, oosEnd });
  }
  return windows;
}

// ─── Bundle slicing ────────────────────────────────────────

/**
 * Build a new bundle whose base timeline ends at `upperBar` (exclusive)
 * and whose tradingStartBar is set to the window's startBar. Uses
 * `.subarray(0, upperBar)` on each typed array so there's no copy —
 * the runtime just sees shorter arrays.
 *
 * HTFs: the `htfBarIndex` Uint32Array on each HTF is sliced to
 * `upperBar` length so lookups inside the sliced timeline are correct.
 * The HTF candle arrays (ts/open/high/low/close/volume) are intentionally
 * NOT sliced — they're indexed via `htfBarIndex`, not via base-bar offset.
 * See module header for the correctness argument.
 */
export function sliceBundle(bundle, { upperBar, tradingStartBar }) {
  const base = bundle.base;
  if (upperBar <= 0 || upperBar > base.close.length) {
    throw new Error(`sliceBundle: upperBar=${upperBar} out of range [1, ${base.close.length}]`);
  }
  const slicedBase = {};
  for (const k of Object.keys(base)) {
    const arr = base[k];
    // Typed arrays expose .subarray; plain arrays fall back to slice.
    slicedBase[k] = typeof arr?.subarray === 'function'
      ? arr.subarray(0, upperBar)
      : Array.isArray(arr) ? arr.slice(0, upperBar) : arr;
  }
  const slicedHtfs = sliceHtfs(bundle.htfs, upperBar);
  return {
    ...bundle,
    base: slicedBase,
    htfs: slicedHtfs,
    tradingStartBar,
    // periodYears is informational; adjust so callers see a truthy value.
    periodYears: computePeriodYears(slicedBase, tradingStartBar),
  };
}

/**
 * For each HTF in `htfs`, return a shallow-cloned HTF object whose
 * `htfBarIndex` is sliced to `upperBar` length. Candle arrays unchanged.
 * Returns `undefined` if `htfs` is falsy (preserves existing behavior for
 * base-TF-only bundles).
 *
 * Exported for unit testing.
 */
export function sliceHtfs(htfs, upperBar) {
  if (!htfs) return htfs;
  const out = {};
  for (const tfMin of Object.keys(htfs)) {
    const htf = htfs[tfMin];
    if (!htf) { out[tfMin] = htf; continue; }
    const hbi = htf.htfBarIndex;
    const slicedHbi = hbi && typeof hbi.subarray === 'function'
      ? hbi.subarray(0, Math.min(upperBar, hbi.length))
      : hbi;
    out[tfMin] = { ...htf, htfBarIndex: slicedHbi };
  }
  return out;
}

function computePeriodYears(base, startBar) {
  const n = base.close.length;
  if (!base.ts || n <= startBar + 1) return 0;
  const first = Number(base.ts[startBar]);
  const last  = Number(base.ts[n - 1]);
  return (last - first) / (365.25 * 864e5);
}

// ─── Internals ─────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
