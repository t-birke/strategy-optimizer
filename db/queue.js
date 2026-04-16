/**
 * db/queue.js — queue helpers over the `runs` table (Phase 4.2a).
 *
 * The run queue is NOT a separate table. `runs.status = 'pending'` is the
 * queue; `runs.status = 'running'` is the "claimed, in flight" set. Phase
 * 4.2a added `priority`, `claimed_by`, `claimed_at`, `heartbeat_at`, and
 * `cancel_requested` to turn the existing `status` column into a pullable
 * queue that a single worker or a future remote drain can consume safely.
 *
 * ── Claim pattern ─────────────────────────────────────────────────────
 * The claim is an atomic `UPDATE ... WHERE id = (SELECT ... LIMIT 1)
 * RETURNING *`. DuckDB executes the update as a single statement, so two
 * concurrent calls cannot both win the same row. One gets the row back,
 * the other gets an empty result set. Verified in scripts/queue-claim-check.
 *
 * ── FSM transitions owned by this module ──────────────────────────────
 *   pending     → running     (claimNextRun)
 *   running     → pending     (recoverStaleRuns, stale-lease sweep)
 *   pending     → cancelled   (handled in claimNextRun when cancel_requested)
 *   running     → completed   (completeRun)
 *   running     → failed      (completeRun)
 *   running     → cancelled   (completeRun)
 *
 * ── What this module does NOT do ──────────────────────────────────────
 * - Enqueue — that's still `INSERT INTO runs ... status='pending'` from
 *   api/routes.js (POST /api/runs). A follow-up 4.2c CLI will expose it.
 * - Execute — the caller (the existing queue processor in api/routes.js
 *   today, a future scripts/queue-worker.js later) runs the GA and passes
 *   results back to completeRun.
 * - Cancel propagation into a running worker — that's 4.2d. Today the
 *   cancel flag is only consulted by the claim path (a pending-but-cancelled
 *   row gets swept to cancelled).
 */

import { getConn, query } from './connection.js';

/**
 * Escape a string for inline SQL. Same defensive escaping as db/specs.js —
 * inputs here are server-generated (workerId from os.hostname+pid), but
 * we still sanitize.
 */
function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Atomically claim the highest-priority pending run.
 *
 * Returns the full claimed row on success, or `null` if the queue is empty
 * (no pending rows, or all pending rows have cancel_requested = TRUE — those
 * get swept separately).
 *
 * The UPDATE is a single DuckDB statement, so two concurrent callers cannot
 * both win the same row. Ordering is `priority DESC, id ASC`.
 *
 * @param {{ workerId: string }} opts
 * @returns {Promise<Object|null>}
 */
export async function claimNextRun({ workerId }) {
  if (!workerId || typeof workerId !== 'string') {
    throw new Error('claimNextRun: workerId is required');
  }
  // Sweep cancelled-while-pending rows first so they don't block the queue.
  // (A user can `requestCancel` a row that's still pending — we should just
  // transition it straight to 'cancelled' rather than claim+complete it.)
  await query(
    `UPDATE runs SET status = 'cancelled', completed_at = current_timestamp ` +
    `WHERE status = 'pending' AND cancel_requested = TRUE`
  );

  const rows = await query(
    `UPDATE runs SET ` +
      `status = 'running', ` +
      `claimed_by = '${sqlEscape(workerId)}', ` +
      `claimed_at = current_timestamp, ` +
      `heartbeat_at = current_timestamp, ` +
      `started_at = current_timestamp ` +
    `WHERE id = (` +
      `SELECT id FROM runs ` +
      `WHERE status = 'pending' AND (cancel_requested = FALSE OR cancel_requested IS NULL) ` +
      `ORDER BY priority DESC, id ASC ` +
      `LIMIT 1` +
    `) ` +
    `RETURNING *`
  );
  return rows.length === 0 ? null : rows[0];
}

/**
 * Bump heartbeat_at on a running row so the stale-lease sweep doesn't
 * reclaim it. Workers call this on an interval (e.g. every 10s).
 *
 * @param {number} runId
 * @returns {Promise<boolean>}  true if a row was updated, false if none matched
 */
export async function heartbeat(runId) {
  if (!Number.isFinite(runId)) throw new Error('heartbeat: runId must be a number');
  const rows = await query(
    `UPDATE runs SET heartbeat_at = current_timestamp ` +
    `WHERE id = ${runId} AND status = 'running' ` +
    `RETURNING id`
  );
  return rows.length > 0;
}

/**
 * Recover rows whose worker died mid-run. Called by the claim loop on a
 * longer interval (e.g. once per minute) or on server startup.
 *
 * A row is "stale" if status='running' AND EITHER
 *   - heartbeat_at < NOW() - timeoutMs (stuck worker), OR
 *   - heartbeat_at IS NULL (legacy row from before 4.2a, or crash before
 *     the first heartbeat)
 * Stale rows go back to status='pending' and get re-claimed on the next
 * claimNextRun.
 *
 * At server startup, call with a short timeoutMs (e.g. 1_000) since no
 * heartbeat could have fired while the process was down — every running
 * row at boot is definitionally stale in single-process mode.
 *
 * @param {{ timeoutMs: number }} opts
 * @returns {Promise<number>}  count of rows recovered
 */
export async function recoverStaleRuns({ timeoutMs }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('recoverStaleRuns: timeoutMs must be a positive number');
  }
  // DuckDB: current_timestamp - INTERVAL X MILLISECOND works; cast to SECOND
  // to avoid surprises with fractional ms. Round up so we never resurrect a
  // row prematurely.
  const timeoutSec = Math.ceil(timeoutMs / 1000);
  const staleCondition =
    `status = 'running' ` +
    `AND (heartbeat_at IS NULL OR heartbeat_at < current_timestamp - INTERVAL '${timeoutSec}' SECOND)`;

  // Runs that already have a best_gene were mid-flight or finished but
  // failed the completeRun write. Mark them completed (with partial data)
  // instead of sending them back to pending — re-running would lose the
  // results we DO have.
  const rescued = await query(
    `UPDATE runs SET ` +
      `status = 'completed', ` +
      `completed_at = COALESCE(completed_at, current_timestamp) ` +
    `WHERE ${staleCondition} AND best_gene IS NOT NULL ` +
    `RETURNING id`
  );
  if (rescued.length > 0) {
    console.log(`[queue] Rescued ${rescued.length} stale run(s) with results → completed: ${rescued.map(r => r.id).join(', ')}`);
  }

  // Runs without any results can safely be retried.
  const retried = await query(
    `UPDATE runs SET ` +
      `status = 'pending', ` +
      `claimed_by = NULL, ` +
      `claimed_at = NULL, ` +
      `heartbeat_at = NULL, ` +
      `started_at = NULL ` +
    `WHERE ${staleCondition} AND best_gene IS NULL ` +
    `RETURNING id`
  );
  if (retried.length > 0) {
    console.log(`[queue] Retried ${retried.length} stale run(s) without results → pending: ${retried.map(r => r.id).join(', ')}`);
  }

  return rescued.length + retried.length;
}

/**
 * Complete a run and store the result payload.
 *
 * The caller (routes.js queue processor or a future worker) builds the
 * payload from the GA result. This helper just writes the fields and sets
 * the terminal status. We accept the payload as a prebuilt object rather
 * than trying to derive it, so the existing routes.js writing logic stays
 * authoritative.
 *
 * @param {number} runId
 * @param {{
 *   status: 'completed'|'failed'|'cancelled',
 *   bestGene?: any, bestMetrics?: any, topResults?: any, generationLog?: any,
 *   fitnessBreakdownJson?: any, regimeBreakdownJson?: any, wfReportJson?: any,
 *   generationsCompleted?: number, totalEvaluations?: number,
 *   error?: string,
 * }} result
 */
export async function completeRun(runId, result) {
  if (!Number.isFinite(runId)) throw new Error('completeRun: runId must be a number');
  if (!result || !result.status) throw new Error('completeRun: result.status is required');
  if (!['completed', 'failed', 'cancelled'].includes(result.status)) {
    throw new Error(`completeRun: invalid status ${result.status}`);
  }

  const fields = [
    `status = '${result.status}'`,
    `completed_at = current_timestamp`,
  ];
  const addJson = (col, val) => {
    if (val === undefined) return;
    if (val === null) { fields.push(`${col} = NULL`); return; }
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    fields.push(`${col} = '${sqlEscape(s)}'`);
  };
  addJson('best_gene',              result.bestGene);
  addJson('best_metrics',           result.bestMetrics);
  addJson('top_results',            result.topResults);
  addJson('generation_log',         result.generationLog);
  addJson('fitness_breakdown_json', result.fitnessBreakdownJson);
  addJson('regime_breakdown_json',  result.regimeBreakdownJson);
  addJson('wf_report_json',         result.wfReportJson);

  if (Number.isFinite(result.generationsCompleted)) {
    fields.push(`generations_completed = ${result.generationsCompleted}`);
  }
  if (Number.isFinite(result.totalEvaluations)) {
    fields.push(`total_evaluations = ${result.totalEvaluations}`);
  }
  if (result.error !== undefined) {
    fields.push(result.error === null ? `error = NULL` : `error = '${sqlEscape(result.error)}'`);
  }

  const conn = await getConn();
  await conn.run(`UPDATE runs SET ${fields.join(', ')} WHERE id = ${runId}`);
}

/**
 * Flag a run for cancellation. If the row is still pending, the next
 * claimNextRun sweep transitions it to 'cancelled'. If the row is running,
 * a future 4.2d change in the runner will detect the flag and stop.
 *
 * @param {number} runId
 * @returns {Promise<boolean>}  true if the row existed and was flagged
 */
export async function requestCancel(runId) {
  if (!Number.isFinite(runId)) throw new Error('requestCancel: runId must be a number');
  const rows = await query(
    `UPDATE runs SET cancel_requested = TRUE ` +
    `WHERE id = ${runId} AND status IN ('pending', 'running') ` +
    `RETURNING id`
  );
  return rows.length > 0;
}

/**
 * Snapshot of the queue for debugging / UI. Returns pending + running rows
 * with just the fields relevant to queue state (no big JSON payloads).
 *
 * @returns {Promise<Array<{id, symbol, timeframe, status, priority, spec_name, ...}>>}
 */
export async function listQueue() {
  return query(
    `SELECT id, symbol, timeframe, start_date, status, priority, ` +
           `spec_hash, spec_name, claimed_by, claimed_at, heartbeat_at, ` +
           `cancel_requested, created_at, started_at, completed_at ` +
    `FROM runs ` +
    `WHERE status IN ('pending', 'running') ` +
    `ORDER BY priority DESC, id ASC`
  );
}
