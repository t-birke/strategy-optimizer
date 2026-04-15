import { DuckDBInstance } from '@duckdb/node-api';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// OPTIMIZER_DB_PATH env var lets short-lived readers (e.g. parity scripts)
// point at a copy of the DB while the long-running server holds the main
// DB's write lock. Default stays the canonical on-disk location.
const DB_PATH = process.env.OPTIMIZER_DB_PATH
  ? resolve(process.env.OPTIMIZER_DB_PATH)
  : resolve(__dirname, '../data/optimizer.duckdb');
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let instance = null;
let conn = null;

/**
 * Parse `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <rest>` into
 * `{ table, column, decl }`. Anything else returns `null`. Used to
 * skip no-op ALTERs at steady state — see getConn() comment.
 */
function parseAlterAddColumn(stmt) {
  // Normalize whitespace for matching; case-insensitive on keywords.
  const m = stmt.replace(/\s+/g, ' ').trim().match(
    /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+(.+)$/i
  );
  if (!m) return null;
  return { table: m[1], column: m[2], decl: m[3] };
}

/**
 * Does `<table>.<column>` exist? Used to guard ALTER TABLE ADD COLUMN
 * so we never issue a no-op ALTER at steady state.
 *
 * Lowercased comparison: DuckDB stores unquoted identifiers lowercased
 * in information_schema, so `priority` matches `PRIORITY` in SQL source.
 */
async function columnExists(c, table, column) {
  const sql =
    `SELECT 1 FROM information_schema.columns ` +
    `WHERE lower(table_name) = lower('${table}') ` +
    `AND lower(column_name) = lower('${column}')`;
  const r = await c.run(sql);
  const rows = await r.getRows();
  return rows.length > 0;
}

export async function getConn() {
  if (conn) return conn;
  instance = await DuckDBInstance.create(DB_PATH);
  conn = await instance.connect();

  // ── Schema migration (guarded, WAL-safe) ─────────────────
  //
  // Root cause of past WAL corruption:
  //   DuckDB may write an ALTER TABLE entry to the WAL even when the
  //   column already exists and the statement is semantically a no-op
  //   (`ADD COLUMN IF NOT EXISTS`). On a subsequent unclean shutdown
  //   followed by a reopen, DuckDB tries to replay that ALTER from the
  //   WAL and hits an internal assertion:
  //     "INTERNAL Error: Failure while replaying WAL file ... Calling
  //      DatabaseManager::GetDefaultDatabase with no default database set"
  //   — because the DEFAULT clause resolver can't find the default DB
  //   context during WAL replay. Result: DB can't be opened at all.
  //
  // Fix:
  //   Don't rely on `IF NOT EXISTS` to be a cheap no-op. Before running
  //   any ALTER TABLE ADD COLUMN, check information_schema and skip the
  //   statement entirely if the column already exists. At steady state
  //   (post first migration), this loop issues ZERO ALTERs, so the WAL
  //   stays empty of DDL and the replay bug can't trigger.
  //
  // CREATE TABLE / CREATE SEQUENCE with IF NOT EXISTS are left as-is —
  // they're not affected by this bug.
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const stmts = schema.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    const alter = parseAlterAddColumn(stmt);
    if (alter) {
      if (await columnExists(conn, alter.table, alter.column)) continue;
      await conn.run(
        `ALTER TABLE ${alter.table} ADD COLUMN ${alter.column} ${alter.decl}`
      );
    } else {
      await conn.run(stmt);
    }
  }

  // Final belt-and-suspenders CHECKPOINT. If the guard above worked,
  // there's nothing to flush. If a brand-new DB just got migrated, this
  // moves the fresh ALTERs from the WAL into the main file so a crash
  // before the next natural checkpoint can't corrupt us.
  await conn.run('CHECKPOINT');
  return conn;
}

/**
 * Run a query and return rows as array of objects.
 * Converts BigInt values to Number for convenience.
 */
export async function query(sql) {
  const c = await getConn();
  const result = await c.run(sql);
  const columns = result.columnNames();
  const rows = await result.getRows();
  return rows.map(row => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      const val = row[i];
      obj[columns[i]] = typeof val === 'bigint' ? Number(val) : val;
    }
    return obj;
  });
}

/**
 * Run a statement (no result needed).
 */
export async function exec(sql) {
  const c = await getConn();
  await c.run(sql);
}

/**
 * Get an appender for bulk inserts.
 */
export async function getAppender(table) {
  const c = await getConn();
  return c.createAppender(table);
}
