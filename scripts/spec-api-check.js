/**
 * spec-api-check — smoke test for Phase 4.3a read-only endpoints.
 *
 *   GET /api/specs   — enumerates strategies/*.json
 *   GET /api/blocks  — enumerates the in-memory block registry
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
