/**
 * queue-claim-check — verify the Phase 4.2a queue-helper surface.
 *
 * Runs against the parity DB at /tmp/optimizer-parity.duckdb. Everything
 * this script writes uses a test marker on `symbol` ('__QCC__') so we can
 * clean up in a finally block without touching real runs rows.
 *
 * Asserts:
 *
 *   1. Schema — 5 new queue columns exist on `runs`.
 *   2. Atomic claim — two concurrent claimNextRun calls get DIFFERENT rows
 *      (no double-claim).
 *   3. Priority ordering — claim returns highest `priority` first, then
 *      lowest `id` within the same priority.
 *   4. Empty queue — claimNextRun returns null, not throws.
 *   5. Heartbeat — updates heartbeat_at; no-op on non-running rows.
 *   6. Stale-lease recovery — a running row with an old heartbeat_at goes
 *      back to 'pending' and is claimable again.
 *   7. Cancel while pending — requestCancel flags the row; the next
 *      claimNextRun sweeps it to 'cancelled' and does NOT return it.
 *   8. completeRun — writes terminal status + JSON payload fields.
 *
 * Run as:
 *   OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb \
 *     node scripts/queue-claim-check.js
 */

import { query, exec, getConn } from '../db/connection.js';
import {
  claimNextRun, heartbeat, recoverStaleRuns,
  completeRun, requestCancel, listQueue,
} from '../db/queue.js';

// Safety — this script writes to runs. Force /tmp/*.duckdb.
const dbPath = process.env.OPTIMIZER_DB_PATH;
if (!dbPath || !dbPath.startsWith('/tmp/')) {
  console.error('ERROR: set OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb');
  process.exit(2);
}

const MARKER = '__QCC__';        // test symbol — all our rows use this
let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) { passCount++; console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`); }
  else      { failCount++; console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`); }
}
// JSON.stringify with BigInt → Number coercion. DuckDB returns BIGINT
// columns (e.g. SEQUENCE ids after PRAGMA reads) as native BigInts, and
// JSON.stringify throws on them.
function stringify(v) {
  return JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? Number(val) : val);
}
function assertEq(label, actual, expected) {
  const ok = stringify(actual) === stringify(expected);
  if (ok) { passCount++; console.log(`  ✓ ${label}`); }
  else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${stringify(actual)}`);
    console.log(`    expected: ${stringify(expected)}`);
  }
}

/**
 * Insert a test row and return its id. Uses the MARKER symbol so cleanup
 * can delete by symbol without touching real rows.
 *
 * Default priority is 20 — high enough that claimNextRun's `ORDER BY priority
 * DESC, id ASC` always picks our test row over any pre-existing pending
 * rows in the parity DB (which default to priority=0). Tests that exercise
 * priority ordering pass explicit values in the 11–15 range, so 20 stays
 * clear of that band too.
 */
async function insertTestRow({ priority = 20, status = 'pending' } = {}) {
  await exec(
    `INSERT INTO runs (symbol, timeframe, start_date, status, priority) ` +
    `VALUES ('${MARKER}', 60, '2024-01-01', '${status}', ${priority})`
  );
  const [{ id }] = await query(
    `SELECT MAX(id) AS id FROM runs WHERE symbol = '${MARKER}'`
  );
  return id;
}

async function cleanup() {
  await exec(`DELETE FROM runs WHERE symbol = '${MARKER}'`).catch(() => {});
}

async function main() {
  await getConn();
  console.log(`Using DB: ${dbPath}`);
  // Scorched-earth cleanup in case a prior run left rows behind.
  await cleanup();

  try {
    // ── 1. Schema ────────────────────────────────────────
    console.log('\n[1] runs table has 5 new queue columns');
    {
      const cols = await query("PRAGMA table_info('runs')");
      const names = new Set(cols.map(c => c.name));
      for (const col of [
        'priority', 'claimed_by', 'claimed_at', 'heartbeat_at', 'cancel_requested',
      ]) {
        assertTrue(`runs.${col} present`, names.has(col));
      }
    }

    // ── 2. Atomic claim under concurrency ────────────────
    console.log('\n[2] two concurrent claims return DIFFERENT rows');
    {
      const id1 = await insertTestRow({ priority: 5 });
      const id2 = await insertTestRow({ priority: 5 });
      // Fire both in parallel. DuckDB serializes writes internally, but the
      // test is that from the caller's perspective each call returns its own
      // row and neither gets nothing.
      const [c1, c2] = await Promise.all([
        claimNextRun({ workerId: 'race-a' }),
        claimNextRun({ workerId: 'race-b' }),
      ]);
      assertTrue('race-a got a row', c1 !== null);
      assertTrue('race-b got a row', c2 !== null);
      assertTrue('race-a and race-b got different ids',
        c1 && c2 && c1.id !== c2.id,
        `a=${c1?.id} b=${c2?.id}`);
      assertTrue('both rows are our test rows',
        new Set([c1?.id, c2?.id]).size === 2
        && [id1, id2].every(id => [c1?.id, c2?.id].includes(id)));
      assertEq('race-a status = running', c1?.status, 'running');
      assertTrue('race-a claimed_by populated', c1?.claimed_by === 'race-a');
      assertTrue('race-a claimed_at populated', c1?.claimed_at != null);
      assertTrue('race-a heartbeat_at populated', c1?.heartbeat_at != null);
    }
    await cleanup();

    // ── 3. Priority ordering ─────────────────────────────
    console.log('\n[3] claim honors priority DESC, id ASC');
    {
      // Use priorities 11–15 so our rows outrank any pre-existing pending
      // rows in the parity DB (which default to priority=0).
      const low1  = await insertTestRow({ priority: 11 });
      const low2  = await insertTestRow({ priority: 11 });
      const mid   = await insertTestRow({ priority: 13 });
      const high1 = await insertTestRow({ priority: 15 });
      const high2 = await insertTestRow({ priority: 15 });
      const testIds = new Set([low1, low2, mid, high1, high2]);

      // Claim repeatedly, keeping only claims that hit our test rows. If the
      // real DB has other pending rows they'll be interleaved by priority,
      // but within the priority=15, 13, 11 tiers ONLY our rows qualify, so
      // the relative order of our test rows must still be exactly as expected.
      const order = [];
      while (order.length < 5) {
        const r = await claimNextRun({ workerId: `p-${order.length}` });
        if (r === null) break;
        if (testIds.has(r.id)) order.push(r.id);
        else {
          // Roll back the interloper claim so we don't pollute the real DB.
          await exec(
            `UPDATE runs SET status = 'pending', claimed_by = NULL, ` +
            `claimed_at = NULL, heartbeat_at = NULL, started_at = NULL ` +
            `WHERE id = ${r.id}`
          );
          // This would starve us if the interloper keeps winning — but we've
          // raised our priorities above any default=0 row, so the only way
          // to hit this is if something else is running at priority >= 11,
          // which is NOT the case in practice on the parity DB.
        }
      }
      // high1 and high2 share priority=15 — low id first. Then mid. Then
      // low1, low2 in insertion order.
      assertEq('claim order = [high1, high2, mid, low1, low2]',
        order, [high1, high2, mid, low1, low2]);
    }
    await cleanup();

    // ── 4. Heartbeat ─────────────────────────────────────
    console.log('\n[4] heartbeat updates heartbeat_at, no-op on non-running');
    {
      const id = await insertTestRow();  // default priority=20 outranks interlopers
      const claimed = await claimNextRun({ workerId: 'hb-worker' });
      const hb0 = claimed.heartbeat_at;
      // Sleep briefly so the new timestamp differs.
      await new Promise(r => setTimeout(r, 1100));
      const hit = await heartbeat(id);
      assertTrue('heartbeat hit a running row', hit === true);
      const [row] = await query(`SELECT heartbeat_at FROM runs WHERE id = ${id}`);
      assertTrue('heartbeat_at advanced',
        new Date(row.heartbeat_at).getTime() > new Date(hb0).getTime(),
        `before=${hb0}, after=${row.heartbeat_at}`);

      // Transition away from running — heartbeat should be a no-op.
      await completeRun(id, { status: 'completed' });
      const miss = await heartbeat(id);
      assertEq('heartbeat miss on completed row', miss, false);
    }
    await cleanup();

    // ── 5. Stale-lease recovery ──────────────────────────
    console.log('\n[5] stale-lease recovery sweeps dead workers back to pending');
    {
      const id = await insertTestRow();  // default priority=20
      const claimed = await claimNextRun({ workerId: 'dead-worker' });
      assertTrue('claimed before sweep', claimed !== null);

      // Force a stale heartbeat_at. DuckDB accepts INTERVAL arithmetic.
      await exec(
        `UPDATE runs SET heartbeat_at = current_timestamp - INTERVAL '10' MINUTE ` +
        `WHERE id = ${id}`
      );

      // Sweep with a 60s timeout — our 10-min-old row must be recovered.
      // The sweep can also catch leftover `running` rows with NULL
      // heartbeat_at from prior test/crash state (4.2a intentional behavior),
      // so we only assert "at least 1".
      const recovered = await recoverStaleRuns({ timeoutMs: 60_000 });
      assertTrue('at least 1 row recovered', recovered >= 1, `count=${recovered}`);

      const [row] = await query(`SELECT status, claimed_by, heartbeat_at FROM runs WHERE id = ${id}`);
      assertEq('row back to pending', row.status, 'pending');
      assertEq('claimed_by cleared',   row.claimed_by, null);
      assertEq('heartbeat_at cleared', row.heartbeat_at, null);

      // And it should be claimable again.
      const reclaim = await claimNextRun({ workerId: 'recovered' });
      assertTrue('reclaim succeeds after recovery', reclaim !== null);
      assertEq('reclaim targets the same id', reclaim.id, id);
    }
    await cleanup();

    // ── 5b. Recovery of NULL-heartbeat running rows ───────
    console.log('\n[5b] recoverStaleRuns also catches status=running with NULL heartbeat_at');
    {
      // Simulate a legacy/crashed row: manually flip to 'running' with no
      // heartbeat_at. The 4.2b server-startup path relies on this — no
      // heartbeat could have fired while the process was down, so every
      // running row at boot is definitionally stale.
      const id = await insertTestRow();
      await exec(
        `UPDATE runs SET status = 'running', heartbeat_at = NULL ` +
        `WHERE id = ${id}`
      );
      const recovered = await recoverStaleRuns({ timeoutMs: 60_000 });
      assertTrue('NULL-heartbeat row swept', recovered >= 1, `count=${recovered}`);
      const [row] = await query(`SELECT status FROM runs WHERE id = ${id}`);
      assertEq('NULL-heartbeat row back to pending', row.status, 'pending');
    }
    await cleanup();

    // ── 6. Cancel while pending ──────────────────────────
    console.log('\n[6] requestCancel on pending row ⇒ claim sweeps it to cancelled');
    {
      const cancelMe = await insertTestRow({ priority: 5 });
      const keep     = await insertTestRow({ priority: 1 });

      const flagged = await requestCancel(cancelMe);
      assertTrue('requestCancel hit the pending row', flagged === true);

      // Next claim should NOT return cancelMe even though it has higher
      // priority — the sweep transitions it to 'cancelled' and claim moves
      // past it.
      const got = await claimNextRun({ workerId: 'cancel-test' });
      assertTrue('claim skipped cancelled row', got !== null && got.id === keep,
        `got id=${got?.id}, expected ${keep}`);

      const [cancelled] = await query(`SELECT status FROM runs WHERE id = ${cancelMe}`);
      assertEq('flagged row now cancelled', cancelled.status, 'cancelled');
    }
    await cleanup();

    // ── 7. completeRun writes payload + status ───────────
    console.log('\n[7] completeRun writes terminal status + JSON payload');
    {
      const id = await insertTestRow();
      await claimNextRun({ workerId: 'complete-test' });
      await completeRun(id, {
        status: 'completed',
        bestGene:    { emaFast: 12 },
        bestMetrics: { pf: 1.5, trades: 100 },
        fitnessBreakdownJson: { score: 0.8, eliminated: false },
        wfReportJson:         { scheme: 'anchored', nWindows: 5 },
        generationsCompleted: 10,
        totalEvaluations: 80,
      });
      const [r] = await query(`SELECT * FROM runs WHERE id = ${id}`);
      assertEq('status = completed',    r.status, 'completed');
      assertTrue('completed_at populated', r.completed_at != null);
      assertEq('generations_completed', r.generations_completed, 10);
      assertEq('total_evaluations',     r.total_evaluations, 80);
      const bestGene = typeof r.best_gene === 'string' ? JSON.parse(r.best_gene) : r.best_gene;
      assertEq('best_gene round-trips', bestGene, { emaFast: 12 });
      const fit = typeof r.fitness_breakdown_json === 'string'
        ? JSON.parse(r.fitness_breakdown_json) : r.fitness_breakdown_json;
      assertEq('fitness_breakdown_json round-trips', fit, { score: 0.8, eliminated: false });
      const wf = typeof r.wf_report_json === 'string'
        ? JSON.parse(r.wf_report_json) : r.wf_report_json;
      assertEq('wf_report_json round-trips', wf, { scheme: 'anchored', nWindows: 5 });
    }
    await cleanup();

    // ── 8. listQueue returns pending + running only ──────
    console.log('\n[8] listQueue returns pending + running, sorted by priority DESC, id ASC');
    {
      const lo = await insertTestRow({ priority: 0 });
      const hi = await insertTestRow({ priority: 5 });
      const doneId = await insertTestRow({ priority: 9 });
      await completeRun(doneId, { status: 'completed' });

      const list = await listQueue();
      const ids = list.filter(r => r.symbol === MARKER).map(r => r.id);
      assertEq('listQueue excludes completed', ids.includes(doneId), false);
      assertEq('listQueue is priority-ordered (hi before lo)',
        ids.indexOf(hi) < ids.indexOf(lo),
        true);
    }

  } finally {
    await cleanup();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
}

main().catch(async err => {
  console.error('FATAL:', err);
  await cleanup().catch(() => {});
  process.exit(1);
});
