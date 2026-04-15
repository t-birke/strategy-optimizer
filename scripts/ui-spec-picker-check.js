/**
 * ui-spec-picker-check — structural test for Phase 4.3b spec picker.
 *
 * The picker lives entirely in `ui/index.html` + `ui/app.js`. A full
 * headless-browser test would pull in jsdom/Puppeteer for a feature this
 * small, so we instead do three lightweight checks that together cover
 * the wiring:
 *
 *   1. DOM: index.html declares the new picker elements
 *      (`#modal-spec`, `#modal-spec-desc`, `#modal-spec-warn`) inside
 *      the new-run modal, in the expected structure.
 *
 *   2. JS wiring: app.js
 *        a. Fetches `/api/specs` when the modal opens.
 *        b. Populates the picker with an option per spec + preserves
 *           the "None (legacy mode)" default.
 *        c. Reads the picker value on Start and conditionally includes
 *           `spec: <filename>` in the POST body (omits the key in
 *           legacy mode — must not be null/undefined).
 *        d. Renders the selected spec's description on change.
 *
 *   3. Server contract: GET /api/specs returns the shape the picker
 *      expects (`{ specs: [{ filename, name, description }], malformed: [] }`).
 *      Covered more comprehensively by spec-api-check; repeated here as
 *      a smoke check so a 4.3b-only run catches an accidental break.
 *
 * Not covered here: the POST /api/runs round-trip with `spec: <filename>`.
 * That's exercised by queue-drain-check's happy path when real candles are
 * present, and by the existing POST /api/runs validation surface.
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
  console.log('\n[1] DOM: picker elements declared in ui/index.html');
  {
    const html = await readText('ui/index.html');
    // The <select id="modal-spec"> must live inside the new-run modal. We
    // verify "inside" by slicing from the modal's opening container to the
    // closing </div> of the actions row, then asserting the picker id is
    // within that slice.
    const modalStart = html.indexOf('id="modal-new-run"');
    // The modal is the last major block in index.html (followed only by the
    // </body> + </html> closers), so slice to end-of-file. Using the next
    // "<!--" would stop prematurely at any comment the picker itself carries.
    assertTrue('modal-new-run block is present', modalStart > -1);
    const slice = modalStart > -1 ? html.slice(modalStart) : html;

    assertTrue('slice contains <select id="modal-spec">',
      contains(slice, 'id="modal-spec"'));
    assertTrue('default "None (legacy mode)" option with empty value',
      contains(slice, '<option value="">None (legacy mode)</option>'));
    assertTrue('description line container present',
      contains(slice, 'id="modal-spec-desc"'));
    assertTrue('warning line container present (display:none by default)',
      contains(slice, 'id="modal-spec-warn"') && contains(slice, 'display:none'));
    // Picker must sit BEFORE the GA-param fields so the user sees it first.
    const pickerIdx = slice.indexOf('id="modal-spec"');
    const popIdx    = slice.indexOf('id="modal-pop"');
    assertTrue('picker appears before Population input',
      pickerIdx > -1 && popIdx > -1 && pickerIdx < popIdx);
  }

  // ── 2. JS wiring in app.js ───────────────────────────────────
  console.log('\n[2] JS: wiring in ui/app.js');
  {
    const js = await readText('ui/app.js');

    // 2a. loadSpecsIntoModal fetches /api/specs.
    assertTrue('defines loadSpecsIntoModal function',
      contains(js, 'function loadSpecsIntoModal'));
    assertTrue('loadSpecsIntoModal calls fetch(\'/api/specs\')',
      /loadSpecsIntoModal[\s\S]{0,800}fetch\('\/api\/specs'\)/.test(js));
    assertTrue('btn-new-run handler awaits loadSpecsIntoModal',
      /btn-new-run[\s\S]{0,1500}await\s+loadSpecsIntoModal\(\)/.test(js));

    // 2b. Populates options + keeps the None default.
    assertTrue('preserves None default on repopulation',
      contains(js, "<option value=\"\">None (legacy mode)</option>"));
    assertTrue('creates an <option> per spec via createElement',
      contains(js, "document.createElement('option')"));

    // 2c. Start handler reads the picker and conditionally sets body.spec.
    assertTrue('Start handler reads modal-spec value',
      /document\.getElementById\('modal-spec'\)\??\.value/.test(js));
    assertTrue('Start handler only adds spec when non-empty',
      /if\s*\(\s*specFilename\s*\)\s*body\.spec\s*=\s*specFilename/.test(js));
    // Legacy mode must NOT include a spec key. Verify no unconditional
    // `body.spec = ...` that would set it for every POST.
    assertTrue('no unconditional body.spec assignment',
      !/\n\s*body\.spec\s*=\s*specFilename\s*;/.test(js.replace(
        /if\s*\(\s*specFilename\s*\)\s*body\.spec\s*=\s*specFilename\s*;/g, '')));

    // 2d. Change handler renders description.
    assertTrue('change handler on modal-spec updates description',
      /getElementById\('modal-spec'\)\.addEventListener\('change'/.test(js));
    assertTrue('description lookup reads specsByFilename',
      contains(js, 'specsByFilename['));
  }

  // ── 3. Server contract: /api/specs shape matches what the UI reads ──
  console.log('\n[3] Server: GET /api/specs returns the shape the picker reads');
  const app = await startApp();
  try {
    const r = await fetch(`http://127.0.0.1:${app.port}/api/specs`);
    assertTrue('GET /api/specs returns 200', r.status === 200);
    const body = await r.json();
    assertTrue('body.specs is an array', Array.isArray(body.specs));
    assertTrue('body.malformed is an array', Array.isArray(body.malformed));
    for (const s of body.specs) {
      assertTrue(`spec ${s.filename}: has filename`, typeof s.filename === 'string');
      assertTrue(`spec ${s.filename}: has name`, typeof s.name === 'string');
      assertTrue(`spec ${s.filename}: description is string or null`,
        s.description === null || typeof s.description === 'string');
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
