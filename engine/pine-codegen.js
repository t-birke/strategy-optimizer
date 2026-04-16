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
  push('var bool   struct_armed  = false');
  push('var string struct_reason = ""');
  push('');

  // ── Per-bar working flags ──
  push('// bar-scoped exit state (fresh each bar)');
  push('bool   bar_exit        = false');
  push('int    bar_exit_dir    = 0');
  push('string bar_exit_reason = ""');
  push('');

  // ── (0) Deferred fills from prior-bar arming ──
  push('// ── (0) Deferred exits armed on the prior bar fill at THIS bar ──');
  push('if pos_dir != 0 and (sl_armed or struct_armed)');
  push('    bar_exit := true');
  push('    bar_exit_dir := pos_dir');
  push('    bar_exit_reason := sl_armed ? "SL" : struct_reason');
  push('    pos_dir := 0');
  push('    pos_entry := na');
  push('    pos_entry_bar := na');
  if (hs?.blockId === 'atrHardStop')       push('    pos_entry_atr_hs := na');
  if (tg?.blockId === 'atrScaleOutTarget') push('    pos_entry_atr_tp := na');
  push('    sl_armed := false');
  push('    struct_armed := false');
  push('    struct_reason := ""');
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
    push('        struct_armed := false');
    push('');
  }

  // ── (2) TP (target: intra-bar, limit, skip entry bar) ──
  if (tg?.blockId === 'atrScaleOutTarget') {
    const p = tg.params;
    // Collect active tranches (pct>0) sorted by mult ascending → first-to-fire order
    const tranches = [];
    for (let n = 1; n <= 6; n++) {
      const pct  = p[`tp${n}Pct`];
      const mult = p[`tp${n}Mult`];
      if (pct > 0 && mult > 0) tranches.push({ n, mult, pct });
    }
    tranches.sort((a, b) => a.mult - b.mult);
    if (tranches.length > 0) {
      push('// ── (2) TP — any active tranche hit closes the whole position ──');
      push('//       (v1 simplification: runtime scales out per tranche, indicator does not)');
      push('if pos_dir != 0 and not bar_exit and bar_index > pos_entry_bar');
      push('    bool is_long_tp = pos_dir > 0');
      // Emit per-tranche price + hit check
      for (const { n, mult } of tranches) {
        push(`    float tp${n}_price = is_long_tp ? pos_entry + pos_entry_atr_tp * ${mult} : pos_entry - pos_entry_atr_tp * ${mult}`);
        push(`    bool  tp${n}_hit   = is_long_tp ? high >= tp${n}_price : low <= tp${n}_price`);
      }
      // any-hit OR in sorted order → reason tag uses first-fire positional label (TP1, TP2, ...)
      const orExpr = tranches.map(t => `tp${t.n}_hit`).join(' or ');
      push(`    if ${orExpr}`);
      // Build a chained ternary: first tranche (nearest) = "TP1", etc.
      //   tp<first>_hit ? "TP1" : tp<second>_hit ? "TP2" : ... : "TP<last>"
      const ternaryChain = tranches
        .map((t, i) => i === tranches.length - 1
          ? `"TP${i + 1}"`
          : `tp${t.n}_hit ? "TP${i + 1}"`)
        .join(' : ');
      push(`        bar_exit := true`);
      push(`        bar_exit_dir := pos_dir`);
      push(`        bar_exit_reason := ${ternaryChain}`);
      push(`        pos_dir := 0`);
      push(`        pos_entry := na`);
      push(`        pos_entry_bar := na`);
      push(`        pos_entry_atr_tp := na`);
      if (hs?.blockId === 'atrHardStop') push('        pos_entry_atr_hs := na');
      push(`        sl_armed := false`);
      push(`        struct_armed := false`);
      push('');
    }
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

  // ── (4) Arm structural / time / reversal ──
  if (tr?.blockId === 'structuralExit') {
    const p = tr.params;
    const rsi = `rsi_${idSfx(p.rsiLen)}`;
    push('// ── (4) Arm structural exit — time / stoch / RSI / reversal ──');
    push('if pos_dir != 0 and not bar_exit and not sl_armed and not struct_armed');
    push('    bool is_long_st = pos_dir > 0');
    push('    int  bars_held = bar_index - pos_entry_bar');
    push(`    bool time_hit = bars_held >= ${p.maxBars} - 1`);
    push(`    bool stoch_exit = is_long_st ? (ta.crossunder(${stochExitK}, ${stochExitD}) and ${stochExitK} > 60) : (ta.crossover(${stochExitK}, ${stochExitD}) and ${stochExitK} < 40)`);
    push(`    bool rsi_exit = is_long_st ? (${rsi} < 40 and ${rsi}[3] > 55) : (${rsi} > 60 and ${rsi}[3] < 45)`);
    push('    bool rev = (is_long_st and rawShort) or (not is_long_st and rawLong)');
    push('    if rev');
    push('        struct_armed := true');
    push('        struct_reason := "Reversal"');
    push('    else if time_hit');
    push('        struct_armed := true');
    push('        struct_reason := "Time"');
    push('    else if stoch_exit or rsi_exit');
    push('        struct_armed := true');
    push('        struct_reason := "Structural"');
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
  if (hs?.blockId === 'atrHardStop')       push(`    pos_entry_atr_hs := nz(atr_${idSfx(hs.params.atrLen)}[1])`);
  if (tg?.blockId === 'atrScaleOutTarget') push(`    pos_entry_atr_tp := nz(atr_${idSfx(tg.params.atrLen)}[1])`);
  push('    sl_armed := false');
  push('    struct_armed := false');
  push('    struct_reason := ""');
  push('if goShort');
  push('    pos_dir := -1');
  push('    pos_entry := close');
  push('    pos_entry_bar := bar_index');
  if (hs?.blockId === 'atrHardStop')       push(`    pos_entry_atr_hs := nz(atr_${idSfx(hs.params.atrLen)}[1])`);
  if (tg?.blockId === 'atrScaleOutTarget') push(`    pos_entry_atr_tp := nz(atr_${idSfx(tg.params.atrLen)}[1])`);
  push('    sl_armed := false');
  push('    struct_armed := false');
  push('    struct_reason := ""');
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
 * @param {string} [args.title]      — override the full indicator title
 * @param {string} [args.shortTitle]  — override the Pine shorttitle (≤10 chars)
 * @returns {{ source: string, title: string, shortTitle: string }}
 */
export function generateEntryAlertsPine({ spec, hydrated, meta = {}, title: titleOverride, shortTitle } = {}) {
  if (!spec || !hydrated) throw new Error('pine-codegen: spec and hydrated are required');

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
  push(`indicator("${title}", "${stitle}", overlay=true, max_labels_count=500)`);
  push('');

  // ─── Ticker override input (for webhook routing) ───────────
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
  // ── Wundertrading alert payloads ──────────────────────────────
  // Pre-compute ATR values on every bar as global floats. Avoids the
  // Pine v5 gotcha where historical references ([1]) inside a function
  // that's only called conditionally may give stale values.
  const wt_hs = hydrated.exits?.hardStop;
  const wt_tg = hydrated.exits?.target;
  const wt_hasTp = wt_tg?.blockId === 'atrScaleOutTarget';
  const wt_hasSl = wt_hs?.blockId === 'atrHardStop';
  const wt_hasBe = wt_hasTp && wt_hasSl;

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

  push('// ============ WUNDERTRADING ALERT PAYLOADS ============');
  if (wt_hasTp) {
    push(`float wt_atr_tp = nz(atr_${idSfx(wt_tg.params.atrLen)}[1])`);
  }
  if (wt_hasSl && (!wt_hasTp || wt_hs.params.atrLen !== wt_tg.params.atrLen)) {
    push(`float wt_atr_sl = nz(atr_${idSfx(wt_hs.params.atrLen)}[1])`);
  }
  push('');

  // f_ts() preserved for dual-webhook / logging use.
  push('f_ts() =>');
  push(`    str.tostring(year) + '-' + str.tostring(month, "00") + '-' + str.tostring(dayofmonth, "00") + 'T' + str.tostring(hour, "00") + ':' + str.tostring(minute, "00") + 'Z'`);
  push('');

  // f_entry_json — Wundertrading Signal Bot entry payload.
  // TP prices = close ± ATR × mult; SL = close ∓ ATR × slMult.
  // moveToBreakeven shifts SL to entry price when TP1 is reached.
  push('f_entry_json(string dir) =>');
  push('    bool is_l = dir == "long"');

  for (const { n, mult } of wt_tranches) {
    push(`    float tp${n} = is_l ? close + wt_atr_tp * ${mult} : close - wt_atr_tp * ${mult}`);
  }
  if (wt_hasSl) {
    const atrVar = (wt_hasTp && wt_hs.params.atrLen === wt_tg.params.atrLen) ? 'wt_atr_tp' : 'wt_atr_sl';
    push(`    float sl = is_l ? close - ${atrVar} * ${wt_hs.params.atrSL} : close + ${atrVar} * ${wt_hs.params.atrSL}`);
  }

  // JSON assembled from local string parts for readability.
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

  // Return expression — concatenate parts + fixed tail.
  const parts = ['s_code', 's_order'];
  if (wt_tranches.length > 0)             parts.push('s_tp');
  if (wt_hasSl)                           parts.push('s_sl');
  if (wt_hasBe && wt_tranches.length > 0) parts.push('s_be');
  push(`    ${parts.join(' + ')} + ',"placeConditionalOrdersOnExchange":true,"reduceOnly":true}'`);
  push('');

  // f_exit_json — minimal close payload for structural / time exits.
  // TPs/SLs are exchange conditional orders; reversals use swing mode.
  // Direction-aware: uses exit-long or exit-short code so Wundertrading
  // routes the close to the correct bot action.
  push('f_exit_json(string dir, string reason) =>');
  push('    bool is_l = dir == "long"');
  push(`    '{"code":"' + (is_l ? i_codeExitLong : i_codeExitShort) + '","orderType":"market","reduceOnly":true}'`);
  push('');

  push('if goLong');
  push('    alert(f_entry_json("long"),  alert.freq_once_per_bar_close)');
  push('if goShort');
  push('    alert(f_entry_json("short"), alert.freq_once_per_bar_close)');
  // Exit alerts: only structural/time. TP/SL = exchange conditional
  // orders, reversals = handled by the entry alert via swing mode.
  push('if bar_exit and (bar_exit_reason == "Structural" or bar_exit_reason == "Time")');
  push('    alert(f_exit_json(bar_exit_dir > 0 ? "long" : "short", bar_exit_reason), alert.freq_once_per_bar_close)');
  push('');
  push('alertcondition(goLong,   "Long Entry",   "Long entry opens new position")');
  push('alertcondition(goShort,  "Short Entry",  "Short entry opens new position")');
  push('alertcondition(bar_exit, "Position Exit","Position closed (any reason)")');
  push('');

  if (regimeName) {
    // Passive surfacing: plot regime label in the upper-left info box.
    push('var table regimeTbl = table.new(position.top_left, 1, 1, bgcolor=color.new(color.black, 40), border_width=0)');
    push('if barstate.islast');
    push(`    table.cell(regimeTbl, 0, 0, "regime: " + str.tostring(${regimeName}), text_color=color.white, text_size=size.small)`);
  }

  return {
    source: lines.join('\n') + '\n',
    title,
    shortTitle: stitle,
  };
}
