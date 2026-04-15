/**
 * ui-spec-editor-check — structural test for Phase 4.3c spec authoring page.
 *
 * Same philosophy as ui-spec-picker-check: a full headless-browser test
 * would be overkill for a page this small, so we verify the wiring with
 * three lightweight checks that together cover the page end-to-end:
 *
 *   1. DOM: ui/index.html declares
 *        a. a Specs nav link (data-page="specs", href="#specs")
 *        b. a #page-specs container,
 *        c. all expected form fields (name, desc, regime, entries mode +
 *           threshold + list + add button, filters mode + list + add
 *           button, three exit slots, sizing, JSON preview, copy button).
 *
 *   2. JS wiring in ui/app.js:
 *        a. loadBlocksForEditor exists, fetches /api/blocks, is called
 *           at init.
 *        b. Kind-filtered population helpers (blocksByKind/ByExitSlot).
 *        c. buildSpecFromUi emits the expected top-level keys.
 *        d. Render hook fires on every input/change that affects the spec.
 *        e. Copy-JSON button writes the preview to the clipboard.
 *
 *   3. Server contract: GET /api/blocks still returns the shape the
 *      editor reads (id/kind/exitSlot/params). Covered more thoroughly
 *      by spec-api-check; repeated as a smoke check so a 4.3c-only run
 *      catches an accidental contract break.
 *
 * Phase 4.3d (per-param narrowing), 4.3e (save-to-disk), and 4.4
 * (fitness config panel) are layered on top: we assert the Save button
 * + status line exist in the DOM, saveSpec() posts to /api/specs with
 * the overwrite fallback wired, the Fitness card renders every
 * weight/cap/gate control + Reset button, and the editor fetches the
 * recommended values from /api/defaults at init. End-to-end POST and
 * /api/defaults contract tests live in spec-api-check.
 */

import { readFile } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from '../api/routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}

async function readText(relPath) {
  return readFile(resolve(ROOT, relPath), 'utf8');
}

function contains(haystack, needle) {
  return haystack.includes(needle);
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise(res => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      res({
        port: server.address().port,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function main() {
  // ── 1. DOM markers in index.html ─────────────────────────────
  console.log('\n[1] DOM: Specs nav link + #page-specs + form fields');
  {
    const html = await readText('ui/index.html');

    // Nav link.
    assertTrue('Specs nav link declared',
      /<a [^>]*href="#specs"[^>]*data-page="specs"/.test(html)
      || /<a [^>]*data-page="specs"[^>]*href="#specs"/.test(html));

    // Page container.
    const pageStart = html.indexOf('id="page-specs"');
    assertTrue('#page-specs block is present', pageStart > -1);
    // Slice from #page-specs to the next `<div id="page-` so we assert
    // fields live *inside* this page, not in a neighbouring one.
    const nextPage = html.indexOf('id="page-', pageStart + 1);
    const slice = nextPage < 0 ? html.slice(pageStart) : html.slice(pageStart, nextPage);

    // Identity.
    assertTrue('spec-name input present', contains(slice, 'id="spec-name"'));
    assertTrue('spec-desc textarea present', contains(slice, 'id="spec-desc"'));

    // Regime.
    assertTrue('spec-regime select present', contains(slice, 'id="spec-regime"'));

    // Entries: mode + threshold (min + max) + list + add button.
    assertTrue('spec-entries-mode select present', contains(slice, 'id="spec-entries-mode"'));
    assertTrue('spec-entries-threshold-min input present', contains(slice, 'id="spec-entries-threshold-min"'));
    assertTrue('spec-entries-threshold-max input present', contains(slice, 'id="spec-entries-threshold-max"'));
    assertTrue('spec-entries-list container present', contains(slice, 'id="spec-entries-list"'));
    assertTrue('spec-entries-add button present', contains(slice, 'id="spec-entries-add"'));
    // Mode options: all/any/score.
    for (const mode of ['"all"', '"any"', '"score"']) {
      assertTrue(`entries mode option ${mode} declared`,
        new RegExp(`<select[^>]*id="spec-entries-mode"[\\s\\S]*?value=${mode}`).test(slice));
    }

    // Filters.
    assertTrue('spec-filters-mode select present', contains(slice, 'id="spec-filters-mode"'));
    assertTrue('spec-filters-list container present', contains(slice, 'id="spec-filters-list"'));
    assertTrue('spec-filters-add button present', contains(slice, 'id="spec-filters-add"'));

    // Three exit slots.
    assertTrue('spec-exit-hardstop select present', contains(slice, 'id="spec-exit-hardstop"'));
    assertTrue('spec-exit-target select present',   contains(slice, 'id="spec-exit-target"'));
    assertTrue('spec-exit-trail select present',    contains(slice, 'id="spec-exit-trail"'));

    // Sizing.
    assertTrue('spec-sizing select present', contains(slice, 'id="spec-sizing"'));
    assertTrue('spec-sizing-req hint container present', contains(slice, 'id="spec-sizing-req"'));

    // Block description containers — one per fixed picker so the UI can
    // show "what does this block do?" next to each slot.
    for (const id of [
      'spec-regime-desc',
      'spec-exit-hardstop-desc',
      'spec-exit-target-desc',
      'spec-exit-trail-desc',
      'spec-sizing-desc',
    ]) {
      assertTrue(`${id} container present`, contains(slice, `id="${id}"`));
    }

    // Param-narrowing containers (Phase 4.3d) — one per fixed picker so
    // the editor can render per-param min/max/step/pin controls under it.
    for (const id of [
      'spec-regime-params',
      'spec-exit-hardstop-params',
      'spec-exit-target-params',
      'spec-exit-trail-params',
      'spec-sizing-params',
    ]) {
      assertTrue(`${id} params container present`, contains(slice, `id="${id}"`));
    }

    // Preview + copy.
    assertTrue('spec-json-preview pre present', contains(slice, 'id="spec-json-preview"'));
    assertTrue('spec-copy-json button present', contains(slice, 'id="spec-copy-json"'));

    // Save to strategies/ (Phase 4.3e) — button + status line.
    assertTrue('spec-save button present', contains(slice, 'id="spec-save"'));
    assertTrue('spec-save-status container present',
      contains(slice, 'id="spec-save-status"'));

    // Fitness config panel (Phase 4.4): card + three weight sliders (each
    // with a value label + recommended-default chip), two cap inputs, three
    // gate inputs, sum indicator, and Reset button. If any of these are
    // missing, the user can't see OR edit the fitness config — both of
    // which are regressions we want to catch before the page ships.
    assertTrue('spec-fitness-card present',   contains(slice, 'id="spec-fitness-card"'));
    assertTrue('spec-fitness-reset button present',
      contains(slice, 'id="spec-fitness-reset"'));

    // Weight sliders: three range inputs, each with -val and -def siblings.
    for (const w of ['pf', 'dd', 'ret']) {
      assertTrue(`spec-fitness-w-${w} slider present`,
        contains(slice, `id="spec-fitness-w-${w}"`));
      assertTrue(`spec-fitness-w-${w}-val label present`,
        contains(slice, `id="spec-fitness-w-${w}-val"`));
      assertTrue(`spec-fitness-w-${w}-def recommended-chip present`,
        contains(slice, `id="spec-fitness-w-${w}-def"`));
    }
    assertTrue('spec-fitness-w-sum indicator present',
      contains(slice, 'id="spec-fitness-w-sum"'));

    // Caps.
    for (const c of ['pf', 'ret']) {
      assertTrue(`spec-fitness-cap-${c} input present`,
        contains(slice, `id="spec-fitness-cap-${c}"`));
      assertTrue(`spec-fitness-cap-${c}-def chip present`,
        contains(slice, `id="spec-fitness-cap-${c}-def"`));
    }

    // Gates.
    for (const g of ['mintrades', 'regimepf', 'wfemin']) {
      assertTrue(`spec-fitness-gate-${g} input present`,
        contains(slice, `id="spec-fitness-gate-${g}"`));
      assertTrue(`spec-fitness-gate-${g}-def chip present`,
        contains(slice, `id="spec-fitness-gate-${g}-def"`));
    }
  }

  // ── 2. JS wiring in app.js ───────────────────────────────────
  console.log('\n[2] JS: wiring in ui/app.js');
  {
    const js = await readText('ui/app.js');

    // 2a. Catalog + loader.
    assertTrue('defines blocksById map', /const\s+blocksById\s*=\s*\{\}/.test(js));
    assertTrue('defines loadBlocksForEditor function',
      /(async\s+function|function)\s+loadBlocksForEditor\b/.test(js));
    assertTrue('loadBlocksForEditor calls fetch(\'/api/blocks\')',
      /loadBlocksForEditor[\s\S]{0,800}fetch\('\/api\/blocks'\)/.test(js));
    assertTrue('init calls loadBlocksForEditor',
      /(^|\n)\s*loadBlocksForEditor\(\)/.test(js));

    // 2b. Kind filters used by the pickers.
    assertTrue('defines blocksByKind helper',  /function\s+blocksByKind\b/.test(js));
    assertTrue('defines blocksByExitSlot helper', /function\s+blocksByExitSlot\b/.test(js));
    // Each exit slot is populated separately.
    for (const slot of ['hardStop', 'target', 'trail']) {
      assertTrue(`populateSpecEditorPickers populates ${slot}`,
        new RegExp(`spec-exit-${slot.toLowerCase() === 'hardstop' ? 'hardstop' : slot}[\\s\\S]{0,200}blocksByExitSlot\\('${slot}'\\)`).test(js)
        || new RegExp(`blocksByExitSlot\\('${slot}'\\)[\\s\\S]{0,200}spec-exit-${slot.toLowerCase() === 'hardstop' ? 'hardstop' : slot}`).test(js));
    }
    assertTrue('sizing picker excludes None option',
      /populateSelect\(\s*'spec-sizing'[^)]*includeNone:\s*false/.test(js));

    // 2c. buildSpecFromUi emits all expected top-level keys.
    assertTrue('defines buildSpecFromUi', /function\s+buildSpecFromUi\b/.test(js));
    for (const key of ['name', 'description', 'regime', 'entries', 'filters', 'exits', 'sizing', 'constraints', 'fitness', 'walkForward']) {
      assertTrue(`buildSpecFromUi emits "${key}"`,
        new RegExp(`return\\s*\\{[\\s\\S]*?\\b${key}\\b`).test(js));
    }
    // Each instanceId defaults to "main" for 4.3c.
    assertTrue('block entries use instanceId:"main"',
      /instanceId:\s*'main'/.test(js));

    // 2d. Render hook + live updates. The central renderer must be wired
    // to the fixed inputs, and add-block buttons must trigger it too.
    assertTrue('defines renderSpecPreview', /function\s+renderSpecPreview\b/.test(js));
    // Every fixed-input id must appear in the listener-array loop.
    for (const id of [
      'spec-name', 'spec-desc', 'spec-regime',
      'spec-entries-mode', 'spec-entries-threshold-min', 'spec-entries-threshold-max',
      'spec-filters-mode',
      'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail',
      'spec-sizing',
    ]) {
      assertTrue(`'${id}' is wired to renderSpecPreview`,
        new RegExp(`'${id}'`).test(js));
    }
    assertTrue('entries-add button triggers addEntryRow',
      /spec-entries-add[\s\S]{0,120}addEntryRow/.test(js));
    assertTrue('filters-add button triggers addFilterRow',
      /spec-filters-add[\s\S]{0,120}addFilterRow/.test(js));

    // 2e. Copy-JSON handler.
    assertTrue('copy-json handler reads #spec-json-preview',
      /spec-copy-json[\s\S]{0,400}spec-json-preview/.test(js));
    assertTrue('copy-json handler writes to navigator.clipboard',
      /navigator\.clipboard\.writeText/.test(js));

    // 2f. Threshold row auto-hides when mode !== 'score'.
    assertTrue('threshold row hides when mode !== score',
      /spec-entries-threshold-row[\s\S]{0,200}mode\s*===\s*'score'/.test(js)
      || /mode\s*===\s*'score'[\s\S]{0,200}spec-entries-threshold-row/.test(js));

    // 2g. Block description rendering — both the fixed-picker helper and
    // the per-row inline description must be wired up so users can see
    // what each block does without leaving the editor.
    assertTrue('defines blockDescriptionFor helper',
      /function\s+blockDescriptionFor\b/.test(js));
    assertTrue('defines updateBlockDescription helper',
      /function\s+updateBlockDescription\b/.test(js));
    // There must be a for-of loop over the fixed-picker ids that passes
    // each id to updateBlockDescription. Asserts each picker id appears
    // within 400 chars before the updateBlockDescription() call.
    for (const id of ['spec-regime', 'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail', 'spec-sizing']) {
      assertTrue(`${id} is fed to updateBlockDescription`,
        new RegExp(`'${id}'[\\s\\S]{0,400}updateBlockDescription\\(`).test(js));
    }
    // Row-level description line in makeBlockRow.
    assertTrue('makeBlockRow renders an inline block description',
      /makeBlockRow[\s\S]{0,2500}blockDescriptionFor\(/.test(js));

    // 2h. Per-param narrowing controls (Phase 4.3d). The editor must be
    // able to render one control row per declared param (min/max/step or
    // pin), and buildSpecFromUi must read those overrides into the emitted
    // JSON — otherwise narrowing has no effect on the preview.
    assertTrue('defines makeParamControlRow helper',
      /function\s+makeParamControlRow\b/.test(js));
    assertTrue('defines renderParamControls helper',
      /function\s+renderParamControls\b/.test(js));
    assertTrue('defines readParamOverrides helper',
      /function\s+readParamOverrides\b/.test(js));

    // Fixed pickers hand their -params container to renderParamControls
    // both on init (populateSpecEditorPickers) and on change.
    for (const id of ['spec-regime', 'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail', 'spec-sizing']) {
      assertTrue(`${id}-params is fed to renderParamControls`,
        new RegExp(`'${id}'[\\s\\S]{0,400}renderParamControls\\(`).test(js));
    }

    // makeBlockRow must attach a per-row params container and re-render
    // it when the block selection changes.
    assertTrue('makeBlockRow creates a .spec-params container',
      /makeBlockRow[\s\S]{0,2500}class(?:Name|=)?\s*=?\s*['"]spec-params['"]/.test(js));
    assertTrue('makeBlockRow renders param controls on select change',
      /makeBlockRow[\s\S]{0,3000}renderParamControls\(/.test(js));

    // blockRefToSpec/buildSpecFromUi must feed the params container (not
    // just the block id) so overrides reach the emitted JSON.
    assertTrue('blockRefToSpec accepts a params container',
      /function\s+blockRefToSpec\s*\([^)]*,\s*\w+/.test(js));
    assertTrue('buildSpecFromUi uses readRows (per-row params plumbing)',
      /readRows\('spec-entries-list'\)/.test(js)
      && /readRows\('spec-filters-list'\)/.test(js));
    // Pin emits {value}; unpinned emits {min,max,step}. Both shapes must
    // be present in the override reader.
    assertTrue('readParamOverrides emits {value} for pinned params',
      /readParamOverrides[\s\S]{0,2500}value\s*:/.test(js));
    assertTrue('readParamOverrides emits {min,max,step} for ranged params',
      /readParamOverrides[\s\S]{0,3500}min\s*:[\s\S]{0,200}max\s*:[\s\S]{0,200}step\s*:/.test(js));

    // 2i. Save-to-disk wiring (Phase 4.3e). The Save button must POST the
    // output of buildSpecFromUi to /api/specs, handle the 409-overwrite
    // fallback via confirm(), and surface 400 validation errors in the
    // status line so users know WHY their spec didn't save.
    assertTrue('defines saveSpec function', /(async\s+function|function)\s+saveSpec\b/.test(js));
    assertTrue('saveSpec fetches POST /api/specs',
      // URL may be built into a variable before fetch() — just assert that
      // both the endpoint path and a fetch() call appear inside saveSpec,
      // and that the method is POST somewhere nearby.
      /saveSpec[\s\S]{0,1500}\/api\/specs[\s\S]{0,1500}fetch\(/.test(js)
      && /saveSpec[\s\S]{0,1500}method:\s*['"]POST['"]/.test(js));
    assertTrue('saveSpec uses buildSpecFromUi as body',
      /saveSpec[\s\S]{0,1200}buildSpecFromUi\(\)/.test(js));
    assertTrue('saveSpec handles overwrite via ?overwrite=1',
      /overwrite=1/.test(js));
    assertTrue('saveSpec prompts confirm() on 409',
      /409[\s\S]{0,600}confirm\(/.test(js)
      || /confirm\([\s\S]{0,600}overwrite/i.test(js));
    assertTrue('saveSpec writes to #spec-save-status',
      /spec-save-status/.test(js));
    assertTrue('spec-save button click triggers saveSpec',
      /spec-save[\s\S]{0,200}saveSpec\b/.test(js));

    // 2j. Fitness config panel wiring (Phase 4.4). The editor must
    // fetch recommended defaults from /api/defaults at init, expose
    // readFitnessFromUi so buildSpecFromUi has a real source for the
    // fitness shape (no more hardcoded defaults), and wire the Reset
    // button to re-apply the cached defaults.
    assertTrue('defines loadFitnessDefaults',
      /(async\s+function|function)\s+loadFitnessDefaults\b/.test(js));
    assertTrue('loadFitnessDefaults fetches /api/defaults',
      /loadFitnessDefaults[\s\S]{0,600}fetch\(\s*['"]\/api\/defaults['"]\)/.test(js));
    assertTrue('init calls loadFitnessDefaults',
      /(^|\n)\s*loadFitnessDefaults\(\)/.test(js));

    assertTrue('defines readFitnessFromUi',
      /function\s+readFitnessFromUi\b/.test(js));
    assertTrue('buildSpecFromUi uses readFitnessFromUi',
      /buildSpecFromUi[\s\S]{0,4000}readFitnessFromUi\(\)/.test(js));

    // buildSpecFromUi must NOT hardcode the old fitness literal any more.
    // If it regresses back to a literal object, the Reset/Edit plumbing
    // is bypassed silently — catch that here.
    assertTrue('buildSpecFromUi does NOT hardcode weights literal',
      !/buildSpecFromUi[\s\S]{0,4000}weights:\s*\{\s*pf:\s*0\.5,\s*dd:\s*0\.3,\s*ret:\s*0\.2/.test(js));

    assertTrue('defines applyFitnessDefaultsToUi',
      /function\s+applyFitnessDefaultsToUi\b/.test(js));
    assertTrue('defines updateWeightLabels',
      /function\s+updateWeightLabels\b/.test(js));

    // Every fitness input id is in the preview-render listener array.
    for (const id of [
      'spec-fitness-w-pf', 'spec-fitness-w-dd', 'spec-fitness-w-ret',
      'spec-fitness-cap-pf', 'spec-fitness-cap-ret',
      'spec-fitness-gate-mintrades', 'spec-fitness-gate-regimepf', 'spec-fitness-gate-wfemin',
    ]) {
      assertTrue(`'${id}' is wired to renderSpecPreview`,
        new RegExp(`'${id}'`).test(js));
    }

    // Reset button wires to applyFitnessDefaultsToUi.
    assertTrue('spec-fitness-reset triggers applyFitnessDefaultsToUi',
      /spec-fitness-reset[\s\S]{0,300}applyFitnessDefaultsToUi/.test(js));
    // Weight sliders update the live value labels on input.
    assertTrue('weight sliders update label on input',
      /spec-fitness-w-(pf|dd|ret)[\s\S]{0,300}updateWeightLabels/.test(js));
  }

  // ── 3. Server contract: GET /api/blocks shape matches editor reads ──
  console.log('\n[3] Server: GET /api/blocks returns the shape the editor reads');
  const app = await startApp();
  try {
    const r = await fetch(`http://127.0.0.1:${app.port}/api/blocks`);
    assertTrue('GET /api/blocks returns 200', r.status === 200);
    const body = await r.json();
    assertTrue('body.blocks is an array', Array.isArray(body.blocks));
    // The editor reads id, version, kind, exitSlot, sizingRequirements,
    // params[].{id, type, min, max, step}. Every block must expose those
    // fields (values may be null for exitSlot/sizingRequirements).
    const KINDS = new Set(['entry', 'filter', 'exit', 'sizing', 'regime']);
    for (const b of body.blocks) {
      assertTrue(`block ${b.id}: has id (string)`, typeof b.id === 'string');
      assertTrue(`block ${b.id}: kind is known`, KINDS.has(b.kind));
      assertTrue(`block ${b.id}: version is a number`, typeof b.version === 'number');
      assertTrue(`block ${b.id}: params is an array`, Array.isArray(b.params));
      // Exit blocks MUST declare exitSlot (the editor filters on it).
      if (b.kind === 'exit') {
        assertTrue(`block ${b.id}: exitSlot in {hardStop,target,trail}`,
          ['hardStop', 'target', 'trail'].includes(b.exitSlot));
      }
      // Params: the editor reads id + {min,max,step} to emit the spec.
      for (const p of b.params) {
        assertTrue(`block ${b.id}.${p.id}: has param id`, typeof p.id === 'string');
        assertTrue(`block ${b.id}.${p.id}: has type int/float`,
          p.type === 'int' || p.type === 'float');
      }
    }
  } finally {
    await app.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
