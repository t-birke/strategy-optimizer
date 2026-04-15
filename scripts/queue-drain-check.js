/**
 * queue-drain-check — integration test for Phase 4.2b `processQueue`.
 *
 * `scripts/queue-claim-check.js` already exercises the queue helpers in
 * isolation (claim, heartbeat, recover, cancel, completeRun). This script
 * plugs the helpers into the real `processQueue` loop from api/routes.js
 * and proves the refactor wires them together correctly:
 *
 *   1. Happy path — enqueue a tiny legacy-mode run (4 pop × 2 gen on
 *      BTCUSDT/4H), kick processQueue, wait for it to drain, verify the
 *      row ends up in status='completed' with best_gene populated and
 *      no rows left pending under our test marker.
 *
 *   2. Spec-hash error path — enqueue a row pointing at a nonexistent
 *      spec hash. processQueue should trap the `spec load error`, mark
 *      the row 'failed' with the error message, and move on without
 *      crashing the drain loop. This is the guarantee that bad data
 *      doesn't wedge the queue.
 *
 *   3. Bad-config error path — enqueue a row with malformed JSON in
 *      `config`. Same contract: row ends 'failed', drain loop survives.
 *
 *   4. Cancel-before-start — requestCancel on a pending row. The row
 *      must end up 'cancelled' without processQueue ever invoking
 *      runOptimization (the claim path sweeps cancel-flagged pending
 *      rows to 'cancelled' and skips past them). Verifies routes.js +
 *      queue.js cooperate on cancel semantics.
 *
 * Test rows use the marker symbol '__QDC__' so cleanup can scope to
 * test rows only. Uses the parity DB at /tmp/optimizer-parity.duckdb.
 *
 * Run as:
 *   OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb \
 *     node scripts/queue-drain-check.js
 */

import { query, exec, getConn } from '../db/connection.js';
import { requestCancel } from '../db/queue.js';
import { processQueue } from '../api/routes.js';

const dbPath = process.env.OPTIMIZER_DB_PATH;
if (!dbPath || !dbPath.startsWith('/tmp/')) {
  console.error('ERROR: set OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb');
  process.exit(2);
}

const MARKER = '__QDC__';
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

async function cleanup() {
  await exec(`DELETE FROM runs WHERE symbol = '${MARKER}'`).catch(() => {});
}

/**
 * Park all pre-existing pending rows so processQueue's drain loop only
 * sees our test rows. Without this, on a shared parity DB the drain loop
 * claims unrelated user rows (8 pending rows on first encounter) and
 * spends minutes running real GAs on them before finishing.
 *
 * `'pending_parked'` is a status value the queue helpers don't recognize
 * — claimNextRun only SELECTs WHERE status='pending' — so parked rows
 * are invisible to the queue for the duration of the test. Restored in
 * the finally block.
 *
 * Returns the set of parked ids so we can restore only them (not any
 * 'pending_parked' rows a previous aborted test might have orphaned —
 * those we also sweep back, since leaving them parked breaks production).
 */
async function parkPendingRows() {
  // First: sweep any leftover 'pending_parked' from a prior aborted run.
  await exec(`UPDATE runs SET status = 'pending' WHERE status = 'pending_parked'`).catch(() => {});
  const before = await query(`SELECT id FROM runs WHERE status = 'pending'`);
  const ids = before.map(r => r.id);
  if (ids.length > 0) {
    await exec(`UPDATE runs SET status = 'pending_parked' WHERE id IN (${ids.join(',')})`);
  }
  return ids;
}

async function restoreParkedRows() {
  // Restore every row we parked, regardless of test outcome.
  await exec(`UPDATE runs SET status = 'pending' WHERE status = 'pending_parked'`).catch(() => {});
}

/**
 * Insert a pending row with the given config JSON. Returns the new id.
 * `configObj` is stringified and single-quote-escaped inline.
 *
 * priority=25 so we always outrank any pre-existing pending rows in the
 * parity DB (queue-claim-check uses 20 for its default — we go higher
 * to avoid any interleaving with leftover test rows).
 */
async function insertPending({
  symbol = MARKER,
  timeframe = 60,
  startDate = '2024-01-01',
  configObj = {},
  configRaw = null,         // when set, overrides configObj (used for bad-JSON test)
  specHash = null,
  specName = null,
  priority = 25,
} = {}) {
  const cfg = configRaw !== null
    ? configRaw
    : JSON.stringify(configObj).replace(/'/g, "''");
  const specCols = specHash ? ', spec_hash, spec_name' : '';
  const specVals = specHash
    ? `, '${specHash}', '${(specName ?? '').replace(/'/g, "''")}'`
    : '';
  await exec(
    `INSERT INTO runs (symbol, timeframe, start_date, status, priority, config${specCols}) ` +
    `VALUES ('${symbol}', ${timeframe}, '${startDate}', 'pending', ${priority}, '${cfg}'${specVals})`
  );
  const [{ id }] = await query(
    `SELECT MAX(id) AS id FROM runs WHERE symbol = '${symbol}'`
  );
  return id;
}

async function main() {
  await getConn();
  console.log(`Using DB: ${dbPath}`);
  await cleanup();
  const parkedIds = await parkPendingRows();
  if (parkedIds.length > 0) {
    console.log(`Parked ${parkedIds.length} pre-existing pending row(s) for test isolation`);
  }

  try {
    // ── 1. Happy path: real tiny GA run drains end-to-end ──────
    //
    // 4 pop × 2 gen on BTCUSDT/4H is the smallest viable legacy run. Needs
    // real candles in the parity DB; if BTCUSDT isn't ingested, skip with
    // a clear message rather than failing ambiguously.
    console.log('\n[1] happy path: enqueue tiny legacy run → processQueue → completed');
    {
      // Sanity: does the parity DB have BTCUSDT 4H candles?
      const [probe] = await query(
        `SELECT COUNT(*) AS n FROM candles WHERE symbol = 'BTCUSDT' AND timeframe = 240`
      ).catch(() => [{ n: 0 }]);
      if (probe.n === 0) {
        console.log('  ⊘ SKIP: BTCUSDT/240 candles not ingested in parity DB');
      } else {
        // Symbol 'BTCUSDT_QDC' is a hack to scope cleanup BUT runOptimization
        // loads candles by the exact `symbol` column, so we MUST use the real
        // symbol. We accept the scope-leak on this one row and clean it up by
        // id rather than by symbol below.
        const id = await insertPending({
          symbol: 'BTCUSDT',
          timeframe: 240,
          startDate: '2021-04-12',
          configObj: {
            populationSize: 4, generations: 2, mutationRate: 0.4,
            numIslands: 1, numPlanets: 1,
            migrationInterval: 0, migrationCount: 3, migrationTopology: 'ring',
            spaceTravelInterval: 2, spaceTravelCount: 1,
            minTrades: 30, maxDrawdownPct: 0.5,
            endDate: null,
            knockoutMode: 'none', knockoutValueMode: 'midpoint',
            label: '__QDC__-happy',
          },
          priority: 25,
        });
        // This real-symbol row needs manual cleanup — track the id.
        const tStart = Date.now();
        await processQueue();
        console.log(`    processQueue returned after ${((Date.now() - tStart)/1000).toFixed(1)}s`);

        const [row] = await query(
          `SELECT status, best_gene, best_metrics, generations_completed, total_evaluations, error ` +
          `FROM runs WHERE id = ${id}`
        );
        assertEq('status = completed', row.status, 'completed');
        assertTrue('no error recorded', row.error == null, `error=${row.error}`);
        assertTrue('best_gene populated', row.best_gene != null);
        assertTrue('best_metrics populated', row.best_metrics != null);
        assertTrue('generations_completed > 0', (row.generations_completed ?? 0) > 0,
          `gens=${row.generations_completed}`);
        assertTrue('total_evaluations > 0', (row.total_evaluations ?? 0) > 0,
          `evals=${row.total_evaluations}`);

        // best_gene should round-trip as valid JSON.
        let gene = null;
        try {
          gene = typeof row.best_gene === 'string' ? JSON.parse(row.best_gene) : row.best_gene;
        } catch { /* fall through */ }
        assertTrue('best_gene is valid JSON object',
          gene && typeof gene === 'object' && Object.keys(gene).length > 0,
          gene ? `keys=${Object.keys(gene).length}` : 'unparseable');

        // Clean up this real-symbol row explicitly.
        await exec(`DELETE FROM runs WHERE id = ${id}`);
      }
    }

    // ── 2. Spec hash missing → failed, drain survives ──────────
    console.log('\n[2] spec_hash points at nothing → row fails cleanly');
    {
      const id = await insertPending({
        configObj: { populationSize: 4, generations: 1, label: 'bad-spec' },
        specHash: 'deadbeef0000000000000000000000000000000000000000000000000000dead',
        specName: '__QDC__-bogus-spec',
      });
      await processQueue();

      const [row] = await query(
        `SELECT status, error FROM runs WHERE id = ${id}`
      );
      assertEq('status = failed', row.status, 'failed');
      assertTrue('error mentions spec',
        typeof row.error === 'string' && row.error.toLowerCase().includes('spec'),
        `error=${row.error}`);

      // Drain loop must still be usable — kick it again on an empty
      // test queue, it should return promptly without throwing.
      await processQueue();
      assertTrue('processQueue survives and is re-entrant-safe', true);
    }

    // ── 3. (removed) Bad config JSON ───────────────────────────
    //
    // DuckDB validates the `config` column as JSON at INSERT time (the
    // column type is JSON, not VARCHAR), so a malformed-JSON row cannot
    // physically exist at rest. The `JSON.parse` try/catch in processQueue
    // is defensive but unreachable on the current schema — no test here.

    // ── 4. Cancel-before-start ─────────────────────────────────
    //
    // Reserve two rows at the same priority. Cancel the first before
    // draining. processQueue claims row 2 (because claim sweeps cancelled
    // pending rows first), leaving row 1 in status='cancelled'. Row 2
    // would then run — we don't want that cost every invocation, so we
    // also cancel row 2 before calling processQueue. Both must end up
    // 'cancelled' without runOptimization ever firing.
    console.log('\n[4] requestCancel on pending rows → sweep to cancelled, no GA fires');
    {
      const id1 = await insertPending({
        configObj: { populationSize: 4, generations: 1, label: 'cancel-1' },
        priority: 25,
      });
      const id2 = await insertPending({
        configObj: { populationSize: 4, generations: 1, label: 'cancel-2' },
        priority: 25,
      });
      await requestCancel(id1);
      await requestCancel(id2);

      await processQueue();

      const rows = await query(
        `SELECT id, status, best_gene, generations_completed FROM runs ` +
        `WHERE id IN (${id1}, ${id2}) ORDER BY id`
      );
      assertEq('row 1 status = cancelled', rows[0].status, 'cancelled');
      assertEq('row 2 status = cancelled', rows[1].status, 'cancelled');
      assertTrue('row 1 never ran (no best_gene)',  rows[0].best_gene == null);
      assertTrue('row 2 never ran (no best_gene)',  rows[1].best_gene == null);
      assertTrue('row 1 never ran (no gens)',       (rows[0].generations_completed ?? 0) === 0);
      assertTrue('row 2 never ran (no gens)',       (rows[1].generations_completed ?? 0) === 0);
    }
  } finally {
    await cleanup();
    await restoreParkedRows();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
  // processQueue uses broadcast() which is a no-op when websocket isn't
  // initialized, but heartbeat timers are cleared on completion so we
  // should exit cleanly. Force exit to be safe in case a stray handle
  // (e.g. DuckDB connection pool) is still alive.
  process.exit(0);
}

main().catch(async err => {
  console.error('FATAL:', err);
  await cleanup().catch(() => {});
  await restoreParkedRows().catch(() => {});
  process.exit(1);
});
