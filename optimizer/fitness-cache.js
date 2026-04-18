/**
 * Fitness cache — persistent, per-(spec,dataset) cache of gene → fitness
 * results across optimizer runs.
 *
 * The in-memory `fitnessCache: Map<geneKey, ...>` lives inside each island
 * worker. That cache is lost when the worker terminates. This module adds
 * a *durable* layer: we load it before a run starts (so a re-run of the
 * same spec on the same data starts warm) and we save the merged cache
 * back when the run completes (so the next run gets the benefit).
 *
 * ─── Schema (nested variants) ──────────────────────────────
 *
 *   entries[geneKey] = {
 *     variants: {
 *       [variantId]: { fitness, metrics }
 *     }
 *   }
 *
 *   The nested-by-variant shape supports Phase 6.2 (Noise-Test During
 *   Optimization): each gene is evaluated on K noise-perturbed candle
 *   variants and the median fitness is used for GA selection. Each
 *   variant's result is cached under its own variantId so partial
 *   progress (some variants evaluated, some not) isn't lost on restart.
 *
 *   For non-NTO runs (the default today), everything lives under
 *   `variants.base` and the schema is behaviorally identical to the
 *   earlier flat-by-gene shape.
 *
 *   The runner-worker wire protocol stays FLAT: workers don't know
 *   about variants yet. The runner flattens nested entries → base-only
 *   on preload, and wraps flat deltas → nested on save. Phase 6.2 will
 *   teach the worker side to emit per-variant deltas when NTO is on.
 *
 * ─── File identity ─────────────────────────────────────────
 *
 *   One file per (spec.hash, datasetId) tuple. The on-disk filename is
 *   `<specHash>__<datasetId>.json`. A different spec or a different
 *   dataset gets a different file — no cross-contamination.
 *
 *   `datasetId = sha256(symbol + ':' + tfMin + ':' + startDate + ':' + endDate
 *                       + ':' + bars + ':' + lastTs)`
 *
 *   The trailing `bars` + `lastTs` catches the case where the candle DB
 *   has been updated since the last run — same symbol/timeframe/window,
 *   but more data → different `bars` → different id → cache invalidated.
 *
 * ─── Top-N cap ─────────────────────────────────────────────
 *
 *   A real GA produces hundreds of thousands of evaluations. Persisting
 *   them all would balloon disk and serialization cost. We cap at
 *   `MAX_ENTRIES` (50K) unique genes and keep the highest-fitness ones.
 *   The cap treats a gene as a unit — all its variants ride together.
 *   Ranking uses the gene's BASE variant fitness (if present); NTO-only
 *   genes without a base variant are dropped first.
 *
 * ─── Storage ───────────────────────────────────────────────
 *
 *   Plain JSON in `<cacheDir>/<specHash>__<datasetId>.json`. Simple,
 *   diff-able, no driver. We write atomically (write to `.tmp` then
 *   rename) so a crashed run can't leave a half-written file.
 *   `cacheDir` defaults to `<repo>/data/fitness-cache/` and can be
 *   overridden with `OPTIMIZER_FITNESS_CACHE_DIR`.
 *
 * ─── Backwards compatibility ───────────────────────────────
 *
 *   Pre-Phase-6.0.2 cache files stored entries in a flat shape:
 *     entries[geneKey] = { fitness, metrics }
 *   `loadCache` detects flat entries and migrates them to
 *     entries[geneKey] = { variants: { base: { fitness, metrics } } }
 *   before returning. No user action required.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Cap on cached entries per (spec, dataset). Keeps disk + load time bounded. */
export const MAX_ENTRIES = 50_000;

/** Default variantId for non-NTO runs. Kept as a named constant so callers
 *  don't sprinkle the literal "base" everywhere. */
export const BASE_VARIANT = 'base';

/**
 * Compute a deterministic dataset identifier.
 */
export function computeDatasetId({ symbol, timeframe, startDate, endDate, bars, lastTs }) {
  const parts = [
    symbol,
    String(timeframe),
    String(startDate),
    String(endDate ?? 'live'),
    String(bars),
    String(lastTs),
  ].join(':');
  return createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

/**
 * Resolve the on-disk path for a (specHash, datasetId) cache file.
 */
export function cacheFilePath(specHash, datasetId, cacheDir) {
  const dir = cacheDir
    ?? process.env.OPTIMIZER_FITNESS_CACHE_DIR
    ?? resolve(REPO_ROOT, 'data', 'fitness-cache');
  return resolve(dir, `${specHash}__${datasetId}.json`);
}

/**
 * Load a cache file. Returns an object
 *   `{ entries, savedAt, count, path }`
 * where `entries` is the nested-by-variant shape. Missing file → empty
 * object. Malformed / corrupt file → warning + treated as empty (a
 * crashed run shouldn't brick the next one).
 */
export async function loadCache({ specHash, datasetId, cacheDir = null }) {
  const path = cacheFilePath(specHash, datasetId, cacheDir);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      console.warn(`[fitness-cache] malformed file at ${path}, treating as empty`);
      return { entries: {}, count: 0 };
    }
    const entries = migrateFlatToNested(parsed.entries);
    return {
      entries,
      savedAt: parsed.savedAt,
      count:   Object.keys(entries).length,
      path,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: {}, count: 0, path };
    console.warn(`[fitness-cache] read failed (${err.code || err.message}), treating as empty`);
    return { entries: {}, count: 0, path };
  }
}

/**
 * Save a cache file atomically. `entries` must be in the nested-variant
 * shape (migrate flat→nested first if you're coming from an old
 * snapshot — `mergeCaches` handles this for you).
 */
export async function saveCache({
  specHash, datasetId, entries, cacheDir = null, maxEntries = MAX_ENTRIES,
}) {
  const path = cacheFilePath(specHash, datasetId, cacheDir);
  // Accept flat or nested input — normalize before cap/filter so both
  // old callers (passing `{geneKey: {fitness, metrics}}`) and new ones
  // work without special-casing at the call site.
  const normalized = migrateFlatToNested(entries);
  const filtered = filterAndCap(normalized, maxEntries);
  const dropped  = Object.keys(normalized).length - Object.keys(filtered).length;

  const payload = {
    specHash,
    datasetId,
    savedAt: Date.now(),
    count: Object.keys(filtered).length,
    entries: filtered,
  };

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  await rename(tmp, path);
  return { path, count: payload.count, dropped };
}

/**
 * Merge multiple per-worker cache snapshots into one. Each snapshot may
 * be in flat OR nested shape — merging normalizes to nested. Variant
 * collisions use last-writer-wins (fine: identical (gene, variant,
 * spec, dataset) tuples produce identical fitness up to fp determinism).
 */
export function mergeCaches(snapshots) {
  const out = {};
  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object') continue;
    const normalized = migrateFlatToNested(snap);
    for (const [geneKey, gv] of Object.entries(normalized)) {
      if (!out[geneKey]) out[geneKey] = { variants: {} };
      for (const [variantId, payload] of Object.entries(gv.variants ?? {})) {
        out[geneKey].variants[variantId] = payload;
      }
    }
  }
  return out;
}

// ─── Variant-level helpers ─────────────────────────────────

/**
 * Read one variant's cached result. Returns `{fitness, metrics}` or
 * `undefined` when the variant hasn't been cached.
 */
export function getVariant(entries, geneKey, variantId = BASE_VARIANT) {
  return entries?.[geneKey]?.variants?.[variantId];
}

/**
 * Write one variant's result. Mutates `entries`. Creates the gene entry
 * if needed.
 */
export function setVariant(entries, geneKey, variantId, payload) {
  if (!entries[geneKey]) entries[geneKey] = { variants: {} };
  if (!entries[geneKey].variants) entries[geneKey].variants = {};
  entries[geneKey].variants[variantId] = payload;
}

/**
 * Check whether every expected variant for a gene is present.
 */
export function hasAllVariants(entries, geneKey, expectedVariantIds) {
  const v = entries?.[geneKey]?.variants;
  if (!v) return false;
  for (const id of expectedVariantIds) {
    if (!v[id]) return false;
  }
  return true;
}

/**
 * Return a composite result aggregated across all expected variants, or
 * `null` if any expected variant is missing. Default aggregator is
 * median-over-fitness. `aggregate` takes the array of `{fitness, metrics}`
 * variant results (in `expectedVariantIds` order) and returns a single
 * `{fitness, metrics}` record.
 */
export function getComposite(entries, geneKey, expectedVariantIds, aggregate = medianAggregate) {
  if (!hasAllVariants(entries, geneKey, expectedVariantIds)) return null;
  const variants = entries[geneKey].variants;
  const ordered = expectedVariantIds.map(id => variants[id]);
  return aggregate(ordered);
}

/**
 * Default aggregator for NTO: median of per-variant fitness. The metrics
 * object returned is the one whose fitness is the median (ties resolve
 * to the lower-indexed variant, i.e. the real/base bundle when it's the
 * median). This keeps downstream metrics readers (fitness-breakdown UI,
 * trade-list visualizers) looking at a CONCRETE backtest run rather than
 * a synthetic averaged metrics blob that doesn't correspond to any real
 * evaluation.
 */
export function medianAggregate(variantResults) {
  if (!variantResults?.length) return { fitness: 0, metrics: {} };
  const indexed = variantResults.map((r, i) => ({ idx: i, fitness: r.fitness }));
  indexed.sort((a, b) => a.fitness - b.fitness);
  const mid = Math.floor((indexed.length - 1) / 2); // lower median on ties
  const medianIdx = indexed[mid].idx;
  return {
    fitness: variantResults[medianIdx].fitness,
    metrics: variantResults[medianIdx].metrics,
  };
}

// ─── Flat ⇄ nested translation (runner-worker boundary) ───

/**
 * Flatten nested entries to the legacy base-only shape — one flat
 * `{fitness, metrics}` per gene, using the `base` variant. Genes
 * without a base variant are omitted (the worker has no way to use
 * variant-only entries today).
 *
 * Use: runner ships `flattenToBase(nested)` as `fitnessCachePreload`
 * to each worker.
 */
export function flattenToBase(nestedEntries) {
  const out = {};
  for (const [geneKey, gv] of Object.entries(nestedEntries ?? {})) {
    const base = gv?.variants?.[BASE_VARIANT];
    if (base) out[geneKey] = base;
  }
  return out;
}

/**
 * Wrap a flat `{geneKey: {fitness, metrics}}` delta (what workers emit
 * today) into the nested-by-variant shape under variantId=base.
 *
 * Use: runner receives `wrapFlat(cache_delta)` from a worker and merges
 * it into the nested master cache.
 */
export function wrapFlat(flatEntries) {
  const out = {};
  for (const [geneKey, payload] of Object.entries(flatEntries ?? {})) {
    out[geneKey] = { variants: { [BASE_VARIANT]: payload } };
  }
  return out;
}

// ─── Internals ─────────────────────────────────────────────

/**
 * Detect legacy flat entries and rewrite them in-place into the nested
 * shape. A "flat" entry has a numeric `fitness` at the gene level (no
 * `variants` child). Leaves already-nested entries untouched. Returns a
 * NEW object — the caller's input is never mutated.
 *
 * This runs both on load (to migrate old on-disk files) and on merge
 * (to normalize worker deltas that are still flat in the current wire
 * protocol).
 */
function migrateFlatToNested(entries) {
  const out = {};
  for (const [geneKey, v] of Object.entries(entries)) {
    if (!v || typeof v !== 'object') continue;
    if (v.variants && typeof v.variants === 'object') {
      // Already nested — copy through.
      out[geneKey] = v;
    } else if (typeof v.fitness === 'number') {
      // Legacy flat — promote to nested under BASE_VARIANT.
      out[geneKey] = { variants: { [BASE_VARIANT]: { fitness: v.fitness, metrics: v.metrics } } };
    }
    // Entries that are neither nested nor flat are silently skipped —
    // a corrupt on-disk file shouldn't crash the loader.
  }
  return out;
}

/**
 * Drop invalid entries, then keep only the top-N genes by their base
 * variant's fitness.
 *
 * Entries we discard:
 *   - no variants at all
 *   - base variant's fitness ≤ 0 (eliminated / soft-penalty band)
 *   - base variant's fitness non-finite
 *
 * Genes with variants but no `base` variant are currently dropped too.
 * When NTO lands (§6.2), we'll revisit so NTO-only entries are retained
 * and ranked by their composite median fitness.
 */
function filterAndCap(entries, maxEntries) {
  const arr = [];
  for (const [k, v] of Object.entries(entries)) {
    const base = v?.variants?.[BASE_VARIANT];
    if (!base) continue;
    const f = base.fitness;
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) continue;
    arr.push([k, v, f]);
  }
  arr.sort((a, b) => b[2] - a[2]);
  const capped = arr.slice(0, maxEntries);
  const out = {};
  for (const [k, v] of capped) out[k] = v;
  return out;
}
