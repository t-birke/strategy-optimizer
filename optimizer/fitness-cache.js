/**
 * Fitness cache — persistent, per-(spec,dataset) cache of gene → fitness
 * results across optimizer runs.
 *
 * The in-memory `fitnessCache: Map<geneKey, { fitness, metrics }>` already
 * lives inside each island worker. That cache is lost when the worker
 * terminates. This module adds a *durable* layer: we load it before a run
 * starts (so a re-run of the same spec on the same data starts warm) and
 * we save the merged cache back when the run completes (so the next run
 * gets the benefit).
 *
 * ─── Cache key ─────────────────────────────────────────────
 *
 *   `spec.hash + ':' + datasetId + ':' + geneKey(gene)`
 *
 *   The `geneKey(gene)` part is what the workers already use as their
 *   in-memory key. We only PREPEND the salt for cross-run namespacing —
 *   the on-disk file is named after the (spec, dataset) tuple, so we
 *   only need `geneKey` as the within-file key. A different spec or a
 *   different dataset gets a different file, full stop.
 *
 * ─── Dataset identity ──────────────────────────────────────
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
 *   them all would balloon disk and serialization cost. We cap the
 *   on-disk file at `MAX_ENTRIES` and keep the highest-fitness ones —
 *   the GA tends to *revisit* high-fitness regions across runs (selection
 *   pressure pulls there), so caching the long tail of mediocre genes
 *   buys little. Eliminated genes (fitness < 0) are dropped entirely.
 *
 * ─── Storage ───────────────────────────────────────────────
 *
 *   Plain JSON in `<cacheDir>/<specHash>__<datasetId>.json`. Simple,
 *   diff-able, no driver. We write atomically (write to `.tmp` then
 *   rename) so a crashed run can't leave a half-written file.
 *   `cacheDir` defaults to `<repo>/data/fitness-cache/` and can be
 *   overridden with `OPTIMIZER_FITNESS_CACHE_DIR`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** Cap on cached entries per (spec, dataset). Keeps disk + load time bounded. */
export const MAX_ENTRIES = 50_000;

/**
 * Compute a deterministic dataset identifier. The `bars` + `lastTs`
 * fields catch the case where candles have been added since the last
 * run, invalidating cached fitness values.
 *
 * @param {Object} parts
 * @param {string} parts.symbol
 * @param {number} parts.timeframe          minutes
 * @param {string} parts.startDate          ISO date or 'YYYY-MM-DD'
 * @param {string|null} [parts.endDate]
 * @param {number} parts.bars               actual loaded bar count
 * @param {number|bigint} parts.lastTs      ts of last loaded bar (ms)
 * @returns {string} 32-char hex digest
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
 * Override the parent directory with `OPTIMIZER_FITNESS_CACHE_DIR`.
 */
export function cacheFilePath(specHash, datasetId, cacheDir) {
  const dir = cacheDir
    ?? process.env.OPTIMIZER_FITNESS_CACHE_DIR
    ?? resolve(REPO_ROOT, 'data', 'fitness-cache');
  return resolve(dir, `${specHash}__${datasetId}.json`);
}

/**
 * Load a cache file. Returns an object `{ entries: { [geneKey]: { fitness,
 * metrics } }, savedAt, count }` — or `{ entries: {}, count: 0 }` if no
 * file exists yet. A corrupt file is treated as a miss with a warning,
 * not a fatal error: a crashed run shouldn't break the next one.
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
    const entries = parsed.entries;
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
 * Save a cache file atomically (write to `.tmp`, then rename). Applies
 * the top-N cap and drops eliminated/invalid entries before persisting.
 *
 * @param {Object} opts
 * @param {string} opts.specHash
 * @param {string} opts.datasetId
 * @param {Object<string, {fitness:number, metrics:Object}>} opts.entries
 *        merged entries from all workers, keyed by geneKey.
 * @param {string} [opts.cacheDir]
 * @param {number} [opts.maxEntries]   override MAX_ENTRIES (tests use this)
 * @returns {Promise<{path:string, count:number, dropped:number}>}
 */
export async function saveCache({
  specHash, datasetId, entries, cacheDir = null, maxEntries = MAX_ENTRIES,
}) {
  const path = cacheFilePath(specHash, datasetId, cacheDir);
  const filtered = filterAndCap(entries, maxEntries);
  const dropped  = Object.keys(entries).length - Object.keys(filtered).length;

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
 * Merge multiple per-worker cache snapshots into one. Later snapshots
 * win on key collision; this is fine because identical (geneKey, spec,
 * dataset) tuples produce identical fitness values up to fp determinism.
 */
export function mergeCaches(snapshots) {
  const out = {};
  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object') continue;
    for (const [k, v] of Object.entries(snap)) {
      out[k] = v;
    }
  }
  return out;
}

// ─── Internals ─────────────────────────────────────────────

/**
 * Drop eliminated/invalid entries, then keep only the top-N by fitness.
 * Entries we discard:
 *   - non-numeric fitness
 *   - fitness ≤ 0  (eliminated genes / soft-penalty band — never a useful
 *                   cache hit; on a re-run the same gene will hit the same
 *                   gate and we don't save a real backtest)
 */
function filterAndCap(entries, maxEntries) {
  const arr = [];
  for (const [k, v] of Object.entries(entries)) {
    if (!v || typeof v !== 'object') continue;
    const f = v.fitness;
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) continue;
    arr.push([k, v]);
  }
  arr.sort((a, b) => b[1].fitness - a[1].fitness);
  const capped = arr.slice(0, maxEntries);
  const out = {};
  for (const [k, v] of capped) out[k] = v;
  return out;
}
