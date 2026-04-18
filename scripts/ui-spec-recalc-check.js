/**
 * ui-spec-recalc-check — regression gate for Phase 4.5c.
 *
 * Covers two bugs fixed together:
 *
 *   1. Strategy Parameters card rendered empty on spec-mode runs
 *      because `openRunDetail` iterated PARAM_LABELS (flat legacy keys
 *      like `emaFast`) while spec-mode genes use qualified IDs like
 *      `emaTrend.main.emaFast`. Fix: new `renderSpecGeneCards` helper
 *      alongside `renderLegacyGeneCards`, branch on `run.spec_hash`.
 *
 *   2. Recalculate button produced $0 for spec-mode runs because
 *      `/api/runs/:id/trades` always called the legacy JM Simple 3TP
 *      simulator (`runStrategy`). Fix: branch on `run.spec_hash` and
 *      route through `runSpec` with the stored spec + paramSpace +
 *      bundle — same pipeline island-worker uses.
 *
 * Sections:
 *   [1] Static: routes.js imports `runSpec` / `loadDataBundle` /
 *       `buildParamSpace`, the recalc endpoint reads `run.spec_hash`,
 *       and calls `runSpec`.
 *   [2] Static: app.js defines `renderSpecGeneCards`,
 *       `renderLegacyGeneCards`, `paramCardHtml`, and the openRunDetail
 *       branch on `run.spec_hash`.
 *   [2b] Behavioral: extract renderSpecGeneCards + deps and run them
 *       against a mock spec-mode gene + mock legacy gene, asserting
 *       the HTML contains expected keys/values.
 *   [3] Server contract: seed a run with `spec_hash` pointing at a
 *       missing spec and confirm the endpoint returns 404 with a
 *       "spec not found" error — proves the branch fires instead of
 *       silently falling through to the legacy simulator.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const TMP_DIR = await mkdtemp(join(tmpdir(), 'spec-recalc-check-'));
process.env.OPTIMIZER_DB_PATH = join(TMP_DIR, 'test.duckdb');

BigInt.prototype.toJSON = function() { return Number(this); };

const [{ default: routes }, { exec }] = await Promise.all([
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
  // ── 1. routes.js imports + spec branch ──────────────────────
  console.log('\n[1] routes.js: spec-mode branch in /api/runs/:id/trades');
  {
    const routesJs = await readText('api/routes.js');

    // New imports needed by the spec branch.
    assertTrue('imports runSpec from engine/runtime',
      /import\s*\{\s*runSpec\s*\}\s*from\s*['"][^'"]*engine\/runtime\.js['"]/.test(routesJs));
    assertTrue('imports loadDataBundle from engine/data-bundle',
      /import\s*\{\s*loadDataBundle\s*\}\s*from\s*['"][^'"]*engine\/data-bundle\.js['"]/.test(routesJs));
    assertTrue('imports buildParamSpace from optimizer/param-space',
      /import\s*\{\s*buildParamSpace\s*\}\s*from\s*['"][^'"]*optimizer\/param-space\.js['"]/.test(routesJs));

    // Slice the /api/runs/:id/trades handler so the branch check is
    // scoped — spec_hash / runSpec references elsewhere in the file
    // (e.g., Send-to-TV guards, run-detail GET) would give false
    // positives on a global grep.
    const handlerStart = routesJs.indexOf(`'/api/runs/:id/trades'`);
    assertTrue('/api/runs/:id/trades handler present', handlerStart > -1);
    // Handler ends at the next `router.` call after it.
    const afterHandler = routesJs.indexOf('router.', handlerStart + 20);
    const handler = routesJs.slice(handlerStart, afterHandler);

    assertTrue('handler reads run.spec_hash',
      /if\s*\(\s*run\.spec_hash\s*\)/.test(handler));
    assertTrue('handler calls registry.ensureLoaded()',
      /registry\.ensureLoaded\(\)/.test(handler));
    assertTrue('handler calls getSpec(run.spec_hash)',
      /getSpec\(\s*run\.spec_hash\s*\)/.test(handler));
    assertTrue('handler calls validateSpec',
      /validateSpec\(/.test(handler));
    assertTrue('handler calls buildParamSpace',
      /buildParamSpace\(/.test(handler));
    assertTrue('handler calls loadDataBundle',
      /loadDataBundle\(/.test(handler));
    assertTrue('handler calls runSpec with collectTrades + collectEquity',
      /runSpec\(\s*\{[\s\S]{0,400}collectTrades:\s*true[\s\S]{0,200}collectEquity:\s*true/.test(handler));
    assertTrue('handler echoes specMode: true in spec branch',
      /specMode:\s*true/.test(handler));
    assertTrue('handler echoes specMode: false in legacy branch',
      /specMode:\s*false/.test(handler));
    // Legacy branch still there — don't want to have accidentally
    // replaced it altogether.
    assertTrue('legacy branch still calls runStrategy',
      /runStrategy\(\s*candles\s*,\s*run\.best_gene/.test(handler));
  }

  // ── 2. app.js: spec-mode gene card renderer ─────────────────
  console.log('\n[2] app.js: renderSpecGeneCards / renderLegacyGeneCards');
  const appJs = await readText('ui/app.js');
  {
    assertTrue('defines renderSpecGeneCards',
      /function\s+renderSpecGeneCards\s*\(/.test(appJs));
    assertTrue('defines renderLegacyGeneCards',
      /function\s+renderLegacyGeneCards\s*\(/.test(appJs));
    assertTrue('defines paramCardHtml',
      /function\s+paramCardHtml\s*\(/.test(appJs));

    // openRunDetail branches on spec_hash to choose which renderer.
    assertTrue('openRunDetail defines isSpecMode from run.spec_hash',
      /const\s+isSpecMode\s*=\s*!!\s*run\.spec_hash/.test(appJs));
    assertTrue('openRunDetail calls renderSpecGeneCards when spec-mode',
      /isSpecMode\s*[\s\S]{0,100}renderSpecGeneCards\(\s*gene\s*\)/.test(appJs));
    assertTrue('openRunDetail falls back to renderLegacyGeneCards',
      /renderLegacyGeneCards\(\s*gene\s*\)/.test(appJs));

    // renderSpecGeneCards must handle the _meta.entries.threshold gene
    // (it's not owned by a block) — surfacing it would otherwise drop
    // silently and the spec editor promises it'd appear.
    assertTrue('renderSpecGeneCards surfaces _meta.entries.threshold',
      /function\s+renderSpecGeneCards[\s\S]{0,1500}_meta\.entries\.threshold/.test(appJs));

    // qid tooltip is the debugging escape hatch — without it a user
    // who sees an unexpected value has no way back to the raw key.
    assertTrue('paramCardHtml sets title=qid tooltip',
      /function\s+paramCardHtml[\s\S]{0,400}title="\$\{qid\}"/.test(appJs));
  }

  // ── 2b. Behavioral: run the spec-mode renderer ──────────────
  console.log('\n[2b] Behavioral: renderSpecGeneCards + renderLegacyGeneCards');
  {
    // Pull out the three functions + their dependency formatGeneNum so
    // we can exercise them outside the browser. Each match is a single
    // function body (non-greedy) — simplest possible extraction.
    function extract(name) {
      const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`);
      return appJs.match(re)?.[0];
    }
    const srcs = [
      extract('renderSpecGeneCards'),
      extract('renderLegacyGeneCards'),
      extract('paramCardHtml'),
      extract('formatGeneNum'),
    ];
    assertTrue('extracted all 4 renderer sources', srcs.every(s => !!s));

    // renderLegacyGeneCards reads the global PARAM_LABELS — stub with
    // just the keys we care about to keep this test self-contained.
    const PARAM_LABELS = {
      emaFast: { label: 'EMA Fast', unit: '',  desc: 'Fast EMA period' },
      emaSlow: { label: 'EMA Slow', unit: '',  desc: 'Slow EMA period' },
      riskPct: { label: 'Risk %',   unit: '%', desc: 'Capital risked per trade' },
      tp2Pct:  { label: 'TP2 %',    unit: '%', desc: 'Position % closed at TP2' },
      tp1Pct:  { label: 'TP1 %',    unit: '%', desc: 'Position % closed at TP1' },
    };
    const body = `
      ${srcs.filter(Boolean).join('\n\n')}
      return { renderSpecGeneCards, renderLegacyGeneCards, paramCardHtml, formatGeneNum };
    `;
    // eslint-disable-next-line no-new-func
    const mod = new Function('PARAM_LABELS', body)(PARAM_LABELS);

    // ── Spec-mode gene ──
    // Mix qualified IDs with _meta.entries.threshold and an ignored
    // _meta.* key to cover: (a) block grouping, (b) meta surfacing,
    // (c) unrecognized meta drop.
    const specGene = {
      'emaTrend.main.emaFast':   20,
      'emaTrend.main.emaSlow':   55,
      'stochCross.main.stochLen': 14,
      '_meta.entries.threshold': 2,
      '_meta.other.ignored':     99,
    };
    const specHtml = mod.renderSpecGeneCards(specGene);
    assertTrue('spec html mentions emaFast', contains(specHtml, 'emaFast'));
    assertTrue('spec html mentions emaSlow', contains(specHtml, 'emaSlow'));
    assertTrue('spec html mentions stochLen', contains(specHtml, 'stochLen'));
    assertTrue('spec html surfaces entries threshold value (2)',
      /Entries[\s\S]{0,400}>\s*2\s*</.test(specHtml));
    assertTrue('spec html does NOT include unrecognized _meta.other',
      !contains(specHtml, '_meta.other'));
    assertTrue('spec html carries qid tooltip for block param',
      contains(specHtml, 'title="emaTrend.main.emaFast"'));
    // subtitle is the block name when instance=='main'. The html
    // contains both the block name in the qid tooltip AND as a card
    // subtitle — assert the subtitle `<div>…emaTrend</div>` directly.
    assertTrue('spec html shows block name in subtitle (not the label)',
      />emaTrend<\/div>/.test(specHtml));
    // Numeric value rendering — 20 stays an int, not "20.0000".
    assertTrue('spec html renders 20 as int (no trailing zeros)',
      />\s*20\s*</.test(specHtml));

    // ── Legacy gene ──
    const legacyGene = { emaFast: 21, emaSlow: 55, riskPct: 1.5, tp1Pct: 40, tp2Pct: 35 };
    const legacyHtml = mod.renderLegacyGeneCards(legacyGene);
    assertTrue('legacy html mentions EMA Fast label',
      contains(legacyHtml, 'EMA Fast'));
    assertTrue('legacy html shows tp3Pct footnote at tp2 card',
      /\(TP3 gets 25%\)/.test(legacyHtml));
    assertTrue('legacy html renders 1.5 as "1.50"',
      /1\.50/.test(legacyHtml));
  }

  // ── 3. Server contract: missing-spec run returns 404 ────────
  console.log('\n[3] Server: spec-mode run with missing spec_hash');
  const app = await startApp();
  try {
    // A run that claims a spec_hash but the specs table has no
    // matching row — exactly the state that'd crop up if someone
    // deleted a spec mid-backtest. Branch must fire and produce a
    // clear "spec not found" error, NOT fall through to runStrategy.
    const runId = 9999995;
    const gene = {
      'emaTrend.main.emaFast': 20,
      'emaTrend.main.emaSlow': 50,
      '_meta.entries.threshold': 1,
    };
    const geneRaw = JSON.stringify(gene).replace(/'/g, "''");

    await exec(`DELETE FROM runs WHERE id = ${runId}`);
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash, best_gene)
       VALUES (${runId}, 'TEST/USDT', 60, '2024-01-01', 'completed',
               'sha256-nonexistent-spec-hash-for-test-only', '${geneRaw}')`,
    );

    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/runs/${runId}/trades`);
      assertTrue('endpoint returns 404 for missing spec (spec branch fired)',
        r.status === 404);
      const body = await r.json();
      assertTrue('error mentions spec not found',
        typeof body.error === 'string' && /spec.*not found/i.test(body.error));
    } finally {
      try { await exec(`DELETE FROM runs WHERE id = ${runId}`); } catch { /* ignore */ }
    }

    // Sanity: a legacy-style run (no spec_hash) with no gene should
    // trip the early "Run has no best gene yet" guard — confirms the
    // legacy branch still runs when spec_hash is null.
    const legacyRunId = 9999994;
    await exec(`DELETE FROM runs WHERE id = ${legacyRunId}`);
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status)
       VALUES (${legacyRunId}, 'TEST/USDT', 60, '2024-01-01', 'completed')`,
    );
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/runs/${legacyRunId}/trades`);
      assertTrue('legacy run without gene returns 400',
        r.status === 400);
      const body = await r.json();
      assertTrue('legacy-no-gene error mentions gene',
        typeof body.error === 'string' && /gene/i.test(body.error));
    } finally {
      try { await exec(`DELETE FROM runs WHERE id = ${legacyRunId}`); } catch { /* ignore */ }
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
