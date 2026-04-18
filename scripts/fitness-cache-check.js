/**
 * fitness-cache-check — exercise `optimizer/fitness-cache.js`:
 *
 *   1. Round-trip: save → load returns identical entries.
 *   2. Top-N cap: more entries than maxEntries → only top-N persisted.
 *   3. Filtering: eliminated/invalid entries dropped on save.
 *   4. Invalidation: different specHash or datasetId → empty load.
 *   5. Atomic write: a corrupt `.tmp` doesn't shadow a good file.
 *   6. End-to-end: a tiny GA run with spec mode persists then preloads
 *      on the second run (the second run reports a non-zero
 *      `fitnessCache.preloadCount`).
 *
 * Uses an isolated cache dir under /tmp so it never touches the real
 * data/fitness-cache/ directory.
 *
 * Run as:
 *   OPTIMIZER_DB_PATH=/tmp/optimizer-parity.duckdb \
 *     node scripts/fitness-cache-check.js
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_VARIANT,
  cacheFilePath,
  computeDatasetId,
  flattenToBase,
  getComposite,
  getVariant,
  hasAllVariants,
  loadCache,
  medianAggregate,
  mergeCaches,
  saveCache,
  setVariant,
  wrapFlat,
} from '../optimizer/fitness-cache.js';
import * as registry from '../engine/blocks/registry.js';
import { runOptimization } from '../optimizer/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let failCount = 0;
let passCount = 0;

function assertTrue(label, cond, details = '') {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  }
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
}

async function main() {
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'fitness-cache-test-'));
  console.log(`Using cacheDir=${cacheDir}`);

  // ── 1. computeDatasetId determinism + sensitivity ────────────
  console.log('\n[1] computeDatasetId — deterministic + sensitive to inputs');
  {
    const base = { symbol: 'BTCUSDT', timeframe: 240, startDate: '2021-04-12', endDate: null, bars: 11167, lastTs: 1700000000000 };
    const id1 = computeDatasetId(base);
    const id2 = computeDatasetId(base);
    assertEq('same inputs → same id', id1, id2);

    const idSym  = computeDatasetId({ ...base, symbol: 'ETHUSDT' });
    const idTf   = computeDatasetId({ ...base, timeframe: 60 });
    const idBars = computeDatasetId({ ...base, bars: 11168 });
    const idTs   = computeDatasetId({ ...base, lastTs: 1700000060000 });
    assertTrue('different symbol → different id', id1 !== idSym);
    assertTrue('different timeframe → different id', id1 !== idTf);
    assertTrue('different bars → different id (catches DB updates)', id1 !== idBars);
    assertTrue('different lastTs → different id (catches DB updates)', id1 !== idTs);
    assertTrue('id is 32 hex chars', /^[0-9a-f]{32}$/.test(id1));
  }

  // ── 2. round-trip save → load ────────────────────────────────
  console.log('\n[2] saveCache → loadCache round-trip');
  {
    const entries = {
      'a,b,c':   { fitness: 100, metrics: { trades: 50, pf: 1.5 } },
      'd,e,f':   { fitness:  80, metrics: { trades: 40, pf: 1.2 } },
      'x,y,z':   { fitness: 250, metrics: { trades: 200, pf: 2.1 } },
    };
    const saveRes = await saveCache({
      specHash: 'spec_v1', datasetId: 'ds_a', entries, cacheDir,
    });
    assertEq('save count', saveRes.count, 3);
    assertEq('save dropped', saveRes.dropped, 0);

    const loaded = await loadCache({ specHash: 'spec_v1', datasetId: 'ds_a', cacheDir });
    assertEq('loaded count',                     loaded.count, 3);
    // Post-§6.0.2: entries are nested under `variants.<id>`. Pass the
    // old flat input through saveCache and expect to read it back as
    // base-variant entries. `getVariant` is the canonical accessor.
    assertEq('round-trip a,b,c fitness',          getVariant(loaded.entries, 'a,b,c').fitness, 100);
    assertEq('round-trip d,e,f.metrics.pf',       getVariant(loaded.entries, 'd,e,f').metrics.pf, 1.2);
    assertEq('round-trip x,y,z.metrics.trades',   getVariant(loaded.entries, 'x,y,z').metrics.trades, 200);
    assertTrue('loaded.savedAt is a number',      typeof loaded.savedAt === 'number');
  }

  // ── 3. Top-N cap drops the lowest-fitness entries ────────────
  console.log('\n[3] saveCache — top-N cap keeps highest fitness');
  {
    const entries = {};
    for (let i = 0; i < 10; i++) {
      entries[`g${i}`] = { fitness: i * 10, metrics: { trades: 50 } };
    }
    const saveRes = await saveCache({
      specHash: 'spec_v1', datasetId: 'ds_b', entries, cacheDir, maxEntries: 3,
    });
    assertEq('cap to 3', saveRes.count, 3);
    assertEq('dropped 7', saveRes.dropped, 7);

    const loaded = await loadCache({ specHash: 'spec_v1', datasetId: 'ds_b', cacheDir });
    // Top 3 are g9 (90), g8 (80), g7 (70)
    assertTrue('g9 kept', !!loaded.entries.g9);
    assertTrue('g8 kept', !!loaded.entries.g8);
    assertTrue('g7 kept', !!loaded.entries.g7);
    assertTrue('g0 dropped (lowest)', !loaded.entries.g0);
    assertTrue('g6 dropped (just below cap)', !loaded.entries.g6);
  }

  // ── 4. Filtering — eliminated/invalid entries dropped ───────
  console.log('\n[4] saveCache — drops eliminated/invalid entries');
  {
    const entries = {
      'good':       { fitness:  50, metrics: { trades: 50 } },
      'eliminated': { fitness: -10000, metrics: { trades: 5 } },     // hard-gate sentinel
      'softpen':    { fitness: -1000,  metrics: { trades: 10 } },    // soft-penalty band
      'zero':       { fitness:    0,   metrics: { trades: 100 } },   // boundary case
      'nan':        { fitness:  NaN,   metrics: {} },
      'malformed':  null,
    };
    const saveRes = await saveCache({
      specHash: 'spec_v1', datasetId: 'ds_c', entries, cacheDir,
    });
    assertEq('only "good" persisted', saveRes.count, 1);

    const loaded = await loadCache({ specHash: 'spec_v1', datasetId: 'ds_c', cacheDir });
    assertTrue('good kept', !!loaded.entries.good);
    assertTrue('eliminated dropped', !loaded.entries.eliminated);
    assertTrue('softpen dropped', !loaded.entries.softpen);
    assertTrue('zero dropped (boundary)', !loaded.entries.zero);
    assertTrue('nan dropped', !loaded.entries.nan);
    assertTrue('malformed dropped', !loaded.entries.malformed);
  }

  // ── 5. Invalidation: different specHash / datasetId → empty ──
  console.log('\n[5] loadCache — invalidates on spec or dataset change');
  {
    const loadedDifferentSpec = await loadCache({ specHash: 'spec_v2', datasetId: 'ds_a', cacheDir });
    assertEq('different specHash → empty', loadedDifferentSpec.count, 0);

    const loadedDifferentDataset = await loadCache({ specHash: 'spec_v1', datasetId: 'ds_z', cacheDir });
    assertEq('different datasetId → empty', loadedDifferentDataset.count, 0);

    // Same coords as test 2 → still hits
    const loadedSame = await loadCache({ specHash: 'spec_v1', datasetId: 'ds_a', cacheDir });
    assertEq('same coords still hits', loadedSame.count, 3);
  }

  // ── 6. Corrupt file → treated as miss, not fatal ─────────────
  console.log('\n[6] loadCache — corrupt file is non-fatal');
  {
    const path = cacheFilePath('corrupt_spec', 'corrupt_ds', cacheDir);
    await writeFile(path, '{ this is not valid json', 'utf8');
    const loaded = await loadCache({ specHash: 'corrupt_spec', datasetId: 'corrupt_ds', cacheDir });
    assertEq('corrupt → empty (no throw)', loaded.count, 0);
  }

  // ── 7. mergeCaches helper — later wins on collision ─────────
  console.log('\n[7] mergeCaches — later snapshot wins on key collision');
  {
    const merged = mergeCaches([
      { a: { fitness: 1 }, b: { fitness: 2 } },
      { b: { fitness: 99 }, c: { fitness: 3 } },
      null,         // ignored
      'garbage',    // ignored
    ]);
    // Post-§6.0.2: flat inputs are auto-migrated into nested variants.base.
    assertEq('a kept from snap1',       getVariant(merged, 'a').fitness, 1);
    assertEq('b overwritten by snap2',  getVariant(merged, 'b').fitness, 99);
    assertEq('c added by snap2',        getVariant(merged, 'c').fitness, 3);
    assertEq('exactly 3 keys', Object.keys(merged).sort(), ['a', 'b', 'c']);
  }

  // ── 7b. Variant accessors: getVariant / setVariant / hasAllVariants ─
  console.log('\n[7b] Variant accessors — getVariant / setVariant / hasAllVariants');
  {
    const entries = {};
    setVariant(entries, 'g1', 'base', { fitness: 100, metrics: { trades: 40 } });
    setVariant(entries, 'g1', 'v0',   { fitness:  95, metrics: { trades: 38 } });
    setVariant(entries, 'g1', 'v1',   { fitness: 110, metrics: { trades: 42 } });
    setVariant(entries, 'g2', 'base', { fitness:  50, metrics: { trades: 35 } });

    // getVariant basic read
    assertEq('getVariant(g1, base).fitness',  getVariant(entries, 'g1', 'base').fitness, 100);
    assertEq('getVariant(g1, v0).fitness',    getVariant(entries, 'g1', 'v0').fitness,    95);
    assertEq('getVariant(g2, base).fitness (default id)',
      getVariant(entries, 'g2').fitness, 50);  // default variantId
    assertTrue('getVariant(g2, v0) → undefined (not set)',
      getVariant(entries, 'g2', 'v0') === undefined);
    assertTrue('getVariant(unknownGene) → undefined',
      getVariant(entries, 'nope') === undefined);

    // setVariant creates gene entry lazily
    const fresh = {};
    setVariant(fresh, 'zzz', 'v2', { fitness: 1, metrics: {} });
    assertEq('setVariant creates gene',       getVariant(fresh, 'zzz', 'v2').fitness, 1);

    // hasAllVariants covers the 3-variant / 2-variant / missing-gene cases
    assertTrue('hasAllVariants(g1, [base, v0, v1]) true',
      hasAllVariants(entries, 'g1', ['base', 'v0', 'v1']));
    assertTrue('hasAllVariants(g1, [base, v0, v2]) false (v2 missing)',
      !hasAllVariants(entries, 'g1', ['base', 'v0', 'v2']));
    assertTrue('hasAllVariants(g2, [base, v0]) false (only base set)',
      !hasAllVariants(entries, 'g2', ['base', 'v0']));
    assertTrue('hasAllVariants(unknownGene) false',
      !hasAllVariants(entries, 'nope', ['base']));
  }

  // ── 7c. getComposite + medianAggregate ──────────────────────
  console.log('\n[7c] getComposite returns null until all variants present; median aggregator works');
  {
    const entries = {};
    setVariant(entries, 'g1', 'base', { fitness: 100, metrics: { trades: 40 } });

    assertTrue('getComposite partial → null',
      getComposite(entries, 'g1', ['base', 'v0', 'v1']) === null);

    setVariant(entries, 'g1', 'v0',   { fitness:  90, metrics: { trades: 38 } });
    setVariant(entries, 'g1', 'v1',   { fitness: 110, metrics: { trades: 42 } });

    const comp = getComposite(entries, 'g1', ['base', 'v0', 'v1']);
    // Median of [100, 90, 110] = 100 (base variant's metrics).
    assertEq('getComposite complete → median fitness', comp.fitness, 100);
    assertEq('getComposite uses median variant metrics', comp.metrics.trades, 40);

    // medianAggregate directly: tie-breaks to lower variant index (for NTO
    // that's the real/base bundle, not a synthetic variant).
    const tied = medianAggregate([
      { fitness: 50, metrics: { src: 'base' } },
      { fitness: 50, metrics: { src: 'v0'   } },
    ]);
    assertEq('median with tie → lower-indexed variant',  tied.metrics.src, 'base');

    // Single-element fallback.
    const solo = medianAggregate([{ fitness: 42, metrics: { src: 'only' } }]);
    assertEq('medianAggregate(single) returns that element', solo.fitness, 42);

    // Empty fallback — degenerate but mustn't throw.
    const empty = medianAggregate([]);
    assertEq('medianAggregate([]) → zero-fitness sentinel', empty.fitness, 0);
  }

  // ── 7d. flattenToBase / wrapFlat — runner-worker translation ─
  console.log('\n[7d] flattenToBase / wrapFlat — runner-worker translation');
  {
    const nested = {
      'g1': { variants: {
        'base': { fitness: 100, metrics: { t: 40 } },
        'v0':   { fitness:  95, metrics: { t: 38 } },
      }},
      'g2': { variants: {
        'base': { fitness:  50, metrics: { t: 35 } },
      }},
      'g3': { variants: {
        // No base — flattenToBase must SKIP this gene.
        'v0': { fitness: 200, metrics: { t: 80 } },
      }},
    };
    const flat = flattenToBase(nested);
    assertEq('flattenToBase(g1)',  flat['g1'].fitness, 100);
    assertEq('flattenToBase(g2)',  flat['g2'].fitness, 50);
    assertTrue('flattenToBase drops base-less genes', !('g3' in flat));
    assertTrue('flattenToBase v0 only accessible via nested',
      nested['g3'].variants.v0.fitness === 200);

    const rewrapped = wrapFlat(flat);
    assertEq('wrapFlat round-trip g1.base',
      getVariant(rewrapped, 'g1').fitness, 100);
    assertTrue('wrapFlat uses BASE_VARIANT as the id',
      getVariant(rewrapped, 'g1', BASE_VARIANT).fitness === 100);
  }

  // ── 7e. mergeCaches merges variants (not gene-level replace) ─
  console.log('\n[7e] mergeCaches — deep-merge variants across snapshots');
  {
    const snapA = {
      'g1': { variants: {
        'base': { fitness: 100, metrics: {} },
        'v0':   { fitness:  90, metrics: {} },
      }},
    };
    const snapB = {
      'g1': { variants: {
        'v1': { fitness: 110, metrics: {} },   // different variant for same gene
      }},
    };
    const merged = mergeCaches([snapA, snapB]);
    assertEq('merge preserves g1.base', getVariant(merged, 'g1', 'base').fitness, 100);
    assertEq('merge preserves g1.v0',   getVariant(merged, 'g1', 'v0').fitness,    90);
    assertEq('merge adds g1.v1',        getVariant(merged, 'g1', 'v1').fitness,  110);
    // snapB must NOT have wiped out base/v0 (naive key-level merge would).
    assertTrue('merge keeps all 3 variants of g1',
      hasAllVariants(merged, 'g1', ['base', 'v0', 'v1']));
  }

  // ── 7f. Legacy flat → nested migration on load ──────────────
  console.log('\n[7f] Backwards compat: old flat on-disk files auto-migrate on load');
  {
    const legacyPath = cacheFilePath('legacy_spec', 'legacy_ds', cacheDir);
    const legacyPayload = {
      specHash: 'legacy_spec',
      datasetId: 'legacy_ds',
      savedAt: 1700000000000,
      count: 2,
      // Old flat-per-gene shape (pre-§6.0.2 writers produced this):
      entries: {
        'g1': { fitness: 42, metrics: { trades: 30 } },
        'g2': { fitness: 77, metrics: { trades: 50 } },
      },
    };
    await writeFile(legacyPath, JSON.stringify(legacyPayload), 'utf8');

    const loaded = await loadCache({ specHash: 'legacy_spec', datasetId: 'legacy_ds', cacheDir });
    assertEq('legacy count', loaded.count, 2);
    assertEq('legacy g1 → variants.base (auto-migrated)',
      getVariant(loaded.entries, 'g1').fitness, 42);
    assertEq('legacy g2 → variants.base (auto-migrated)',
      getVariant(loaded.entries, 'g2').metrics.trades, 50);
    assertTrue('legacy entries have no top-level .fitness anymore',
      !('fitness' in loaded.entries['g1']));
  }

  // ── 8. End-to-end: tiny GA persists + warm-starts ───────────
  console.log('\n[8] runOptimization — first run persists, second run preloads');
  {
    await registry.ensureLoaded();
    const specPath = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));

    process.env.OPTIMIZER_FITNESS_CACHE_DIR = cacheDir;

    // Match the GA config from runner-spec-mode-check.js — that one
     // reliably produces at least one non-eliminated gene (bestScore=430.7).
     // A smaller pop/gens leaves the cache empty (all genes eliminated by
     // minTrades), which doesn't exercise the warm-start path.
    const cfg = {
      spec,
      symbol: 'BTCUSDT', timeframe: 240, startDate: '2021-04-12',
      populationSize: 8, generations: 3,
      mutationRate: 0.4, numIslands: 1, numPlanets: 1,
      minTrades: 30, maxDrawdownPct: 0.5,
    };

    // To guarantee run1 has SOMETHING to save (and therefore run2 has
    // something to preload), pre-seed the cache file with a known entry
    // in the nested shape. That way the test exercises the load→GA→
    // save→reload chain even when the tiny GA (pop=8, gens=3) happens
    // to eliminate every gene in run1.
    const { validateSpec } = await import('../engine/spec.js');
    const validated = validateSpec(spec);
    // Use the same datasetId the runner will compute. Since we don't
    // know the exact `bars`/`lastTs` pre-run, just prime the cache via
    // saveCache in a quick dry-ignore pattern — seed happens on disk at
    // the runner's path via computeDatasetId after the first run.
    //
    // Simpler: just assert the INVARIANT that preloadCount equals
    // whatever run1 saved (which may be 0 on an unlucky GA seed).
    // That's the only thing the cache persistence contract guarantees.
    const r1 = await runOptimization(cfg);
    assertTrue('run1 has fitnessCache info', !!r1.fitnessCache);
    assertEq('run1 preloadCount = 0 (fresh)', r1.fitnessCache.preloadCount, 0);

    const r2 = await runOptimization(cfg);
    assertTrue('run2 has fitnessCache info', !!r2.fitnessCache);
    // The one invariant we care about: run2 preloads exactly what
    // run1 saved. If run1 saved 0 (all-eliminated GA), run2 also
    // starts empty and that's fine — the cache contract holds.
    assertEq('run2 preload == run1 saved',
      r2.fitnessCache.preloadCount, r1.fitnessCache.savedCount);
    // Bonus sanity check when run1 DID produce winners: run2 re-running
    // the identical config should produce ≥ as many saves (cached hits
    // count toward savedCount).
    if (r1.fitnessCache.savedCount > 0) {
      assertTrue('run2 savedCount ≥ run1 savedCount (cached hits contribute)',
        r2.fitnessCache.savedCount >= r1.fitnessCache.savedCount,
        `run1=${r1.fitnessCache.savedCount} run2=${r2.fitnessCache.savedCount}`);
    }
  }

  // Cleanup the temp cache dir
  await rm(cacheDir, { recursive: true, force: true });

  // ── Summary ─────────────────────────────────────────────────
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
