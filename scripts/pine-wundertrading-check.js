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

  // ── New inputs in the Webhook group ──
  assertTrue('i_posSize input declared',
    src.includes('i_posSize = input.float('));
  assertTrue('i_posSize default 0.1',
    /i_posSize\s*=\s*input\.float\(0\.1/.test(src));
  assertTrue('i_leverage input declared',
    src.includes('i_leverage = input.int('));
  assertTrue('i_leverage default 1',
    /i_leverage\s*=\s*input\.int\(1,/.test(src));
  assertTrue('i_codeLong input declared',
    /i_codeLong\s*=\s*input\.string\("ENTER-LONG"/.test(src));
  assertTrue('i_codeShort input declared',
    /i_codeShort\s*=\s*input\.string\("ENTER-SHORT"/.test(src));
  assertTrue('i_codeExit input declared',
    /i_codeExit\s*=\s*input\.string\("EXIT-ALL"/.test(src));
  assertTrue('All inputs in GRP_WH group',
    [/i_posSize.*group=GRP_WH/, /i_leverage.*group=GRP_WH/,
     /i_codeLong.*group=GRP_WH/, /i_codeShort.*group=GRP_WH/,
     /i_codeExit.*group=GRP_WH/].every(r => r.test(src)));

  // ── Pre-computed ATR global vars ──
  assertTrue('wt_atr_tp declared',
    /float wt_atr_tp = nz\(atr_\w+\[1\]\)/.test(src));
  // SL ATR may or may not be separate (depends on gene's atrLen match).
  const tpAtrLen = hydrated.exits.target.params.atrLen;
  const slAtrLen = hydrated.exits.hardStop.params.atrLen;
  if (tpAtrLen !== slAtrLen) {
    assertTrue('wt_atr_sl declared (different atrLen)',
      /float wt_atr_sl = nz\(atr_\w+\[1\]\)/.test(src));
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

  for (const { n, mult, pct } of activeTranches) {
    assertTrue(`TP${n} price formula uses mult ${mult}`,
      src.includes(`close + wt_atr_tp * ${mult}`) &&
      src.includes(`close - wt_atr_tp * ${mult}`));
    const frac = (pct / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    assertTrue(`TP${n} portfolio fraction = ${frac}`,
      src.includes(`"portfolio":${frac}`));
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

  // ── f_exit_json — minimal close payload ──
  assertTrue('f_exit_json defined',
    src.includes('f_exit_json(string dir, string reason) =>'));
  assertTrue('exit payload uses i_codeExit',
    /f_exit_json[\s\S]*?i_codeExit/.test(src));
  assertTrue('exit payload is minimal (market + reduceOnly, no TPs)',
    (() => {
      const exitFn = src.split('f_exit_json(string dir, string reason) =>')[1]
                        ?.split('\n')[1] || '';
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
// [4] Backward compatibility
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
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`pine-wundertrading-check: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
