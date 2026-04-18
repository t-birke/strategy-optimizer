#!/usr/bin/env node
/**
 * Phase 4.2c — queue CLI.
 *
 * Thin HTTP client over the optimizer server's queue endpoints. Single-
 * process mode: the server is the sole DB writer, so the CLI never
 * touches DuckDB directly — all commands go through /api/*. If the
 * server isn't running, every command fails fast with a clear
 * "server not reachable" error.
 *
 * Why HTTP (not direct DB):
 *  - DuckDB is single-writer per DB file; opening the same file from
 *    a second process while the server holds it would error.
 *  - Cancels need to flip the in-process `cancelRequested` flag so the
 *    GA bails within the current generation — only the server process
 *    can do that. The HTTP endpoint already handles both (DB flag +
 *    in-process flag).
 *
 * Usage:
 *   node scripts/queue.js <command> [options]
 *
 * Commands:
 *   add <symbol> <tf> [options]    Enqueue a run
 *   list [--running]               Show pending + running rows
 *   cancel <id>                    Cancel a run (pending or active)
 *   recover [--timeout-ms <N>]     Recover stale 'running' rows
 *
 * `add` options:
 *   --spec <file>                  Spec file under strategies/ (spec mode).
 *                                  Omit for legacy mode.
 *   --priority <N>                 Higher = claimed sooner (default 0).
 *   --start <YYYY-MM-DD>           Start date. Default: 5y back.
 *   --end <YYYY-MM-DD>             End date. Default: null (present).
 *   --pop <N>                      Population size (default 80).
 *   --gens <N>                     Generations (default 80).
 *   --mut <0-1>                    Mutation rate (default 0.4).
 *   --islands <N>                  Islands per planet (default 4).
 *   --planets <N>                  Planets (default 1).
 *   --min-trades <N>               Min trades gate (default 30).
 *   --max-dd <PCT>                 Max drawdown % (default 50).
 *   --label <str>                  Human label for the run.
 *
 * `recover` options:
 *   --timeout-ms <N>               Stale-lease timeout (default 60000).
 *
 * Environment:
 *   OPTIMIZER_HOST                 Default: localhost
 *   OPTIMIZER_PORT                 Default: 3000
 *
 * Examples:
 *   node scripts/queue.js add BTCUSDT 240 --spec 20260414-001-jm-simple-3tp-legacy.json
 *   node scripts/queue.js add ETHUSDT 60 --priority 10 --pop 120 --gens 100
 *   node scripts/queue.js list
 *   node scripts/queue.js cancel 42
 *   node scripts/queue.js recover --timeout-ms 120000
 */

const HOST = process.env.OPTIMIZER_HOST || 'localhost';
const PORT = process.env.OPTIMIZER_PORT || '3000';
const BASE = `http://${HOST}:${PORT}`;

/** Parse argv[3+] into `{ flags: {k:v}, positional: [] }`. Flags are
 *  `--key value` or `--key=value`; bare flags (no value) become `true`. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** HTTP helper. Returns parsed JSON on 2xx; throws on non-2xx with a
 *  readable error that includes the server's error body if any. */
async function http(method, path, body) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-layer failures (ECONNREFUSED etc.) — the server isn't up.
    throw new Error(
      `server not reachable at ${BASE} — is the optimizer server running? ` +
      `(underlying: ${err.message})`
    );
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : text || res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return parsed;
}

/** Parse a required positional or throw with a helpful message. */
function need(positional, idx, name) {
  const v = positional[idx];
  if (v === undefined) throw new Error(`missing argument: ${name}`);
  return v;
}

/** Numeric flag with default — tolerant of "42" vs 42. */
function num(flags, key, defaultVal) {
  if (flags[key] === undefined) return defaultVal;
  const n = Number(flags[key]);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${flags[key]}"`);
  return n;
}

// ─── Commands ──────────────────────────────────────────────────

async function cmdAdd({ flags, positional }) {
  const symbol = need(positional, 1, 'symbol').toUpperCase();
  const tfRaw = need(positional, 2, 'tf');

  // The server's INTERVAL_MAP expects labels like '4H', '1H', '15m'.
  // For the CLI we accept either the label ('4H') or the minute count (240)
  // and normalize on the way through. Plain numbers → minutes → label.
  const MIN_TO_LABEL = {
    1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m',
    60: '1H', 120: '2H', 180: '3H', 240: '4H', 360: '6H', 480: '8H',
  };
  const VALID_LABELS = new Set(Object.values(MIN_TO_LABEL));
  let ivLabel;
  if (VALID_LABELS.has(tfRaw)) {
    ivLabel = tfRaw;
  } else if (/^\d+$/.test(tfRaw) && MIN_TO_LABEL[Number(tfRaw)]) {
    ivLabel = MIN_TO_LABEL[Number(tfRaw)];
  } else {
    throw new Error(`unsupported tf "${tfRaw}" — use a minute count (60, 240) or label (1H, 4H)`);
  }

  const body = {
    symbols: [symbol],
    intervals: [ivLabel],
    populationSize: num(flags, 'pop', 80),
    generations:    num(flags, 'gens', 80),
    mutationRate:   num(flags, 'mut', 0.4),
    numIslands:     num(flags, 'islands', 4),
    numPlanets:     num(flags, 'planets', 1),
    minTrades:      num(flags, 'min-trades', 30),
    maxDrawdownPct: num(flags, 'max-dd', 50),
  };
  if (flags.spec)     body.spec = flags.spec;     // filename string, server resolves under strategies/
  if (flags.start)    body.startDate = flags.start;
  if (flags.end)      body.endDate = flags.end;

  const out = await http('POST', '/api/runs', body);
  console.log(`queued runIds: ${out.runIds.join(', ')} (total ${out.totalRuns})`);

  // Priority can't be set via POST /api/runs today (routes.js always
  // inserts with default priority). If the user asked for a non-default
  // priority we'd need a separate endpoint. Warn loudly rather than lie.
  if (flags.priority !== undefined && flags.priority !== '0' && flags.priority !== 0) {
    console.warn(
      `WARN: --priority ${flags.priority} was ignored. POST /api/runs does not expose priority yet; ` +
      `edit the row directly or extend routes.js if you need it.`
    );
  }
  if (flags.label !== undefined) {
    console.warn(
      `WARN: --label was ignored. Label is derived from interval today (set server-side).`
    );
  }
}

async function cmdList({ flags }) {
  const out = await http('GET', '/api/queue');
  const activeRow = out.active;
  const pending = out.pending || [];
  if (flags.running) {
    if (!activeRow) { console.log('(no active run)'); return; }
    console.log(`[running] #${activeRow.runId}  ${activeRow.symbol}/${activeRow.timeframe}m  label=${activeRow.label ?? '-'}`);
    return;
  }
  if (activeRow) {
    console.log(`[running] #${activeRow.runId}  ${activeRow.symbol}/${activeRow.timeframe}m  label=${activeRow.label ?? '-'}`);
  } else {
    console.log('[running] (none)');
  }
  if (pending.length === 0) {
    console.log('[pending] (empty)');
    return;
  }
  console.log(`[pending] ${pending.length} row(s):`);
  for (const r of pending) {
    console.log(
      `  #${r.runId}  pri=${r.priority}  ${r.symbol}/${r.timeframe}m  ` +
      `spec=${r.specName ?? '-'}  label=${r.label ?? '-'}`
    );
  }
}

async function cmdCancel({ positional }) {
  const id = Number(need(positional, 1, 'id'));
  if (!Number.isFinite(id)) throw new Error(`id must be a number, got "${positional[1]}"`);
  const out = await http('POST', `/api/runs/${id}/cancel`);
  console.log(`run ${id}: ${out.status}`);
}

async function cmdRecover({ flags }) {
  const timeoutMs = num(flags, 'timeout-ms', 60_000);
  const out = await http('POST', '/api/queue/recover', { timeoutMs });
  console.log(`recovered ${out.recovered} stale 'running' row(s) (timeoutMs=${out.timeoutMs})`);
}

// ─── Entry ─────────────────────────────────────────────────────

function printUsage() {
  console.log(`Usage: node scripts/queue.js <command> [options]

Commands:
  add <symbol> <tf>              Enqueue a run (see top of file for --flags)
  list [--running]               Show pending + running rows
  cancel <id>                    Cancel a run
  recover [--timeout-ms N]       Sweep stale running rows

Environment:
  OPTIMIZER_HOST (default localhost)
  OPTIMIZER_PORT (default 3000)`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || flags.help || flags.h) {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  const dispatch = {
    add:     cmdAdd,
    list:    cmdList,
    cancel:  cmdCancel,
    recover: cmdRecover,
  };
  const fn = dispatch[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  }

  try {
    await fn({ flags, positional });
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
