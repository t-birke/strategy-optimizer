/**
 * ui-pine-export-check — regression gate for Phase 4.6.
 *
 * Phase 4.6 added a one-click Pine indicator export from a winning run's
 * detail page. Three things wired up together:
 *
 *   1. UI: a "Pine Export" card on the run-detail page with a button
 *      that POSTs to /api/runs/:id/pine-export and shows path / hash /
 *      title / source preview.
 *
 *   2. Wiring: openRunDetail toggles the button's disabled state based
 *      on `run.spec_hash` — Pine codegen requires a hydrated spec, so
 *      legacy GA runs (no spec) get a disabled button + tooltip rather
 *      than a click-into-error UX.
 *
 *   3. API: POST /api/runs/:id/pine-export pulls the stored spec via
 *      `getSpec(spec_hash)`, hydrates the gene through buildParamSpace,
 *      runs `generateEntryAlertsPine`, writes a content-addressable
 *      file `<spec.name>-<hash12>.pine`, and returns a JSON envelope.
 *      Idempotent: re-clicking returns `reused: true` and doesn't
 *      rewrite the file.
 *
 * Sections:
 *   [1] DOM: card, button, status, result divs declared in index.html.
 *   [2] JS wiring: window.generatePine + openRunDetail button-state
 *       branch on `run.spec_hash`.
 *   [3] Server contract: success path (file written, response shape,
 *       idempotency), plus the 4xx error paths the UI relies on.
 *
 * Output isolation: OPTIMIZER_PINE_OUT_DIR points the endpoint at a
 * tmpdir so this gate doesn't dirty the repo's real pine/generated/
 * tree — same pattern as OPTIMIZER_DB_PATH for the DB.
 */

import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Set both env vars BEFORE importing routes/db modules — both read them
// at module-load time (DB) or first-request time (pine out dir).
const TMP_DIR = await mkdtemp(join(tmpdir(), 'pine-export-check-'));
process.env.OPTIMIZER_DB_PATH = join(TMP_DIR, 'test.duckdb');
process.env.OPTIMIZER_PINE_OUT_DIR = join(TMP_DIR, 'pine-out');

// DuckDB returns timestamps as BigInt; the API JSON-serializes them.
BigInt.prototype.toJSON = function() { return Number(this); };

const [
  { default: routes },
  { exec },
  { upsertSpec },
  { validateSpec },
  { buildParamSpace },
  registry,
] = await Promise.all([
  import('../api/routes.js'),
  import('../db/connection.js'),
  import('../db/specs.js'),
  import('../engine/spec.js'),
  import('../optimizer/param-space.js'),
  import('../engine/blocks/registry.js'),
]);

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}
function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passCount++; console.log(`  ✓ ${label}`); }
  else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
}
async function readText(relPath) {
  return readFile(resolve(ROOT, relPath), 'utf8');
}
const contains = (h, n) => h.includes(n);

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
  // ── 1. DOM declared in index.html ───────────────────────────
  console.log('\n[1] index.html: Pine Export card + button + status + result');
  {
    const html = await readText('ui/index.html');
    assertTrue('detail-pine-card div present',
      /id="detail-pine-card"/.test(html));
    assertTrue('btn-pine-export button present',
      /id="btn-pine-export"/.test(html));
    assertTrue('button onclick wired to generatePine()',
      /onclick="generatePine\(\)"/.test(html));
    assertTrue('pine-export-status span present',
      /id="pine-export-status"/.test(html));
    assertTrue('pine-export-result container present',
      /id="pine-export-result"/.test(html));
    // Card should sit on the run-detail page, not the optimizer index —
    // a quick sanity check to stop someone from accidentally moving it.
    const pineCardIdx = html.indexOf('id="detail-pine-card"');
    const detailPageIdx = html.indexOf('id="page-run-detail"');
    assertTrue('detail-pine-card lives inside page-run-detail',
      detailPageIdx > -1 && pineCardIdx > detailPageIdx);
  }

  // ── 2. ui/app.js: generatePine + button-state wiring ────────
  console.log('\n[2] ui/app.js: generatePine handler + openRunDetail button state');
  const appJs = await readText('ui/app.js');
  {
    assertTrue('window.generatePine defined',
      /window\.generatePine\s*=\s*async\s*\(/.test(appJs));
    assertTrue('generatePine POSTs to /api/runs/${detailRunId}/pine-export',
      /fetch\(\s*`\/api\/runs\/\$\{detailRunId\}\/pine-export`\s*,\s*\{\s*method:\s*['"]POST['"]/.test(appJs));
    // Server tells UI when the file already existed; UI must reflect that.
    assertTrue('generatePine renders reused state distinctly',
      /data\.reused/.test(appJs) && /Already generated/.test(appJs));
    // Source HTML-escape — Pine code contains <= which would otherwise
    // be eaten by the DOM. This is a real footgun, lock it in.
    assertTrue('generatePine HTML-escapes data.source',
      /esc\(data\.source\)/.test(appJs));
    // Button state: spec-mode enables, legacy disables.
    assertTrue('openRunDetail looks up btn-pine-export',
      /getElementById\(\s*['"]btn-pine-export['"]\s*\)/.test(appJs));
    assertTrue('openRunDetail enables button when isSpecMode',
      /isSpecMode[\s\S]{0,300}pineBtn\.disabled\s*=\s*false/.test(appJs));
    assertTrue('openRunDetail disables button for legacy runs',
      /pineBtn\.disabled\s*=\s*true/.test(appJs));
    // Tooltip on the disabled button explains *why* — without it a user
    // staring at a greyed-out button has zero context.
    assertTrue('disabled-button tooltip mentions spec-mode requirement',
      /pineBtn\.title\s*=\s*['"][^'"]*spec-mode[^'"]*['"]/.test(appJs));
    // Status/result are reset on detail open so a stale "Generated" from
    // a previous run doesn't appear under the new run's button.
    assertTrue('openRunDetail resets pine-export-status on open',
      /pineStatus\.textContent\s*=\s*['"]['"]/.test(appJs));
    assertTrue('openRunDetail resets pine-export-result on open',
      /pineResult\.innerHTML\s*=\s*['"]['"]/.test(appJs));
  }

  // ── 3. Server contract ──────────────────────────────────────
  console.log('\n[3] Server: POST /api/runs/:id/pine-export contract');

  // Seed: load and upsert the real legacy spec, build paramSpace, draw
  // a deterministic-enough gene (just a randomIndividual — what matters
  // is that hydration succeeds, not the specific values).
  await registry.ensureLoaded();
  const specPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
  const rawSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const spec = validateSpec(rawSpec, { sourcePath: specPath });
  await upsertSpec(spec);
  const paramSpace = buildParamSpace(spec);
  const gene = paramSpace.randomIndividual();
  const geneRaw = JSON.stringify(gene).replace(/'/g, "''");

  const SPEC_RUN_ID    = 9999990;
  const LEGACY_RUN_ID  = 9999991;
  const NO_GENE_RUN_ID = 9999992;
  const MISSING_SPEC_RUN_ID = 9999993;

  await exec(`DELETE FROM runs WHERE id IN (${SPEC_RUN_ID}, ${LEGACY_RUN_ID}, ${NO_GENE_RUN_ID}, ${MISSING_SPEC_RUN_ID})`);
  // Spec-mode happy-path run.
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash, best_gene)
     VALUES (${SPEC_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'completed',
             '${spec.hash}', '${geneRaw}')`,
  );
  // Legacy-mode run (no spec_hash).
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, best_gene)
     VALUES (${LEGACY_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'completed',
             '${JSON.stringify({ emaFast: 14 }).replace(/'/g, "''")}')`,
  );
  // Spec-mode run, but no best_gene yet (mid-optimization).
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash)
     VALUES (${NO_GENE_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'running',
             '${spec.hash}')`,
  );
  // Spec-mode run pointing at a spec_hash that doesn't exist (spec deleted).
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash, best_gene)
     VALUES (${MISSING_SPEC_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'completed',
             'sha256-nonexistent-xyz', '${geneRaw}')`,
  );

  const app = await startApp();
  let firstResponseFilename = null;
  let firstResponsePath = null;
  try {
    // ── 3a. Happy path ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/${SPEC_RUN_ID}/pine-export`,
        { method: 'POST' },
      );
      assertTrue('spec-mode run returns 200',
        r.status === 200, `got ${r.status}`);
      const body = await r.json();
      // Response shape — every field the UI renders.
      for (const key of ['path', 'filename', 'hash12', 'title', 'shortTitle', 'bytes', 'lines', 'source', 'reused']) {
        assertTrue(`response includes "${key}"`, key in body);
      }
      assertTrue('hash12 is 12 hex chars',
        typeof body.hash12 === 'string' && /^[0-9a-f]{12}$/.test(body.hash12));
      assertTrue('filename matches "<spec.name>-<hash12>.pine"',
        body.filename === `${spec.name}-${body.hash12}.pine`);
      // Output dir must honor OPTIMIZER_PINE_OUT_DIR — otherwise the gate
      // would dirty the repo's real pine/generated/ tree.
      assertTrue('path lives under OPTIMIZER_PINE_OUT_DIR',
        body.path.startsWith(resolve(process.env.OPTIMIZER_PINE_OUT_DIR)));
      assertTrue('source is non-empty Pine code',
        typeof body.source === 'string' && body.source.length > 100);
      assertTrue('source starts with //@version=5 (Pine v5 declaration)',
        /^\/\/@version=5/m.test(body.source));
      assertTrue('bytes matches source length', body.bytes === body.source.length);
      assertTrue('lines matches source line count',
        body.lines === body.source.split('\n').length);
      assertTrue('first call has reused: false', body.reused === false);

      // File must actually exist on disk.
      let fileExists = false;
      try { await stat(body.path); fileExists = true; } catch {}
      assertTrue('written .pine file exists on disk', fileExists);

      firstResponseFilename = body.filename;
      firstResponsePath = body.path;
    }

    // ── 3b. Idempotency: re-call returns reused: true, same path ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/${SPEC_RUN_ID}/pine-export`,
        { method: 'POST' },
      );
      assertTrue('repeat call still 200', r.status === 200);
      const body = await r.json();
      assertTrue('repeat call has reused: true', body.reused === true);
      assertTrue('repeat call returns same filename', body.filename === firstResponseFilename);
      assertTrue('repeat call returns same path', body.path === firstResponsePath);
    }

    // ── 3c. 404 for unknown run id ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/8888888/pine-export`,
        { method: 'POST' },
      );
      assertTrue('unknown run returns 404', r.status === 404);
      const body = await r.json();
      assertTrue('unknown-run error mentions run not found',
        typeof body.error === 'string' && /run not found/i.test(body.error));
    }

    // ── 3d. 400 for legacy run (no spec_hash) ──
    // The button is pre-disabled in the UI for this case, but the
    // server must guard too — the UI guard is best-effort, not security.
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/${LEGACY_RUN_ID}/pine-export`,
        { method: 'POST' },
      );
      assertTrue('legacy run returns 400', r.status === 400);
      const body = await r.json();
      assertTrue('legacy error mentions spec-mode requirement',
        typeof body.error === 'string' && /spec/i.test(body.error));
    }

    // ── 3e. 400 for run with no best_gene yet ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/${NO_GENE_RUN_ID}/pine-export`,
        { method: 'POST' },
      );
      assertTrue('no-gene run returns 400', r.status === 400);
      const body = await r.json();
      assertTrue('no-gene error mentions gene',
        typeof body.error === 'string' && /gene/i.test(body.error));
    }

    // ── 3f. 404 for run pointing at missing spec ──
    // Distinguishes "spec was deleted post-run" from a bad run id, so
    // the UI can produce a more useful error than "Run not found".
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/api/runs/${MISSING_SPEC_RUN_ID}/pine-export`,
        { method: 'POST' },
      );
      assertTrue('missing-spec run returns 404', r.status === 404);
      const body = await r.json();
      assertTrue('missing-spec error mentions spec hash',
        typeof body.error === 'string' && /spec.*not found/i.test(body.error));
    }
  } finally {
    try {
      await exec(`DELETE FROM runs WHERE id IN (${SPEC_RUN_ID}, ${LEGACY_RUN_ID}, ${NO_GENE_RUN_ID}, ${MISSING_SPEC_RUN_ID})`);
    } catch { /* ignore */ }
    await app.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  await cleanupTmpDir();
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
  process.exit(0);
}

async function cleanupTmpDir() {
  try { await rm(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch(async err => {
  console.error('FATAL:', err);
  await cleanupTmpDir();
  process.exit(1);
});
