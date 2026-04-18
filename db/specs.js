/**
 * db/specs.js — CRUD helpers for the `specs` table.
 *
 * The `specs` table is a content-addressed store of validated spec JSON,
 * keyed by `spec.hash`. Every completed `runs` row that was optimized from
 * a spec carries a `spec_hash` pointer, so we can always look back and see
 * the exact spec that produced a given run — even if the on-disk strategy
 * file has since been edited.
 *
 * Upsert semantics: identical hash ⇒ no-op (INSERT OR IGNORE). Two
 * byte-identical specs must produce the same hash by construction
 * (see `engine/spec.js::hashSpec`), so a collision on hash implies a
 * collision on content, and rewriting isn't needed. We keep the earliest
 * `created_at` to preserve provenance.
 */

import { getConn, query } from './connection.js';

/**
 * Escape a string for inline SQL interpolation. We don't have prepared
 * statements on this tiny helper surface — all callers pass
 * server-generated values (spec.hash, spec.name, JSON.stringify(spec)),
 * never user input directly — but JSON can contain any character so we
 * still defensively escape single quotes.
 */
function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Upsert a validated spec into the `specs` table. Idempotent: if a row
 * with the same hash already exists, this is a no-op.
 *
 * @param {Object} spec  Validated spec (must have .hash and .name attached)
 * @returns {Promise<{hash:string, inserted:boolean}>}
 */
export async function upsertSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('upsertSpec: spec must be an object');
  }
  if (!spec.hash || typeof spec.hash !== 'string') {
    throw new Error('upsertSpec: spec.hash is required (run validateSpec first)');
  }
  if (!spec.name || typeof spec.name !== 'string') {
    throw new Error('upsertSpec: spec.name is required');
  }

  // Probe first — we return `inserted: false` on collision so callers can
  // log "used existing spec" vs "stored new spec".
  const existing = await query(
    `SELECT hash FROM specs WHERE hash = '${sqlEscape(spec.hash)}'`
  );
  if (existing.length > 0) {
    return { hash: spec.hash, inserted: false };
  }

  const conn = await getConn();
  const version = typeof spec.version === 'number' ? spec.version : null;
  const json = sqlEscape(JSON.stringify(spec));

  await conn.run(
    `INSERT INTO specs (hash, name, version, json) VALUES (
       '${sqlEscape(spec.hash)}',
       '${sqlEscape(spec.name)}',
       ${version === null ? 'NULL' : version},
       '${json}'
     )`
  );
  return { hash: spec.hash, inserted: true };
}

/**
 * Fetch a spec by hash. Returns the parsed JSON payload, or `null` if
 * no such row exists.
 *
 * @param {string} hash
 * @returns {Promise<Object|null>}
 */
export async function getSpec(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const rows = await query(
    `SELECT hash, name, version, json, created_at FROM specs
      WHERE hash = '${sqlEscape(hash)}'`
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const json = typeof r.json === 'string' ? JSON.parse(r.json) : r.json;
  return {
    hash:       r.hash,
    name:       r.name,
    version:    r.version,
    json,
    created_at: r.created_at,
  };
}

/**
 * List all stored specs, newest first. Returns metadata only (no json
 * payload) — callers fetch the full payload via `getSpec(hash)` when
 * they need it. Used by the UI's spec picker.
 *
 * @returns {Promise<Array<{hash, name, version, created_at}>>}
 */
export async function listSpecs() {
  return query(
    `SELECT hash, name, version, created_at FROM specs
      ORDER BY created_at DESC`
  );
}
