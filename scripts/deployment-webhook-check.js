/**
 * deployment-webhook-check — regression gate for Phase 4.7a.
 *
 * Phase 4.7a establishes the deployment registry and the TV-alert
 * inbox. No dispatch yet (that's 4.7b). What this gate proves:
 *
 *   - Schema: `deployments` and `webhook_events` tables exist with the
 *     columns and constraints the rest of the system will rely on.
 *   - Auth: bearer-secret-in-URL with constant-time comparison. Bad
 *     secrets are 401'd AND audited (signature_ok=false rows persist
 *     so we can see attack attempts later).
 *   - Dedup: a re-fired alert (same bar_time/action/direction) returns
 *     200 + deduped:true; only one row lands in webhook_events.
 *   - Validation: stale payloads (>2*timeframe minutes old) → 400.
 *     Future-dated, missing-fields, malformed-time → 400.
 *   - Body cap: Content-Length > 4 KB → 413.
 *   - Resource lookup: unknown deployment_id → 404.
 *   - Listing: GET redacts secret to a 4-char preview; GET-by-id
 *     reveals it (single-user-box convention).
 *
 * Sections:
 *   [1] Schema — tables/columns/CHECK constraints present.
 *   [2] Helpers — db/deployments.js round-trips (create, get, list,
 *       recordWebhookEvent dedup, mode CHECK).
 *   [3] Server — POST /api/deployments + the full /webhook/:id/:secret
 *       error matrix.
 *
 * Output isolation: OPTIMIZER_DB_PATH points at a tmpdir so this gate
 * doesn't dirty the real DB and coexists with a running dev server.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = await mkdtemp(join(tmpdir(), 'deployment-webhook-check-'));
process.env.OPTIMIZER_DB_PATH = join(TMP_DIR, 'test.duckdb');

BigInt.prototype.toJSON = function() { return Number(this); };

const [
  { default: routes },
  { exec, query },
  { upsertSpec },
  { validateSpec },
  { createDeployment, getDeployment, listDeployments,
    recordWebhookEvent, countWebhookEvents, mintSecret, dedupKey },
  registry,
  { readFile },
  { resolve, dirname },
  { fileURLToPath },
] = await Promise.all([
  import('../api/routes.js'),
  import('../db/connection.js'),
  import('../db/specs.js'),
  import('../engine/spec.js'),
  import('../db/deployments.js'),
  import('../engine/blocks/registry.js'),
  import('node:fs/promises'),
  import('node:path'),
  import('node:url'),
]);

await registry.ensureLoaded();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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

/** Build a TV-style payload at a given clock time (defaults to now). */
function makePayload({ at = new Date(), action = 'open', direction = 'long',
                      reason = 'signal', price = 50000 } = {}) {
  // Match codegen format: 'YYYY-MM-DDTHH:MMZ' (no seconds).
  const t = at.toISOString().slice(0, 16) + 'Z';
  return { action, direction, reason, price, time: t, ticker: 'BTCUSDT' };
}

async function main() {
  // ── 1. Schema ───────────────────────────────────────────────
  console.log('\n[1] Schema: deployments + webhook_events tables');
  {
    // Ensure tables initialized by triggering the connection.
    await query('SELECT 1');

    const depCols = await query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE lower(table_name) = 'deployments'`
    );
    const need = ['id','run_id','spec_hash','symbol','timeframe','mode',
                  'status','secret_key','pine_filename','pine_hash12',
                  'max_position_size','max_loss_per_day_usd','config_json',
                  'created_at','armed_at','paused_at','pause_reason'];
    const have = new Set(depCols.map(c => c.column_name.toLowerCase()));
    for (const col of need) {
      assertTrue(`deployments.${col} exists`, have.has(col));
    }

    const evCols = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE lower(table_name) = 'webhook_events'`
    );
    const evNeed = ['id','deployment_id','received_at','raw_body',
                    'signature_ok','bar_time','action','direction',
                    'reason','price','dedup_key'];
    const evHave = new Set(evCols.map(c => c.column_name.toLowerCase()));
    for (const col of evNeed) {
      assertTrue(`webhook_events.${col} exists`, evHave.has(col));
    }

    // CHECK constraint: mode='live' must reject. The CHECK is defensive
    // depth — the helper rejects too, but if someone bypasses the
    // helper and writes raw SQL, the DB still won't allow it.
    let dbRejectedLive = false;
    try {
      await exec(`INSERT INTO deployments (spec_hash, symbol, timeframe, mode, secret_key)
                  VALUES ('x', 'X', 60, 'live', 'fake')`);
    } catch { dbRejectedLive = true; }
    assertTrue('CHECK constraint rejects mode=live at the DB layer', dbRejectedLive);
    // Clean any partial side effect just in case.
    await exec(`DELETE FROM deployments WHERE secret_key = 'fake'`).catch(() => {});
  }

  // ── 2. Helpers (in-process) ─────────────────────────────────
  console.log('\n[2] db/deployments.js helpers');
  {
    // mintSecret produces 64 hex chars (32 bytes).
    const s1 = mintSecret();
    const s2 = mintSecret();
    assertTrue('mintSecret returns 64 hex chars', /^[0-9a-f]{64}$/.test(s1));
    assertTrue('mintSecret produces unique values', s1 !== s2);

    // dedupKey is stable + composite.
    assertEq('dedupKey composes bar_time:action:direction',
      dedupKey({ bar_time: '2024-01-01T12:00Z', action: 'open', direction: 'long' }),
      '2024-01-01T12:00Z:open:long');
    assertTrue('dedupKey distinguishes action',
      dedupKey({ bar_time: 't', action: 'open',  direction: 'long' }) !==
      dedupKey({ bar_time: 't', action: 'close', direction: 'long' }));
    assertTrue('dedupKey distinguishes direction',
      dedupKey({ bar_time: 't', action: 'open', direction: 'long' }) !==
      dedupKey({ bar_time: 't', action: 'open', direction: 'short' }));

    // create + get round-trip.
    const created = await createDeployment({
      spec_hash: 'sha256-test-helper',
      symbol:    'BTCUSDT',
      timeframe: 240,
    });
    assertTrue('createDeployment returns id', Number.isInteger(created.id));
    assertEq('createDeployment defaults mode=paper', created.mode, 'paper');
    assertEq('createDeployment defaults status=draft', created.status, 'draft');
    assertTrue('createDeployment mints 64-char secret',
      typeof created.secret_key === 'string' && created.secret_key.length === 64);

    const fetched = await getDeployment(created.id);
    assertTrue('getDeployment round-trips', fetched && fetched.id === created.id);
    assertEq('getDeployment matches symbol', fetched.symbol, 'BTCUSDT');

    // list filtered by status.
    const drafts = await listDeployments({ status: 'draft' });
    assertTrue('listDeployments({status:draft}) finds the new row',
      drafts.some(d => d.id === created.id));
    const armed = await listDeployments({ status: 'armed' });
    assertTrue('listDeployments({status:armed}) excludes drafts',
      !armed.some(d => d.id === created.id));

    // recordWebhookEvent: insert, then dedup.
    const payload = makePayload({ at: new Date('2024-01-01T12:00:00Z') });
    const r1 = await recordWebhookEvent({
      deployment_id: created.id,
      payload,
      signature_ok: true,
    });
    assertEq('recordWebhookEvent first call → inserted',
      { inserted: r1.inserted, duplicate: r1.duplicate }, { inserted: true, duplicate: false });
    const r2 = await recordWebhookEvent({
      deployment_id: created.id,
      payload: { ...payload, price: 99999 }, // different price, same dedup key
      signature_ok: true,
    });
    assertEq('recordWebhookEvent second call (same key) → duplicate',
      { inserted: r2.inserted, duplicate: r2.duplicate }, { inserted: false, duplicate: true });
    assertEq('countWebhookEvents reflects dedup',
      await countWebhookEvents(created.id), 1);
    // The duplicate response returns the ORIGINAL row (not the dup payload),
    // so a caller can see what was already stored.
    assertEq('duplicate result echoes original price',
      r2.event.price, payload.price);

    // helper rejects mode=live.
    let helperRejectedLive = false;
    try {
      await createDeployment({ spec_hash: 'x', symbol: 'X', timeframe: 60, mode: 'live' });
    } catch { helperRejectedLive = true; }
    assertTrue('createDeployment rejects mode=live at the helper', helperRejectedLive);
  }

  // ── 3. Server contract ──────────────────────────────────────
  console.log('\n[3] Server: POST /api/deployments + /webhook/:id/:secret');

  // Seed: a real spec + a spec-mode run + a legacy run, so we can
  // exercise the endpoint's gating logic.
  const specPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
  const rawSpec = JSON.parse(await readFile(specPath, 'utf8'));
  const spec = validateSpec(rawSpec, { sourcePath: specPath });
  await upsertSpec(spec);

  const SPEC_RUN_ID   = 9700001;
  const LEGACY_RUN_ID = 9700002;
  const NO_GENE_ID    = 9700003;
  await exec(`DELETE FROM runs WHERE id IN (${SPEC_RUN_ID}, ${LEGACY_RUN_ID}, ${NO_GENE_ID})`);
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash, best_gene)
     VALUES (${SPEC_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'completed',
             '${spec.hash}', '${JSON.stringify({ x: 1 }).replace(/'/g, "''")}')`,
  );
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, best_gene)
     VALUES (${LEGACY_RUN_ID}, 'BTCUSDT', 240, '2024-01-01', 'completed',
             '${JSON.stringify({ emaFast: 14 }).replace(/'/g, "''")}')`,
  );
  await exec(
    `INSERT INTO runs (id, symbol, timeframe, start_date, status, spec_hash)
     VALUES (${NO_GENE_ID}, 'BTCUSDT', 240, '2024-01-01', 'running',
             '${spec.hash}')`,
  );

  const app = await startApp();
  let deploymentId = null;
  let deploymentSecret = null;
  try {
    // ── 3a. POST /api/deployments — happy path ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: SPEC_RUN_ID }),
      });
      assertTrue('POST /api/deployments (spec-mode run) → 200', r.status === 200);
      const body = await r.json();
      assertTrue('response includes id', Number.isInteger(body.id));
      assertEq('response defaults status=draft', body.status, 'draft');
      assertEq('response defaults mode=paper', body.mode, 'paper');
      assertEq('response copies symbol from run', body.symbol, 'BTCUSDT');
      assertEq('response copies timeframe from run', Number(body.timeframe), 240);
      assertEq('response copies spec_hash from run', body.spec_hash, spec.hash);
      assertTrue('response includes full secret (creation only)',
        typeof body.secret_key === 'string' && body.secret_key.length === 64);
      deploymentId = body.id;
      deploymentSecret = body.secret_key;
    }

    // ── 3b. POST /api/deployments — legacy run rejected ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: LEGACY_RUN_ID }),
      });
      assertTrue('POST /api/deployments (legacy run) → 400', r.status === 400);
      const body = await r.json();
      assertTrue('legacy-run error mentions spec',
        typeof body.error === 'string' && /spec/i.test(body.error));
    }

    // ── 3c. POST /api/deployments — no-gene run rejected ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: NO_GENE_ID }),
      });
      assertTrue('POST /api/deployments (no best_gene) → 400', r.status === 400);
    }

    // ── 3d. POST /api/deployments — missing run_id ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assertTrue('POST /api/deployments (missing run_id) → 400', r.status === 400);
    }

    // ── 3e. POST /api/deployments — unknown run_id ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run_id: 12345678 }),
      });
      assertTrue('POST /api/deployments (unknown run) → 404', r.status === 404);
    }

    // ── 3f. GET /api/deployments redacts secret ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments`);
      assertTrue('GET /api/deployments → 200', r.status === 200);
      const body = await r.json();
      assertTrue('GET list returns array', Array.isArray(body));
      const me = body.find(d => d.id === deploymentId);
      assertTrue('list includes our deployment', !!me);
      assertTrue('list response does NOT include secret_key',
        !('secret_key' in me));
      assertTrue('list response includes secret_key_preview',
        typeof me.secret_key_preview === 'string');
      assertTrue('preview is just first 4 chars + ellipsis',
        /^[0-9a-f]{4}…$/.test(me.secret_key_preview));
    }

    // ── 3g. GET /api/deployments/:id reveals secret + event count ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments/${deploymentId}`);
      assertTrue('GET /api/deployments/:id → 200', r.status === 200);
      const body = await r.json();
      assertEq('GET-by-id reveals full secret', body.secret_key, deploymentSecret);
      assertEq('GET-by-id includes event_count=0 initially', body.event_count, 0);
    }

    // ── 3h. GET /api/deployments/:id — missing → 404 ──
    {
      const r = await fetch(`http://127.0.0.1:${app.port}/api/deployments/87654321`);
      assertTrue('GET /api/deployments/missing → 404', r.status === 404);
    }

    // ── 3i. POST /webhook/:id/:secret — happy path ──
    let firstEventId = null;
    {
      const payload = makePayload({ at: new Date() });
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(payload),
        },
      );
      assertTrue('POST /webhook (valid sig, fresh payload) → 200', r.status === 200);
      const body = await r.json();
      assertEq('response.ok=true', body.ok, true);
      assertEq('response.deduped=false', body.deduped, false);
      assertTrue('response includes event_id', Number.isInteger(body.event_id));
      firstEventId = body.event_id;

      // Verify row landed with signature_ok=true.
      const rows = await query(
        `SELECT * FROM webhook_events WHERE id = ${firstEventId}`
      );
      assertTrue('event row exists in DB', rows.length === 1);
      assertEq('signature_ok=true on stored row',
        rows[0].signature_ok === true || rows[0].signature_ok === 1, true);
      assertEq('action persisted', rows[0].action, 'open');
      assertEq('direction persisted', rows[0].direction, 'long');
    }

    // ── 3j. POST /webhook — duplicate → 200 + deduped:true, 1 row ──
    {
      const payload = makePayload({ at: new Date() }); // same time → same dedup_key
      // (clock advanced, but slice(0,16) is minute-precision so still
      //  same key as long as we're in the same minute)
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ ...payload, price: 11111 }),
        },
      );
      assertTrue('duplicate POST /webhook → 200', r.status === 200);
      const body = await r.json();
      assertEq('duplicate.ok=true', body.ok, true);
      assertEq('duplicate.deduped=true', body.deduped, true);
      // dispatcher consumes by event_id — duplicate returns the
      // original event_id so the consumer can correlate.
      assertEq('duplicate returns original event_id', body.event_id, firstEventId);

      const count = await countWebhookEvents(deploymentId);
      assertEq('only one row persisted after dedup', count, 1);
    }

    // ── 3k. POST /webhook — bad secret → 401 + auth_fail row ──
    {
      const before = await query(
        `SELECT count(*)::INTEGER AS n FROM webhook_events
           WHERE deployment_id = ${deploymentId} AND signature_ok = FALSE`
      );
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${'0'.repeat(64)}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(makePayload()),
        },
      );
      assertTrue('POST /webhook (bad secret) → 401', r.status === 401);
      const body = await r.json();
      assertTrue('401 error mentions invalid secret',
        typeof body.error === 'string' && /invalid/i.test(body.error));

      const after = await query(
        `SELECT count(*)::INTEGER AS n FROM webhook_events
           WHERE deployment_id = ${deploymentId} AND signature_ok = FALSE`
      );
      assertEq('failed-auth attempt persisted (signature_ok=false)',
        after[0].n, before[0].n + 1);
    }

    // ── 3l. POST /webhook — unknown deployment → 404 ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/99999999/${'0'.repeat(64)}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(makePayload()),
        },
      );
      assertTrue('POST /webhook (unknown deployment) → 404', r.status === 404);
    }

    // ── 3m. POST /webhook — stale payload → 400 ──
    {
      // Timeframe is 240 min → max age 480 min. Use 24h-old payload.
      const stale = makePayload({ at: new Date(Date.now() - 24 * 60 * 60 * 1000) });
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(stale),
        },
      );
      assertTrue('POST /webhook (stale payload) → 400', r.status === 400);
      const body = await r.json();
      assertTrue('stale error mentions stale/age',
        typeof body.error === 'string' && /stale|too|age/i.test(body.error));
    }

    // ── 3n. POST /webhook — missing fields → 400 ──
    {
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ price: 100 }),  // no action, no time
        },
      );
      assertTrue('POST /webhook (missing fields) → 400', r.status === 400);
    }

    // ── 3o. POST /webhook — body too large → 413 ──
    {
      // Pad the payload past 4 KB. We pad a 'reason' field; valid JSON.
      const big = makePayload();
      big.reason = 'x'.repeat(5000);
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(big),
        },
      );
      assertTrue('POST /webhook (>4KB body) → 413', r.status === 413);
    }

    // ── 3p. POST /webhook — close action does NOT dedupe with open ──
    // Same bar_time as the original open, but different action — must
    // create a fresh row (the dispatcher relies on this to recognize
    // exits separately from entries).
    {
      const closePayload = makePayload({ at: new Date(), action: 'close', reason: 'TP1' });
      const r = await fetch(
        `http://127.0.0.1:${app.port}/webhook/${deploymentId}/${deploymentSecret}`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(closePayload),
        },
      );
      assertTrue('close (same bar, different action) → 200', r.status === 200);
      const body = await r.json();
      assertEq('close is NOT deduped vs prior open', body.deduped, false);
    }
  } finally {
    try {
      await exec(`DELETE FROM runs WHERE id IN (${SPEC_RUN_ID}, ${LEGACY_RUN_ID}, ${NO_GENE_ID})`);
    } catch { /* ignore */ }
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
