// One-shot recovery script. Opens the main DB (WAL must be moved aside
// BEFORE running this), applies schema.sql, CHECKPOINTs, verifies every
// expected column is present, and lists row counts.
//
// Safe to re-run: schema.sql is idempotent.

import { DuckDBInstance } from '@duckdb/node-api';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../data/optimizer.duckdb');
const WAL_PATH = DB_PATH + '.wal';
const SCHEMA_PATH = resolve(__dirname, '../db/schema.sql');

if (existsSync(WAL_PATH)) {
  console.error(`REFUSING to proceed: WAL still present at ${WAL_PATH}`);
  console.error('Move it aside first (rename or delete) before running recovery.');
  process.exit(1);
}

const EXPECTED_COLS = [
  'id','symbol','timeframe','start_date','status','config',
  'best_gene','best_metrics','top_results','generation_log',
  'generations_completed','total_evaluations','error',
  'started_at','completed_at','created_at',
  // Phase 4.1
  'spec_hash','spec_name','wf_report_json','fitness_breakdown_json','regime_breakdown_json',
  // Phase 4.2a
  'priority','claimed_by','claimed_at','heartbeat_at','cancel_requested',
];

async function run() {
  console.log(`Opening ${DB_PATH} (WAL absent)`);
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();

  console.log(`Applying schema.sql (idempotent)…`);
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const stmts = schema.split(';').map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await conn.run(stmt);
  }

  console.log(`CHECKPOINT…`);
  await conn.run('CHECKPOINT');
  console.log('CHECKPOINT ok');

  const colsResult = await conn.run(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'runs' ORDER BY ordinal_position`
  );
  const cols = (await colsResult.getRows()).map(r => r[0]);
  const missing = EXPECTED_COLS.filter(c => !cols.includes(c));
  if (missing.length) {
    console.error(`MISSING columns on runs: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`All ${EXPECTED_COLS.length} expected columns present.`);

  const tbls = await conn.run(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY 1`
  );
  const tblNames = (await tbls.getRows()).map(r => r[0]);
  console.log('tables:', tblNames.join(', '));
  if (!tblNames.includes('specs')) {
    console.error('specs table is missing');
    process.exit(1);
  }

  for (const t of ['candles', 'runs', 'specs']) {
    const r = await conn.run(`SELECT COUNT(*) FROM ${t}`);
    const [[cnt]] = await r.getRows();
    console.log(`  ${t}: ${cnt} rows`);
  }

  // Final CHECKPOINT so the WAL is minimal when we exit.
  await conn.run('CHECKPOINT');
  console.log('Final CHECKPOINT ok — DB ready.');
}

run().catch(err => {
  console.error('RECOVERY FAILED:', err);
  process.exit(1);
});
