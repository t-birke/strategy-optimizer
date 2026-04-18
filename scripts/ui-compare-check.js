/**
 * ui-compare-check — structural gate for Phase 4.5b's compare-runs page.
 *
 * Same three-section layout as ui-run-detail-check (DOM, JS wiring,
 * server round-trip) but scoped to the side-by-side compare view:
 *
 *   [1] DOM: index.html declares #page-compare with mirrored
 *       Walk-Forward Report cards (`detail-wf-card-a` / `-b`), the
 *       mismatch banner + empty-state note, and the compare-mode
 *       toolbar on the runs-table (checkbox column, toggle button,
 *       Compare (N) button, count + hint spans).
 *
 *   [2] JS wiring in ui/app.js:
 *        a. renderWalkForwardReport accepts an `idSuffix` parameter
 *           (so the compare page can reuse it for both columns).
 *        b. openCompare / renderCompareColumn / highlightCompareWindows
 *           are defined.
 *        c. openCompare fans out via Promise.all over two /api/runs/:id
 *           fetches and routes the result through renderWalkForwardReport
 *           with suffixes '-a' / '-b'.
 *        d. Hash-route handler `routeCompareFromHash` registered on
 *           the `hashchange` event — so pasting a URL works.
 *        e. Compare-toggle / compare-go / select-all / per-row
 *           checkbox event listeners are wired.
 *        f. closeCompare() returns to the optimizer page.
 *        g. Behavioral: extract highlightCompareWindows and confirm it
 *           flags a clear winner while ignoring near-ties.
 *
 *   [3] Server contract: seed two runs with different WF reports and
 *       confirm GET /api/runs/:id returns each `wf_report_json` as a
 *       parsed object with the expected scheme / windows / wfe.
 *       Reuses the OPTIMIZER_DB_PATH temp-DB pattern from the 4.5a
 *       gate so this test coexists with a running dev server.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Throwaway temp DB so the gate coexists with a running dev server
// holding the main DB's write lock. Must happen before the db/api
// imports — those read OPTIMIZER_DB_PATH at module eval time.
const TMP_DIR = await mkdtemp(join(tmpdir(), 'compare-check-'));
process.env.OPTIMIZER_DB_PATH = join(TMP_DIR, 'test.duckdb');

// Match server.js's BigInt→JSON shim. DuckDB returns timestamps and
// some ids as BigInts; res.json would otherwise 500.
BigInt.prototype.toJSON = function() { return Number(this); };

const [{ default: routes }, { exec, query }] = await Promise.all([
  import('../api/routes.js'),
  import('../db/connection.js'),
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
  // ── 1. DOM markers in index.html ────────────────────────────
  console.log('\n[1] DOM: compare page + runs-list toolbar');
  {
    const html = await readText('ui/index.html');

    // Slice the compare page for scoped assertions. New Run modal sits
    // after most pages in this file and contains its own tables, so
    // globally grepping for column headers would yield false positives.
    const pageStart = html.indexOf('id="page-compare"');
    assertTrue('#page-compare block is present', pageStart > -1);
    const nextPage = html.indexOf('id="page-', pageStart + 1);
    const slice = nextPage < 0 ? html.slice(pageStart) : html.slice(pageStart, nextPage);

    // Mismatch banner + empty-state note containers.
    assertTrue('compare-mismatch-banner present', contains(slice, 'id="compare-mismatch-banner"'));
    assertTrue('compare-mismatch-body present',   contains(slice, 'id="compare-mismatch-body"'));
    assertTrue('compare-empty-note present',      contains(slice, 'id="compare-empty-note"'));
    assertTrue('compare-title present',           contains(slice, 'id="compare-title"'));

    // Two-column grid with suffixed WF cards.
    assertTrue('.compare-grid wrapper present',   contains(slice, 'class="compare-grid"'));
    for (const suffix of ['-a', '-b']) {
      assertTrue(`compare-header-body${suffix} present`, contains(slice, `id="compare-header-body${suffix}"`));
      assertTrue(`detail-wf-card${suffix} present`,      contains(slice, `id="detail-wf-card${suffix}"`));
      assertTrue(`detail-wf-summary${suffix} present`,   contains(slice, `id="detail-wf-summary${suffix}"`));
      assertTrue(`detail-wf-table${suffix} present`,     contains(slice, `id="detail-wf-table${suffix}"`));
      assertTrue(`detail-wf-tbody${suffix} present`,     contains(slice, `id="detail-wf-tbody${suffix}"`));
    }
    // Both columns must declare the per-window columns; we check the
    // column-A slice specifically so a partial copy-paste into only
    // one column would still fail.
    const sliceColA = slice.slice(0, slice.indexOf('detail-wf-card-b'));
    for (const th of ['Window', 'IS trades', 'IS PF', 'IS net %', 'OOS trades', 'OOS PF', 'OOS net %']) {
      assertTrue(`col A declares "${th}" column`, contains(sliceColA, th));
    }

    // Hidden nav link (mirrors nav-run-detail's pattern — the user
    // arrives via the toolbar button, not top nav). Attribute order is
    // not fixed by HTML so check both attrs independently on an <a>.
    const navMatch = html.match(/<a\b[^>]*\bid="nav-compare"[^>]*>/);
    assertTrue('#nav-compare link declared', !!navMatch);
    assertTrue('#nav-compare carries data-page="compare"',
      !!navMatch && /data-page="compare"/.test(navMatch[0]));
    assertTrue('#nav-compare hidden by default',
      !!navMatch && /style="[^"]*display:\s*none/.test(navMatch[0]));

    // Runs-table compare toolbar in #page-optimizer.
    assertTrue('btn-compare-toggle present', contains(html, 'id="btn-compare-toggle"'));
    assertTrue('btn-compare-go present',     contains(html, 'id="btn-compare-go"'));
    assertTrue('compare-count span present', contains(html, 'id="compare-count"'));
    assertTrue('compare-hint span present',  contains(html, 'id="compare-hint"'));

    // Compare column in the runs-table header.
    assertTrue('runs-table has .compare-col <th>',
      /<th class="compare-col"[^>]*>\s*<input[^>]*id="compare-select-all"/.test(html));
  }

  // ── 2. JS wiring in app.js ──────────────────────────────────
  console.log('\n[2] JS: compare wiring in ui/app.js');
  const js = await readText('ui/app.js');
  {
    // renderWalkForwardReport grew an optional idSuffix param.
    assertTrue('renderWalkForwardReport signature includes idSuffix',
      /function\s+renderWalkForwardReport\s*\(\s*wf\s*,\s*idSuffix\s*=\s*''\s*\)/.test(js));
    // …and actually uses it when looking up DOM nodes.
    assertTrue('renderWalkForwardReport interpolates idSuffix into IDs',
      /getElementById\(`detail-wf-(card|summary|tbody)\$\{idSuffix\}`\)/.test(js));

    // Compare helpers.
    assertTrue('defines openCompare',             /async\s+function\s+openCompare\s*\(/.test(js));
    assertTrue('defines renderCompareColumn',     /function\s+renderCompareColumn\s*\(/.test(js));
    assertTrue('defines highlightCompareWindows', /function\s+highlightCompareWindows\s*\(/.test(js));

    // openCompare fans out via Promise.all over /api/runs/:id.
    assertTrue('openCompare uses Promise.all for parallel fetches',
      /openCompare[\s\S]{0,1500}Promise\.all/.test(js));
    assertTrue('openCompare fetches /api/runs/${id}',
      /openCompare[\s\S]{0,2000}fetch\(\s*`\/api\/runs\/\$\{\s*id\s*\}`\s*\)/.test(js));

    // renderCompareColumn routes WF data through the shared helper
    // with the per-column suffix — proving the refactor is actually
    // wired up (not just declared).
    assertTrue('renderCompareColumn calls renderWalkForwardReport with suffix',
      /renderCompareColumn[\s\S]{0,2000}renderWalkForwardReport\(\s*run\??\.wf_report_json\s*,\s*suffix\s*\)/.test(js));

    // Hash routing: #compare?ids=a,b bookmarkability.
    assertTrue('defines routeCompareFromHash',
      /function\s+routeCompareFromHash\b/.test(js));
    assertTrue('routeCompareFromHash matches #compare prefix',
      /routeCompareFromHash[\s\S]{0,300}hash\.startsWith\(\s*['"]#compare['"]\s*\)/.test(js));
    assertTrue('routeCompareFromHash parses ids=',
      /routeCompareFromHash[\s\S]{0,600}ids=\(\[\^\&\]\+\)/.test(js));
    assertTrue('hashchange listener registered',
      /addEventListener\(\s*['"]hashchange['"]\s*,\s*routeCompareFromHash\s*\)/.test(js));

    // Compare-mode state + toolbar wiring.
    assertTrue('selectedRunIds Set declared',
      /const\s+selectedRunIds\s*=\s*new\s+Set\(\)/.test(js));
    assertTrue('compareMode flag declared', /let\s+compareMode\s*=\s*false/.test(js));
    assertTrue('btn-compare-toggle click handler registered',
      /getElementById\(\s*['"]btn-compare-toggle['"]\s*\)\?\.addEventListener\(\s*['"]click['"]/.test(js));
    assertTrue('btn-compare-go click handler registered',
      /getElementById\(\s*['"]btn-compare-go['"]\s*\)\?\.addEventListener\(\s*['"]click['"]/.test(js));
    assertTrue('btn-compare-go sets location.hash to #compare?ids=',
      /location\.hash\s*=\s*`#compare\?ids=\$\{ids\.join\([^)]*\)\}`/.test(js));
    assertTrue('select-all checkbox wired',
      /getElementById\(\s*['"]compare-select-all['"]\s*\)\?\.addEventListener\(\s*['"]change['"]/.test(js));
    assertTrue('per-row checkbox delegated on tbody',
      /querySelector\(\s*['"]#runs-table tbody['"]\s*\)\?\.addEventListener\(\s*['"]change['"]/.test(js));

    // renderRunsList emits per-row checkbox + applyCompareModeToTable
    // is re-applied after rebuilds.
    assertTrue('runs-table row emits .compare-row-check input',
      /class="compare-row-check"[\s\S]{0,100}data-run-id/.test(js));
    assertTrue('runs-table row wraps checkbox in .compare-col cell',
      /class="compare-col"\s+style="display:none"\s+onclick="event\.stopPropagation\(\)"/.test(js));
    assertTrue('loadRuns reapplies compare mode after rebuild',
      /if\s*\(\s*compareMode\s*\)\s*applyCompareModeToTable\(\)/.test(js));
    // Expand row colspan bumped to 16 to cover the new compare column.
    assertTrue('expand row colspan bumped to 16 for compare column',
      /class="expand-row"[\s\S]{0,200}colspan="16"/.test(js));

    // closeCompare returns to optimizer + hides nav breadcrumb.
    assertTrue('closeCompare resets nav to optimizer',
      /window\.closeCompare\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,800}data-page="optimizer"/.test(js));
    assertTrue('closeCompare hides #nav-compare',
      /window\.closeCompare[\s\S]{0,800}nav-compare['"]\s*\)\s*\.style\.display\s*=\s*['"]none['"]/.test(js));

    // Highlight threshold: 10% gap. Drift here would either show too
    // many winners (noise) or too few (useful gaps go uncoloured).
    assertTrue('highlightCompareWindows uses 10% gap threshold',
      /function\s+highlightCompareWindows[\s\S]{0,800}gap\s*<\s*0\.10/.test(js));
    assertTrue('highlightCompareWindows applies cmp-best / cmp-worst classes',
      /highlightCompareWindows[\s\S]{0,2000}cmp-best[\s\S]{0,500}cmp-worst/.test(js));

    // Mismatch banner: scheme + nWindows checks.
    assertTrue('openCompare flags scheme mismatch',
      /openCompare[\s\S]{0,4000}wfA\.scheme\s*!==\s*wfB\.scheme/.test(js));
    assertTrue('openCompare flags nWindows mismatch',
      /openCompare[\s\S]{0,4000}wfA\.nWindows\s*!==\s*wfB\.nWindows/.test(js));
  }

  // ── 2b. Behavioral: extract highlightCompareWindows and run it ──
  console.log('\n[2b] Behavioral: highlightCompareWindows with mock DOM');
  {
    // Grab just the function source.
    const fnSrc = js.match(
      /function\s+highlightCompareWindows\s*\([^)]*\)\s*\{[\s\S]*?\n\}/
    )?.[0];
    assertTrue('extracted highlightCompareWindows source', !!fnSrc);

    if (fnSrc) {
      // Tiny DOM stub — highlightCompareWindows only needs
      // querySelectorAll('#detail-wf-tbody-a tr') and the returned
      // elements' classList.add().
      function makeRow() {
        const classes = new Set();
        return {
          classList: {
            add: (c) => classes.add(c),
            has: (c) => classes.has(c),
          },
        };
      }
      const rowsA = [makeRow(), makeRow(), makeRow(), makeRow()];
      const rowsB = [makeRow(), makeRow(), makeRow(), makeRow()];
      const fakeDoc = {
        querySelectorAll(sel) {
          if (sel === '#detail-wf-tbody-a tr') return rowsA;
          if (sel === '#detail-wf-tbody-b tr') return rowsB;
          return [];
        },
      };

      // eslint-disable-next-line no-new-func
      const run = new Function(
        'document',
        `${fnSrc}\nreturn highlightCompareWindows;`,
      )(fakeDoc);

      // Window 0: A wins by huge margin (3.0 vs 1.0) — A green, B red.
      // Window 1: B wins by huge margin (0.8 vs 2.0) — A red, B green.
      // Window 2: near tie (1.05 vs 1.00) — neither class.
      // Window 3: one side Infinity — skipped (not finite numeric gap).
      run(
        { windows: [{ oosPf: 3.0 }, { oosPf: 0.8 }, { oosPf: 1.05 }, { oosPf: Infinity }] },
        { windows: [{ oosPf: 1.0 }, { oosPf: 2.0 }, { oosPf: 1.00 }, { oosPf: 1.0 }] },
      );

      assertTrue('window 0: A row got cmp-best',  rowsA[0].classList.has('cmp-best'));
      assertTrue('window 0: B row got cmp-worst', rowsB[0].classList.has('cmp-worst'));
      assertTrue('window 1: A row got cmp-worst', rowsA[1].classList.has('cmp-worst'));
      assertTrue('window 1: B row got cmp-best',  rowsB[1].classList.has('cmp-best'));
      assertTrue('window 2: near-tie skipped (A)',
        !rowsA[2].classList.has('cmp-best') && !rowsA[2].classList.has('cmp-worst'));
      assertTrue('window 2: near-tie skipped (B)',
        !rowsB[2].classList.has('cmp-best') && !rowsB[2].classList.has('cmp-worst'));
      assertTrue('window 3: Infinity skipped (A)',
        !rowsA[3].classList.has('cmp-best') && !rowsA[3].classList.has('cmp-worst'));
    }
  }

  // ── 3. Server contract: two runs round-trip their WF reports ────
  console.log('\n[3] Server: /api/runs/:id returns parsed wf_report_json for each run');
  const app = await startApp();
  try {
    // Two synthetic runs with meaningfully-different WF reports so the
    // compare page has real data to compare against (not just two
    // copies of the same report).
    const idA = 9999997;
    const idB = 9999996;
    const wfA = {
      scheme: 'anchored', nWindows: 3, warmup: 0, validWindows: 3,
      windows: [
        { index: 0, isTrades: 30, isPf: 1.5, isNetPct: 12, oosTrades: 10, oosPf: 1.2, oosNetPct: 4 },
        { index: 1, isTrades: 40, isPf: 1.8, isNetPct: 14, oosTrades: 12, oosPf: 1.5, oosNetPct: 5 },
        { index: 2, isTrades: 35, isPf: 2.0, isNetPct: 16, oosTrades: 11, oosPf: 1.8, oosNetPct: 6 },
      ],
      meanIsPf: 1.77, meanOosPf: 1.5, wfe: 0.85,
    };
    const wfB = {
      scheme: 'rolling', nWindows: 3, warmup: 0, validWindows: 3,
      windows: [
        { index: 0, isTrades: 25, isPf: 2.5, isNetPct: 20, oosTrades:  8, oosPf: 0.8, oosNetPct: -2 },
        { index: 1, isTrades: 30, isPf: 2.2, isNetPct: 18, oosTrades: 10, oosPf: 1.0, oosNetPct:  0 },
        { index: 2, isTrades: 28, isPf: 2.4, isNetPct: 22, oosTrades:  9, oosPf: 1.1, oosNetPct:  1 },
      ],
      meanIsPf: 2.37, meanOosPf: 0.97, wfe: 0.41,
    };
    const rawA = JSON.stringify(wfA).replace(/'/g, "''");
    const rawB = JSON.stringify(wfB).replace(/'/g, "''");

    await exec(`DELETE FROM runs WHERE id IN (${idA}, ${idB})`);
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status, wf_report_json)
       VALUES (${idA}, 'TEST/USDT', 60, '2024-01-01', 'completed', '${rawA}')`,
    );
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status, wf_report_json)
       VALUES (${idB}, 'TEST/USDT', 60, '2024-01-01', 'completed', '${rawB}')`,
    );

    try {
      const [rA, rB] = await Promise.all([
        fetch(`http://127.0.0.1:${app.port}/api/runs/${idA}`),
        fetch(`http://127.0.0.1:${app.port}/api/runs/${idB}`),
      ]);
      assertTrue('GET /api/runs/:idA returns 200', rA.status === 200);
      assertTrue('GET /api/runs/:idB returns 200', rB.status === 200);
      const bodyA = await rA.json();
      const bodyB = await rB.json();

      // Both WF reports come back as parsed objects (not strings).
      assertTrue('runA.wf_report_json is an object',
        bodyA.wf_report_json && typeof bodyA.wf_report_json === 'object');
      assertTrue('runB.wf_report_json is an object',
        bodyB.wf_report_json && typeof bodyB.wf_report_json === 'object');

      assertEq('runA.wf.scheme preserved', bodyA.wf_report_json.scheme, 'anchored');
      assertEq('runB.wf.scheme preserved', bodyB.wf_report_json.scheme, 'rolling');
      assertEq('runA.wf.windows length', bodyA.wf_report_json.windows.length, 3);
      assertEq('runB.wf.windows length', bodyB.wf_report_json.windows.length, 3);

      // Spot-check the windows that trigger highlights: window 0,
      // A.oosPf=1.2 vs B.oosPf=0.8 — a clear A-wins row past the 10%
      // threshold (gap = (1.2-0.8)/1.2 ≈ 33%).
      assertEq('runA.windows[0].oosPf', bodyA.wf_report_json.windows[0].oosPf, 1.2);
      assertEq('runB.windows[0].oosPf', bodyB.wf_report_json.windows[0].oosPf, 0.8);
    } finally {
      try { await exec(`DELETE FROM runs WHERE id IN (${idA}, ${idB})`); } catch { /* ignore */ }
    }
  } finally {
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
