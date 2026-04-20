/**
 * ui-run-detail-check — structural test for Phase 4.5a run-detail page.
 *
 * The run-detail page gained three spec-mode-only cards in 4.5a:
 * Fitness Breakdown, Walk-Forward Report, and Regime Breakdown. This
 * gate follows the same philosophy as ui-spec-editor-check — three
 * lightweight sections instead of a full headless-browser test:
 *
 *   1. DOM: index.html declares the three cards + every data-target
 *      element each renderer writes into (tables, summary rows,
 *      chip containers).
 *
 *   2. JS wiring in ui/app.js:
 *        a. renderFitnessBreakdown / renderWalkForwardReport /
 *           renderRegimeBreakdown helpers exist.
 *        b. openRunDetail invokes all three after the fetch.
 *        c. Each helper hides its card when the input is null/empty.
 *        d. fmtPf/fmtPct/fmtWfe formatters handle Infinity + NaN
 *           (the underlying data sources can emit both).
 *
 *   3. Server contract: GET /api/runs/:id parses the three new
 *      JSON columns (wf_report_json, fitness_breakdown_json,
 *      regime_breakdown_json) into live objects — not strings.
 *      Tested end-to-end against an in-memory run row inserted
 *      directly into the DB so this test doesn't need a full GA.
 *
 * Gates against the realistic failure modes of a spec-mode run
 * landing in the UI with unhelpful "[object Object]" strings or
 * silent blank cards — both of which have happened in prior
 * iterations and are exactly what this file is guarding against.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Point DB connection at a throwaway temp file so this gate coexists
// with a running dev server that holds the main DB's write lock.
// Must happen BEFORE importing api/routes.js or db/connection.js —
// they read OPTIMIZER_DB_PATH at module-evaluation time.
const TMP_DIR = await mkdtemp(join(tmpdir(), 'run-detail-check-'));
process.env.OPTIMIZER_DB_PATH = join(TMP_DIR, 'test.duckdb');

// Match server.js's global BigInt→JSON shim. DuckDB returns some columns
// (sequence-backed ids, timestamps) as native BigInts, which JSON.stringify
// otherwise chokes on. server.js sets this before mounting routes; we must
// do the same when exercising routes.js directly.
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
  // ── 1. DOM markers in index.html ─────────────────────────────
  console.log('\n[1] DOM: run-detail page has the three 4.5a cards');
  {
    const html = await readText('ui/index.html');

    // Slice the run-detail page so assertions don't leak into nearby
    // pages (New Run modal sits right after and contains its own table).
    const pageStart = html.indexOf('id="page-run-detail"');
    assertTrue('#page-run-detail block is present', pageStart > -1);
    const nextPage = html.indexOf('id="page-', pageStart + 1);
    const slice = nextPage < 0 ? html.slice(pageStart) : html.slice(pageStart, nextPage);

    // Fitness Breakdown card + body.
    assertTrue('detail-fitness-card present', contains(slice, 'id="detail-fitness-card"'));
    assertTrue('detail-fitness-body present', contains(slice, 'id="detail-fitness-body"'));

    // Walk-Forward Report card + summary + table body.
    assertTrue('detail-wf-card present',    contains(slice, 'id="detail-wf-card"'));
    assertTrue('detail-wf-summary present', contains(slice, 'id="detail-wf-summary"'));
    assertTrue('detail-wf-table present',   contains(slice, 'id="detail-wf-table"'));
    assertTrue('detail-wf-tbody present',   contains(slice, 'id="detail-wf-tbody"'));

    // WF table must declare the per-window columns the renderer fills.
    for (const th of ['Window', 'IS trades', 'IS PF', 'IS net %', 'OOS trades', 'OOS PF', 'OOS net %']) {
      assertTrue(`WF table column "${th}" present`, contains(slice, `>${th}<`) || contains(slice, th));
    }

    // Regime Breakdown card + source line + table body.
    assertTrue('detail-regime-card present',    contains(slice, 'id="detail-regime-card"'));
    assertTrue('detail-regime-source present',  contains(slice, 'id="detail-regime-source"'));
    assertTrue('detail-regime-table present',   contains(slice, 'id="detail-regime-table"'));
    assertTrue('detail-regime-tbody present',   contains(slice, 'id="detail-regime-tbody"'));

    // Each card's <h3> carries a title tooltip. 4.4 established this
    // pattern as standard — enforce it here too so the three new
    // cards don't regress into undocumented knobs.
    assertTrue('Fitness Breakdown h3 has tooltip',
      /id="detail-fitness-card"[\s\S]{0,1500}<h3[^>]*title="[^"]{20,}"/.test(slice));
    assertTrue('WF Report h3 has tooltip',
      /id="detail-wf-card"[\s\S]{0,1500}<h3[^>]*title="[^"]{20,}"/.test(slice));
    assertTrue('Regime Breakdown h3 has tooltip',
      /id="detail-regime-card"[\s\S]{0,1500}<h3[^>]*title="[^"]{20,}"/.test(slice));

    // Custom-window picker — extend lookback on a frozen gene without
    // re-running the GA. Two date inputs (start + end), a reset button,
    // and an info span that shows the effective window after recalc.
    assertTrue('recalc-start-date input present',
      contains(slice, 'id="recalc-start-date"') && /type="date"[^>]*id="recalc-start-date"|id="recalc-start-date"[^>]*type="date"/.test(slice));
    assertTrue('recalc-end-date input present',
      contains(slice, 'id="recalc-end-date"')   && /type="date"[^>]*id="recalc-end-date"|id="recalc-end-date"[^>]*type="date"/.test(slice));
    assertTrue('btn-recalc-reset-dates button present',
      contains(slice, 'id="btn-recalc-reset-dates"'));
    assertTrue('recalc-window-info span present',
      contains(slice, 'id="recalc-window-info"'));
  }

  // ── 2. JS wiring in app.js ───────────────────────────────────
  console.log('\n[2] JS: renderers wired into openRunDetail');
  {
    const js = await readText('ui/app.js');

    // Renderer definitions.
    assertTrue('defines renderFitnessBreakdown',
      /function\s+renderFitnessBreakdown\b/.test(js));
    assertTrue('defines renderWalkForwardReport',
      /function\s+renderWalkForwardReport\b/.test(js));
    assertTrue('defines renderRegimeBreakdown',
      /function\s+renderRegimeBreakdown\b/.test(js));

    // openRunDetail must invoke all three after the fetch. If any call
    // goes missing, the respective card stays hidden forever — a silent
    // regression we specifically want to catch.
    assertTrue('openRunDetail calls renderFitnessBreakdown',
      /openRunDetail[\s\S]{0,3000}renderFitnessBreakdown\(/.test(js));
    assertTrue('openRunDetail calls renderWalkForwardReport',
      /openRunDetail[\s\S]{0,3000}renderWalkForwardReport\(/.test(js));
    assertTrue('openRunDetail calls renderRegimeBreakdown',
      /openRunDetail[\s\S]{0,3000}renderRegimeBreakdown\(/.test(js));

    // Each renderer hides its card when input is missing. Pattern:
    // early return with `style.display = 'none'`. The exact string
    // "display = 'none'" or "display:'none'" must appear within the
    // first ~200 chars of the function body.
    for (const fn of [
      'renderFitnessBreakdown', 'renderWalkForwardReport', 'renderRegimeBreakdown',
    ]) {
      assertTrue(`${fn} hides card when input is null`,
        new RegExp(`function\\s+${fn}\\b[\\s\\S]{0,600}style\\.display\\s*=\\s*['"]none['"]`).test(js),
        'expected early-return with display=none');
    }

    // Each renderer flips its card visible on the happy path. Same
    // shape check but with an empty string (the CSS default).
    // Phase 4.5b: renderWalkForwardReport switched to template-literal
    // IDs (e.g. `detail-wf-card${idSuffix}`) so the card string now
    // appears inside a backtick, not a quote — accept either delimiter.
    for (const [fn, cardId] of [
      ['renderFitnessBreakdown',  'detail-fitness-card'],
      ['renderWalkForwardReport', 'detail-wf-card'],
      ['renderRegimeBreakdown',   'detail-regime-card'],
    ]) {
      assertTrue(`${fn} un-hides ${cardId} on happy path`,
        new RegExp(`function\\s+${fn}\\b[\\s\\S]{0,5000}['"\`]${cardId}`).test(js));
    }

    // Formatters handle Infinity + NaN. PF is +Infinity when no
    // losing trades; WFE is NaN when mean IS PF is 0. Both show up in
    // real data; a renderer that can't handle them crashes the page.
    assertTrue('defines fmtPf formatter',  /function\s+fmtPf\b/.test(js));
    assertTrue('defines fmtPct formatter', /function\s+fmtPct\b/.test(js));
    assertTrue('defines fmtWfe formatter', /function\s+fmtWfe\b/.test(js));
    assertTrue('fmtPf handles Infinity',
      /function\s+fmtPf\b[\s\S]{0,400}Number\.isFinite/.test(js));
    assertTrue('fmtWfe handles NaN',
      /function\s+fmtWfe\b[\s\S]{0,400}isNaN/.test(js));

    // Low-confidence regime heuristic: fewer than 5 trades. fitness.js
    // uses the same threshold for the worst-regime gate; drift here
    // would mean the UI flags different rows than the gate evaluates.
    assertTrue('renderRegimeBreakdown flags trades < 5 as low-confidence',
      /function\s+renderRegimeBreakdown\b[\s\S]{0,3000}trades\s*<\s*5/.test(js));

    // ── Phase 6.1 — Robustness breakdown renderer ──
    // A secondary card rendered inside renderFitnessBreakdown that
    // surfaces the 5 robustness terms + the geomean multiplier. Only
    // activates when fitness_breakdown_json.breakdown.robustness is
    // present (i.e. the run had spec.fitness.robustness.enabled=true).
    // All 5 term labels must appear so the UI always labels the 5
    // modules even if one term degenerates to "—".
    assertTrue('defines renderRobustnessBreakdown helper',
      /function\s+renderRobustnessBreakdown\b/.test(js));
    assertTrue('renderRobustnessBreakdown returns empty string when robustness missing',
      /function\s+renderRobustnessBreakdown\b[\s\S]{0,400}return\s+['"`]['"`]/.test(js));
    assertTrue('renderFitnessBreakdown invokes renderRobustnessBreakdown',
      /function\s+renderFitnessBreakdown\b[\s\S]{0,5000}renderRobustnessBreakdown\(/.test(js));

    // All 5 term labels present in the robustness renderer.
    for (const label of ['MC-DD P95', 'Bootstrap', 'Random OOS', 'Param CoV', 'Adversarial']) {
      assertTrue(`renderRobustnessBreakdown emits "${label}" row`,
        new RegExp(`function\\s+renderRobustnessBreakdown\\b[\\s\\S]{0,6000}['"\`]${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}['"\`]`).test(js));
    }

    // The multiplier chip is added to the chips row at the top of
    // renderFitnessBreakdown when breakdown.robustness is present.
    // Guard against regression of the "Robustness ×" chip label.
    assertTrue('renderFitnessBreakdown emits Robustness × chip when present',
      /function\s+renderFitnessBreakdown\b[\s\S]{0,5000}Robustness\s*×/.test(js));

    // Score-formula footnote below the robustness table — helps users
    // see WHERE the multiplier enters the composite. Regression-guard
    // the exact structure so a refactor doesn't silently drop it.
    assertTrue('renderRobustnessBreakdown shows score-formula hint',
      /function\s+renderRobustnessBreakdown\b[\s\S]{0,6000}base\s*×\s*freqFactor/.test(js));

    // ── Custom-window recalc: JS wiring ──
    // recalcRun reads both date inputs, adds them to the fetch URL
    // when non-empty, and surfaces the effective window returned by
    // the server in recalc-window-info.
    assertTrue('recalcRun reads recalc-start-date',
      /recalcRun[\s\S]{0,3000}getElementById\(['"]recalc-start-date['"]\)/.test(js));
    assertTrue('recalcRun reads recalc-end-date',
      /recalcRun[\s\S]{0,3000}getElementById\(['"]recalc-end-date['"]\)/.test(js));
    assertTrue('recalcRun passes startDate / endDate as query params',
      /URLSearchParams[\s\S]{0,500}(startDate|endDate)/.test(js));
    assertTrue('recalcRun surfaces effectiveWindow from server response',
      /effectiveWindow/.test(js));

    // initRecalcDatePickers seeds the pickers with the run's defaults
    // so Recalculate matches the original window out of the box.
    assertTrue('defines initRecalcDatePickers helper',
      /function\s+initRecalcDatePickers\b/.test(js));
    assertTrue('openRunDetail calls initRecalcDatePickers',
      /openRunDetail[\s\S]{0,5000}initRecalcDatePickers\(/.test(js));

    // Reset button restores the run's original dates.
    assertTrue('btn-recalc-reset-dates listener wired',
      /btn-recalc-reset-dates[\s\S]{0,400}addEventListener\(\s*['"]click['"]/.test(js));

    // ── Winner-config helper (4.5a follow-up) ─────────────────
    //
    // Before this fix, the runs-list expand panel inlined
    //   E${gene.minEntry} St${gene.stochLen}/${gene.stochSmth} ...
    // which works for legacy GA genes (flat keys like `emaFast`) but
    // produces "Eundefined Stundefined/undefined ..." for spec-mode
    // runs whose gene uses qualified IDs ("emaTrend.main.emaFast").
    // The fix is a formatWinnerConfig(gene, isSpecMode) helper that
    // branches on the run's spec_hash. Guard the regression:
    assertTrue('defines formatWinnerConfig helper',
      /function\s+formatWinnerConfig\s*\(\s*gene\s*,\s*isSpecMode\s*\)/.test(js));
    assertTrue('defines formatGeneNum helper',
      /function\s+formatGeneNum\s*\(/.test(js));

    // The expand panel must now route winner-config rendering through
    // the helper — not inline the legacy template string. Specifically,
    // the legacy shape `E${gene.minEntry} St${gene.stochLen}` should
    // no longer appear anywhere OUTSIDE formatWinnerConfig itself.
    const outsideHelper = js.replace(
      /function\s+formatWinnerConfig\b[\s\S]*?\n\}/,
      '/* formatWinnerConfig body elided for regression scan */',
    );
    assertTrue(
      'expand panel no longer inlines legacy gene template',
      !/E\$\{gene\.minEntry\}\s+St\$\{gene\.stochLen\}/.test(outsideHelper),
      'found the pre-fix template outside formatWinnerConfig — ' +
      'spec-mode runs would render "Eundefined Stundefined..."',
    );

    // formatWinnerConfig is called from the expand-panel render (the
    // `if (gene)` block in the big renderResults/toggleExpand chain).
    assertTrue('expand panel calls formatWinnerConfig',
      /formatWinnerConfig\s*\(\s*gene\s*,/.test(js));

    // Send to TV button is hidden/disabled for spec-mode runs. The
    // current Pine template only speaks legacy gene keys, so a TV
    // round-trip on a spec-mode run would push `undefined` for every
    // input and mislead the user with a spurious "GA vs TV" delta.
    // Detection hook: the `run.spec_hash` truthy-check used by the
    // guard. If the branch disappears, this test screams.
    assertTrue('expand panel guards Send-to-TV on spec-mode runs',
      /isSpecMode\s*=\s*!!\s*run\.spec_hash/.test(js),
      'expected `const isSpecMode = !!run.spec_hash`');
    assertTrue('disabled TV button present for spec-mode',
      /btn-tv[\s\S]{0,500}disabled\b[\s\S]{0,500}legacy only/i.test(js),
      'expected a disabled "Send to TV (legacy only)" button branch');

    // ── Behavioral: actually evaluate the helper ──────────────
    //
    // Static regex gets us partway — let's also run the function and
    // confirm it produces usable text on a real spec-mode gene (shape
    // copied from run #58 — BTCUSDT 4H, Phase 4.1 spec-mode) AND
    // still emits the legacy JM Simple 3TP string for a flat gene.
    //
    // We extract the two helpers via regex and eval them in isolation
    // so we don't need a DOM or the rest of app.js.
    const formatWinnerConfigSrc = js.match(
      /function\s+formatWinnerConfig\s*\([^)]*\)\s*\{[\s\S]*?\n\}/
    )?.[0];
    const formatGeneNumSrc = js.match(
      /function\s+formatGeneNum\s*\([^)]*\)\s*\{[\s\S]*?\n\}/
    )?.[0];
    assertTrue('extracted formatWinnerConfig source', !!formatWinnerConfigSrc);
    assertTrue('extracted formatGeneNum source', !!formatGeneNumSrc);

    if (formatWinnerConfigSrc && formatGeneNumSrc) {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        `${formatGeneNumSrc}\n${formatWinnerConfigSrc}\nreturn formatWinnerConfig;`,
      )();

      // Spec-mode gene (abbreviated from run #58).
      const specGene = {
        '_meta.entries.threshold': 3,
        'stochCross.main.stochLen': 8,
        'stochCross.main.stochSmth': 3,
        'emaTrend.main.emaFast': 38,
        'emaTrend.main.emaSlow': 40,
        'bbSqueezeBreakout.main.bbLen': 37,
        'bbSqueezeBreakout.main.bbMult': 2,
        'atrScaleOutTarget.main.tp2Mult': 3.8,
      };
      const specOut = fn(specGene, true);
      assertTrue('spec-mode output: no "undefined"',
        !specOut.includes('undefined'),
        `got: ${specOut}`);
      assertTrue('spec-mode output: leads with entry threshold',
        /^E3\b/.test(specOut), `got: ${specOut}`);
      assertTrue('spec-mode output: groups by block id',
        specOut.includes('emaTrend(') && specOut.includes('bbSqueezeBreakout('),
        `got: ${specOut}`);
      assertTrue('spec-mode output: preserves param=value pairs',
        specOut.includes('emaFast=38') && specOut.includes('tp2Mult=3.8'),
        `got: ${specOut}`);

      // Legacy gene — same flat keys the template has always read.
      const legacyGene = {
        minEntry: 2, stochLen: 14, stochSmth: 3, rsiLen: 14,
        emaFast: 50, emaSlow: 200, bbLen: 20, bbMult: 2,
        atrLen: 14, atrSL: 2.5, tp1Mult: 1.5, tp2Mult: 2.5, tp3Mult: 4,
        tp1Pct: 25, tp2Pct: 50, riskPct: 1.5, maxBars: 500,
      };
      const legacyOut = fn(legacyGene, false);
      assertTrue('legacy output: no "undefined"',
        !legacyOut.includes('undefined'), `got: ${legacyOut}`);
      assertTrue('legacy output: contains EMA pair',
        legacyOut.includes('EMA50/200'), `got: ${legacyOut}`);
      assertTrue('legacy output: contains BB pair',
        legacyOut.includes('BB20x2'), `got: ${legacyOut}`);
    }
  }

  // ── 3. Server contract: /api/runs/:id parses the 3 JSON cols ─
  console.log('\n[3] Server: /api/runs/:id parses the spec-mode JSON fields');
  const app = await startApp();
  try {
    // Seed a synthetic run row with all three JSON fields populated.
    // Using unique id=9999999 so a real run can't collide and a
    // failure cleanup leaves an obviously-fake row for manual rm.
    // Schema auto-initializes on first getConn() call inside exec().
    const testId = 9999999;
    const wfReport = {
      scheme: 'anchored', nWindows: 3, warmup: 0, validWindows: 3,
      windows: [
        { index: 0, isStart: 0, isEnd: 100, oosEnd: 120, isTrades: 30, isPf: 1.5, isNetPct: 12.3, oosTrades: 10, oosPf: 1.2, oosNetPct: 4.1 },
      ],
      meanIsPf: 1.5, meanOosPf: 1.2, meanIsNetPct: 12.3, meanOosNetPct: 4.1, wfe: 0.8,
    };
    const fit = {
      score: 0.62, eliminated: false, gatesFailed: [],
      breakdown: { normPf: 0.75, normDd: 0.6, normRet: 0.3, weightsN: { pf: 0.5, dd: 0.3, ret: 0.2 }, wfe: 0.8 },
    };
    const regimes = {
      trending: { trades: 42, wins: 25, pf: 1.8, net: 523.4, grossProfit: 1800, grossLoss: 1000 },
      choppy:   { trades:  3, wins:  1, pf: 0.5, net: -12.0, grossProfit:   50, grossLoss: 100  },
    };

    // Clean up any prior attempt, then insert. exec() takes only SQL —
    // no parameter binding — so JSON is inlined with '-escaping (SQL
    // single-quote doubling). Matches the pattern in db-schema-check.js.
    const wfReportRaw = JSON.stringify(wfReport).replace(/'/g, "''");
    const fitRaw      = JSON.stringify(fit).replace(/'/g, "''");
    const regimesRaw  = JSON.stringify(regimes).replace(/'/g, "''");

    await exec(`DELETE FROM runs WHERE id = ${testId}`);
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status, wf_report_json, fitness_breakdown_json, regime_breakdown_json)
       VALUES (${testId}, 'TEST/USDT', 60, '2024-01-01', 'completed', '${wfReportRaw}', '${fitRaw}', '${regimesRaw}')`,
    );

    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/runs/${testId}`);
      const body = await r.json();
      assertTrue('GET /api/runs/:id returns 200', r.status === 200,
        r.status !== 200 ? `status=${r.status} body=${JSON.stringify(body).slice(0, 300)}` : '');

      // Each of the three JSON fields must come back as a parsed
      // object, not a string. That's the whole point of this change;
      // pre-4.5a, every consumer had to JSON.parse() locally.
      assertTrue('wf_report_json parsed to object',
        body.wf_report_json && typeof body.wf_report_json === 'object' && !Array.isArray(body.wf_report_json),
        `typeof=${typeof body.wf_report_json}`);
      assertTrue('fitness_breakdown_json parsed to object',
        body.fitness_breakdown_json && typeof body.fitness_breakdown_json === 'object' && !Array.isArray(body.fitness_breakdown_json));
      assertTrue('regime_breakdown_json parsed to object',
        body.regime_breakdown_json && typeof body.regime_breakdown_json === 'object' && !Array.isArray(body.regime_breakdown_json));

      // Shape deep-check — the fields the renderers read must survive
      // the round-trip intact.
      assertEq('wf_report.scheme',          body.wf_report_json?.scheme,   'anchored');
      assertEq('wf_report.wfe',             body.wf_report_json?.wfe,      0.8);
      assertEq('wf_report.windows length',  body.wf_report_json?.windows?.length, 1);
      assertEq('wf_report.windows[0].oosPf', body.wf_report_json?.windows?.[0]?.oosPf, 1.2);

      assertEq('fitness.score',         body.fitness_breakdown_json?.score,      0.62);
      assertEq('fitness.eliminated',    body.fitness_breakdown_json?.eliminated, false);
      assertEq('fitness.gatesFailed',   body.fitness_breakdown_json?.gatesFailed, []);
      assertEq('fitness.breakdown.normPf',     body.fitness_breakdown_json?.breakdown?.normPf, 0.75);
      assertEq('fitness.breakdown.weightsN.pf', body.fitness_breakdown_json?.breakdown?.weightsN?.pf, 0.5);

      assertEq('regimes.trending.pf',    body.regime_breakdown_json?.trending?.pf, 1.8);
      assertEq('regimes.choppy.trades',  body.regime_breakdown_json?.choppy?.trades, 3);
    } finally {
      // Cleanup. Swallow errors since the row may not exist on some
      // failure paths (e.g. INSERT itself failed).
      try { await exec(`DELETE FROM runs WHERE id = ${testId}`); } catch { /* ignore */ }
    }

    // Legacy run (no spec-mode JSON fields) still returns 200 with
    // null values — the UI relies on the renderers' null-check to
    // hide the cards. If the endpoint ever started 500-ing on null
    // JSON fields we'd miss that without an explicit test.
    const legacyId = 9999998;
    await exec(`DELETE FROM runs WHERE id = ${legacyId}`);
    await exec(
      `INSERT INTO runs (id, symbol, timeframe, start_date, status)
       VALUES (${legacyId}, 'TEST/USDT', 60, '2024-01-01', 'completed')`,
    );
    try {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/runs/${legacyId}`);
      assertTrue('legacy run returns 200', r.status === 200);
      const body = await r.json();
      assertTrue('legacy run has null wf_report_json',       body.wf_report_json == null);
      assertTrue('legacy run has null fitness_breakdown_json', body.fitness_breakdown_json == null);
      assertTrue('legacy run has null regime_breakdown_json',  body.regime_breakdown_json == null);
    } finally {
      try { await exec(`DELETE FROM runs WHERE id = ${legacyId}`); } catch { /* ignore */ }
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
