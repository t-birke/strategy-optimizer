/**
 * pine-codegen — turn a hydrated (spec, gene) pair into a Pine v5 indicator
 * that alerts on the same entry signals the runtime would fire.
 *
 * Scope: entry alerts only. Position state, SL/TP, and sizing are intentionally
 * NOT emitted — by contract (engine/blocks/contract.js), pineTemplate is only
 * required for entry / filter / regime blocks. The generated indicator is
 * meant to sit alongside a Pine strategy tester that models the rest; its
 * job is to be a one-click webhook generator for goLong / goShort events.
 *
 * Gene mode:
 *   - "frozen" (default): every block param is emitted as a numeric literal.
 *                         The indicator has no user-tunable inputs for strategy
 *                         logic (other than ticker override + alert toggles).
 *                         This is what we diff against a hand-written reference
 *                         Pine like `pine/jm_3tp_alerts.pine` — same numbers,
 *                         same conditions, bar-for-bar.
 *   - "inputs": not yet implemented; will emit `input.int(...)` for each
 *               tunable param. Pending once we want a generic tuning sandbox.
 *
 * Entry aggregation modes:
 *   - "score": bullScore = sum(long_i), bearScore = sum(short_i);
 *              goLong  = bullScore  >= threshold; goShort = bearScore >= threshold.
 *   - "all":   goLong  = AND(long_i);  goShort = AND(short_i).
 *   - "any":   goLong  = OR(long_i);   goShort = OR(short_i).
 *
 * Filter aggregation (if the spec has filters) follows the same shape and is
 * AND-ed into goLong/goShort. We emit filter pineTemplate() output the same
 * way we do entries.
 *
 * Regime (if present): emit its pineTemplate; the regime label isn't gating
 * entries in the current runtime contract — we just surface it as a plot-label
 * so the human can spot regime shifts. TODO: wire regime into go* gates once
 * the runtime honors regime for entry eligibility.
 */

import { createHash } from 'node:crypto';
import * as registry from './blocks/registry.js';

/**
 * Deterministic JSON stringify with sorted keys. Two genes with the same
 * numeric content always produce the same string, regardless of how the
 * caller assembled them. Shared between the API (`/api/runs/:id/pine-
 * export`) and CLI scripts so both produce byte-identical gene hashes →
 * identical `pine/generated/<spec-name>-<hash12>.pine` filenames for the
 * same (spec, gene) pair.
 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

/**
 * First 12 hex chars of SHA-256(canonicalJson(gene)). Stable, short
 * enough to fit a filename cleanly, collision-resistant for the few
 * thousand winners a single user will ever generate.
 */
export function geneHash(gene) {
  return createHash('sha256').update(canonicalJson(gene)).digest('hex').slice(0, 12);
}

// Scripts map spec name → friendly Pine `indicator()` short-title. Keeping
// short-title ≤ 10 chars is a TV convention.
function defaultShortTitle(specName) {
  // specName = "20260414-001-jm-simple-3tp-legacy" → "GEN-001"
  const m = /^\d{8}-(\d+)-/.exec(specName);
  return m ? `GEN-${m[1]}` : 'GEN';
}

/**
 * Render a frozen-literal Pine param ref for interpolation into pineTemplate.
 * Numbers → themselves; others → throw (frozen mode demands numerics).
 */
function literalRefs(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`pine-codegen: frozen mode requires numeric params; got ${k}=${JSON.stringify(v)}`);
    }
    // Preserve int-ness to match hand-written Pine (20 not 20.0).
    out[k] = Number.isInteger(v) ? String(v) : String(v);
  }
  return out;
}

/**
 * Invoke a block's pineTemplate with literal refs.
 * Normalizes legacy string-only return to `{code}` (long/short undefined) so
 * the orchestrator can fail loudly if a needed signal name is missing.
 */
function renderBlockPine(blockId, version, params) {
  const block = registry.get(blockId, version);
  if (typeof block.pineTemplate !== 'function') {
    throw new Error(`pine-codegen: block "${blockId}" v${version} has no pineTemplate()`);
  }
  const ret = block.pineTemplate(params, literalRefs(params));
  if (typeof ret === 'string') return { code: ret };
  if (!ret || typeof ret !== 'object' || typeof ret.code !== 'string') {
    throw new Error(`pine-codegen: block "${blockId}" v${version} pineTemplate() must return a string or {code,long?,short?,regime?}`);
  }
  return ret;
}

function aggregate(mode, signals, threshold, varPrefix) {
  // signals is an array of var-name strings (each a Pine bool).
  if (signals.length === 0) return { code: `bool ${varPrefix} = false`, name: varPrefix };

  if (mode === 'score') {
    // int bullScore = 0 / bullScore += s ? 1 : 0 / bool goLong = bullScore >= threshold
    const lines = [`int ${varPrefix}_score = 0`];
    for (const s of signals) lines.push(`${varPrefix}_score += ${s} ? 1 : 0`);
    lines.push(`bool ${varPrefix} = ${varPrefix}_score >= ${threshold}`);
    return { code: lines.join('\n'), name: varPrefix };
  }
  if (mode === 'all') {
    return { code: `bool ${varPrefix} = ${signals.join(' and ')}`, name: varPrefix };
  }
  if (mode === 'any') {
    return { code: `bool ${varPrefix} = ${signals.join(' or ')}`, name: varPrefix };
  }
  throw new Error(`pine-codegen: unknown aggregation mode "${mode}"`);
}

/**
 * Given a block-ref description {blockId, version, params, direction}, return
 * the long/short signal var names respecting the block's declared direction.
 * If direction is 'long'-only, the short signal contribution is forced false,
 * and vice versa — same rule the runtime uses for score aggregation.
 */
function directionGatedSignals(blockId, version, pineRet) {
  const block = registry.get(blockId, version);
  const dir = block.direction; // 'long' | 'short' | 'both'
  const long  = pineRet.long
    ? (dir === 'short' ? 'false' : pineRet.long)
    : null;
  const short = pineRet.short
    ? (dir === 'long'  ? 'false' : pineRet.short)
    : null;
  return { long, short };
}

// ──────────────────────────────────────────────────────────────
// Exit state machine — emits the Pine block that tracks a single open
// position, gates new entries while in position, and plots exit arrows
// when any armed exit fills. Dispatched per block.id for the three
// known exit blocks (atrHardStop, atrScaleOutTarget, structuralExit).
// New exit blocks need a case added here.
//
// ── WHY THIS IS HARDCODED (not a generic pineTemplate contract) ──
//
// Entry/filter/regime blocks are simple: each emits a boolean signal,
// the codegen aggregates them. Exit blocks are fundamentally different —
// they declare state variables, indicator series, an execution model
// (intra-bar stop= vs close-based deferral vs limit fill), cross-block
// interactions (breakeven shift after TP1 requires hardStop to know when
// the target block fires), and a strict evaluation order (ESL → TP →
// close-based SL → structural). A flat pineTemplate() returning a code
// string can't express any of this.
//
// Generalizing would require a structured-hook contract like:
//   pineExitTemplate(params, paramRefs) → {
//     stateVars, indicators, onEntry, onTpHit,
//     check: { model: 'close-deferred'|'intra-bar'|'limit', code, tag }
//   }
// with the codegen assembling pieces in the correct order. This is
// viable but premature — the number of fundamentally different exit
// *behaviors* in trading is small (ATR/fixed stop, ATR/R target,
// trailing stop, time/structural). We'd design better hooks after
// implementing 2-3 more concrete blocks than by speculating now.
//
// Decision: keep hardcoded, add blocks lazily. The throw-on-unknown
// below serves as a "you need to add TV support" reminder. When the
// 4th or 5th exit block reveals repeated patterns, extract the
// structured-hook contract based on real cases.
//
// Tracked in: docs/backlog.md → "Deferred features → Generic exit
// block Pine codegen"
// ──────────────────────────────────────────────────────────────

// Safe Pine identifier suffix from a numeric param (dots → 'p').
function idSfx(v) { return String(v).replace(/\./g, 'p').replace(/-/g, 'n'); }

/** Format a 0–1 fraction for a Pine numeric literal: strip trailing zeros. */
function formatFrac(f) {
  return f.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function emitExitStateMachine(push, hydrated) {
  const hs = hydrated.exits.hardStop;
  const tg = hydrated.exits.target;
  const tr = hydrated.exits.trail;

  // ── Pre-flight: confirm we know how to handle each assigned block ──
  const supported = new Set(['atrHardStop', 'atrScaleOutTarget', 'structuralExit']);
  for (const slot of [hs, tg, tr]) {
    if (slot && !supported.has(slot.blockId)) {
      throw new Error(`pine-codegen: exit block "${slot.blockId}" has no indicator template yet. ` +
        `Add a case in emitExitStateMachine() or set that exit slot to null in the spec.`);
    }
  }

  // ── Resolve active TP tranches ONCE (used by multiple steps) ──
  // The tp_fired per-tranche flags let step 2 skip already-hit tranches
  // without closing the position, so later tranches and the structural
  // exit still reference the same pos_entry/pos_entry_bar as the runtime.
  let tranches = [];
  if (tg?.blockId === 'atrScaleOutTarget') {
    const p = tg.params;
    for (let n = 1; n <= 6; n++) {
      const pct  = p[`tp${n}Pct`];
      const mult = p[`tp${n}Mult`];
      if (pct > 0 && mult > 0) tranches.push({ n, mult, pct });
    }
    tranches.sort((a, b) => a.mult - b.mult);
  }
  // Helper to reset tp_fired flags on any new entry (goLong, goShort, reversal)
  const emitTpFlagReset = (indent) => {
    for (const { n } of tranches) push(`${indent}tp${n}_fired := false`);
  };

  push('// ============ EXIT INDICATOR SERIES ============');
  // ATR(s) — hardStop and target may use same or different lengths. Emit
  // one series per unique length so the compile doesn't warn about dupes.
  const atrLens = new Set();
  if (hs?.blockId === 'atrHardStop')          atrLens.add(hs.params.atrLen);
  if (tg?.blockId === 'atrScaleOutTarget')    atrLens.add(tg.params.atrLen);
  for (const len of atrLens) {
    push(`atr_${idSfx(len)} = ta.atr(${len})`);
  }
  // RSI — only needed if structuralExit is in use
  if (tr?.blockId === 'structuralExit') {
    push(`rsi_${idSfx(tr.params.rsiLen)} = ta.rsi(close, ${tr.params.rsiLen})`);
  }

  // Stoch exit series: structuralExit needs stoch k/d. If params exactly
  // match a stochCross entry block we already emitted, reuse those names
  // instead of re-declaring. Otherwise emit under a distinct suffix.
  let stochExitK = null, stochExitD = null;
  if (tr?.blockId === 'structuralExit') {
    const p = tr.params;
    const sfx = `${p.stochLen}_${p.stochSmth}`;
    // Check whether an entry block used identical stoch series — the
    // stochCross block emits names stoch_k_<len>_<smth>, stoch_d_<len>_<smth>.
    const matchesEntryStoch = hydrated.entries.blocks.some(b =>
      b.blockId === 'stochCross' &&
      b.params.stochLen  === p.stochLen &&
      b.params.stochSmth === p.stochSmth);
    if (matchesEntryStoch) {
      stochExitK = `stoch_k_${sfx}`;
      stochExitD = `stoch_d_${sfx}`;
      push(`// reusing stoch_k_${sfx} / stoch_d_${sfx} from entry stochCross`);
    } else {
      stochExitK = `stoch_exit_k_${sfx}`;
      stochExitD = `stoch_exit_d_${sfx}`;
      push(`stoch_exit_raw_${sfx} = ta.stoch(close, high, low, ${p.stochLen})`);
      push(`${stochExitK} = ta.sma(stoch_exit_raw_${sfx}, ${p.stochSmth})`);
      push(`${stochExitD} = ta.sma(${stochExitK}, ${p.stochSmth})`);
    }
  }
  push('');

  // ── Position state vars ──
  push('// ============ POSITION STATE ============');
  push('var int    pos_dir       = 0   // -1 short, 0 flat, +1 long');
  push('var float  pos_entry     = na');
  push('var int    pos_entry_bar = na');
  if (hs?.blockId === 'atrHardStop')       push(`var float  pos_entry_atr_hs = na`);
  if (tg?.blockId === 'atrScaleOutTarget') push(`var float  pos_entry_atr_tp = na`);
  push('var bool   sl_armed      = false');
  // Per-tranche TP hit flags — prevent a tranche firing more than once per
  // position, and let later tranches / structural exit keep running against
  // the original pos_entry/pos_entry_bar instead of flattening the indicator.
  for (const { n } of tranches) {
    push(`var bool   tp${n}_fired    = false`);
  }
  push('');

  // ── Per-bar working flags ──
  push('// bar-scoped exit state (fresh each bar)');
  push('bool   bar_exit        = false');
  push('int    bar_exit_dir    = 0');
  push('string bar_exit_reason = ""');
  push('');

  // ── (0) Deferred SL fill from prior-bar arming ──
  // Only the ATR close-based SL uses the 1-bar arming mechanism (sl_armed).
  // Structural/time/reversal exits fire immediately in step 4 (no arming),
  // matching the runtime where trail returns closeNextBarOpen directly.
  push('// ── (0) Deferred SL armed on the prior bar → fill at THIS bar ──');
  push('if pos_dir != 0 and sl_armed');
  push('    bar_exit := true');
  push('    bar_exit_dir := pos_dir');
  push('    bar_exit_reason := "SL"');
  push('    pos_dir := 0');
  push('    pos_entry := na');
  push('    pos_entry_bar := na');
  if (hs?.blockId === 'atrHardStop')       push('    pos_entry_atr_hs := na');
  if (tg?.blockId === 'atrScaleOutTarget') push('    pos_entry_atr_tp := na');
  push('    sl_armed := false');
  emitTpFlagReset('    ');
  push('');

  // ── (1) ESL (hardStop: emergency %, intra-bar, same-bar including entry) ──
  if (hs?.blockId === 'atrHardStop') {
    const ep = hs.params.emergencySlPct;
    push('// ── (1) ESL — emergency % stop, intra-bar, same bar incl. entry ──');
    push('if pos_dir != 0 and not bar_exit');
    push('    bool is_long_esl = pos_dir > 0');
    push(`    float esl_price = is_long_esl ? pos_entry * (1 - ${ep}/100.0) : pos_entry * (1 + ${ep}/100.0)`);
    push('    bool esl_hit = is_long_esl ? low <= esl_price : high >= esl_price');
    push('    if esl_hit');
    push('        bar_exit := true');
    push('        bar_exit_dir := pos_dir');
    push('        bar_exit_reason := "ESL"');
    push('        pos_dir := 0');
    push('        pos_entry := na');
    push('        pos_entry_bar := na');
    if (tg?.blockId === 'atrScaleOutTarget') push('        pos_entry_atr_tp := na');
    push('        pos_entry_atr_hs := na');
    push('        sl_armed := false');
    emitTpFlagReset('        ');
    push('');
  }

  // ── (2) TP (target: intra-bar, limit, skip entry bar) ──
  // Per-tranche: first hit of each tranche sets tpN_fired := true. The
  // position is NOT closed — later tranches and the structural exit
  // must keep running against the original pos_entry/pos_entry_bar to
  // match the runtime's scale-out behavior. bar_exit is still set so
  // later steps (SL arm, structural) can't fire on the same bar.
  //
  // Multiple tranches CAN fire on the same bar (e.g. a big candle
  // sweeps TP1 and TP2) — we iterate all active tranches and set
  // every fired flag, but bar_exit / bar_exit_reason only reflect the
  // first-fired (nearest) tranche since the runtime processes them in
  // sequence and only one "Tp" reason is tagged per bar exit.
  if (tranches.length > 0) {
    push('// ── (2) TP — per-tranche partial fill tracking (no position close) ──');
    push('//       (matches runtime scale-out: TP1 flag set, pos stays open for TP2/TP3)');
    push('if pos_dir != 0 and not bar_exit and bar_index > pos_entry_bar');
    push('    bool is_long_tp = pos_dir > 0');
    // Emit per-tranche price + hit check (skip already-fired tranches)
    for (const { n, mult } of tranches) {
      push(`    float tp${n}_price = is_long_tp ? pos_entry + pos_entry_atr_tp * ${mult} : pos_entry - pos_entry_atr_tp * ${mult}`);
      push(`    bool  tp${n}_hit   = not tp${n}_fired and (is_long_tp ? high >= tp${n}_price : low <= tp${n}_price)`);
    }
    // any-hit OR in sorted order → sets bar_exit with first-fired reason
    const orExpr = tranches.map(t => `tp${t.n}_hit`).join(' or ');
    push(`    if ${orExpr}`);
    // Mark each hit tranche as fired (all fired flags update on same bar).
    for (const { n } of tranches) {
      push(`        if tp${n}_hit`);
      push(`            tp${n}_fired := true`);
    }
    // Chained ternary: first-fired (nearest) tranche label wins
    //   tp<first>_hit ? "TP1" : tp<second>_hit ? "TP2" : ... : "TP<last>"
    const ternaryChain = tranches
      .map((t, i) => i === tranches.length - 1
        ? `"TP${i + 1}"`
        : `tp${t.n}_hit ? "TP${i + 1}"`)
      .join(' : ');
    push(`        bar_exit := true`);
    push(`        bar_exit_dir := pos_dir`);
    push(`        bar_exit_reason := ${ternaryChain}`);
    // NOTE: pos_dir / pos_entry / pos_entry_bar / pos_entry_atr_* / sl_armed
    // intentionally unchanged — the position continues running for later
    // tranches and the structural exit.
    push('');
  }

  // ── (3) Arm close-based ATR SL (1-bar defer — v1 simplification) ──
  if (hs?.blockId === 'atrHardStop') {
    const sl = hs.params.atrSL;
    push('// ── (3) Arm close-based ATR SL for next-bar fill ──');
    push('//       (v1 simplification: runtime uses 2-bar defer; we use 1-bar)');
    push('if pos_dir != 0 and not bar_exit and not sl_armed');
    push('    bool is_long_sl = pos_dir > 0');
    push(`    float sl_price = is_long_sl ? pos_entry - pos_entry_atr_hs * ${sl} : pos_entry + pos_entry_atr_hs * ${sl}`);
    push('    if (is_long_sl ? close <= sl_price : close >= sl_price)');
    push('        sl_armed := true');
    push('');
  }

  // ── (4) Structural / time / reversal — fires IMMEDIATELY ──
  // The runtime's trail (structuralExit) returns closeNextBarOpen directly —
  // a 1-bar delay (detect → fill at next open). The old indicator used
  // struct_armed (2-bar delay: arm → fire close_all → fill), which was
  // 1 bar too slow. Fix: set bar_exit immediately so strategy.close_all()
  // fires on the detection bar, filling at the next bar's open.
  //
  // Guard: `not sl_armed` removed. In the runtime, when hardStop sets
  // triggered=true (returns null), the trail slot still evaluates. If
  // structural fires on the same bar as SL arms, structural wins (1-bar
  // delay beats the SL's 2-bar delay). Removing the guard matches this.
  //
  // Reversal: the indicator enters the opposite position immediately.
  // Without this, the indicator stays flat after a reversal (bar_exit
  // blocked step 5 from entering), losing track of the position. The
  // strategy handles reversals via strategy.entry (auto-close with
  // pyramiding=0), but the indicator's structural exit uses bar_exit
  // which requires the indicator to know about the position.
  if (tr?.blockId === 'structuralExit') {
    const p = tr.params;
    const rsi = `rsi_${idSfx(p.rsiLen)}`;
    push('// ── (4) Structural / time / reversal exit — fires immediately ──');
    push('if pos_dir != 0 and not bar_exit');
    push('    bool is_long_st = pos_dir > 0');
    push('    int  bars_held = bar_index - pos_entry_bar');
    push(`    bool time_hit = bars_held >= ${p.maxBars} - 1`);
    push(`    bool stoch_exit = is_long_st ? (ta.crossunder(${stochExitK}, ${stochExitD}) and ${stochExitK} > 60) : (ta.crossover(${stochExitK}, ${stochExitD}) and ${stochExitK} < 40)`);
    push(`    bool rsi_exit = is_long_st ? (${rsi} < 40 and ${rsi}[3] > 55) : (${rsi} > 60 and ${rsi}[3] < 45)`);
    push('    bool rev = (is_long_st and rawShort) or (not is_long_st and rawLong)');
    push('    if rev or time_hit or stoch_exit or rsi_exit');
    push('        bar_exit := true');
    push('        bar_exit_dir := pos_dir');
    push('        bar_exit_reason := rev ? "Reversal" : time_hit ? "Time" : "Structural"');
    push('        pos_dir := 0');
    push('        pos_entry := na');
    push('        pos_entry_bar := na');
    if (hs?.blockId === 'atrHardStop')       push('        pos_entry_atr_hs := na');
    if (tg?.blockId === 'atrScaleOutTarget') push('        pos_entry_atr_tp := na');
    push('        sl_armed := false');
    // Reset tp_fired flags — the next position (reversal or later goLong/goShort)
    // starts fresh with no tranches fired.
    emitTpFlagReset('        ');
    push('        if rev');
    push('            pos_dir := -bar_exit_dir');
    push('            pos_entry := close');
    push('            pos_entry_bar := bar_index');
    if (hs?.blockId === 'atrHardStop')       push(`            pos_entry_atr_hs := nz(atr_${idSfx(hs.params.atrLen)})`);
    if (tg?.blockId === 'atrScaleOutTarget') push(`            pos_entry_atr_tp := nz(atr_${idSfx(tg.params.atrLen)})`);
    push('');
  }

  // ── (5) Open a new position on raw entry signal, only when flat ──
  push('// ── (5) Entry gate — open a new position only while flat ──');
  push('bool goLong  = rawLong  and pos_dir == 0 and not bar_exit');
  push('bool goShort = rawShort and pos_dir == 0 and not bar_exit');
  push('if goLong');
  push('    pos_dir := 1');
  push('    pos_entry := close');
  push('    pos_entry_bar := bar_index');
  if (hs?.blockId === 'atrHardStop')       push(`    pos_entry_atr_hs := nz(atr_${idSfx(hs.params.atrLen)})`);
  if (tg?.blockId === 'atrScaleOutTarget') push(`    pos_entry_atr_tp := nz(atr_${idSfx(tg.params.atrLen)})`);
  push('    sl_armed := false');
  emitTpFlagReset('    ');
  push('if goShort');
  push('    pos_dir := -1');
  push('    pos_entry := close');
  push('    pos_entry_bar := bar_index');
  if (hs?.blockId === 'atrHardStop')       push(`    pos_entry_atr_hs := nz(atr_${idSfx(hs.params.atrLen)})`);
  if (tg?.blockId === 'atrScaleOutTarget') push(`    pos_entry_atr_tp := nz(atr_${idSfx(tg.params.atrLen)})`);
  push('    sl_armed := false');
  emitTpFlagReset('    ');
  push('');
}

/**
 * Main entry point.
 *
 * @param {Object} args
 * @param {Object} args.spec       — validated spec (with .hash)
 * @param {Object} args.hydrated   — paramSpace.hydrate(gene)
 * @param {Object} [args.meta]     — optional metadata embedded into header
 *                                   { ticker, timeframe, warmupBars, source }
 * @param {string}  [args.title]      — override the full indicator/strategy title
 * @param {string}  [args.shortTitle]  — override the Pine shorttitle (≤10 chars)
 * @param {string}  [args.mode]        — 'indicator' (default) or 'strategy'
 * @param {Object}  [args.dates]       — { startDate, endDate } for strategy mode
 * @returns {{ source: string, title: string, shortTitle: string }}
 */
export function generateEntryAlertsPine({ spec, hydrated, meta = {}, title: titleOverride, shortTitle, mode, dates } = {}) {
  if (!spec || !hydrated) throw new Error('pine-codegen: spec and hydrated are required');

  const isStrategy = mode === 'strategy';
  const title = titleOverride || `${spec.name} (entries)`;
  const stitle = shortTitle ?? defaultShortTitle(spec.name);

  const lines = [];
  const push = (...xs) => { for (const x of xs) lines.push(x); };

  // ─── Header ────────────────────────────────────────────────
  push(`// ${title}`);
  push(`// Auto-generated by engine/pine-codegen.js — DO NOT hand-edit.`);
  push(`// Spec:      ${spec.name}`);
  if (spec.hash) push(`// SpecHash:  ${spec.hash}`);
  if (meta.ticker)     push(`// Ticker:    ${meta.ticker}`);
  if (meta.timeframe)  push(`// Timeframe: ${meta.timeframe}`);
  if (meta.source)     push(`// Source:    ${meta.source}`);
  push(`// Generated: ${new Date().toISOString()}`);
  push('');
  push('//@version=5');
  if (isStrategy) {
    // Strategy mode: matches GA backtest settings (100k capital, 0.06%
    // commission, slippage=2, fixed qty computed from ATR-risk sizing).
    push(`strategy("${title}", "${stitle}", overlay=true, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=0, commission_type=strategy.commission.percent, commission_value=0.06, slippage=2, pyramiding=0)`);
  } else {
    push(`indicator("${title}", "${stitle}", overlay=true, max_labels_count=500)`);
  }
  push('');

  // ─── Webhook inputs (indicator mode only — strategy is local backtesting) ──
  if (!isStrategy) {
    push('GRP_WH = "Webhook"');
    push('i_tickerOverride = input.string("", "Ticker Override", tooltip="Leave empty to use chart ticker. Set e.g. \'SOLUSDT.P\' for exchange-specific routing.", group=GRP_WH)');
    push('string ticker = i_tickerOverride != "" ? i_tickerOverride : syminfo.ticker');
    push('i_posSize = input.float(0.1, "Position Size (fraction)", minval=0.001, maxval=1.0, step=0.01, tooltip="Wundertrading amountPerTrade: 0.1 = 10%% of sub-account equity.", group=GRP_WH)');
    push('i_leverage = input.int(1, "Leverage", minval=1, maxval=125, step=1, tooltip="Exchange leverage multiplier.", group=GRP_WH)');
    push('i_codeLong = input.string("", "Code: Enter Long", tooltip="Wundertrading Signal Bot token for long entries. Paste from bot settings: Enter Long Comment.", group=GRP_WH)');
    push('i_codeExitLong = input.string("", "Code: Exit Long", tooltip="Wundertrading Signal Bot token for closing longs. Paste from bot settings: Exit Long Comment.", group=GRP_WH)');
    push('i_codeShort = input.string("", "Code: Enter Short", tooltip="Wundertrading Signal Bot token for short entries. Paste from bot settings: Enter Short Comment.", group=GRP_WH)');
    push('i_codeExitShort = input.string("", "Code: Exit Short", tooltip="Wundertrading Signal Bot token for closing shorts. Paste from bot settings: Exit Short Comment.", group=GRP_WH)');
    push('i_codeExitAll = input.string("", "Code: Exit All", tooltip="Wundertrading Signal Bot token for closing all positions. Paste from bot settings: Exit All Comment.", group=GRP_WH)');
    push('');
  }

  // ─── Date range inputs (strategy mode only) ─────────────────
  if (isStrategy) {
    const startTs = dates?.startDate
      ? `timestamp("${dates.startDate}")`
      : 'timestamp("2021-01-01")';
    const endTs = dates?.endDate
      ? `timestamp("${dates.endDate}")`
      : 'timestamp("2099-12-31")';
    push('GRP_BT = "Backtest"');
    push(`i_startDate = input.time(${startTs}, "Start Date", group=GRP_BT)`);
    push(`i_endDate   = input.time(${endTs}, "End Date", group=GRP_BT)`);
    push('bool in_date_range = time >= i_startDate and time <= i_endDate');
    push('');
  }

  // ─── Regime (optional, passive for now) ────────────────────
  let regimeName = null;
  if (hydrated.regime) {
    const r = hydrated.regime;
    const rp = renderBlockPine(r.blockId, r.version, r.params);
    push('// ============ REGIME ============');
    push(rp.code);
    push('');
    regimeName = rp.regime ?? null;
  }

  // ─── Entry blocks ──────────────────────────────────────────
  push('// ============ ENTRIES ============');
  const longEntrySignals  = [];
  const shortEntrySignals = [];
  for (const b of hydrated.entries.blocks) {
    const rp = renderBlockPine(b.blockId, b.version, b.params);
    push(rp.code);
    push('');
    const { long, short } = directionGatedSignals(b.blockId, b.version, rp);
    if (!long && !short) {
      throw new Error(`pine-codegen: entry block "${b.blockId}" pineTemplate() declared neither long nor short`);
    }
    if (long)  longEntrySignals.push(long);
    if (short) shortEntrySignals.push(short);
  }

  // ─── Filter blocks (optional) ──────────────────────────────
  const longFilterSignals  = [];
  const shortFilterSignals = [];
  if (hydrated.filters && hydrated.filters.blocks.length > 0) {
    push('// ============ FILTERS ============');
    for (const b of hydrated.filters.blocks) {
      const rp = renderBlockPine(b.blockId, b.version, b.params);
      push(rp.code);
      push('');
      const { long, short } = directionGatedSignals(b.blockId, b.version, rp);
      if (long)  longFilterSignals.push(long);
      if (short) shortFilterSignals.push(short);
    }
  }

  // ─── Aggregation ───────────────────────────────────────────
  push('// ============ AGGREGATION ============');
  const entriesThreshold = hydrated.entries.threshold ?? 1;
  const bull = aggregate(hydrated.entries.mode, longEntrySignals,  entriesThreshold, 'bull');
  const bear = aggregate(hydrated.entries.mode, shortEntrySignals, entriesThreshold, 'bear');
  push(bull.code);
  push(bear.code);

  let goLongExpr  = 'bull';
  let goShortExpr = 'bear';
  if (hydrated.filters && hydrated.filters.blocks.length > 0) {
    const fMode = hydrated.filters.mode;
    const fThresh = hydrated.filters.threshold ?? 1;
    const fL = aggregate(fMode, longFilterSignals,  fThresh, 'filter_long');
    const fS = aggregate(fMode, shortFilterSignals, fThresh, 'filter_short');
    push(fL.code);
    push(fS.code);
    goLongExpr  = `bull and filter_long`;
    goShortExpr = `bear and filter_short`;
  }
  push(`bool rawLong  = ${goLongExpr}`);
  push(`bool rawShort = ${goShortExpr}`);
  push('');

  // ─── Exit state machine (position tracker) ────────────────
  // Emit a Pine-side position tracker so entry arrows fire only on NEW
  // trades (pos_dir == 0 → entry) and we plot exit arrows on close.
  //
  // Generic over hydrated.exits slots (hardStop, target, trail — each may
  // be null). Per-block logic is dispatched by block.id.
  //
  // Known v1 simplifications vs the backtest runtime (documented so that
  // small arrow-placement differences don't surprise anyone):
  //   • Close-based ATR SL uses 1-bar defer (runtime is 2-bar). Causes
  //     some SL exits to land 1 bar earlier than the runtime's trade-log.
  //   • First TP hit closes the WHOLE position (runtime scales out per
  //     tranche + shifts SL to breakeven). So the indicator shows a
  //     single exit at the first TP, whereas the runtime may exit the
  //     remainder later at BE+ SL.
  //   • No per-tranche partial-exit arrows.
  //   • Entry / exit *fill* is NOT simulated at next-bar open — arrows
  //     sit on the signal bar (entry) or the armed-fill bar (exit),
  //     matching TV's alertcondition semantics rather than runtime fills.
  const hasExits = !!(hydrated.exits && (
    hydrated.exits.hardStop || hydrated.exits.target || hydrated.exits.trail));

  if (hasExits) {
    emitExitStateMachine(push, hydrated);
  } else {
    // No exits configured: preserve the old "signal-only" indicator shape.
    push('bool goLong  = rawLong');
    push('bool goShort = rawShort');
    push('bool bar_exit = false');
    push('int  bar_exit_dir = 0');
    push('string bar_exit_reason = ""');
    push('');
  }

  // ─── Visualization + alerts ────────────────────────────────
  push('// ============ VIZ + ALERTS ============');
  push('plotshape(goLong,  "Long Entry",  shape.triangleup,   location.belowbar, color.lime,   size=size.small)');
  push('plotshape(goShort, "Short Entry", shape.triangledown, location.abovebar, color.red,    size=size.small)');
  push('plotshape(bar_exit and bar_exit_dir > 0, "Long Exit",  shape.xcross,   location.abovebar, color.yellow, size=size.small)');
  push('plotshape(bar_exit and bar_exit_dir < 0, "Short Exit", shape.xcross,   location.belowbar, color.aqua,   size=size.small)');
  push('');
  push('// Text labels next to each marker — entries show direction, exits show reason.');
  push('// Boxed stickers with a tail that points toward the bar:');
  push('//   • yloc.belowbar → style_label_up   (tail points up toward the candle)');
  push('//   • yloc.abovebar → style_label_down (tail points down toward the candle)');
  push('if goLong');
  push('    label.new(bar_index, low,  "LONG",  xloc=xloc.bar_index, yloc=yloc.belowbar, style=label.style_label_up,   color=color.lime,   textcolor=color.black, size=size.small)');
  push('if goShort');
  push('    label.new(bar_index, high, "SHORT", xloc=xloc.bar_index, yloc=yloc.abovebar, style=label.style_label_down, color=color.red,    textcolor=color.white, size=size.small)');
  push('if bar_exit and bar_exit_dir > 0');
  push('    label.new(bar_index, high, bar_exit_reason, xloc=xloc.bar_index, yloc=yloc.abovebar, style=label.style_label_down, color=color.yellow, textcolor=color.black, size=size.small)');
  push('if bar_exit and bar_exit_dir < 0');
  push('    label.new(bar_index, low,  bar_exit_reason, xloc=xloc.bar_index, yloc=yloc.belowbar, style=label.style_label_up,   color=color.aqua,   textcolor=color.black, size=size.small)');
  push('');
  // ── Exit block analysis (shared between alert + strategy sections) ──
  const wt_hs = hydrated.exits?.hardStop;
  const wt_tg = hydrated.exits?.target;
  const wt_tr = hydrated.exits?.trail;
  const wt_hasTp = wt_tg?.blockId === 'atrScaleOutTarget';
  const wt_hasSl = wt_hs?.blockId === 'atrHardStop';
  const wt_hasStructural = wt_tr?.blockId === 'structuralExit';
  const wt_hasBe = wt_hasTp && wt_hasSl;

  // Resolve structural exit indicator variable names (stoch K/D + RSI).
  // These are emitted by emitExitStateMachine() earlier in the Pine source,
  // so the strategy section can reference them for its own independent
  // structural detection. Logic mirrors that function's naming decisions.
  let wt_stochK = null, wt_stochD = null, wt_rsi = null;
  if (wt_hasStructural) {
    const p = wt_tr.params;
    const sfx = `${p.stochLen}_${p.stochSmth}`;
    const matchesEntryStoch = hydrated.entries.blocks.some(b =>
      b.blockId === 'stochCross' &&
      b.params.stochLen === p.stochLen &&
      b.params.stochSmth === p.stochSmth);
    wt_stochK = matchesEntryStoch ? `stoch_k_${sfx}` : `stoch_exit_k_${sfx}`;
    wt_stochD = matchesEntryStoch ? `stoch_d_${sfx}` : `stoch_exit_d_${sfx}`;
    wt_rsi = `rsi_${idSfx(p.rsiLen)}`;
  }

  // Active tranches sorted by mult ascending (nearest TP fires first).
  const wt_tranches = [];
  if (wt_hasTp) {
    for (let n = 1; n <= 6; n++) {
      const pct  = wt_tg.params[`tp${n}Pct`];
      const mult = wt_tg.params[`tp${n}Mult`];
      if (pct > 0 && mult > 0) wt_tranches.push({ n, mult, pct });
    }
    wt_tranches.sort((a, b) => a.mult - b.mult);
  }

  // ── Wundertrading alert payloads (indicator mode only) ──────────
  // Strategy mode is for local backtesting — no alerts, no webhook JSON.
  if (!isStrategy) {
    // Pre-compute ATR values on every bar as global floats. Avoids the
    // Pine v5 gotcha where historical references ([1]) inside a function
    // that's only called conditionally may give stale values.
    push('// ============ WUNDERTRADING ALERT PAYLOADS ============');
    if (wt_hasTp) {
      push(`float wt_atr_tp = nz(atr_${idSfx(wt_tg.params.atrLen)})`);
    }
    if (wt_hasSl && (!wt_hasTp || wt_hs.params.atrLen !== wt_tg.params.atrLen)) {
      push(`float wt_atr_sl = nz(atr_${idSfx(wt_hs.params.atrLen)})`);
    }
    push('');

    // f_ts() preserved for dual-webhook / logging use.
    push('f_ts() =>');
    push(`    str.tostring(year) + '-' + str.tostring(month, "00") + '-' + str.tostring(dayofmonth, "00") + 'T' + str.tostring(hour, "00") + ':' + str.tostring(minute, "00") + 'Z'`);
    push('');

    // f_entry_json — Wundertrading Signal Bot entry payload.
    push('f_entry_json(string dir) =>');
    push('    bool is_l = dir == "long"');

    for (const { n, mult } of wt_tranches) {
      push(`    float tp${n} = is_l ? close + wt_atr_tp * ${mult} : close - wt_atr_tp * ${mult}`);
    }
    if (wt_hasSl) {
      const atrVar = (wt_hasTp && wt_hs.params.atrLen === wt_tg.params.atrLen) ? 'wt_atr_tp' : 'wt_atr_sl';
      push(`    float sl = is_l ? close - ${atrVar} * ${wt_hs.params.atrSL} : close + ${atrVar} * ${wt_hs.params.atrSL}`);
    }

    push(`    string s_code = '{"code":"' + (is_l ? i_codeLong : i_codeShort) + '"'`);
    push(`    string s_order = ',"orderType":"market","amountPerTradeType":"percents","amountPerTrade":' + str.tostring(i_posSize) + ',"leverage":' + str.tostring(i_leverage)`);

    if (wt_tranches.length > 0) {
      let tpLine = `    string s_tp = ',"takeProfits":['`;
      for (let i = 0; i < wt_tranches.length; i++) {
        const { n, pct } = wt_tranches[i];
        if (i > 0) tpLine += ` + ','`;
        tpLine += ` + '{"price":' + str.tostring(tp${n}, "#.####") + ',"portfolio":${formatFrac(pct / 100)}}'`;
      }
      tpLine += ` + ']'`;
      push(tpLine);
    }

    if (wt_hasSl) {
      push(`    string s_sl = ',"stopLoss":{"price":' + str.tostring(sl, "#.####") + '}'`);
    }

    if (wt_hasBe && wt_tranches.length > 0) {
      const tp1Var = `tp${wt_tranches[0].n}`;
      push(`    string s_be = ',"moveToBreakeven":{"activationPrice":' + str.tostring(${tp1Var}, "#.####") + ',"executePrice":' + str.tostring(close, "#.####") + '}'`);
    }

    const parts = ['s_code', 's_order'];
    if (wt_tranches.length > 0)             parts.push('s_tp');
    if (wt_hasSl)                           parts.push('s_sl');
    if (wt_hasBe && wt_tranches.length > 0) parts.push('s_be');
    push(`    ${parts.join(' + ')} + ',"placeConditionalOrdersOnExchange":true,"reduceOnly":true}'`);
    push('');

    // f_exit_json — direction-aware close payload.
    push('f_exit_json(string dir, string reason) =>');
    push('    bool is_l = dir == "long"');
    push(`    '{"code":"' + (is_l ? i_codeExitLong : i_codeExitShort) + '","orderType":"market","reduceOnly":true}'`);
    push('');

    push('if goLong');
    push('    alert(f_entry_json("long"),  alert.freq_once_per_bar_close)');
    push('if goShort');
    push('    alert(f_entry_json("short"), alert.freq_once_per_bar_close)');
    push('if bar_exit and (bar_exit_reason == "Structural" or bar_exit_reason == "Time")');
    push('    alert(f_exit_json(bar_exit_dir > 0 ? "long" : "short", bar_exit_reason), alert.freq_once_per_bar_close)');
    push('');
    push('alertcondition(goLong,   "Long Entry",   "Long entry opens new position")');
    push('alertcondition(goShort,  "Short Entry",  "Short entry opens new position")');
    push('alertcondition(bar_exit, "Position Exit","Position closed (any reason)")');
    push('');
  }

  if (regimeName) {
    // Passive surfacing: plot regime label in the upper-left info box.
    push('var table regimeTbl = table.new(position.top_left, 1, 1, bgcolor=color.new(color.black, 40), border_width=0)');
    push('if barstate.islast');
    push(`    table.cell(regimeTbl, 0, 0, "regime: " + str.tostring(${regimeName}), text_color=color.white, text_size=size.small)`);
  }

  // ─── Strategy execution (strategy mode only) ───────────────────
  if (isStrategy) {
    // strategy.entry/exit/close calls for TradingView's strategy tester.
    // These run in parallel with the exit state machine (which drives
    // visualization + Wundertrading alerts).
    //
    // SL parity model (matches runtime atr-hard-stop.js and main-branch
    // jm_simple_3tp.pine):
    //   - ATR SL: close-based check → slTriggered flag → strategy.close()
    //     on the NEXT bar (1-bar deferral). NOT a stop= order.
    //   - Emergency SL: fixed % from entry, on stop= parameter so TV fills
    //     it intra-bar on wick touches. Circuit-breaker for flash crashes.
    //   - Breakeven: after TP1 fills, ATR SL tightens to entry × 1.003/0.997.
    push('');
    push('// ============ STRATEGY EXECUTION ============');

    // ── State vars ──
    // Track entry prices independently of the exit state machine, which
    // resets pos_entry/pos_entry_atr on first TP hit. The strategy needs
    // these prices to stay valid for the remaining partial position.
    push('var float strat_entry  = na');
    if (wt_hasTp) push('var float strat_atr_tp = na');
    if (wt_hasSl) push('var float strat_atr_hs = na');
    // Bar index of the strategy's fill — used by the independent structural /
    // time detection further down. Tracking it here (rather than reading the
    // indicator's pos_entry_bar) decouples the strategy from the indicator
    // state machine, which can go stale when the indicator's internal SL
    // fires earlier than the strategy's (indicator uses close[signal] as its
    // entry reference, strategy uses the actual fill price — see section 20
    // of the reference doc).
    if (wt_hasStructural) push('var int   strat_entry_bar = na');
    // Close-based SL: flag arms when close pierces ATR SL → executes
    // via strategy.close() on the NEXT bar (1-bar deferral, matching the
    // runtime's closeNextBarOpen and the main-branch jm_simple_3tp.pine).
    // Emergency SL (fixed %) stays on the strategy.exit(stop=) for
    // intra-bar protection. This is the key parity fix: the old codegen
    // put ATR SL on stop= which TV fills intra-bar on wick touches, but
    // the runtime only checks close vs SL.
    if (wt_hasSl) {
      push('var bool  slTriggered  = false');
      // Bar index when TP1 filled (-1 = not hit yet). Using bar_index with a
      // STRICT `>` comparison in the SL check gives a 1-bar delay between TP1
      // fill and the breakeven-SL transition — matches runtime's
      // `i > tp1HitBar` in atr-hard-stop.js. Without this delay, the SL
      // check on the TP1 fill bar itself uses the tight breakeven SL,
      // causing it to trigger ~1 bar earlier than the runtime.
      push('var int   strat_tp1HitBar = -1');
    }

    // Signal detection — fires on the SIGNAL bar (bar N).
    //
    // IMPORTANT: Use rawLong/rawShort here, NOT goLong/goShort. The indicator
    // state machine gates goLong with `pos_dir == 0 and not bar_exit`, which
    // suppresses the entry signal on bars where the deferred SL fires
    // (bar_exit = true from step 0). The strategy needs to see the raw entry
    // signal so it can detect reversals even when the indicator thinks the
    // position is already being closed by SL. strategy.position_size provides
    // the correct gating for the strategy execution path.
    //
    // `position_size <= 0` captures flat OR short (new long = fresh entry or
    // reversal-to-long). `position_size >= 0` captures flat OR long.
    push('bool strat_new_long  = rawLong  and strategy.position_size <= 0');
    push('bool strat_new_short = rawShort and strategy.position_size >= 0');
    push('');

    // Fill-bar capture — fires on the FILL bar (bar N+1, one bar after signal).
    //
    // THIS IS A PARITY FIX (Trade #32 SL timing): the runtime's
    // `position.entryPrice = fillPrice` uses the bar-open ± slippage.
    // Pine's `strategy.position_avg_price` also reflects the real fill
    // price (open ± strategy slippage), so using it matches runtime.
    //
    // The OLD code captured `strat_entry := close` on the SIGNAL bar — that
    // value differs from the real fill by one bar's open-close gap plus
    // slippage, and when an up/down gap between signal close and fill open
    // shifts the SL price, the close-based cross-detection fires on a
    // different bar than the runtime's. Symptom: SL exit 4 hours early/late
    // in TV vs runtime.
    //
    // Detection: `position_size` sign transitions from "non-long" to long
    // (or "non-short" to short) — fires on the fill bar only. Matches the
    // runtime's `openPosition(fill, i)` at bar N+1 open.
    //
    // ATR capture on the fill bar uses `atr_N[1]` = atr on the PRIOR bar =
    // atr[signalBar]. Matches the runtime which reads
    // `atr[fillBar - 1] = atr[signalBar]`. (The legacy hand-written Pine
    // used the same [1] offset because it also captured on the fill bar.)
    //
    // slTriggered/strat_tp1Hit reset on fill bar (NOT signal bar): an old
    // position's SL armed from a prior bar should still fire on the signal
    // bar (the reset used to cancel it on reversal signals). After the
    // reversal fills on bar N+1, the NEW position needs a clean slate.
    push('bool strat_fill_long  = strategy.position_size > 0 and strategy.position_size[1] <= 0');
    push('bool strat_fill_short = strategy.position_size < 0 and strategy.position_size[1] >= 0');
    push('if strat_fill_long or strat_fill_short');
    push('    strat_entry := strategy.position_avg_price');
    if (wt_hasTp) push(`    strat_atr_tp := nz(atr_${idSfx(wt_tg.params.atrLen)}[1])`);
    if (wt_hasSl) push(`    strat_atr_hs := nz(atr_${idSfx(wt_hs.params.atrLen)}[1])`);
    if (wt_hasStructural) push('    strat_entry_bar := bar_index');
    if (wt_hasSl) {
      push('    slTriggered     := false');
      push('    strat_tp1HitBar := -1');
    }
    push('');

    // Position sizing: Van Tharp ATR-risk formula (matches GA engine).
    // qty = (equity × riskPct / 100) / (ATR × atrSL)
    //
    // Sizing runs on the SIGNAL bar (before strategy.entry), so strat_atr_hs
    // isn't captured yet. Use `atr_N` directly (= atr[signalBar]), which
    // matches the runtime's `planStop` which reads `atr[i-1]` at
    // fillBar → atr[signalBar]. Same value, just read at different points.
    //
    // Capped by leverage (default 1×) to match the runtime's
    //   maxUnits = (equity * leverage) / fillPrice
    // — without this cap, TV opens positions larger than equity.
    const riskPct = hydrated.sizing?.params?.riskPct;
    if (riskPct != null && wt_hasSl) {
      push(`float strat_risk = strategy.equity * ${riskPct} / 100`);
      push(`float strat_stop = nz(atr_${idSfx(wt_hs.params.atrLen)}) * ${wt_hs.params.atrSL}`);
      push('float strat_qty_raw = strat_stop > 0 ? strat_risk / strat_stop : 0');
      push('float strat_max_qty = close > 0 ? strategy.equity / close : 0');
      push('float strat_qty = math.min(strat_qty_raw, strat_max_qty)');
    }
    const qtyArg = (riskPct != null && wt_hasSl) ? ', qty=strat_qty' : '';

    // Gate entries on actual position change — matching the signal gate above.
    // Calling strategy.entry for the same direction with pyramiding=0 is a
    // no-op in TV, but gating avoids confusing the trade list and keeps the
    // entry qty consistent with the freshly-computed strat_qty.
    push('if strat_new_long and in_date_range');
    push(`    strategy.entry("Long", strategy.long${qtyArg})`);
    push('if strat_new_short and in_date_range');
    push(`    strategy.entry("Short", strategy.short${qtyArg})`);
    push('');

    // ── Execute pending close-based SL (deferred from previous bar) ──
    // Must run BEFORE strategy.exit() calls so the close takes effect at
    // this bar's open, matching Pine's execution model where
    // strategy.close() on bar N fills at bar N's open.
    if (wt_hasSl) {
      push('if slTriggered and strategy.position_size != 0');
      push('    strategy.close_all(comment="SL")');
      push('    slTriggered := false');
      push('');
    }

    // ── Detect TP1 hit for breakeven SL shift (1-bar-delayed) ──
    // Stamp strat_tp1HitBar with bar_index when position size decreases
    // (long) or increases (short). The effective strat_tp1Hit boolean
    // uses a STRICT `bar_index > strat_tp1HitBar`, so on the TP1 fill
    // bar itself (bar_index == strat_tp1HitBar) the SL still uses the
    // ORIGINAL wide ATR SL. The transition to breakeven SL happens on
    // the NEXT bar.
    //
    // Matches runtime atr-hard-stop.js line 134:
    //   const tp1Hit = Number.isInteger(tp1HitBar) && i > tp1HitBar;
    //
    // The `strat_tp1HitBar < 0` gate prevents re-stamping on subsequent
    // partial TP fills (TP2, TP3 also decrease position_size for long).
    if (wt_hasSl && wt_hasTp) {
      push('if strat_tp1HitBar < 0 and strategy.position_size > 0 and strategy.position_size < strategy.position_size[1]');
      push('    strat_tp1HitBar := bar_index');
      push('if strat_tp1HitBar < 0 and strategy.position_size < 0 and strategy.position_size > strategy.position_size[1]');
      push('    strat_tp1HitBar := bar_index');
      // Effective flag: strict `>` for 1-bar delay (matches runtime).
      push('bool strat_tp1Hit = strat_tp1HitBar >= 0 and bar_index > strat_tp1HitBar');
      push('');
    }

    // TP exits — each tranche gets its own strategy.exit with normalized
    // qty_percent. TradingView's strategy.exit LOCKS the exit order
    // quantity at first placement time and does NOT recalculate when
    // the order is updated on subsequent bars. When multiple exits
    // fire, ALL use the ORIGINAL full position size for their
    // qty_percent calculation — NOT the remaining position after
    // prior fills. So we pass normalized percentages directly.
    //
    // The runtime (atr-scale-out-target.js) NORMALIZES the raw tp pcts to
    // sum to 100% (e.g., 10+50+10=70 → 14.29/71.43/14.29). The Pine
    // must match: normalize, then pass directly as qty_percent (no
    // cascading adjustment needed).
    //
    // The stop= parameter is ONLY the emergency SL (fixed % from entry),
    // NOT the ATR SL. The ATR SL uses close-based detection + deferred
    // strategy.close() (see below). This matches the runtime where ATR SL
    // checks close and defers, while ESL fires intra-bar on wick touches.
    if (wt_tranches.length > 0 || wt_hasSl) {
      // Normalize percentages to sum to 100% (matches runtime behavior).
      const pctSum = wt_tranches.reduce((s, t) => s + t.pct, 0);
      const normTranches = wt_tranches.map(t => ({
        ...t,
        normPct: pctSum > 0 ? (t.pct / pctSum) * 100 : 0,
      }));

      // Use normalized pcts directly as TV qty_percent — TV applies
      // qty_percent to the ORIGINAL position size (locked at first
      // order placement), not the remaining after prior fills.
      const adjTranches = normTranches.map(t => ({
        ...t,
        adjPct: Math.round(t.normPct * 100) / 100,
      }));

      // Emergency SL only — intra-bar protection via stop=. The ATR-based
      // SL is handled by the close-based check further below.
      const eslPct = wt_hasSl ? wt_hs.params.emergencySlPct : 0;
      const eslLongExpr  = wt_hasSl ? `, stop=strat_entry * ${formatFrac(1 - eslPct / 100)}` : '';
      const eslShortExpr = wt_hasSl ? `, stop=strat_entry * ${formatFrac(1 + eslPct / 100)}` : '';

      // Long exits
      push('if strategy.position_size > 0');
      if (adjTranches.length > 0) {
        for (const { n, mult, adjPct } of adjTranches) {
          push(`    strategy.exit("TP${n}", "Long", qty_percent=${adjPct}, limit=strat_entry + strat_atr_tp * ${mult}${eslLongExpr})`);
        }
      } else if (wt_hasSl) {
        push(`    strategy.exit("ESL", "Long", stop=strat_entry * ${formatFrac(1 - eslPct / 100)})`);
      }

      // Short exits
      push('if strategy.position_size < 0');
      if (adjTranches.length > 0) {
        for (const { n, mult, adjPct } of adjTranches) {
          push(`    strategy.exit("TP${n}", "Short", qty_percent=${adjPct}, limit=strat_entry - strat_atr_tp * ${mult}${eslShortExpr})`);
        }
      } else if (wt_hasSl) {
        push(`    strategy.exit("ESL", "Short", stop=strat_entry * ${formatFrac(1 + eslPct / 100)})`);
      }
      push('');
    }

    // ── Close-based ATR SL with breakeven shift ──
    // Checks close vs SL price. When triggered, sets slTriggered flag;
    // strategy.close_all() fires at the NEXT bar's open (see above).
    // After TP1 hits, SL tightens to breakeven-plus (entry × 1.003/0.997),
    // matching atr-hard-stop.js BE_PLUS_LONG / BE_PLUS_SHORT.
    if (wt_hasSl) {
      const atrSL = wt_hs.params.atrSL;
      push('if strategy.position_size > 0 and not slTriggered');
      if (wt_hasTp) {
        push(`    float sl_long = strat_tp1Hit ? strat_entry * 1.003 : strat_entry - strat_atr_hs * ${atrSL}`);
      } else {
        push(`    float sl_long = strat_entry - strat_atr_hs * ${atrSL}`);
      }
      push('    if close <= sl_long');
      push('        slTriggered := true');

      push('if strategy.position_size < 0 and not slTriggered');
      if (wt_hasTp) {
        push(`    float sl_short = strat_tp1Hit ? strat_entry * 0.997 : strat_entry + strat_atr_hs * ${atrSL}`);
      } else {
        push(`    float sl_short = strat_entry + strat_atr_hs * ${atrSL}`);
      }
      push('    if close >= sl_short');
      push('        slTriggered := true');
      push('');
    }

    // Safety reset: if position went flat while slTriggered was pending
    if (wt_hasSl) {
      push('if strategy.position_size == 0');
      push('    slTriggered := false');
      push('');
    }

    // ── Structural / Time exits — INDEPENDENT of the indicator state ──
    //
    // PARITY FIX (Trades 34–36 structural vs Pine SL late-fire): the old
    // codegen read `bar_exit and bar_exit_reason == "Structural"|"Time"`
    // from the indicator's step 4. That's fragile because the indicator's
    // `pos_dir` can go to 0 EARLY — the indicator's internal SL (step 3
    // arm + step 0 deferred fill) uses `close[signalBar]` as its entry
    // reference, while the strategy uses the actual fill price. On a gap
    // between signal close and fill open, the indicator's SL can cross
    // BEFORE the strategy's (real) SL crosses. That sets
    // `pos_dir := 0` in step 0, which gates step 4 off for the rest of
    // the position's life — so structural / time exits never fire for
    // the strategy, and the position is held until the strategy's own
    // SL eventually crosses. Result: "SL" exit in TV where runtime
    // shows "Structural" (5-bar gap in the original bug report).
    //
    // Fix: compute structural / time detection IN the strategy, using
    // `strategy.position_size` as the in-position gate and
    // `strat_entry_bar` (captured on fill bar) for bars-held. This is
    // independent of the indicator's state machine, so the indicator's
    // internal SL firing early doesn't affect the strategy.
    //
    // Reversals are still NOT handled here: with pyramiding=0, a
    // `strategy.entry` in the opposite direction auto-closes the current
    // position. The strat_new_long/short gate above takes care of it.
    if (wt_hasStructural) {
      const p = wt_tr.params;
      push('if strategy.position_size != 0 and not na(strat_entry_bar)');
      push('    bool strat_is_long_st = strategy.position_size > 0');
      push('    int  strat_bars_held  = bar_index - strat_entry_bar');
      push(`    bool strat_time_hit   = strat_bars_held >= ${p.maxBars} - 1`);
      push(`    bool strat_stoch_exit = strat_is_long_st ? (ta.crossunder(${wt_stochK}, ${wt_stochD}) and ${wt_stochK} > 60) : (ta.crossover(${wt_stochK}, ${wt_stochD}) and ${wt_stochK} < 40)`);
      push(`    bool strat_rsi_exit   = strat_is_long_st ? (${wt_rsi} < 40 and ${wt_rsi}[3] > 55) : (${wt_rsi} > 60 and ${wt_rsi}[3] < 45)`);
      push('    if strat_time_hit or strat_stoch_exit or strat_rsi_exit');
      push('        strategy.close_all(comment=strat_time_hit ? "Time" : "Structural")');
      push('');
    } else {
      // No trail block configured → no structural/time exit. Nothing to emit.
    }
  }

  return {
    source: lines.join('\n') + '\n',
    title,
    shortTitle: stitle,
  };
}
