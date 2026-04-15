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

export async function getConn() {
  if (conn) return conn;
  instance = await DuckDBInstance.create(DB_PATH);
  conn = await instance.connect();

  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    await conn.run(stmt);
  }

  // Checkpoint after schema replay. DuckDB cannot reliably replay ALTER TABLE
  // entries with DEFAULT clauses from the WAL (internal assertion failure
  // "GetDefaultDatabase with no default database set" during bind). Forcing
  // a checkpoint right after migration moves the ALTERs into the main file
  // and truncates the WAL, so subsequent opens never try to replay them.
  // The schema is idempotent (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD
  // COLUMN IF NOT EXISTS), so when the DB is already migrated this loop is
  // a no-op and the CHECKPOINT is cheap.
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
