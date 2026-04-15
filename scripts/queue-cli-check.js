/**
 * queue-cli-check — smoke test for Phase 4.2c scripts/queue.js.
 *
 * Spins up a minimal fake HTTP server that implements the queue
 * endpoints as mocks (records what it receives, returns canned
 * responses), then spawns `scripts/queue.js` against it as a child
 * process. Asserts:
 *
 *   1. `queue.js list` on an empty queue prints "(none)" / "(empty)"
 *      and calls GET /api/queue exactly once.
 *   2. `queue.js add BTCUSDT 240 --spec foo.json --pop 12 --gens 3`
 *      POSTs /api/runs with the right body shape.
 *   3. `queue.js cancel 42` POSTs /api/runs/42/cancel.
 *   4. `queue.js recover --timeout-ms 30000` POSTs /api/queue/recover
 *      with `{ timeoutMs: 30000 }`.
 *   5. Unknown command exits non-zero with usage.
 *   6. No server reachable → exits non-zero with "server not reachable".
 *
 * Pure HTTP contract test — no DuckDB, no optimizer server. Fast.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'queue.js');

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

/**
 * Spin up a fake HTTP server. `handler({method, path, body}) => response`
 * where response is either `{ status, json }` or `null` for 404.
 * Records every request in `received` for later assertions.
 *
 * Returns `{ port, close, received }`. `close()` terminates the server.
 */
function startFakeServer(handler) {
  const received = [];
  return new Promise(resolvePromise => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = null;
        if (raw) {
          try { body = JSON.parse(raw); }
          catch { body = raw; }
        }
        const captured = { method: req.method, path: req.url, body };
        received.push(captured);
        const r = handler(captured);
        if (!r) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.json ?? {}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolvePromise({
        port,
        received,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/**
 * Run the CLI as a subprocess against `port`, with the given argv.
 * Returns `{ code, stdout, stderr }`.
 */
function runCli(port, argv) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...process.env,
        OPTIMIZER_HOST: '127.0.0.1',
        OPTIMIZER_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}

async function main() {
  // ── 1. list on empty queue ──────────────────────────────────
  console.log('\n[1] list on empty queue');
  {
    const srv = await startFakeServer(({ method, path }) => {
      if (method === 'GET' && path === '/api/queue') {
        return { json: { active: null, pending: [] } };
      }
      return null;
    });
    const r = await runCli(srv.port, ['list']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertTrue('calls GET /api/queue exactly once', srv.received.length === 1,
      `received=${srv.received.length}`);
    assertEq('GET /api/queue', { method: srv.received[0].method, path: srv.received[0].path },
      { method: 'GET', path: '/api/queue' });
    assertTrue('shows no active', r.stdout.includes('(none)'));
    assertTrue('shows empty pending', r.stdout.includes('(empty)'));
  }

  // ── 2. list --running ───────────────────────────────────────
  console.log('\n[2] list --running with one active row');
  {
    const srv = await startFakeServer(() => ({
      json: {
        active: { runId: 7, symbol: 'BTCUSDT', timeframe: 240, label: '4H' },
        pending: [{ runId: 8, symbol: 'ETHUSDT', timeframe: 60, priority: 5, specName: null, label: '1H' }],
      },
    }));
    const r = await runCli(srv.port, ['list', '--running']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertTrue('mentions active run id', r.stdout.includes('#7'));
    assertTrue('does NOT mention pending row', !r.stdout.includes('#8'));
  }

  // ── 3. add with spec + flags ────────────────────────────────
  console.log('\n[3] add BTCUSDT 240 --spec ... --pop 12 --gens 3');
  {
    const srv = await startFakeServer(({ method, path }) => {
      if (method === 'POST' && path === '/api/runs') {
        return { json: { status: 'queued', runIds: [101], totalRuns: 1 } };
      }
      return null;
    });
    const r = await runCli(srv.port, [
      'add', 'btcusdt', '240',
      '--spec', '20260414-001-jm-simple-3tp-legacy.json',
      '--pop', '12',
      '--gens', '3',
      '--mut', '0.4',
      '--islands', '1',
      '--planets', '1',
      '--start', '2021-04-12',
    ]);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertEq('POST /api/runs', srv.received[0].path, '/api/runs');
    assertEq('symbol uppercased', srv.received[0].body.symbols, ['BTCUSDT']);
    assertEq('tf 240 → 4H label',  srv.received[0].body.intervals, ['4H']);
    assertEq('spec passed through', srv.received[0].body.spec, '20260414-001-jm-simple-3tp-legacy.json');
    assertEq('pop maps to populationSize', srv.received[0].body.populationSize, 12);
    assertEq('gens maps to generations',   srv.received[0].body.generations, 3);
    assertEq('startDate present',          srv.received[0].body.startDate, '2021-04-12');
    assertTrue('stdout reports runId 101', r.stdout.includes('101'));
  }

  // ── 3b. add with tf as label directly ───────────────────────
  console.log('\n[3b] add accepts tf=4H label directly');
  {
    const srv = await startFakeServer(() => ({
      json: { status: 'queued', runIds: [102], totalRuns: 1 },
    }));
    const r = await runCli(srv.port, ['add', 'ETHUSDT', '1H']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertEq('1H label passed through as-is', srv.received[0].body.intervals, ['1H']);
  }

  // ── 3c. add with invalid tf ─────────────────────────────────
  console.log('\n[3c] add rejects unknown tf');
  {
    const srv = await startFakeServer(() => ({ json: {} }));
    const r = await runCli(srv.port, ['add', 'BTCUSDT', '7m']);
    await srv.close();
    assertTrue('exit code non-zero', r.code !== 0);
    assertTrue('error mentions unsupported tf',
      r.stderr.toLowerCase().includes('unsupported tf') || r.stderr.toLowerCase().includes('tf'));
    assertTrue('did NOT call server', srv.received.length === 0);
  }

  // ── 4. cancel ───────────────────────────────────────────────
  console.log('\n[4] cancel 42');
  {
    const srv = await startFakeServer(({ method, path }) => {
      if (method === 'POST' && path === '/api/runs/42/cancel') {
        return { json: { status: 'cancel_requested' } };
      }
      return null;
    });
    const r = await runCli(srv.port, ['cancel', '42']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertEq('POST /api/runs/42/cancel', srv.received[0].path, '/api/runs/42/cancel');
    assertTrue('stdout contains status', r.stdout.includes('cancel_requested'));
  }

  // ── 4b. cancel with non-numeric id ──────────────────────────
  console.log('\n[4b] cancel rejects non-numeric id');
  {
    const srv = await startFakeServer(() => ({ json: {} }));
    const r = await runCli(srv.port, ['cancel', 'abc']);
    await srv.close();
    assertTrue('exit code non-zero', r.code !== 0);
    assertTrue('error mentions id', r.stderr.toLowerCase().includes('id'));
    assertTrue('did NOT call server', srv.received.length === 0);
  }

  // ── 5. recover ──────────────────────────────────────────────
  console.log('\n[5] recover --timeout-ms 30000');
  {
    const srv = await startFakeServer(({ method, path, body }) => {
      if (method === 'POST' && path === '/api/queue/recover') {
        // Echo what we received for assertion below.
        return { json: { recovered: 2, timeoutMs: body?.timeoutMs ?? null } };
      }
      return null;
    });
    const r = await runCli(srv.port, ['recover', '--timeout-ms', '30000']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertEq('POST /api/queue/recover', srv.received[0].path, '/api/queue/recover');
    assertEq('timeoutMs forwarded', srv.received[0].body.timeoutMs, 30000);
    assertTrue('stdout reports recovered count', r.stdout.includes('2'));
  }

  // ── 5b. recover with default timeout ────────────────────────
  console.log('\n[5b] recover with no flag → default 60000');
  {
    const srv = await startFakeServer(() => ({
      json: { recovered: 0, timeoutMs: 60_000 },
    }));
    const r = await runCli(srv.port, ['recover']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertEq('default timeoutMs=60000', srv.received[0].body.timeoutMs, 60_000);
  }

  // ── 6. unknown command ──────────────────────────────────────
  console.log('\n[6] unknown command');
  {
    const srv = await startFakeServer(() => ({ json: {} }));
    const r = await runCli(srv.port, ['frobnicate']);
    await srv.close();
    assertTrue('exit code non-zero', r.code !== 0);
    assertTrue('stderr mentions unknown command',
      r.stderr.toLowerCase().includes('unknown command'));
    assertTrue('usage printed to stdout',
      r.stdout.toLowerCase().includes('usage'));
  }

  // ── 7. server unreachable ───────────────────────────────────
  console.log('\n[7] server unreachable → clear error');
  {
    // Use a port we didn't bind. 127.0.0.1:1 is reliably refused.
    const r = await runCli(1, ['list']);
    assertTrue('exit code non-zero', r.code !== 0);
    assertTrue('error mentions server not reachable',
      r.stderr.toLowerCase().includes('server not reachable'));
  }

  // ── 8. --priority warns (not silently dropped) ──────────────
  console.log('\n[8] --priority prints a warning (feature not exposed by POST /api/runs)');
  {
    const srv = await startFakeServer(() => ({
      json: { status: 'queued', runIds: [103], totalRuns: 1 },
    }));
    const r = await runCli(srv.port, ['add', 'BTCUSDT', '240', '--priority', '10']);
    await srv.close();
    assertEq('exit code 0', r.code, 0);
    assertTrue('stderr has WARN about priority',
      r.stderr.toLowerCase().includes('priority'));
  }

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
