/**
 * db/deployments.js — CRUD helpers for `deployments` and the
 * `webhook_events` inbox.
 *
 * Phase 4.7a scope:
 *   - createDeployment       : draft from a (run, spec) pair, mints a secret
 *   - getDeployment(id)      : single row, parsed
 *   - listDeployments({...}) : filtered list for the UI
 *   - recordWebhookEvent     : insert with dedup; returns
 *                              { event, inserted, duplicate }
 *   - countWebhookEvents(id) : observability for a deployment
 *
 * Status transitions (`setStatus`, `arm`, `pause`, `retire`) and
 * Pine-push linkage land with 4.7c.
 *
 * SQL escaping: same pattern as db/specs.js — server-generated values
 * only, but JSON / arbitrary strings still get the single-quote
 * defensive escape via `sqlEscape`.
 */

import { randomBytes } from 'node:crypto';
import { getConn, query } from './connection.js';

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** SQL literal for a possibly-null value (string columns only). */
function sqlNullable(v) {
  return v == null ? 'NULL' : `'${sqlEscape(v)}'`;
}

/** SQL literal for a possibly-null number. */
function sqlNullableNum(v) {
  return v == null || !Number.isFinite(v) ? 'NULL' : String(v);
}

/**
 * Mint a 64-hex-char secret. 32 bytes of randomness — same magnitude
 * as a high-entropy API key. The secret lives in the URL path
 * (`POST /webhook/:id/:secret`) and is also the input to the
 * timing-safe comparison in the route handler.
 *
 * Exposed for the gate so it can mint secrets without going through
 * createDeployment when seeding fixtures.
 */
export function mintSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Build a deduplication key from a TV alert payload. Lives here
 * (rather than inline in routes.js) so the gate can compute the same
 * key when seeding events that should collide.
 *
 * Design: the key identifies the *signal*, not the receive event —
 * `bar_time` (TV's bar timestamp from the payload) + action +
 * direction. A second alert from the same bar for the same direction
 * is a duplicate; an exit on the same bar that opened is NOT a
 * duplicate (different action), and an opposing-side reversal is NOT
 * a duplicate (different direction).
 */
export function dedupKey({ bar_time, action, direction }) {
  return `${bar_time || ''}:${action || ''}:${direction || ''}`;
}

/**
 * Create a draft deployment from a run.
 *
 * Required fields: run_id, spec_hash, symbol, timeframe.
 * Optional: mode (default 'paper'), max_position_size,
 * max_loss_per_day_usd, config (object → JSON).
 *
 * The secret is minted here and returned to the caller — this is the
 * ONLY chance to surface the secret in plaintext. Subsequent reads
 * via getDeployment/listDeployments do return it (it's stored
 * unhashed; this is bearer-token semantics, not password storage —
 * we need the literal value to compare incoming webhook URL paths
 * against), but the convention in the API layer is to redact it
 * from list responses and only show it in the per-deployment GET
 * (which the UI gates behind an explicit "reveal secret" click in
 * 4.7c). Callers in 4.7a just get the full row.
 */
export async function createDeployment(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('createDeployment: opts required');
  }
  const { run_id, spec_hash, symbol, timeframe, mode, max_position_size,
          max_loss_per_day_usd, config } = opts;

  if (!spec_hash || typeof spec_hash !== 'string') {
    throw new Error('createDeployment: spec_hash required');
  }
  if (!symbol || typeof symbol !== 'string') {
    throw new Error('createDeployment: symbol required');
  }
  if (!Number.isInteger(timeframe) || timeframe <= 0) {
    throw new Error('createDeployment: timeframe (minutes) required');
  }
  const m = mode || 'paper';
  if (!['dry-run', 'paper', 'live-stub'].includes(m)) {
    throw new Error(`createDeployment: invalid mode "${m}"`);
  }

  const secret = mintSecret();
  const conn = await getConn();
  await conn.run(
    `INSERT INTO deployments
       (run_id, spec_hash, symbol, timeframe, mode, status, secret_key,
        max_position_size, max_loss_per_day_usd, config_json)
     VALUES (
       ${run_id == null ? 'NULL' : Number(run_id)},
       '${sqlEscape(spec_hash)}',
       '${sqlEscape(symbol)}',
       ${Number(timeframe)},
       '${sqlEscape(m)}',
       'draft',
       '${sqlEscape(secret)}',
       ${sqlNullableNum(max_position_size)},
       ${sqlNullableNum(max_loss_per_day_usd)},
       ${config == null ? 'NULL' : `'${sqlEscape(JSON.stringify(config))}'`}
     )`
  );

  // DuckDB's `currval` per-sequence is per-connection, and we don't have
  // RETURNING in stable DuckDB. The pattern used elsewhere (e.g. queue
  // helpers) is to read the freshly-inserted row by max(id), but that's
  // racy under concurrent inserts. Since deployment creation is a UI
  // action (manual, infrequent), the race is acceptable and we re-read
  // by (created_at, secret_key) which is unique per insert.
  const rows = await query(
    `SELECT * FROM deployments WHERE secret_key = '${sqlEscape(secret)}'`
  );
  if (rows.length === 0) {
    throw new Error('createDeployment: insert succeeded but row not found');
  }
  return parseRow(rows[0]);
}

/**
 * Fetch a single deployment by id, with config_json parsed.
 * Returns null if missing.
 */
export async function getDeployment(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const rows = await query(`SELECT * FROM deployments WHERE id = ${n}`);
  if (rows.length === 0) return null;
  return parseRow(rows[0]);
}

/**
 * List deployments. `status` filter is optional; pass `null`/undefined
 * to return all. Order: newest first. Secret is included — caller is
 * responsible for redaction.
 */
export async function listDeployments({ status } = {}) {
  let where = '';
  if (status) {
    if (!['draft', 'armed', 'paused', 'retired'].includes(status)) {
      throw new Error(`listDeployments: invalid status "${status}"`);
    }
    where = `WHERE status = '${sqlEscape(status)}'`;
  }
  const rows = await query(
    `SELECT * FROM deployments ${where} ORDER BY created_at DESC`
  );
  return rows.map(parseRow);
}

/**
 * Insert a webhook event, deduplicating on (deployment_id, dedup_key).
 *
 * Behavior:
 *   - First insert with that key   → returns { inserted:true,  duplicate:false, event }
 *   - Subsequent insert (same key) → returns { inserted:false, duplicate:true,  event }
 *
 * Implementation: probe-then-insert. DuckDB doesn't have ON CONFLICT
 * IGNORE in stable, and the UNIQUE index would just throw an error
 * we'd have to swallow — slower in the dedupe path AND noisier in
 * logs. Probe first, insert second. The probe-insert race is
 * acceptable here: a true duplicate webhook arriving twice within
 * milliseconds is extremely rare (TV's retry interval is multiple
 * seconds), and even if it slipped through, the UNIQUE constraint on
 * the table is the actual safety net.
 *
 * `payload` is the parsed JSON body. `signature_ok` is computed by the
 * caller (route handler) — this helper doesn't know about secrets.
 */
export async function recordWebhookEvent(opts) {
  const { deployment_id, payload, signature_ok } = opts;
  if (!Number.isInteger(deployment_id)) {
    throw new Error('recordWebhookEvent: deployment_id required');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('recordWebhookEvent: payload object required');
  }

  const bar_time = payload.time || null;
  const action   = payload.action || null;
  const direction = payload.direction || null;
  const reason   = payload.reason || null;
  const price    = typeof payload.price === 'number' ? payload.price : null;
  const dk = dedupKey({ bar_time, action, direction });

  // Probe for an existing row with the same dedup key. Note: dedup is
  // PER deployment — two deployments coincidentally generating the same
  // key (different specs, same bar) are independent.
  const existing = await query(
    `SELECT * FROM webhook_events
      WHERE deployment_id = ${deployment_id}
        AND dedup_key = '${sqlEscape(dk)}'
      LIMIT 1`
  );
  if (existing.length > 0) {
    return { inserted: false, duplicate: true, event: parseEventRow(existing[0]) };
  }

  const conn = await getConn();
  await conn.run(
    `INSERT INTO webhook_events
       (deployment_id, raw_body, signature_ok, bar_time, action,
        direction, reason, price, dedup_key)
     VALUES (
       ${deployment_id},
       '${sqlEscape(JSON.stringify(payload))}',
       ${signature_ok ? 'TRUE' : 'FALSE'},
       ${sqlNullable(bar_time)},
       ${sqlNullable(action)},
       ${sqlNullable(direction)},
       ${sqlNullable(reason)},
       ${sqlNullableNum(price)},
       '${sqlEscape(dk)}'
     )`
  );

  // Re-read to return the inserted row (for the response payload + audit).
  const rows = await query(
    `SELECT * FROM webhook_events
      WHERE deployment_id = ${deployment_id}
        AND dedup_key = '${sqlEscape(dk)}'
      LIMIT 1`
  );
  return { inserted: true, duplicate: false, event: parseEventRow(rows[0]) };
}

/**
 * Count events for a deployment. Used by the deployment GET endpoint
 * for a quick "events received" stat without dragging the whole list.
 */
export async function countWebhookEvents(deployment_id) {
  const n = Number(deployment_id);
  if (!Number.isInteger(n)) return 0;
  const rows = await query(
    `SELECT count(*)::INTEGER AS n FROM webhook_events WHERE deployment_id = ${n}`
  );
  return rows[0]?.n ?? 0;
}

// ─── Internal: row parsers ──────────────────────────────────

function parseRow(r) {
  if (!r) return r;
  const out = { ...r };
  if (typeof out.config_json === 'string') {
    try { out.config_json = JSON.parse(out.config_json); } catch {}
  }
  return out;
}

function parseEventRow(r) {
  if (!r) return r;
  const out = { ...r };
  if (typeof out.raw_body === 'string') {
    try { out.raw_body = JSON.parse(out.raw_body); } catch {}
  }
  return out;
}
