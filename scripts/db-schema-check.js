/**
 * db-schema-check — verify the Phase 4.1 schema migration.
 *
 * Uses the parity DB at /tmp/optimizer-parity.duckdb, which already has
 * candles loaded — the script can't use a fresh empty DB because the
 * end-to-end test (group 6) needs real candles to run a tiny GA. All
 * test rows are removed at the end by spec_hash match, so the DB is
 * left in the same shape we found it.
 *
 * Asserts:
 *
 *   1. All five new `runs` columns exist (spec_hash, spec_name,
 *      wf_report_json, fitness_breakdown_json, regime_breakdown_json).
 *   2. The `specs` table exists with its 5 columns.
 *   3. `upsertSpec` is idempotent on identical content (same hash ⇒ no-op).
 *   4. `getSpec(hash)` round-trips the full JSON payload.
 *   5. `listSpecs()` returns metadata rows (no JSON payload).
 *   6. End-to-end: run a tiny GA in spec mode, write the result to the
 *      `runs` table the way the queue processor does, then read the row
 *      back and confirm the new columns were populated.
 *
 * Run as:
 *   OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb \
 *     node scripts/db-schema-check.js
 */

import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConn, query, exec } from '../db/connection.js';
import { upsertSpec, getSpec, listSpecs } from '../db/specs.js';
import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { runOptimization } from '../optimizer/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Safety check — this script writes test rows into the `runs` table, so
// we refuse to run against the canonical data/optimizer.duckdb. Point it
// at /tmp/optimizer-parity.duckdb (the scripts convention).
const dbPath = process.env.OPTIMIZER_DB_PATH;
if (!dbPath || !dbPath.startsWith('/tmp/')) {
  console.error('ERROR: set OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb');
  process.exit(2);
}

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  }
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
}

async function main() {
  // Trigger schema replay (idempotent; tests the migration applies
  // cleanly to an already-populated DB).
  await getConn();
  console.log(`Using DB: ${dbPath}`);

  // ── 1. Schema: new columns on `runs` ──────────────────
  console.log('\n[1] runs table has 5 new spec-mode columns');
  {
    const cols = await query("PRAGMA table_info('runs')");
    const names = new Set(cols.map(c => c.name));
    for (const col of [
      'spec_hash', 'spec_name', 'wf_report_json',
      'fitness_breakdown_json', 'regime_breakdown_json',
    ]) {
      assertTrue(`runs.${col} present`, names.has(col));
    }
  }

  // ── 2. Schema: `specs` table exists ───────────────────
  console.log('\n[2] specs table has expected columns');
  {
    const cols = await query("PRAGMA table_info('specs')");
    const names = new Set(cols.map(c => c.name));
    for (const col of ['hash', 'name', 'version', 'json', 'created_at']) {
      assertTrue(`specs.${col} present`, names.has(col));
    }
  }

  // ── 3. upsertSpec idempotency ─────────────────────────
  console.log('\n[3] upsertSpec — idempotent on same hash');
  await registry.ensureLoaded();
  const specPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
  const rawSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const spec = validateSpec(rawSpec);

  {
    // First upsert may insert (fresh DB) or no-op (prior test run left
    // the row). Either is valid — we only care that the hash matches
    // and that a second upsert is always a no-op.
    const first = await upsertSpec(spec);
    assertEq('hash matches spec.hash', first.hash, spec.hash);

    const second = await upsertSpec(spec);
    assertEq('second upsert no-op (idempotent)', second.inserted, false);
    assertEq('second upsert hash matches', second.hash, spec.hash);
  }

  // ── 4. getSpec round-trip ─────────────────────────────
  console.log('\n[4] getSpec — round-trips full payload');
  {
    const got = await getSpec(spec.hash);
    assertTrue('row found',          got !== null);
    assertEq('hash matches',         got.hash, spec.hash);
    assertEq('name matches',         got.name, spec.name);
    assertEq('json.name round-trips', got.json.name, spec.name);
    assertTrue('json.entries present', !!got.json.entries);

    const missing = await getSpec('does_not_exist');
    assertEq('missing hash → null',  missing, null);
  }

  // ── 5. listSpecs ──────────────────────────────────────
  console.log('\n[5] listSpecs — returns metadata only');
  {
    const list = await listSpecs();
    assertTrue('at least 1 spec listed', list.length >= 1);
    const entry = list.find(s => s.hash === spec.hash);
    assertTrue('target spec is in list', !!entry);
    assertEq('entry.name',               entry.name, spec.name);
    assertTrue('no json payload in list (metadata only)',
      !Object.prototype.hasOwnProperty.call(entry, 'json'));
  }

  // ── 6. End-to-end: runOptimization → write → read back ─
  console.log('\n[6] end-to-end — tiny spec-mode GA populates all 5 columns');
  let runId = null;
  try {
    // Use an isolated fitness-cache dir so this test doesn't preload stale
    // entries from data/fitness-cache/ (which could produce zero-eval runs).
    process.env.OPTIMIZER_FITNESS_CACHE_DIR = '/tmp/db-schema-check-cache';
    await rm(process.env.OPTIMIZER_FITNESS_CACHE_DIR, { recursive: true, force: true });

    const result = await runOptimization({
      spec: rawSpec,
      symbol: 'BTCUSDT', timeframe: 240, startDate: '2021-04-12',
      populationSize: 8, generations: 3,
      mutationRate: 0.4, numIslands: 1, numPlanets: 1,
      minTrades: 30, maxDrawdownPct: 0.5,
    });

    assertTrue('runOptimization returned', !!result);
    assertTrue('bestMetrics._fitness present', !!result.bestMetrics?._fitness);
    assertTrue('wfReport present (Phase 4.1b post-GA WF)',
      !!result.wfReport,
      result.wfReport ? `wfe=${result.wfReport.wfe?.toFixed(3)}` : 'null');
    // regimeBreakdown may be null for specs without a regime block —
    // the legacy migration-gate spec has `regime: null`, so this is
    // expected to be null. We still exercise the NULL-safe write path.
    const hasRegime = !!result.bestMetrics?.regimeBreakdown;
    console.log(`    regimeBreakdown present: ${hasRegime} (null is OK — migration-gate spec has no regime block)`);

    // Mimic the api/routes.js queue processor's INSERT+UPDATE sequence.
    const bestGene     = JSON.stringify(result.bestGene).replace(/'/g, "''");
    const bestMetrics  = JSON.stringify(result.bestMetrics).replace(/'/g, "''");
    const topResults   = JSON.stringify(result.topResults).replace(/'/g, "''");
    const genLog       = JSON.stringify(result.generationLog).replace(/'/g, "''");
    const fitnessBdRaw = JSON.stringify(result.bestMetrics._fitness).replace(/'/g, "''");
    const regimeBdRaw  = hasRegime
      ? JSON.stringify(result.bestMetrics.regimeBreakdown).replace(/'/g, "''")
      : null;
    const wfReportRaw  = result.wfReport
      ? JSON.stringify(result.wfReport).replace(/'/g, "''")
      : null;

    await exec(`INSERT INTO runs (symbol, timeframe, start_date, status, spec_hash, spec_name)
      VALUES ('BTCUSDT', 240, '2021-04-12', 'running', '${spec.hash}', '${spec.name.replace(/'/g, "''")}')`);
    const rows = await query('SELECT MAX(id) AS id FROM runs');
    runId = rows[0].id;

    await exec(`UPDATE runs SET
      status = 'completed',
      best_gene = '${bestGene}',
      best_metrics = '${bestMetrics}',
      top_results = '${topResults}',
      generation_log = '${genLog}',
      fitness_breakdown_json = '${fitnessBdRaw}',
      regime_breakdown_json  = ${regimeBdRaw ? `'${regimeBdRaw}'` : 'NULL'},
      wf_report_json         = ${wfReportRaw ? `'${wfReportRaw}'` : 'NULL'},
      generations_completed = ${result.completedGens},
      total_evaluations = ${result.totalEvaluations},
      completed_at = current_timestamp
      WHERE id = ${runId}`);

    // Read back and verify
    const readback = await query(`SELECT * FROM runs WHERE id = ${runId}`);
    assertEq('runs row exists',          readback.length, 1);
    const r = readback[0];

    assertEq('spec_hash persisted',      r.spec_hash, spec.hash);
    assertEq('spec_name persisted',      r.spec_name, spec.name);
    assertEq('status = completed',       r.status, 'completed');

    const fitBd = typeof r.fitness_breakdown_json === 'string'
      ? JSON.parse(r.fitness_breakdown_json)
      : r.fitness_breakdown_json;
    assertTrue('fitness_breakdown_json has score',
      typeof fitBd.score === 'number');
    assertTrue('fitness_breakdown_json has breakdown.normPf',
      typeof fitBd.breakdown?.normPf === 'number');
    assertTrue('fitness_breakdown_json has eliminated flag',
      typeof fitBd.eliminated === 'boolean');

    if (hasRegime) {
      const rBd = typeof r.regime_breakdown_json === 'string'
        ? JSON.parse(r.regime_breakdown_json)
        : r.regime_breakdown_json;
      assertTrue('regime_breakdown_json is an object', typeof rBd === 'object');
    } else {
      assertTrue('regime_breakdown_json is NULL for regime-less spec',
        r.regime_breakdown_json === null);
    }

    // Phase 4.1b: wf_report_json round-trips end-to-end.
    const wfBd = typeof r.wf_report_json === 'string'
      ? JSON.parse(r.wf_report_json)
      : r.wf_report_json;
    assertTrue('wf_report_json persisted', wfBd !== null && typeof wfBd === 'object');
    assertEq('wf_report.scheme',        wfBd.scheme, 'anchored');
    assertEq('wf_report.nWindows',      wfBd.nWindows, 5);
    assertEq('wf_report.windows.length', wfBd.windows.length, 5);
    assertTrue('wf_report.meanIsPf is number', typeof wfBd.meanIsPf === 'number');
    assertTrue('wf_report has per-window isPf/oosPf',
      typeof wfBd.windows[0].isPf === 'number' && typeof wfBd.windows[0].oosPf === 'number');
  } finally {
    // Cleanup — leave the parity DB in the shape we found it.
    if (runId !== null) {
      await exec(`DELETE FROM runs WHERE id = ${runId}`).catch(() => {});
    }
    await rm(process.env.OPTIMIZER_FITNESS_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  }

  // ── Summary ───────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
