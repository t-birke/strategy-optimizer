/**
 * pine-deploy — non-destructive TradingView push for generated Pine indicators.
 *
 * Wraps the `tradingview-mcp-jackson` CLI (`tv pine <sub>`, JSON on stdout) into
 * the 7-step flow we agreed on:
 *
 *   1. pine-codegen                  → generate the .pine source in-memory
 *   2. tv pine check                 → offline pre-flight compile; abort on errors
 *   3. tv pine list                  → collision check on indicator() title
 *   4. tv pine new indicator         → creates a fresh editor tab (NOT setValue-over)
 *                                      — reject if `warning` field set (destructive fallback fired)
 *   5. tv pine set --file <tmp>      → inject generated source into the new tab
 *   6. tv pine save                  → Ctrl+S → TV Save dialog auto-fills name from
 *                                      the indicator() first arg, our save-helper
 *                                      clicks the dialog's Save button
 *   7. tv pine compile (smart)       → "Add to chart" + poll Monaco markers
 *   8. tv pine open <title>          → round-trip: fetch back, confirm persistence
 *
 * Flags:
 *   --spec <path>         override spec file (default: migration-gate spec)
 *   --allow-overwrite     proceed even if a TV script with the same title exists
 *                         (default: abort — MEMORY.md rule: never overwrite)
 *   --dry-run             do steps 1-3 only (codegen + pre-flight compile + list);
 *                         write the .pine locally and print what WOULD happen
 *   --keep-tmp            don't delete the tmp .pine file after push
 *
 * Exit codes:
 *   0  success
 *   1  usage / internal error
 *   2  TV connection failure (propagated from tv CLI exit code 2)
 *   3  pre-flight compile failed
 *   4  title collision (without --allow-overwrite)
 *   5  destructive-fallback detected in pine_new
 *   6  TV compile errored after push
 *   7  round-trip verification failed
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { generateEntryAlertsPine } from '../engine/pine-codegen.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TV_CLI = resolve(ROOT, '..', 'tradingview-mcp-jackson', 'src', 'cli', 'index.js');
const DEFAULT_SPEC = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');

// Keep BTC-winner gene in sync with scripts/parity-gate.js :: LEGACY_PARAMS and
// scripts/pine-export.js :: BTC_LEGACY. Duplicated rather than shared because
// the three consumers are independent entry points.
const BTC_LEGACY = {
  minEntry: 2,
  stochLen: 39, stochSmth: 6,
  rsiLen: 16,
  emaFast: 14, emaSlow: 135,
  bbLen: 40, bbMult: 3,
  atrLen: 24, atrSL: 3.25,
  tp1Mult: 2.5, tp2Mult: 6, tp3Mult: 7,
  tp1Pct: 10, tp2Pct: 10,
  riskPct: 5,
  maxBars: 25,
  emergencySlPct: 25,
};

function buildBtcGene(paramSpace, p = BTC_LEGACY) {
  const g = paramSpace.randomIndividual();
  const set = (qid, v) => { if (Object.prototype.hasOwnProperty.call(g, qid)) g[qid] = v; };
  set('_meta.entries.threshold', p.minEntry);
  set('stochCross.main.stochLen',  p.stochLen);
  set('stochCross.main.stochSmth', p.stochSmth);
  set('emaTrend.main.emaFast', p.emaFast);
  set('emaTrend.main.emaSlow', p.emaSlow);
  set('bbSqueezeBreakout.main.bbLen',  p.bbLen);
  set('bbSqueezeBreakout.main.bbMult', p.bbMult);
  set('atrHardStop.main.atrLen',         p.atrLen);
  set('atrHardStop.main.atrSL',          p.atrSL);
  set('atrHardStop.main.emergencySlPct', p.emergencySlPct);
  set('atrScaleOutTarget.main.atrLen',  p.atrLen);
  set('atrScaleOutTarget.main.tp1Mult', p.tp1Mult);
  set('atrScaleOutTarget.main.tp2Mult', p.tp2Mult);
  set('atrScaleOutTarget.main.tp3Mult', p.tp3Mult);
  set('atrScaleOutTarget.main.tp1Pct',  p.tp1Pct);
  set('atrScaleOutTarget.main.tp2Pct',  p.tp2Pct);
  set('atrScaleOutTarget.main.tp3Pct',  100 - p.tp1Pct - p.tp2Pct);
  set('structuralExit.main.stochLen',  p.stochLen);
  set('structuralExit.main.stochSmth', p.stochSmth);
  set('structuralExit.main.rsiLen',    p.rsiLen);
  set('structuralExit.main.maxBars',   p.maxBars);
  set('atrRisk.main.riskPct', p.riskPct);
  return g;
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
function geneHash(gene) {
  return createHash('sha256').update(canonicalJson(gene)).digest('hex').slice(0, 12);
}

// Parse `indicator("Title", "Short", ...)` first string arg out of Pine source
// so we can collision-check before sending. If the regex misses, abort — we'd
// rather fail loud than push a script with a mystery title.
function extractIndicatorTitle(source) {
  const m = /^\s*indicator\(\s*"((?:[^"\\]|\\.)*)"/m.exec(source);
  if (!m) throw new Error('pine-deploy: could not extract indicator() title from generated source');
  return m[1];
}

// ─── tv CLI wrapper ───────────────────────────────────────────

/**
 * Shell out to `node <tv_cli> <subsystem> <args...>`, parse JSON stdout.
 * Stderr goes straight to our stderr for debuggability. Exit code 2 from the
 * tv CLI = connection failure; we propagate that through unchanged so callers
 * can tell "TV isn't running" from "TV ran your command and it errored".
 */
function runTv(subsystem, ...args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [TV_CLI, subsystem, ...args], { stdio: ['inherit', 'pipe', 'inherit'] });
    const stdoutChunks = [];
    child.stdout.on('data', d => stdoutChunks.push(d));
    child.on('error', reject);
    child.on('close', code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (code === 2) {
        const err = new Error('TV CLI reports connection failure (exit 2). Is TradingView open with the Chrome debug port?');
        err.exitCode = 2;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new Error(`tv ${subsystem} ${args.join(' ')} exited ${code}\n${stdout}`);
        err.exitCode = code;
        reject(err);
        return;
      }
      if (!stdout) { resolvePromise({}); return; }
      try { resolvePromise(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`tv ${subsystem} ${args.join(' ')} returned non-JSON stdout: ${stdout.slice(0, 200)}`)); }
    });
  });
}

// ─── CLI arg parsing ──────────────────────────────────────────

function parseArgs(argv) {
  const out = { spec: DEFAULT_SPEC, allowOverwrite: false, dryRun: false, keepTmp: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec')              out.spec = resolve(argv[++i]);
    else if (a === '--allow-overwrite') out.allowOverwrite = true;
    else if (a === '--dry-run')      out.dryRun = true;
    else if (a === '--keep-tmp')     out.keepTmp = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else throw new Error(`pine-deploy: unknown arg "${a}"`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/pine-deploy.js [options]

  --spec <path>         override spec file (default: migration-gate spec)
  --allow-overwrite     proceed even if a TV script with the same title exists
  --dry-run             codegen + pre-flight compile + list only; no TV push
  --keep-tmp            don't delete tmp .pine file
  -h, --help            show this help

Exit codes: 0 ok · 1 usage · 2 tv down · 3 pre-compile · 4 collision · 5 destructive
            6 post-compile errors · 7 round-trip failed`);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  console.log('\n=== pine-deploy ===\n');
  console.log(`spec:   ${args.spec}`);
  console.log(`mode:   ${args.dryRun ? 'DRY RUN' : 'LIVE'}${args.allowOverwrite ? ' (allow-overwrite)' : ''}`);

  // ─── Step 1: codegen ─────────────────────────────────────
  await registry.ensureLoaded();
  const rawSpec = JSON.parse(await readFile(args.spec, 'utf8'));
  const spec = validateSpec(rawSpec, { sourcePath: args.spec });
  const paramSpace = buildParamSpace(spec);
  const gene = buildBtcGene(paramSpace);
  const hydrated = paramSpace.hydrate(gene);
  const { source } = generateEntryAlertsPine({
    spec, hydrated,
    meta: { ticker: 'BTCUSDT', timeframe: '4H', source: 'scripts/pine-deploy.js  (BTC-4H tuned winner)' },
  });
  const title = extractIndicatorTitle(source);
  const ghash = geneHash(gene);
  console.log(`\n[1/8] codegen: "${title}"  (${source.length} bytes, ${source.split('\n').length} lines, gene=${ghash})`);

  // Persist locally so we have an artifact even if later steps fail
  const outDir = resolve(ROOT, 'pine/generated');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `${spec.name}-${ghash}.pine`);
  await writeFile(outPath, source, 'utf8');
  console.log(`      wrote: ${outPath}`);

  // ─── Step 2: offline pre-flight compile ──────────────────
  console.log('\n[2/8] tv pine check (offline compile)');
  const tmpPath = resolve(tmpdir(), `pine-deploy-${ghash}.pine`);
  await writeFile(tmpPath, source, 'utf8');
  try {
    const check = await runTv('pine', 'check', '--file', tmpPath);
    if (!check.compiled) {
      console.error(`      ❌ pre-flight compile FAILED — ${check.error_count} errors:`);
      for (const e of (check.errors ?? [])) {
        console.error(`         line ${e.line}: ${e.message}`);
      }
      process.exit(3);
    }
    console.log(`      ✓ clean compile (warnings: ${check.warning_count ?? 0})`);
    if (check.warnings?.length) {
      for (const w of check.warnings) console.log(`         ⚠ line ${w.line}: ${w.message}`);
    }
  } catch (e) {
    if (e.exitCode === 2) { console.error('      ' + e.message); process.exit(2); }
    throw e;
  }

  // ─── Step 3: collision check ─────────────────────────────
  console.log('\n[3/8] tv pine list (collision check)');
  const list = await runTv('pine', 'list');
  const collisions = (list.scripts ?? []).filter(s => s.name === title || s.title === title);
  if (collisions.length > 0) {
    console.log(`      ⚠ found ${collisions.length} existing script(s) with title "${title}":`);
    for (const c of collisions) console.log(`         • ${c.name}  (id=${c.id}, modified=${new Date(c.modified*1000).toISOString().slice(0,16)})`);
    if (!args.allowOverwrite) {
      console.error(`\n      ❌ aborting (pass --allow-overwrite to proceed anyway, MEMORY.md cautions against this)`);
      process.exit(4);
    }
    console.log(`      → proceeding because --allow-overwrite was passed`);
  } else {
    console.log(`      ✓ no collision`);
  }

  if (args.dryRun) {
    console.log('\n[dry-run] stopping here. Re-run without --dry-run to actually push.');
    if (!args.keepTmp) await unlink(tmpPath).catch(() => {});
    return;
  }

  // ─── Step 4: open a tab that will host our source ────────
  // Two paths:
  //  • fresh (no collision or collision but creating new): open a NEW blank
  //    indicator tab via the script-name dropdown. On save, TV opens a
  //    Save-As dialog naming the script from the indicator() literal.
  //  • overwrite (collision + --allow-overwrite): OPEN the existing script
  //    by title, then `pine set` replaces its source. On save, TV updates
  //    in-place — no "... 1" sibling is created.
  //
  // The overwrite path is required because TV's Save-As path auto-appends
  // " 1", " 2", ... to disambiguate against existing titles — `--allow-
  // overwrite` without opening first just creates a duplicate.
  const wantOverwrite = args.allowOverwrite && collisions.length > 0;
  if (wantOverwrite) {
    console.log('\n[4/8] open existing script (overwrite path)');
    const target = collisions[0];
    // Prefer opening by `name` (TV's unique display string); fall back to title.
    const openRes = await runTv('pine', 'open', target.name ?? target.title ?? title);
    if (!openRes?.success) {
      console.error(`      ❌ tv pine open failed for "${target.name ?? target.title}"`);
      process.exit(5);
    }
    console.log(`      ✓ opened "${openRes.name}" (id=${openRes.script_id ?? target.id}) for in-place update`);
    // Let the Monaco buffer swap in before step 5 injects.
    await new Promise(r => setTimeout(r, 500));
  } else {

  console.log('\n[4/8] new blank indicator tab (DOM sequence)');

  // 4.pre: ensure the Pine Editor panel is visible. If collapsed, the
  // nameButton selector returns nothing. Piggyback on the MCP's own
  // ensurePineEditorOpen() via a cheap pine subcommand.
  await runTv('pine', 'get').catch(() => {}); // ignore failure; just wakes the panel

  // 4a. Click the script-name dropdown in the Pine editor header.
  const clickName = `(function(){
    var btn = document.querySelector('[class*=nameButton-]');
    if (!btn) return { ok:false, step:'nameButton', err:'not found' };
    btn.click();
    return { ok:true, step:'nameButton' };
  })()`;
  const r4a = await runTv('ui', 'eval', clickName);
  if (!r4a?.result?.ok) {
    console.error(`      ❌ ${r4a?.result?.step}: ${r4a?.result?.err ?? 'unknown'}`);
    process.exit(5);
  }
  console.log(`      ✓ opened script-name dropdown`);

  // 4b. Hover "Create new" to reveal its submenu (dispatch pointer events,
  //     not just .click(), because the submenu is hover-triggered).
  const hoverCreateNew = `(function(){
    var items = document.querySelectorAll('[class*=button-HZXWyU6m]');
    for (var i=0;i<items.length;i++){
      var t = (items[i].textContent||'').trim();
      if (t === 'Create new' || t.indexOf('Create new') === 0) {
        ['mouseover','mouseenter','pointerover','pointerenter'].forEach(function(ev){
          items[i].dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window}));
        });
        return { ok:true, text:t };
      }
    }
    return { ok:false, err:'Create new menu item not found' };
  })()`;
  const r4b = await runTv('ui', 'eval', hoverCreateNew);
  if (!r4b?.result?.ok) {
    console.error(`      ❌ hover Create new: ${r4b?.result?.err ?? 'unknown'}`);
    process.exit(5);
  }
  // Let the submenu paint.
  await new Promise(r => setTimeout(r, 200));
  console.log(`      ✓ hovered "Create new"`);

  // 4c. Click the "Indicator" submenu entry. Its text is "Indicator⌘ K, ⌘ I".
  const clickIndicator = `(function(){
    var items = document.querySelectorAll('[class*=button-HZXWyU6m]');
    for (var i=0;i<items.length;i++){
      var t = (items[i].textContent||'').trim();
      if (t.indexOf('Indicator') === 0) {
        items[i].click();
        return { ok:true, text:t };
      }
    }
    return { ok:false, err:'Indicator submenu item not found' };
  })()`;
  const r4c = await runTv('ui', 'eval', clickIndicator);
  if (!r4c?.result?.ok) {
    console.error(`      ❌ click Indicator: ${r4c?.result?.err ?? 'unknown'}`);
    process.exit(5);
  }
  console.log(`      ✓ clicked "Indicator" — fresh tab opened`);
  // Give TV a beat to swap the Monaco buffer to the blank template.
  await new Promise(r => setTimeout(r, 400));
  } // end fresh-tab else

  // ─── Step 5: set source ──────────────────────────────────
  console.log('\n[5/8] tv pine set --file <tmp>');
  const setRes = await runTv('pine', 'set', '--file', tmpPath);
  console.log(`      ✓ injected ${setRes.lines_set ?? '?'} lines`);

  // ─── Step 6: save (toolbar Save button → MCP confirms dialog) ──
  // Critical gotcha: the MCP's `tv pine set` writes the buffer via Monaco's
  // model API, which does NOT fire the keyboard-level dirty tracker. So a
  // fresh Ctrl+S right after `pine set` is a no-op on some TV builds — the
  // editor sees "no unsaved changes" even though the source differs and the
  // toolbar Save button shows the `unsaved-` class.
  //
  // What works reliably: click the visible toolbar Save button
  // (`.saveButton-fF7iXGw2.unsaved-…`) directly with a full React pointer
  // sequence. That opens the "Save Script" dialog with the indicator()
  // title pre-populated. Then `tv pine save` (which presses Enter / clicks
  // the dialog's confirm button) reliably commits. Finally we poll the
  // toolbar button's class until it flips `unsaved-` → `saved-`.
  console.log('\n[6/8] tv pine save (toolbar click → dialog confirm)');

  const stateProbe = `(function(){
    var btn = document.querySelector('.saveButton-fF7iXGw2');
    if (!btn) return { found:false };
    var cls = btn.className || '';
    return {
      found: true,
      unsaved: cls.indexOf('unsaved-') >= 0,
      pending: cls.indexOf('pending-') >= 0,
      saved:   cls.indexOf('saved-')   >= 0,
      scriptName: (document.querySelector('[class*=nameButton-]')||{}).textContent || null
    };
  })()`;

  const initial = (await runTv('ui', 'eval', stateProbe))?.result;
  if (!initial?.found) {
    console.error('      ❌ toolbar .saveButton-fF7iXGw2 not found — is the Pine editor panel open?');
    process.exit(6);
  }
  if (!initial.unsaved) {
    console.log('      · buffer already clean (unexpected for a fresh injection — continuing anyway)');
  } else {
    console.log('      · buffer is unsaved — clicking toolbar Save button');
    const clickSave = `(function(){
      var btn = document.querySelector('.saveButton-fF7iXGw2');
      if (!btn) return { clicked:false, reason:'saveButton-fF7iXGw2 not found' };
      var r = btn.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      var opts = {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy, button:0, pointerId:1, pointerType:'mouse', isPrimary:true};
      btn.dispatchEvent(new PointerEvent('pointerover', opts));
      btn.dispatchEvent(new PointerEvent('pointerdown', opts));
      btn.dispatchEvent(new MouseEvent('mousedown',  opts));
      btn.focus();
      btn.dispatchEvent(new PointerEvent('pointerup', opts));
      btn.dispatchEvent(new MouseEvent('mouseup',    opts));
      btn.dispatchEvent(new MouseEvent('click',      opts));
      return { clicked:true };
    })()`;
    await runTv('ui', 'eval', clickSave);
    await new Promise(r => setTimeout(r, 400)); // let the Save dialog mount

    // Let the MCP confirm the dialog (it knows how to click the dialog's
    // Save button / press Enter in the name input).
    await runTv('pine', 'save');
  }

  // Poll up to 6s for the Save button class to flip to `saved-`.
  let committed = false;
  let lastState = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    lastState = (await runTv('ui', 'eval', stateProbe))?.result ?? null;
    if (lastState?.saved && !lastState.pending) { committed = true; break; }
  }
  if (!committed) {
    console.error(`      ❌ toolbar Save button never reached saved state (last: ${JSON.stringify(lastState)})`);
    process.exit(6);
  }
  console.log(`      ✓ toolbar shows saved, scriptName="${lastState.scriptName}"`);

  // Final sanity: confirm the script now shows up in the script list under
  // the expected title. If not, we didn't actually save.
  await new Promise(r => setTimeout(r, 500));
  const listAfterSave = await runTv('pine', 'list');
  const saved = (listAfterSave.scripts ?? []).find(s => s.name === title || s.title === title);
  if (!saved) {
    console.error(`      ❌ "${title}" not in pine list after save — save did not commit`);
    process.exit(6);
  }
  console.log(`      ✓ confirmed in list: id=${saved.id}`);

  // ─── Step 7: compile (Add/Update on chart) + error check ─
  console.log('\n[7/8] tv pine compile (smart)');
  const cmp = await runTv('pine', 'compile');
  // The MCP's `has_errors` lumps in Monaco warnings (severity 4) and hints
  // (severity 1) alongside real errors (severity 8). Only severity ≥ 8 is
  // actually blocking; lower severities get printed but don't abort.
  const rawMarkers = cmp.errors ?? [];
  const realErrors = rawMarkers.filter(e => (e.severity ?? 8) >= 8);
  const nonErrors  = rawMarkers.filter(e => (e.severity ?? 8) < 8);
  if (nonErrors.length) {
    for (const e of nonErrors) console.log(`      ⚠ line ${e.line}: ${e.message}`);
  }
  if (realErrors.length) {
    console.error(`      ❌ post-compile shows ${realErrors.length} error(s):`);
    for (const e of realErrors) console.error(`         line ${e.line}: ${e.message}`);
    process.exit(6);
  }
  console.log(`      ✓ clean compile (button: ${cmp.button_clicked}, study_added: ${cmp.study_added ?? 'unknown'})`);

  // ─── Step 8: round-trip verification ─────────────────────
  console.log('\n[8/8] tv pine open (round-trip)');
  try {
    const opened = await runTv('pine', 'open', title);
    if (!opened.success) {
      console.error(`      ❌ round-trip: tv pine open reported failure`);
      process.exit(7);
    }
    console.log(`      ✓ fetched back: "${opened.name}"  (id=${opened.script_id}, ${opened.lines} lines)`);
  } catch (e) {
    console.error(`      ❌ round-trip failed: ${e.message}`);
    process.exit(7);
  }

  if (!args.keepTmp) await unlink(tmpPath).catch(() => {});

  console.log('\n=== DONE ===');
  console.log(`saved as:  "${title}"`);
  console.log(`local:     ${outPath}`);
  console.log(`\nNext: on the TV chart, verify entry arrows on BTCUSDT/4H line up`);
  console.log(`       with the parity-gate entry timestamps.\n`);
}

main().catch(err => {
  console.error(`\npine-deploy: ${err.message}`);
  process.exit(err.exitCode ?? 1);
});
