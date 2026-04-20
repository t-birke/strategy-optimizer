/**
 * pine-wundertrading-check — regression gate for Phase 4.7b.
 *
 * Phase 4.7b updated `engine/pine-codegen.js` to emit Wundertrading
 * Signal Bot-compatible JSON in the Pine indicator's `alert()` calls.
 * The gene's frozen TP/SL parameters are computed into absolute prices
 * at alert time and packed into the payload so Wundertrading can place
 * them as conditional orders on the exchange.
 *
 * Sections:
 *   [1] Codegen output — full spec with TPs + SL + moveToBreakeven:
 *       new inputs, Wundertrading JSON fields, TP/SL math, portfolio
 *       fractions, and moveToBreakeven wiring.
 *   [2] Exit alert gating — only Structural/Time fire exit alerts;
 *       TP/SL/ESL are exchange-handled, reversals use swing mode.
 *   [3] Graceful degradation — specs with no target, no hardStop,
 *       or no exits at all produce valid but reduced payloads.
 *   [4] Backward compatibility — exit state machine visualization
 *       (plotshape/label arrows) and alertcondition lines preserved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const [
  { validateSpec },
  { buildParamSpace },
  { generateEntryAlertsPine },
  registry,
] = await Promise.all([
  import('../engine/spec.js'),
  import('../optimizer/param-space.js'),
  import('../engine/pine-codegen.js'),
  import('../engine/blocks/registry.js'),
]);

await registry.ensureLoaded();

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}

// ── Helpers ─────────────────────────────────────────────────

function loadMigrationGateSpec() {
  const raw = JSON.parse(readFileSync(
    resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json'), 'utf8'));
  return validateSpec(raw);
}

/** Generate Pine from the migration-gate spec with a random gene. */
function generateFull() {
  const spec = loadMigrationGateSpec();
  const ps = buildParamSpace(spec);
  const gene = ps.randomIndividual();
  const hydrated = ps.hydrate(gene);
  const result = generateEntryAlertsPine({
    spec, hydrated,
    meta: { ticker: 'BTCUSDT', timeframe: '4H' },
  });
  return { result, spec, hydrated, gene };
}

/** Generate Pine in strategy mode with dates. */
function generateStrategy() {
  const spec = loadMigrationGateSpec();
  const ps = buildParamSpace(spec);
  const gene = ps.randomIndividual();
  const hydrated = ps.hydrate(gene);
  const result = generateEntryAlertsPine({
    spec, hydrated,
    meta: { ticker: 'BTCUSDT', timeframe: '4H' },
    mode: 'strategy',
    dates: { startDate: '2021-04-11', endDate: '2025-12-31' },
  });
  return { result, spec, hydrated, gene };
}

/** Generate Pine with a modified exits config. */
function generateWithExits(overrides) {
  const spec = loadMigrationGateSpec();
  const ps = buildParamSpace(spec);
  const gene = ps.randomIndividual();
  const hydrated = ps.hydrate(gene);
  // Override specific exit slots.
  Object.assign(hydrated.exits, overrides);
  const result = generateEntryAlertsPine({
    spec, hydrated,
    meta: { ticker: 'BTCUSDT', timeframe: '4H' },
  });
  return { result, spec, hydrated, gene };
}

// ═══════════════════════════════════════════════════════════════
// [1] Codegen output — full spec
// ═══════════════════════════════════════════════════════════════
console.log('\n[1] Codegen output — full spec (TPs + SL + moveToBreakeven)');
{
  const { result, hydrated } = generateFull();
  const src = result.source;

  // ── Default mode is indicator ──
  assertTrue('indicator() declaration (default mode)',
    src.includes('indicator(') && !src.includes('strategy('));
  assertTrue('No strategy.entry in indicator mode',
    !src.includes('strategy.entry('));

  // ── New inputs in the Webhook group ──
  assertTrue('i_posSize input declared',
    src.includes('i_posSize = input.float('));
  assertTrue('i_posSize default 0.1',
    /i_posSize\s*=\s*input\.float\(0\.1/.test(src));
  assertTrue('i_leverage input declared',
    src.includes('i_leverage = input.int('));
  assertTrue('i_leverage default 1',
    /i_leverage\s*=\s*input\.int\(1,/.test(src));
  assertTrue('i_codeLong input declared (empty default)',
    /i_codeLong\s*=\s*input\.string\("",/.test(src));
  assertTrue('i_codeExitLong input declared (empty default)',
    /i_codeExitLong\s*=\s*input\.string\("",/.test(src));
  assertTrue('i_codeShort input declared (empty default)',
    /i_codeShort\s*=\s*input\.string\("",/.test(src));
  assertTrue('i_codeExitShort input declared (empty default)',
    /i_codeExitShort\s*=\s*input\.string\("",/.test(src));
  assertTrue('i_codeExitAll input declared (empty default)',
    /i_codeExitAll\s*=\s*input\.string\("",/.test(src));
  assertTrue('All inputs in GRP_WH group',
    [/i_posSize.*group=GRP_WH/, /i_leverage.*group=GRP_WH/,
     /i_codeLong.*group=GRP_WH/, /i_codeExitLong.*group=GRP_WH/,
     /i_codeShort.*group=GRP_WH/, /i_codeExitShort.*group=GRP_WH/,
     /i_codeExitAll.*group=GRP_WH/].every(r => r.test(src)));

  // ── Pre-computed ATR global vars ──
  // No [1] — the codegen captures ATR on the signal bar (current bar),
  // matching the runtime which reads atr[fillBar-1] = atr[signalBar].
  assertTrue('wt_atr_tp declared',
    /float wt_atr_tp = nz\(atr_\w+\)/.test(src));
  // SL ATR may or may not be separate (depends on gene's atrLen match).
  const tpAtrLen = hydrated.exits.target.params.atrLen;
  const slAtrLen = hydrated.exits.hardStop.params.atrLen;
  if (tpAtrLen !== slAtrLen) {
    assertTrue('wt_atr_sl declared (different atrLen)',
      /float wt_atr_sl = nz\(atr_\w+\)/.test(src));
  } else {
    assertTrue('wt_atr_sl NOT declared (same atrLen — reuses wt_atr_tp)',
      !src.includes('wt_atr_sl'));
  }

  // ── f_entry_json function structure ──
  assertTrue('f_entry_json(string dir) defined',
    src.includes('f_entry_json(string dir) =>'));
  assertTrue('is_l direction flag',
    src.includes('bool is_l = dir == "long"'));

  // ── Wundertrading JSON fields ──
  assertTrue('code field references i_codeLong / i_codeShort',
    /is_l \? i_codeLong : i_codeShort/.test(src));
  assertTrue('orderType: market',
    src.includes('"orderType":"market"'));
  assertTrue('amountPerTradeType: percents',
    src.includes('"amountPerTradeType":"percents"'));
  assertTrue('amountPerTrade references i_posSize',
    /amountPerTrade.*str\.tostring\(i_posSize\)/.test(src));
  assertTrue('leverage references i_leverage',
    /leverage.*str\.tostring\(i_leverage\)/.test(src));
  assertTrue('placeConditionalOrdersOnExchange: true',
    src.includes('"placeConditionalOrdersOnExchange":true'));
  assertTrue('reduceOnly: true',
    src.includes('"reduceOnly":true'));

  // ── TP array ──
  assertTrue('takeProfits array present',
    src.includes('"takeProfits":['));

  // Verify active tranches match the gene's params.
  const tg = hydrated.exits.target;
  const activeTranches = [];
  for (let n = 1; n <= 6; n++) {
    const pct = tg.params[`tp${n}Pct`];
    const mult = tg.params[`tp${n}Mult`];
    if (pct > 0 && mult > 0) activeTranches.push({ n, mult, pct });
  }
  activeTranches.sort((a, b) => a.mult - b.mult);

  assertTrue(`${activeTranches.length} active tranche(s) in the gene`,
    activeTranches.length > 0);

  for (const { n, mult } of activeTranches) {
    assertTrue(`TP${n} price formula uses mult ${mult}`,
      src.includes(`close + wt_atr_tp * ${mult}`) &&
      src.includes(`close - wt_atr_tp * ${mult}`));
  }

  // Wundertrading bug-fix regression — the takeProfits portfolio values
  // in the emitted JSON MUST sum to exactly 1.0 or WT rejects the signal
  // ("Take profits 'portfolio' values SUM must be equal to 1"). Previously
  // we emitted raw `pct/100`, producing sums like 0.7 on specs where
  // tp1+tp2+tp3 ≠ 100. Now the emitter normalizes to sum=1.0 with
  // last-tranche-carry so 0.1429 + 0.7143 + 0.1428 = 1.0000 exactly.
  const tpLine = src.split('\n').find(l => l.includes('"takeProfits":['));
  assertTrue('takeProfits line found', !!tpLine);
  if (tpLine) {
    const portfolioValues = [...tpLine.matchAll(/"portfolio":([\d.]+)/g)]
      .map(m => parseFloat(m[1]));
    assertTrue(`portfolio values count matches active tranches (${portfolioValues.length})`,
      portfolioValues.length === activeTranches.length);
    const sum = portfolioValues.reduce((s, v) => s + v, 0);
    assertTrue(`portfolio values sum to 1.0 (got ${sum})`,
      Math.abs(sum - 1.0) < 1e-9,
      `values: ${portfolioValues.join(',')} sum=${sum}`);
  }

  // Verify no INACTIVE tranches are emitted.
  for (let n = 1; n <= 6; n++) {
    const pct = tg.params[`tp${n}Pct`];
    const mult = tg.params[`tp${n}Mult`];
    if (pct <= 0 || mult <= 0) {
      assertTrue(`Inactive TP${n} (pct=${pct}, mult=${mult}) NOT emitted`,
        !new RegExp(`float tp${n} =`).test(src));
    }
  }

  // ── SL ──
  assertTrue('stopLoss present',
    src.includes('"stopLoss":{"price":'));
  const atrVar = (tpAtrLen === slAtrLen) ? 'wt_atr_tp' : 'wt_atr_sl';
  assertTrue(`SL formula: close ∓ ${atrVar} * ${hydrated.exits.hardStop.params.atrSL}`,
    src.includes(`close - ${atrVar} * ${hydrated.exits.hardStop.params.atrSL}`) &&
    src.includes(`close + ${atrVar} * ${hydrated.exits.hardStop.params.atrSL}`));

  // ── moveToBreakeven ──
  assertTrue('moveToBreakeven present',
    src.includes('"moveToBreakeven":{'));
  assertTrue('activationPrice references TP1 var',
    /activationPrice.*str\.tostring\(tp\d/.test(src));
  assertTrue('executePrice references close (entry price)',
    /executePrice.*str\.tostring\(close/.test(src));

  // ── f_exit_json — minimal close payload, direction-aware ──
  assertTrue('f_exit_json defined',
    src.includes('f_exit_json(string dir, string reason) =>'));
  assertTrue('exit payload uses direction-aware codes (i_codeExitLong / i_codeExitShort)',
    /f_exit_json[\s\S]*?i_codeExitLong[\s\S]*?i_codeExitShort/.test(src));
  assertTrue('exit payload is minimal (market + reduceOnly, no TPs)',
    (() => {
      const exitFn = src.split('f_exit_json(string dir, string reason) =>')[1]
                        ?.split('\n')[2] || '';
      return exitFn.includes('"orderType":"market"') &&
             exitFn.includes('"reduceOnly":true') &&
             !exitFn.includes('takeProfits');
    })());

  // ── Old format GONE ──
  assertTrue('No old action:open format',
    !src.includes('"action":"open"'));
  assertTrue('No old action:close format',
    !src.includes('"action":"close"'));
}

// ═══════════════════════════════════════════════════════════════
// [2] Exit alert gating
// ═══════════════════════════════════════════════════════════════
console.log('\n[2] Exit alert gating — only Structural/Time');
{
  const { result } = generateFull();
  const src = result.source;

  // The exit alert if-guard sits on the line ABOVE the alert() call.
  const exitGuardLine = src.split('\n').find(l =>
    l.includes('bar_exit') && l.includes('bar_exit_reason') && l.includes('if '));
  assertTrue('exit alert guard line exists', !!exitGuardLine);
  assertTrue('exit alert guarded by bar_exit_reason == "Structural"',
    exitGuardLine?.includes('"Structural"'));
  assertTrue('exit alert guarded by bar_exit_reason == "Time"',
    exitGuardLine?.includes('"Time"'));

  // The guard must use AND with bar_exit — verify the compound condition.
  assertTrue('exit alert requires bar_exit AND (Structural or Time)',
    /if bar_exit and \(bar_exit_reason == "Structural" or bar_exit_reason == "Time"\)/.test(src));

  // Make sure TP/SL/ESL/Reversal don't have their own alert dispatch.
  // The old unconditional `if bar_exit` alert line must be gone.
  const unconditionalExitAlert = src.split('\n').filter(l =>
    l.trim().startsWith('if bar_exit') &&
    l.includes('alert(f_exit_json(') &&
    !l.includes('bar_exit_reason'));
  assertTrue('No unconditional bar_exit alert (old pattern gone)',
    unconditionalExitAlert.length === 0);
}

// ═══════════════════════════════════════════════════════════════
// [3] Graceful degradation
// ═══════════════════════════════════════════════════════════════
console.log('\n[3] Graceful degradation — partial or missing exit blocks');
{
  // 3a: No target (hardStop only) → no takeProfits, no moveToBreakeven
  console.log('  [3a] No target block → no TPs, no moveToBreakeven');
  {
    const { result } = generateWithExits({ target: null });
    const src = result.source;
    assertTrue('No takeProfits in payload',
      !src.includes('"takeProfits"'));
    assertTrue('No moveToBreakeven in payload',
      !src.includes('"moveToBreakeven"'));
    assertTrue('stopLoss still present',
      src.includes('"stopLoss"'));
    assertTrue('f_entry_json still generates valid payload',
      src.includes('f_entry_json(string dir) =>'));
    assertTrue('placeConditionalOrdersOnExchange still present',
      src.includes('"placeConditionalOrdersOnExchange":true'));
  }

  // 3b: No hardStop (target only) → no stopLoss, no moveToBreakeven
  console.log('  [3b] No hardStop block → no SL, no moveToBreakeven');
  {
    const { result } = generateWithExits({ hardStop: null });
    const src = result.source;
    assertTrue('No stopLoss in payload',
      !src.includes('"stopLoss"'));
    assertTrue('No moveToBreakeven in payload',
      !src.includes('"moveToBreakeven"'));
    assertTrue('takeProfits still present',
      src.includes('"takeProfits"'));
    assertTrue('f_entry_json still generates valid payload',
      src.includes('f_entry_json(string dir) =>'));
  }

  // 3c: No exits at all → entry-only alert (code + sizing)
  console.log('  [3c] No exit blocks → entry-only alert');
  {
    const { result } = generateWithExits({
      hardStop: null, target: null, trail: null,
    });
    const src = result.source;
    assertTrue('No takeProfits',
      !src.includes('"takeProfits"'));
    assertTrue('No stopLoss',
      !src.includes('"stopLoss"'));
    assertTrue('No moveToBreakeven',
      !src.includes('"moveToBreakeven"'));
    assertTrue('No wt_atr_tp declaration',
      !src.includes('wt_atr_tp'));
    assertTrue('f_entry_json still present with code + sizing',
      src.includes('f_entry_json(string dir) =>') &&
      src.includes('"orderType":"market"'));
    assertTrue('placeConditionalOrdersOnExchange still present',
      src.includes('"placeConditionalOrdersOnExchange":true'));
    // Exit alert guard still present but bar_exit is always false
    // (no exit state machine emitted), so it's a dead path. Fine.
    assertTrue('goLong/goShort = rawLong/rawShort (no position gate)',
      src.includes('bool goLong  = rawLong') &&
      src.includes('bool goShort = rawShort'));
  }
}

// ═══════════════════════════════════════════════════════════════
// [4] Backward compatibility — viz + alertcondition preserved
// ═══════════════════════════════════════════════════════════════
console.log('\n[4] Backward compatibility — viz + alertcondition preserved');
{
  const { result } = generateFull();
  const src = result.source;

  // Exit state machine visualization.
  assertTrue('plotshape goLong (Long Entry)',
    src.includes('plotshape(goLong'));
  assertTrue('plotshape goShort (Short Entry)',
    src.includes('plotshape(goShort'));
  assertTrue('plotshape long exit',
    src.includes('plotshape(bar_exit and bar_exit_dir > 0'));
  assertTrue('plotshape short exit',
    src.includes('plotshape(bar_exit and bar_exit_dir < 0'));

  // Label markers for entries + exits.
  assertTrue('label LONG on entry',
    src.includes('"LONG"'));
  assertTrue('label SHORT on entry',
    src.includes('"SHORT"'));
  assertTrue('label exit reason on long exit',
    /label\.new.*bar_exit_reason.*yloc\.abovebar/.test(src));
  assertTrue('label exit reason on short exit',
    /label\.new.*bar_exit_reason.*yloc\.belowbar/.test(src));

  // alertcondition preserved.
  assertTrue('alertcondition goLong',
    src.includes('alertcondition(goLong'));
  assertTrue('alertcondition goShort',
    src.includes('alertcondition(goShort'));
  assertTrue('alertcondition bar_exit',
    src.includes('alertcondition(bar_exit'));

  // f_ts() preserved for dual-webhook / logging.
  assertTrue('f_ts() still defined',
    src.includes('f_ts() =>'));

  // Ticker override input still present.
  assertTrue('i_tickerOverride input preserved',
    src.includes('i_tickerOverride'));
}

// ═══════════════════════════════════════════════════════════════
// [5] Strategy mode — strategy() + entry/exit/close + dates + sizing
// ═══════════════════════════════════════════════════════════════
console.log('\n[5] Strategy mode — strategy tester support');
{
  const { result, hydrated } = generateStrategy();
  const src = result.source;

  // strategy() declaration instead of indicator()
  assertTrue('strategy() declaration (not indicator)',
    src.includes('strategy(') && !src.includes('indicator('));
  assertTrue('initial_capital=100000',
    src.includes('initial_capital=100000'));
  assertTrue('commission_value=0.06',
    src.includes('commission_value=0.06'));
  assertTrue('slippage=2',
    src.includes('slippage=2'));
  assertTrue('pyramiding=0',
    src.includes('pyramiding=0'));
  assertTrue('default_qty_type=strategy.fixed',
    src.includes('default_qty_type=strategy.fixed'));

  // Date inputs
  assertTrue('i_startDate input declared',
    src.includes('i_startDate = input.time('));
  assertTrue('i_endDate input declared',
    src.includes('i_endDate'));
  assertTrue('in_date_range gate',
    src.includes('bool in_date_range'));
  assertTrue('startDate default matches dates arg',
    src.includes('timestamp("2021-04-11")'));
  assertTrue('endDate default matches dates arg',
    src.includes('timestamp("2025-12-31")'));

  // ATR-risk position sizing (Van Tharp formula)
  const riskPct = hydrated.sizing?.params?.riskPct;
  assertTrue('strat_risk uses strategy.equity * riskPct',
    src.includes(`strategy.equity * ${riskPct} / 100`));
  assertTrue('strat_stop uses atrSL',
    src.includes(`strat_atr_hs * ${hydrated.exits.hardStop.params.atrSL}`));
  assertTrue('strat_qty computed from risk / stop',
    src.includes('strat_risk / strat_stop'));

  // strategy.entry calls gated by new-position check + in_date_range.
  // Must use rawLong/rawShort (NOT goLong/goShort) because the indicator's
  // goLong is gated by `not bar_exit` which suppresses entries on SL-fire bars.
  assertTrue('strat_new_long uses rawLong (not goLong)',
    src.includes('strat_new_long') && /rawLong\s+and\s+strategy\.position_size\s*<=\s*0/.test(src));
  assertTrue('strat_new_short uses rawShort (not goShort)',
    src.includes('strat_new_short') && /rawShort\s+and\s+strategy\.position_size\s*>=\s*0/.test(src));
  assertTrue('strategy.entry Long gated by strat_new_long',
    src.includes('if strat_new_long and in_date_range'));
  assertTrue('strategy.entry Short gated by strat_new_short',
    src.includes('if strat_new_short and in_date_range'));
  assertTrue('strategy.entry uses qty=strat_qty',
    src.includes('strategy.entry("Long", strategy.long, qty=strat_qty)'));

  // strategy.exit TP calls for active tranches
  const tg = hydrated.exits.target;
  const activeTranches = [];
  for (let n = 1; n <= 6; n++) {
    const pct = tg.params[`tp${n}Pct`];
    const mult = tg.params[`tp${n}Mult`];
    if (pct > 0 && mult > 0) activeTranches.push({ n, mult, pct });
  }
  activeTranches.sort((a, b) => a.mult - b.mult);

  for (const { n } of activeTranches) {
    assertTrue(`strategy.exit TP${n} for Long`,
      src.includes(`strategy.exit("TP${n}", "Long"`));
    assertTrue(`strategy.exit TP${n} for Short`,
      src.includes(`strategy.exit("TP${n}", "Short"`));
  }

  // OCO pattern: stop= is on every TP exit, not a separate SL exit
  const atrSL = hydrated.exits.hardStop.params.atrSL;
  if (activeTranches.length > 0) {
    assertTrue('TP exits include stop= for OCO (Long)',
      activeTranches.every(({ n }) =>
        new RegExp(`strategy\\.exit\\("TP${n}", "Long".*stop=`).test(src)));
    assertTrue('TP exits include stop= for OCO (Short)',
      activeTranches.every(({ n }) =>
        new RegExp(`strategy\\.exit\\("TP${n}", "Short".*stop=`).test(src)));
    assertTrue('No separate SL exit when TPs present',
      !src.includes('strategy.exit("SL"'));
  } else {
    // SL-only (no TPs) — standalone stop exit
    assertTrue('strategy.exit SL for Long (no TPs)',
      src.includes('strategy.exit("SL", "Long"'));
    assertTrue('strategy.exit SL for Short (no TPs)',
      src.includes('strategy.exit("SL", "Short"'));
  }

  // Close-based ATR SL parity: slTriggered flag + strategy.close on
  // next bar (NOT a stop= order). Matches runtime's closeNextBarOpen.
  assertTrue('slTriggered flag declared',
    src.includes('var bool  slTriggered'));
  assertTrue('close-based SL check for Long (close <= sl)',
    /if close <= sl_long/.test(src));
  assertTrue('close-based SL check for Short (close >= sl)',
    /if close >= sl_short/.test(src));
  assertTrue('slTriggered arms on close-based SL',
    src.includes('slTriggered := true'));
  assertTrue('strategy.close_all for deferred SL',
    src.includes('strategy.close_all(comment="SL")'));

  // Emergency SL is on stop= (intra-bar), NOT the ATR SL
  const eslPct = hydrated.exits.hardStop.params.emergencySlPct;
  assertTrue('TP stop= uses ESL (not ATR SL) for Long',
    new RegExp(`stop=strat_entry \\* ${(1 - eslPct / 100).toFixed(2)}`).test(src) ||
    new RegExp(`stop=strat_entry \\* 0\\.`).test(src));

  // Breakeven shift after TP1
  assertTrue('breakeven long (entry * 1.003)',
    src.includes('strat_entry * 1.003'));
  assertTrue('breakeven short (entry * 0.997)',
    src.includes('strat_entry * 0.997'));

  // strategy.close_all for structural/time exits — NEW: strategy computes
  // structural detection independently of the indicator's bar_exit/pos_dir
  // (see section [9] for the full rationale). The close_all comment is a
  // ternary based on strat_time_hit: "Time" if time_hit, else "Structural".
  assertTrue('strategy.close_all for Structural/Time (independent detection)',
    src.includes('strategy.close_all(comment=strat_time_hit ? "Time" : "Structural")'));
  assertTrue('old bar_exit-based close_all REMOVED from strategy',
    !src.includes('strategy.close_all(comment=bar_exit_reason)'));

  // Independent price tracking vars (not reset by exit state machine)
  assertTrue('strat_entry var declared',
    src.includes('var float strat_entry'));
  assertTrue('strat_atr_tp var declared',
    src.includes('var float strat_atr_tp'));
  assertTrue('strat_atr_hs var declared',
    src.includes('var float strat_atr_hs'));

  // Strategy mode must NOT contain alert / webhook machinery
  assertTrue('No Wundertrading webhook inputs in strategy mode',
    !src.includes('GRP_WH') && !src.includes('i_codeLong'));
  assertTrue('No f_entry_json in strategy mode',
    !src.includes('f_entry_json'));
  assertTrue('No f_exit_json in strategy mode',
    !src.includes('f_exit_json'));
  assertTrue('No alert() calls in strategy mode',
    !src.includes('alert(f_entry') && !src.includes('alert(f_exit'));
  assertTrue('No alertcondition in strategy mode',
    !src.includes('alertcondition('));
}

// ═══════════════════════════════════════════════════════════════
// [6] ATR bar-offset parity, leverage cap, sub-allocation normalization
// ═══════════════════════════════════════════════════════════════
{
  console.log('\n[6] Parity fixes — ATR offset, leverage cap, sub-allocation');

  const { result: stratResult, hydrated: hyd6 } = generateStrategy();
  const src = stratResult.source;
  const { result: indResult } = generateFull();
  const indSrc = indResult.source;

  // ── ATR bar-offset: strategy captures on the FILL bar using atr_N[1] ──
  // The runtime reads atr[fillBar-1] = atr[signalBar]. Since the strategy
  // captures on the fill bar (= signalBar + 1), `atr_N[1]` on the fill bar
  // is `atr[signalBar]` — matching the runtime. On the signal bar, `atr_N`
  // is `atr[signalBar]` (same value, different read point).
  //
  // The indicator's state machine still captures on the entry bar (which
  // for the indicator IS the signal bar), so it uses `atr_N` (no [1]).
  assertTrue('strat_atr_tp captures signal-bar ATR on fill bar (atr_N[1])',
    /strat_atr_tp := nz\(atr_\w+\[1\]\)/.test(src));
  assertTrue('strat_atr_hs captures signal-bar ATR on fill bar (atr_N[1])',
    /strat_atr_hs := nz\(atr_\w+\[1\]\)/.test(src));

  // Indicator mode exit state machine must also use current-bar ATR.
  assertTrue('pos_entry_atr_hs captures current-bar ATR (no [1])',
    /pos_entry_atr_hs := nz\(atr_\w+\)/.test(indSrc) &&
    !/pos_entry_atr_hs := nz\(atr_\w+\[1\]\)/.test(indSrc));
  assertTrue('pos_entry_atr_tp captures current-bar ATR (no [1])',
    /pos_entry_atr_tp := nz\(atr_\w+\)/.test(indSrc) &&
    !/pos_entry_atr_tp := nz\(atr_\w+\[1\]\)/.test(indSrc));

  // ── Leverage cap: strat_qty must be capped by equity / close ──
  assertTrue('strat_max_qty leverage cap declared',
    src.includes('strat_max_qty') && /strategy\.equity\s*\/\s*close/.test(src));
  assertTrue('strat_qty uses math.min with cap',
    /strat_qty\s*=\s*math\.min\(strat_qty_raw/.test(src));
  assertTrue('strat_qty_raw computed from risk / stop (uncapped)',
    src.includes('strat_qty_raw') && src.includes('strat_risk / strat_stop'));

  // ── Sub-allocation normalization (direct, NOT cascading) ──
  // The runtime normalizes raw tp pcts to sum to 100% (e.g., 10+50+10=70
  // → 14.29/71.43/14.29). TV's strategy.exit locks qty at first placement
  // and applies qty_percent to the ORIGINAL position size, not the
  // remaining. So we pass normalized pcts directly — no cascading.
  const tp1Pct = hyd6.exits.target.params.tp1Pct;
  const tp2Pct = hyd6.exits.target.params.tp2Pct;
  const tp3Pct = hyd6.exits.target.params.tp3Pct;
  const pctSum = tp1Pct + tp2Pct + tp3Pct;
  if (pctSum !== 100 && pctSum > 0) {
    const norm1 = Math.round(tp1Pct / pctSum * 10000) / 100;
    const norm2 = Math.round(tp2Pct / pctSum * 10000) / 100;
    const norm3 = Math.round(tp3Pct / pctSum * 10000) / 100;
    const exitLines = src.split('\n').filter(l => /strategy\.exit\("TP\d"/.test(l));
    const tp1Lines = exitLines.filter(l => l.includes('"TP1"'));
    const tp2Lines = exitLines.filter(l => l.includes('"TP2"'));
    const tp3Lines = exitLines.filter(l => l.includes('"TP3"'));

    // Each tranche must use the DIRECT normalized pct, not a cascading one.
    // For gene 10/50/10 (sum=70): TP1=14.29, TP2=71.43, TP3=14.29.
    // A cascading approach would wrongly give TP2=83.33, TP3=100.
    if (tp1Lines.length > 0) {
      assertTrue('TP1 qty_percent is normalized (not raw)',
        tp1Lines.some(l => l.includes(`qty_percent=${norm1}`)));
    }
    if (tp2Lines.length > 0) {
      assertTrue('TP2 qty_percent is direct normalized (not cascading 83.33)',
        tp2Lines.some(l => l.includes(`qty_percent=${norm2}`)));
    }
    if (tp3Lines.length > 0) {
      assertTrue('TP3 qty_percent is direct normalized (not 100)',
        tp3Lines.some(l => l.includes(`qty_percent=${norm3}`)));
    }
  }

  // ── Entry-variable capture gated on fill-bar detection (not signal) ──
  // PARITY FIX (Trade #32 SL timing): strat_entry must equal the REAL fill
  // price, not the signal-bar close. The runtime uses `position.entryPrice =
  // fillPrice` = `open[fillBar] ± slippage`. Pine's `strategy.position_avg_price`
  // is the actual fill price including strategy slippage. Capturing it on the
  // FILL bar (one bar after signal) matches the runtime's SL anchor.
  //
  // The capture must NOT fire on the signal bar (would use stale close[signal]
  // which differs from the real fill by the open-close gap + slippage).
  assertTrue('strat_entry captured from strategy.position_avg_price',
    /strat_entry\s*:=\s*strategy\.position_avg_price/.test(src));
  assertTrue('strat_entry NOT captured from close[signal] directly',
    !/strat_entry\s*:=\s*close(?:\s|$)/.test(src));
  assertTrue('strat_fill_long detects position transition to long',
    /strat_fill_long\s*=.*strategy\.position_size\s*>\s*0.*strategy\.position_size\[1\]\s*<=\s*0/.test(src));
  assertTrue('strat_fill_short detects position transition to short',
    /strat_fill_short\s*=.*strategy\.position_size\s*<\s*0.*strategy\.position_size\[1\]\s*>=\s*0/.test(src));

  // The `if strat_fill_long or strat_fill_short` block is the capture site
  // — strat_entry, strat_atr_*, slTriggered, strat_tp1HitBar all reset here.
  assertTrue('strat_tp1HitBar reset gated on fill-bar detection (not signal)',
    (() => {
      const lines = src.split('\n');
      const resetLine = lines.findIndex(l => /strat_tp1HitBar\s*:=\s*-1/.test(l));
      if (resetLine < 0) return false;
      // Walk backwards to find the enclosing if — must be strat_fill_*
      for (let j = resetLine - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (t.startsWith('if ')) {
          return t.includes('strat_fill_long') || t.includes('strat_fill_short');
        }
      }
      return false;
    })());
  assertTrue('slTriggered reset gated on fill-bar detection (not signal)',
    (() => {
      const lines = src.split('\n');
      // Find FIRST slTriggered := false (the fill-bar reset — precedes the
      // deferred-close block which also has a reset).
      const resetLine = lines.findIndex(l => /^\s+slTriggered\s+:=\s+false\b/.test(l));
      if (resetLine < 0) return false;
      for (let j = resetLine - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (t.startsWith('if ')) {
          return t.includes('strat_fill_long') || t.includes('strat_fill_short');
        }
      }
      return false;
    })());

  // Sizing must use `atr_N` directly (not strat_atr_hs) since strat_atr_hs
  // is only populated on the fill bar — one bar too late for sizing.
  assertTrue('strat_stop uses atr_N directly for sizing on signal bar',
    /float strat_stop = nz\(atr_\w+\)\s*\*/.test(src));
  assertTrue('strat_stop does NOT use strat_atr_hs (not yet captured)',
    !/float strat_stop = strat_atr_hs/.test(src));

  // strat_new_long/short still used to GATE strategy.entry (not capture)
  assertTrue('strategy.entry Long gated on strat_new_long',
    /if strat_new_long and in_date_range[\s\S]*?strategy\.entry\("Long"/.test(src));
  assertTrue('strategy.entry Short gated on strat_new_short',
    /if strat_new_short and in_date_range[\s\S]*?strategy\.entry\("Short"/.test(src));
}

// [7] Structural exit timing + reversal position tracking
// ═══════════════════════════════════════════════════════════════
{
  console.log('\n[7] Structural exit — immediate fire + reversal entry');

  const { result: indResult7 } = generateFull();
  const ind = indResult7.source;
  const { result: stratResult7 } = generateStrategy();
  const strat = stratResult7.source;

  // ── struct_armed / struct_reason removed ──
  // The old arming mechanism added an extra 1-bar delay to structural exits.
  // The runtime fires closeNextBarOpen directly (1-bar delay), not through an
  // arming step (which would give 2-bar delay). Removing struct_armed aligns
  // the timing.
  assertTrue('no struct_armed variable in indicator output',
    !ind.includes('struct_armed'));
  assertTrue('no struct_reason variable in indicator output',
    !ind.includes('struct_reason'));

  // ── Step 4 fires immediately (sets bar_exit, not struct_armed) ──
  // The detection bar should set bar_exit := true directly so
  // strategy.close_all() fires on the same bar (filling at next open).
  assertTrue('structural exit sets bar_exit directly (no arming)',
    ind.includes('bar_exit_reason := rev ? "Reversal" : time_hit ? "Time" : "Structural"'));

  // ── Step 4 guard does NOT include `not sl_armed` ──
  // In the runtime, when hardStop arms its triggered flag (returns null),
  // the trail slot still evaluates. If structural fires on the same bar,
  // it wins. The indicator must allow structural to fire even when SL is armed.
  const step4Guard = ind.split('\n').find(l => l.includes('bool is_long_st'));
  const step4If = step4Guard ? (() => {
    const lines = ind.split('\n');
    const idx = lines.indexOf(step4Guard);
    return idx > 0 ? lines[idx - 1] : '';
  })() : '';
  assertTrue('step 4 guard allows structural when SL is armed',
    step4If.includes('pos_dir != 0') &&
    step4If.includes('not bar_exit') &&
    !step4If.includes('sl_armed'));

  // ── Reversal: indicator enters opposite position ──
  // When the indicator detects a reversal in step 4, it must enter the
  // opposite position so it tracks the new position for exit signals.
  // Without this, the indicator loses position tracking after reversals.
  assertTrue('reversal enters opposite position (pos_dir := -bar_exit_dir)',
    ind.includes('pos_dir := -bar_exit_dir'));
  assertTrue('reversal captures entry at close',
    ind.includes('if rev') &&
    ind.includes('pos_entry := close') &&
    ind.includes('pos_entry_bar := bar_index'));

  // ── Step 0 only handles SL (not structural) ──
  // Structural exits fire immediately in step 4, so step 0 only needs
  // to handle the deferred SL fill.
  const step0Guard = ind.split('\n').find(l =>
    l.includes('sl_armed') && l.startsWith('if pos_dir'));
  assertTrue('step 0 only handles SL (not struct_armed)',
    step0Guard != null &&
    step0Guard.includes('sl_armed') &&
    !step0Guard.includes('struct_armed'));
}

// ═══════════════════════════════════════════════════════════════
// [7c] Strategy structural/time detection — independent of indicator
// ═══════════════════════════════════════════════════════════════
// PARITY FIX (Trades 34–36 structural vs Pine late-SL). The old codegen
// read `bar_exit and bar_exit_reason in ("Structural","Time")` from the
// indicator's step 4. But the indicator's `pos_dir` gets reset to 0 when
// its INTERNAL SL fires via step 0, and the indicator's SL uses
// `close[signalBar]` as entry reference — different from the strategy's
// `strategy.position_avg_price` (real fill price). On gap bars, the
// indicator's SL can fire BEFORE the strategy's. pos_dir → 0 gates
// step 4 off forever, so structural never fires for the strategy and
// the position runs until the strategy's own SL finally crosses →
// "SL" exit in TV where runtime shows "Structural".
//
// Fix: compute structural / time in the STRATEGY section using
// `strategy.position_size` and `strat_entry_bar` (captured on fill bar).
// Independent of the indicator state machine.
{
  console.log('\n[7c] Strategy structural detection — independent of indicator pos_dir');

  const { result: stratResult7c, hydrated: hyd7c } = generateStrategy();
  const src = stratResult7c.source;

  const trail = hyd7c.exits.trail;
  const maxBars = trail?.params?.maxBars;

  // ── strat_entry_bar declared & captured on fill bar ──
  assertTrue('var strat_entry_bar declared',
    /var int\s+strat_entry_bar\s*=\s*na/.test(src));
  assertTrue('strat_entry_bar captured on fill-bar block',
    (() => {
      const lines = src.split('\n');
      const idx = lines.findIndex(l => /strat_entry_bar\s*:=\s*bar_index/.test(l));
      if (idx < 0) return false;
      for (let j = idx - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (t.startsWith('if ')) {
          return t.includes('strat_fill_long') || t.includes('strat_fill_short');
        }
      }
      return false;
    })());

  // ── Independent structural block present; guards on position_size ──
  assertTrue('structural check gated on strategy.position_size != 0',
    /if strategy\.position_size\s*!=\s*0 and not na\(strat_entry_bar\)/.test(src));
  assertTrue('strat_is_long_st from strategy.position_size (not pos_dir)',
    /bool strat_is_long_st\s*=\s*strategy\.position_size\s*>\s*0/.test(src));
  assertTrue('strat_bars_held uses strat_entry_bar (not pos_entry_bar)',
    /int\s+strat_bars_held\s*=\s*bar_index\s*-\s*strat_entry_bar/.test(src));

  // ── Same thresholds as runtime's structural-exit.js ──
  if (Number.isInteger(maxBars)) {
    assertTrue(`strat_time_hit uses maxBars - 1 threshold (${maxBars})`,
      new RegExp(`strat_time_hit\\s*=\\s*strat_bars_held\\s*>=\\s*${maxBars}\\s*-\\s*1`).test(src));
  }
  assertTrue('strat_stoch_exit matches runtime thresholds (60 / 40)',
    /strat_stoch_exit\s*=\s*strat_is_long_st\s*\?\s*\(ta\.crossunder\([^)]+\)\s*and[^>]+>\s*60\)[^:]*:\s*\(ta\.crossover\([^)]+\)\s*and[^<]+<\s*40\)/.test(src));
  assertTrue('strat_rsi_exit matches runtime thresholds (40/55, 60/45)',
    /strat_rsi_exit\s*=\s*strat_is_long_st\s*\?\s*\([^)]*<\s*40\s*and[^>]+>\s*55\)\s*:\s*\([^)]*>\s*60\s*and[^<]+<\s*45\)/.test(src));

  // ── Close-all uses Time/Structural comment (not bar_exit_reason) ──
  assertTrue('close_all comment picks Time or Structural via strat_time_hit',
    /strategy\.close_all\(comment=strat_time_hit\s*\?\s*"Time"\s*:\s*"Structural"\)/.test(src));

  // ── Reversal NOT handled here (strategy.entry auto-close via pyramiding=0) ──
  // The strat check must NOT include a "rev" branch. Rev is implicit in
  // strat_new_long/short gating strategy.entry(opposite direction).
  const stratBlock = (() => {
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.includes('strat_is_long_st'));
    if (start < 0) return '';
    // Stop at next section or end
    let end = lines.findIndex((l, i) => i > start && (l.trim() === '' || l.includes('//')));
    return lines.slice(start, end > 0 ? end : lines.length).join('\n');
  })();
  assertTrue('no "Reversal" branch in strategy structural (entry auto-close)',
    !/"Reversal"/.test(stratBlock));
  assertTrue('no `rev` computation in strategy structural block',
    !/\brev\s*=/.test(stratBlock));
}

// ═══════════════════════════════════════════════════════════════
// [7b] TP1 → breakeven SL transition — 1-bar delay (runtime parity)
// ═══════════════════════════════════════════════════════════════
// Runtime atr-hard-stop.js line 134: `i > tp1HitBar` (STRICT greater).
// On the TP1 fill bar itself, tp1Hit is false → SL stays WIDE.
// One bar later, tp1Hit turns true → SL switches to TIGHT (breakeven+).
//
// The old Pine used `var bool strat_tp1Hit`, setting it to true on the
// TP1 fill bar and reading it IMMEDIATELY in the SL check. That made
// the breakeven SL activate on the fill bar itself, causing the SL
// close-based cross-detection to fire ~1 bar earlier than runtime.
// Symptom: Trade #32 SL exit at 2022-05-26 22:00 in TV vs 2022-05-27
// 02:00 in runtime (4h gap, same direction each time — TV always 1 bar
// earlier after a TP1 hit).
//
// Fix: track `var int strat_tp1HitBar = -1`, stamp `bar_index` on TP1
// fill, and compute `strat_tp1Hit = strat_tp1HitBar >= 0 and
// bar_index > strat_tp1HitBar` (strict). Matches runtime's 1-bar delay.
{
  console.log('\n[7b] TP1 → breakeven SL — 1-bar delay (runtime parity)');

  const { result: stratResult7b } = generateStrategy();
  const src = stratResult7b.source;

  // ── var declaration: int strat_tp1HitBar = -1 (no bool strat_tp1Hit) ──
  assertTrue('var strat_tp1HitBar declared with -1 sentinel',
    /var int\s+strat_tp1HitBar\s*=\s*-1/.test(src));
  assertTrue('OLD var bool strat_tp1Hit NOT declared',
    !/var bool\s+strat_tp1Hit\s*=\s*false/.test(src));

  // ── Detection stamps bar_index (not sets bool to true) ──
  assertTrue('TP1 detection (long) stamps strat_tp1HitBar := bar_index',
    /if strat_tp1HitBar\s*<\s*0 and strategy\.position_size\s*>\s*0[\s\S]*?strat_tp1HitBar\s*:=\s*bar_index/.test(src));
  assertTrue('TP1 detection (short) stamps strat_tp1HitBar := bar_index',
    /if strat_tp1HitBar\s*<\s*0 and strategy\.position_size\s*<\s*0[\s\S]*?strat_tp1HitBar\s*:=\s*bar_index/.test(src));
  assertTrue('old "strat_tp1Hit := true" pattern NOT present',
    !/strat_tp1Hit\s*:=\s*true/.test(src));

  // ── Effective strat_tp1Hit uses STRICT `>` (1-bar delay) ──
  assertTrue('strat_tp1Hit computed with strict bar_index > strat_tp1HitBar',
    /bool\s+strat_tp1Hit\s*=\s*strat_tp1HitBar\s*>=\s*0 and bar_index\s*>\s*strat_tp1HitBar/.test(src));

  // ── SL check still references strat_tp1Hit (now the local bool) ──
  assertTrue('SL long uses strat_tp1Hit for breakeven branch',
    /sl_long\s*=\s*strat_tp1Hit\s*\?\s*strat_entry\s*\*\s*1\.003/.test(src));
  assertTrue('SL short uses strat_tp1Hit for breakeven branch',
    /sl_short\s*=\s*strat_tp1Hit\s*\?\s*strat_entry\s*\*\s*0\.997/.test(src));

  // ── Fill-bar reset uses strat_tp1HitBar := -1 ──
  assertTrue('fill-bar reset sets strat_tp1HitBar := -1',
    /strat_tp1HitBar\s*:=\s*-1/.test(src));

  // ── Detection gated on strat_tp1HitBar < 0 (single-fire) ──
  // Prevents re-stamping when position_size decreases further via TP2/TP3.
  assertTrue('detection gated on strat_tp1HitBar < 0',
    (src.match(/if strat_tp1HitBar\s*<\s*0 and/g) || []).length >= 2);
}

// ═══════════════════════════════════════════════════════════════
// [8] TP per-tranche tracking — partial fills don't close position
// ═══════════════════════════════════════════════════════════════
// The indicator's step 2 (TP) used to close the whole position on any
// tranche hit — a v1 simplification that broke multi-tranche tracking.
// Symptom: after TP1 fires, the indicator goes flat, so TP2/TP3 /
// structural exit lose reference to the original pos_entry/pos_entry_bar.
// A later rawShort (for the next trade) then enters a phantom position
// and the structural exit fires against THAT bar rather than the real
// position still held by the strategy. Observed as a 24-hour gap between
// runtime structural exit and the indicator's close_all signal.
//
// Fix: per-tranche `var bool tpN_fired` flags. Step 2 skips already-fired
// tranches, sets the flag on hit, and leaves pos_dir/pos_entry/etc alone
// so later tranches and the structural exit keep working against the
// same reference bar. bar_exit still fires so SL arm / structural can't
// double-up on the same bar. Flags reset on every new-position entry
// (step 5 goLong/goShort, step 4 reversal) and on position-closing
// exits (step 0 SL deferred, step 1 ESL, step 4 structural/time).
{
  console.log('\n[8] TP per-tranche tracking — partial fills keep position open');

  const { result: indResult8, hydrated: hyd8 } = generateFull();
  const ind = indResult8.source;

  // Count active TP tranches in the fixture (mirrors the codegen logic).
  const tgParams = hyd8.exits.target.params;
  const active = [];
  for (let n = 1; n <= 6; n++) {
    if (tgParams[`tp${n}Pct`] > 0 && tgParams[`tp${n}Mult`] > 0) active.push(n);
  }
  active.sort((a, b) => tgParams[`tp${a}Mult`] - tgParams[`tp${b}Mult`]);

  // ── var declarations for each active tranche ──
  for (const n of active) {
    assertTrue(`var tp${n}_fired declared`,
      new RegExp(`var bool\\s+tp${n}_fired\\s*=\\s*false`).test(ind));
  }

  // ── Step 2 gates each tranche by `not tpN_fired` ──
  // Without the gate, a tranche could fire multiple times if price sweeps
  // back through it (e.g. retest). The runtime only fills each tranche once.
  for (const n of active) {
    assertTrue(`tp${n}_hit gated by not tp${n}_fired`,
      new RegExp(`bool\\s+tp${n}_hit\\s*=\\s*not\\s+tp${n}_fired\\s+and`).test(ind));
  }

  // ── Step 2 sets tpN_fired := true (does NOT close position) ──
  for (const n of active) {
    assertTrue(`tp${n}_fired set to true on hit`,
      new RegExp(`if\\s+tp${n}_hit\\s*\\n\\s+tp${n}_fired\\s*:=\\s*true`).test(ind));
  }

  // ── Step 2 does NOT flatten pos_dir on TP hit ──
  // The whole point of the fix: pos_dir/pos_entry/etc must stay intact
  // so later tranches and the structural exit reference the same bar.
  const step2Block = (() => {
    const lines = ind.split('\n');
    const start = lines.findIndex(l => l.includes('(2) TP'));
    if (start < 0) return '';
    // Step 2 ends at step 3 header or step 4 header (whichever appears).
    let end = lines.findIndex((l, i) => i > start &&
      (l.includes('(3) Arm') || l.includes('(4) Structural')));
    if (end < 0) end = lines.length;
    return lines.slice(start, end).join('\n');
  })();
  assertTrue('step 2 does NOT reset pos_dir',
    !/pos_dir\s*:=\s*0/.test(step2Block));
  assertTrue('step 2 does NOT reset pos_entry',
    !/pos_entry\s*:=\s*na/.test(step2Block));
  assertTrue('step 2 does NOT reset pos_entry_bar',
    !/pos_entry_bar\s*:=\s*na/.test(step2Block));
  assertTrue('step 2 does NOT reset sl_armed',
    !/sl_armed\s*:=\s*false/.test(step2Block));

  // ── Step 2 still sets bar_exit + bar_exit_reason (so other steps see it) ──
  // Even though the position stays open, marking bar_exit prevents step 3
  // (SL arm) and step 4 (structural) from double-triggering on the same bar.
  assertTrue('step 2 sets bar_exit := true',
    /if\s+tp1_hit.*\n[\s\S]*?bar_exit\s*:=\s*true/.test(step2Block));
  assertTrue('step 2 sets bar_exit_reason with chained TP ternary',
    /bar_exit_reason\s*:=\s*tp\d_hit\s*\?\s*"TP1"/.test(step2Block));

  // ── Flag resets on every new-position entry ──
  // goLong / goShort must reset flags so the new position starts fresh.
  const firstTranche = `tp${active[0]}_fired := false`;
  const goLongBlock = (() => {
    const i = ind.indexOf('if goLong');
    const j = ind.indexOf('if goShort', i);
    return ind.slice(i, j);
  })();
  const goShortBlock = (() => {
    const i = ind.indexOf('if goShort');
    // goShort is the last block in emitExitStateMachine — slice to end of function
    return ind.slice(i);
  })();
  assertTrue('goLong resets tp_fired flags', goLongBlock.includes(firstTranche));
  assertTrue('goShort resets tp_fired flags', goShortBlock.includes(firstTranche));

  // ── Flag resets inside the step 4 structural/reversal block ──
  // When a reversal fires, the opposite-direction position that step 4
  // immediately opens needs clean flags (no carry-over from prior position).
  const step4Block = (() => {
    const lines = ind.split('\n');
    const start = lines.findIndex(l => l.includes('(4) Structural'));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && l.includes('(5) Entry'));
    return lines.slice(start, end < 0 ? lines.length : end).join('\n');
  })();
  assertTrue('step 4 resets tp_fired flags', step4Block.includes(firstTranche));

  // ── Flag resets on SL-deferred fill (step 0) and ESL (step 1) ──
  // These close the position, so the next entry (any direction) starts clean.
  const step0Block = (() => {
    const lines = ind.split('\n');
    const start = lines.findIndex(l => l.includes('(0) Deferred SL'));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && l.includes('(1) ESL'));
    return lines.slice(start, end < 0 ? lines.length : end).join('\n');
  })();
  assertTrue('step 0 (SL deferred) resets tp_fired flags',
    step0Block.includes(firstTranche));

  const step1Block = (() => {
    const lines = ind.split('\n');
    const start = lines.findIndex(l => l.includes('(1) ESL'));
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && l.includes('(2) TP'));
    return lines.slice(start, end < 0 ? lines.length : end).join('\n');
  })();
  assertTrue('step 1 (ESL) resets tp_fired flags',
    step1Block.includes(firstTranche));
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`pine-wundertrading-check: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
