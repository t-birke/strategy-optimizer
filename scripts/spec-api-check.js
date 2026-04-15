/**
 * spec-api-check — smoke test for Phase 4.3a read-only endpoints
 * (and the 4.3e POST + 4.4 defaults endpoint bolted on top).
 *
 *   GET /api/specs    — enumerates strategies/*.json
 *   GET /api/blocks   — enumerates the in-memory block registry
 *   GET /api/defaults — surfaces DEFAULT_FITNESS + DEFAULT_WALK_FORWARD (4.4)
 *
 * Neither endpoint touches the queue or DuckDB, so this test boots a bare
 * Express app with the real router mounted, hits the endpoints via fetch
 * on an ephemeral port, and validates response shape + invariants.
 *
 * We do NOT touch `strategies/` on disk — the repo already ships one spec
 * file (`20260414-001-jm-simple-3tp-legacy.json`) which is exactly what
 * the test asserts against. If that file disappears, this test fails loudly
 * (which is the right behavior — it would also break the UI).
 *
 * The `/api/blocks` assertions are framed against the 14 shipped blocks
 * enumerated by engine/blocks/library/index.js — not a hardcoded count,
 * but a set of invariants (every block has id/version/kind/params; entry
 * blocks have direction; exit blocks have exitSlot; sizing blocks never
 * have direction/exitSlot; etc.) so adding a new block doesn't break the
 * test.
 */

import express from 'express';
import { createServer } from 'node:http';
import { unlink, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import routes from '../api/routes.js';

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

/** Spin up the real router on an ephemeral port. Returns { port, close }. */
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

/** Simple fetch wrapper that returns `{ status, body }`. */
async function get(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function post(port, path, json) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

/**
 * A minimal-but-valid spec that passes validateSpec against the shipping
 * block registry. Used by the POST /api/specs suite to build happy-path
 * and edge-case payloads without duplicating 30 lines of JSON in every test.
 * Returns a fresh object each call so tests can mutate freely.
 */
function minimalValidSpec(name) {
  return {
    name,
    description: 'spec-api-check POST smoke',
    regime: null,
    entries: {
      mode: 'all',
      blocks: [
        {
          block: 'stochCross',
          version: 1,
          instanceId: 'main',
          params: {
            stochLen:   { min: 5, max: 40, step: 1 },
            stochSmth:  { min: 1, max: 8,  step: 1 },
            longLevel:  { value: 40 },
            shortLevel: { value: 60 },
          },
        },
      ],
    },
    filters: { mode: 'all', blocks: [] },
    exits: {
      hardStop: {
        block: 'atrHardStop',
        version: 1,
        instanceId: 'main',
        params: {
          atrLen:         { min: 5,   max: 30,  step: 1 },
          atrSL:          { min: 0.5, max: 4.0, step: 0.25 },
          emergencySlPct: { min: 5,   max: 25,  step: 1 },
        },
      },
    },
    sizing: {
      block: 'pctOfEquity',
      version: 1,
      instanceId: 'main',
      params: { pct: { min: 1, max: 100, step: 1 } },
    },
    constraints: [],
    fitness: {
      weights: { pf: 0.5, dd: 0.3, ret: 0.2 },
      caps:    { pf: 4.0, ret: 2.0 },
      gates:   { minTradesPerWindow: 30, worstRegimePfFloor: 1.0, wfeMin: 0.5 },
    },
    walkForward: { nWindows: 5, scheme: 'anchored' },
  };
}

async function main() {
  const app = await startApp();
  try {
    // ── 1. GET /api/specs ──────────────────────────────────────
    console.log('\n[1] GET /api/specs');
    {
      const r = await get(app.port, '/api/specs');
      assertEq('status 200', r.status, 200);
      assertTrue('body has specs array',
        r.body && Array.isArray(r.body.specs), `specs=${typeof r.body?.specs}`);
      assertTrue('body has malformed array',
        r.body && Array.isArray(r.body.malformed), `malformed=${typeof r.body?.malformed}`);

      // Must include the baseline legacy spec that ships with the repo.
      const legacy = r.body.specs.find(s =>
        s.filename === '20260414-001-jm-simple-3tp-legacy.json');
      assertTrue('includes legacy spec', legacy != null);
      if (legacy) {
        assertEq('legacy name',
          legacy.name, '20260414-001-jm-simple-3tp-legacy');
        assertTrue('legacy has description',
          typeof legacy.description === 'string' && legacy.description.length > 0);
        assertTrue('legacy description <= 281 chars (280 + ellipsis)',
          legacy.description.length <= 281);
        assertTrue('legacy sizeBytes > 0', legacy.sizeBytes > 0);
        assertTrue('legacy mtime parses as ISO',
          !Number.isNaN(Date.parse(legacy.mtime)));
      }

      // Every spec object has the full documented shape — picker relies on it.
      for (const s of r.body.specs) {
        assertTrue(`spec ${s.filename}: has filename`, typeof s.filename === 'string');
        assertTrue(`spec ${s.filename}: has name`, typeof s.name === 'string');
        assertTrue(`spec ${s.filename}: has sizeBytes`, typeof s.sizeBytes === 'number');
        assertTrue(`spec ${s.filename}: has mtime`, typeof s.mtime === 'string');
      }
    }

    // ── 2. GET /api/blocks ─────────────────────────────────────
    console.log('\n[2] GET /api/blocks');
    {
      const r = await get(app.port, '/api/blocks');
      assertEq('status 200', r.status, 200);
      assertTrue('body has blocks array',
        r.body && Array.isArray(r.body.blocks));
      assertTrue('registry is non-empty',
        r.body.blocks.length > 0, `count=${r.body.blocks.length}`);

      // Invariants per-block.
      const KINDS = new Set(['entry', 'filter', 'regime', 'exit', 'sizing']);
      const DIRECTIONS = new Set(['long', 'short', 'both']);
      const EXIT_SLOTS = new Set(['hardStop', 'target', 'trail']);
      for (const b of r.body.blocks) {
        assertTrue(`block has id`, typeof b.id === 'string' && b.id.length > 0);
        assertTrue(`block ${b.id}: version is positive integer`,
          Number.isInteger(b.version) && b.version >= 1);
        assertTrue(`block ${b.id}: kind is valid`, KINDS.has(b.kind));
        assertTrue(`block ${b.id}: params is array`, Array.isArray(b.params));

        // Direction is required on entry/filter/exit; null on regime/sizing.
        if (b.kind === 'entry' || b.kind === 'filter' || b.kind === 'exit') {
          assertTrue(`block ${b.id}: direction is valid`,
            DIRECTIONS.has(b.direction), `direction=${b.direction}`);
        } else {
          assertEq(`block ${b.id}: direction null (${b.kind})`, b.direction, null);
        }

        // exitSlot is required on exit; null elsewhere.
        if (b.kind === 'exit') {
          assertTrue(`block ${b.id}: exitSlot is valid`,
            EXIT_SLOTS.has(b.exitSlot), `exitSlot=${b.exitSlot}`);
        } else {
          assertEq(`block ${b.id}: exitSlot null (${b.kind})`, b.exitSlot, null);
        }

        // sizingRequirements: non-null only on sizing blocks (and optional there).
        if (b.kind !== 'sizing') {
          assertEq(`block ${b.id}: sizingRequirements null (${b.kind})`,
            b.sizingRequirements, null);
        }

        // description: optional, but if present must be a non-empty string.
        // The UI editor surfaces this under each block picker so users can
        // remember what each block does without reading source.
        assertTrue(`block ${b.id}: description is string or null`,
          b.description === null || typeof b.description === 'string',
          `typeof=${typeof b.description}`);
        if (typeof b.description === 'string') {
          assertTrue(`block ${b.id}: description is non-empty`,
            b.description.length > 0);
        }

        // Every declared param has id/type/min/max/step.
        for (const p of b.params) {
          assertTrue(`${b.id}.${p.id}: has id`, typeof p.id === 'string' && p.id.length > 0);
          assertTrue(`${b.id}.${p.id}: type is 'int' or 'float'`,
            p.type === 'int' || p.type === 'float');
          assertTrue(`${b.id}.${p.id}: min/max/step are numbers`,
            typeof p.min === 'number' && typeof p.max === 'number' && typeof p.step === 'number');
          assertTrue(`${b.id}.${p.id}: min < max`, p.min < p.max);
          assertTrue(`${b.id}.${p.id}: step > 0`, p.step > 0);
        }
      }

      // Specific anchor — `stochCross` must be present with its 4 declared
      // params, since the legacy spec references it. If it drifts, the
      // legacy spec stops loading; we want to catch that here.
      const stoch = r.body.blocks.find(b => b.id === 'stochCross' && b.version === 1);
      assertTrue('stochCross v1 is registered', stoch != null);
      if (stoch) {
        assertEq('stochCross kind', stoch.kind, 'entry');
        assertEq('stochCross direction', stoch.direction, 'both');
        const paramIds = stoch.params.map(p => p.id).sort();
        assertEq('stochCross params',
          paramIds, ['longLevel', 'shortLevel', 'stochLen', 'stochSmth']);
        assertTrue('stochCross has a non-empty description',
          typeof stoch.description === 'string' && stoch.description.length > 0);
      }

      // Anchor: every shipping block has a description. New blocks are
      // welcome to omit it (the contract makes it optional), but if any
      // block regresses to null we want the gate to flag it.
      const undescribed = r.body.blocks
        .filter(b => typeof b.description !== 'string' || b.description.length === 0)
        .map(b => b.id);
      assertTrue('all registered blocks have a description',
        undescribed.length === 0,
        undescribed.length ? `missing: ${undescribed.join(', ')}` : '');

      // Anchor for an exit block with a slot.
      const hardStop = r.body.blocks.find(b => b.id === 'atrHardStop');
      assertTrue('atrHardStop is registered', hardStop != null);
      if (hardStop) {
        assertEq('atrHardStop kind', hardStop.kind, 'exit');
        assertEq('atrHardStop exitSlot', hardStop.exitSlot, 'hardStop');
      }

      // Anchor for a sizing block with declared requirements.
      const atrRisk = r.body.blocks.find(b => b.id === 'atrRisk');
      assertTrue('atrRisk is registered', atrRisk != null);
      if (atrRisk) {
        assertEq('atrRisk kind', atrRisk.kind, 'sizing');
        assertEq('atrRisk direction null', atrRisk.direction, null);
        assertEq('atrRisk exitSlot null', atrRisk.exitSlot, null);
        assertEq('atrRisk sizingRequirements', atrRisk.sizingRequirements, ['stopDistance']);
      }

      // Stable sort: (kind, id, version). Verify by checking kind ordering
      // — all regime come before entry, entry before filter, etc.
      const KIND_ORDER = { regime: 0, entry: 1, filter: 2, exit: 3, sizing: 4 };
      let lastKey = -1;
      for (const b of r.body.blocks) {
        const k = KIND_ORDER[b.kind];
        assertTrue(`sort: ${b.id} kind=${b.kind} non-regressing`, k >= lastKey);
        lastKey = k;
      }
    }

    // ── 2b. GET /api/defaults ──────────────────────────────────
    // Phase 4.4 surfaces DEFAULT_FITNESS + DEFAULT_WALK_FORWARD so the
    // UI "Reset to recommended" button is in lockstep with the runner.
    // Hardcoding the expected values here — if engine/spec.js drifts,
    // the UI will drift with it, and this test flags the drift.
    console.log('\n[2b] GET /api/defaults');
    {
      const r = await get(app.port, '/api/defaults');
      assertEq('status 200', r.status, 200);

      // Exact shape the UI reads.
      assertTrue('body has fitness',     r.body && typeof r.body.fitness === 'object');
      assertTrue('body has walkForward', r.body && typeof r.body.walkForward === 'object');

      const fit = r.body.fitness;
      assertTrue('fitness.weights has pf/dd/ret',
        fit?.weights
        && 'pf'  in fit.weights
        && 'dd'  in fit.weights
        && 'ret' in fit.weights);
      assertTrue('fitness.caps has pf/ret',
        fit?.caps && 'pf' in fit.caps && 'ret' in fit.caps);
      assertTrue('fitness.gates has minTradesPerWindow/worstRegimePfFloor/wfeMin',
        fit?.gates
        && 'minTradesPerWindow' in fit.gates
        && 'worstRegimePfFloor' in fit.gates
        && 'wfeMin'             in fit.gates);

      // Exact values: lockstep with DEFAULT_FITNESS in engine/spec.js.
      // If these change, they MUST change intentionally in both places.
      assertEq('weights.pf',  fit.weights.pf,  0.5);
      assertEq('weights.dd',  fit.weights.dd,  0.3);
      assertEq('weights.ret', fit.weights.ret, 0.2);
      assertEq('caps.pf',     fit.caps.pf,     4.0);
      assertEq('caps.ret',    fit.caps.ret,    2.0);
      assertEq('gates.minTradesPerWindow', fit.gates.minTradesPerWindow, 30);
      assertEq('gates.worstRegimePfFloor', fit.gates.worstRegimePfFloor, 1.0);
      assertEq('gates.wfeMin',             fit.gates.wfeMin,             0.5);

      // Weights sum to 1.0 — engine/spec.js raises a validator warning
      // otherwise. This is an invariant we want to enforce on the
      // shipped defaults so Reset-to-recommended never hands the user
      // a non-normalized starting point.
      const sum = fit.weights.pf + fit.weights.dd + fit.weights.ret;
      assertTrue('weights sum to ~1.0',
        Math.abs(sum - 1) <= 0.001, `sum=${sum}`);

      const wf = r.body.walkForward;
      assertEq('walkForward.nWindows', wf?.nWindows, 5);
      assertEq('walkForward.scheme',   wf?.scheme,   'anchored');

      // Immutability: hitting the endpoint twice must return identical
      // shapes — the handler deep-spreads so downstream mutation of the
      // first response can't poison the second.
      const r2 = await get(app.port, '/api/defaults');
      assertEq('second call returns same shape',
        JSON.stringify(r2.body), JSON.stringify(r.body));
    }

    // ── 3. POST /api/specs ─────────────────────────────────────
    // Covers Phase 4.3e: save-to-disk endpoint. Every test uses a unique
    // "test-only" filename under strategies/ and cleans up at the end so
    // we never leak fixtures into the shipped spec directory.
    //
    // Filename convention: `20991231-999-post-spec-test-<slug>.json`. The
    // leading 20991231 places these in the far future, so if cleanup ever
    // fails the orphans are easy to spot and rm manually.
    console.log('\n[3] POST /api/specs');
    const testNames = [];
    try {
      // 3a. Happy path — fresh name, returns 201, file is written.
      {
        const name = '20991231-999-post-spec-test-happy';
        testNames.push(name);
        const r = await post(app.port, '/api/specs', minimalValidSpec(name));
        assertEq('happy: status 201', r.status, 201);
        assertEq('happy: ok=true',     r.body?.ok, true);
        assertEq('happy: filename',    r.body?.filename, `${name}.json`);
        assertEq('happy: name',        r.body?.name, name);
        assertEq('happy: overwritten=false', r.body?.overwritten, false);

        const target = resolve(process.cwd(), 'strategies', `${name}.json`);
        let fileStat = null;
        try { fileStat = await stat(target); } catch { /* miss */ }
        assertTrue('happy: file exists on disk', fileStat != null);
        if (fileStat) {
          assertTrue('happy: file is non-empty', fileStat.size > 0);
          const text = await readFile(target, 'utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* bad */ }
          assertTrue('happy: file is valid JSON', parsed != null);
          if (parsed) {
            assertEq('happy: persisted name matches', parsed.name, name);
            assertTrue('happy: persisted has entries.blocks',
              Array.isArray(parsed.entries?.blocks));
            assertTrue('happy: hash field is NOT persisted',
              !('hash' in parsed), `found hash=${parsed.hash}`);
          }
        }
      }

      // 3b. Non-object body — 400.
      {
        const r = await post(app.port, '/api/specs', []);
        assertEq('non-object: status 400', r.status, 400);
        assertEq('non-object: ok=false',   r.body?.ok, false);
        assertTrue('non-object: error mentions JSON object',
          typeof r.body?.error === 'string' && /object/i.test(r.body.error));
      }

      // 3c. Invalid name — validateSpec rejects with 400.
      {
        const bad = minimalValidSpec('not a valid name!');
        const r = await post(app.port, '/api/specs', bad);
        assertEq('bad-name: status 400', r.status, 400);
        assertEq('bad-name: ok=false',   r.body?.ok, false);
        assertTrue('bad-name: error mentions name',
          typeof r.body?.error === 'string' && /name/i.test(r.body.error),
          `error=${r.body?.error}`);
      }

      // 3d. Out-of-range param — validateSpec rejects (min >= max).
      {
        const bad = minimalValidSpec('20991231-999-post-spec-test-badparam');
        // Flip stochLen so min > max — validateSpec must catch this.
        bad.entries.blocks[0].params.stochLen = { min: 40, max: 5, step: 1 };
        const r = await post(app.port, '/api/specs', bad);
        assertEq('bad-param: status 400', r.status, 400);
        assertEq('bad-param: ok=false',   r.body?.ok, false);
        assertTrue('bad-param: error surfaces the violation',
          typeof r.body?.error === 'string' && r.body.error.length > 0);

        // And no file should have been written.
        const target = resolve(process.cwd(), 'strategies',
          '20991231-999-post-spec-test-badparam.json');
        let leaked = false;
        try { await stat(target); leaked = true; } catch { /* good */ }
        assertTrue('bad-param: no file leaked to disk', !leaked);
      }

      // 3e. Duplicate filename without ?overwrite — 409.
      {
        const name = '20991231-999-post-spec-test-happy'; // already written in 3a
        const r = await post(app.port, '/api/specs', minimalValidSpec(name));
        assertEq('dup: status 409', r.status, 409);
        assertEq('dup: ok=false',   r.body?.ok, false);
        assertEq('dup: filename echoed', r.body?.filename, `${name}.json`);
        assertTrue('dup: error mentions overwrite',
          typeof r.body?.error === 'string' && /overwrite/i.test(r.body.error));
      }

      // 3f. Duplicate filename WITH ?overwrite=1 — 200, file replaced.
      {
        const name = '20991231-999-post-spec-test-happy'; // still from 3a
        const spec = minimalValidSpec(name);
        // Tweak description so we can tell the file actually got rewritten.
        spec.description = 'spec-api-check overwrite marker';
        const r = await post(app.port, '/api/specs?overwrite=1', spec);
        assertEq('overwrite: status 200', r.status, 200);
        assertEq('overwrite: ok=true',    r.body?.ok, true);
        assertEq('overwrite: overwritten=true', r.body?.overwritten, true);
        assertEq('overwrite: filename',   r.body?.filename, `${name}.json`);

        // Confirm the on-disk file picked up the new description.
        const target = resolve(process.cwd(), 'strategies', `${name}.json`);
        const text = await readFile(target, 'utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* bad */ }
        assertTrue('overwrite: file still parses', parsed != null);
        if (parsed) {
          assertEq('overwrite: description was replaced on disk',
            parsed.description, 'spec-api-check overwrite marker');
        }
      }

      // 3g. No .tmp files should be left behind in strategies/ after the run.
      {
        const dir = resolve(process.cwd(), 'strategies');
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(dir);
        const tmpLeaks = entries.filter(f => f.endsWith('.tmp'));
        assertTrue('no .tmp files left in strategies/',
          tmpLeaks.length === 0,
          tmpLeaks.length ? `found: ${tmpLeaks.join(', ')}` : '');
      }
    } finally {
      // Cleanup — unlink every test file we created. Swallow ENOENT so
      // a half-failed run doesn't crash cleanup.
      for (const name of testNames) {
        const target = resolve(process.cwd(), 'strategies', `${name}.json`);
        try { await unlink(target); } catch (err) {
          if (err.code !== 'ENOENT') {
            console.log(`  (cleanup) failed to unlink ${target}: ${err.message}`);
          }
        }
      }
    }
  } finally {
    await app.close();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.error('FAILED');
    process.exit(1);
  }
  console.log('OK');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
