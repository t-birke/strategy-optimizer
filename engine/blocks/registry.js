/**
 * Block registry — central lookup for all available blocks.
 *
 * Blocks are registered by (id, version). A spec pins each reference to
 * a specific version, so changing a block's semantics requires bumping
 * its version — old specs keep loading the old version until they're
 * explicitly migrated.
 *
 * Registration happens at import time: each block module in
 * engine/blocks/library/*.js should be imported here and passed to
 * `register()`. The registry is populated lazily when `ensureLoaded()`
 * is called, which dynamically imports the library. This keeps
 * zero-block tooling (the spec validator, unit tests) fast.
 */

import { validateBlock } from './contract.js';

// key = `${id}@${version}`, value = block module
const BLOCKS = new Map();

// Tracks whether the library bundle has been auto-loaded. Tests and
// library code can register blocks manually without triggering the
// auto-load.
let libraryLoaded = false;

/**
 * Register a block. Validates the contract and rejects duplicates.
 * Safe to call multiple times with the exact same module reference
 * (idempotent for hot-reload scenarios).
 */
export function register(block) {
  validateBlock(block);
  const key = blockKey(block.id, block.version);
  const existing = BLOCKS.get(key);
  if (existing && existing !== block) {
    throw new Error(`Block "${block.id}" v${block.version} already registered with a different module`);
  }
  BLOCKS.set(key, block);
  return block;
}

/**
 * Look up a block by id + version. Throws if not found (specs must pin
 * versions, so a miss is an authoring error, not a fallback-worthy case).
 */
export function get(id, version) {
  const key = blockKey(id, version);
  const b = BLOCKS.get(key);
  if (!b) {
    const available = listVersions(id);
    const hint = available.length
      ? ` Available versions: ${available.join(', ')}`
      : ` No versions of "${id}" are registered.`;
    throw new Error(`Block "${id}" v${version} not found.${hint}`);
  }
  return b;
}

/**
 * True iff a specific (id, version) is registered. Non-throwing variant.
 */
export function has(id, version) {
  return BLOCKS.has(blockKey(id, version));
}

/**
 * Enumerate all registered blocks. Handy for UI "block picker" panels.
 */
export function list() {
  return Array.from(BLOCKS.values());
}

/**
 * List all registered versions for a block id (ascending).
 */
export function listVersions(id) {
  const versions = [];
  for (const [key, block] of BLOCKS) {
    if (block.id === id) versions.push(block.version);
  }
  return versions.sort((a, b) => a - b);
}

/**
 * The highest registered version of a block id. Useful for spec
 * authoring UX ("use latest by default"), but specs themselves should
 * always pin a version explicitly.
 */
export function latestVersion(id) {
  const vs = listVersions(id);
  return vs.length ? vs[vs.length - 1] : null;
}

/**
 * Clear the registry. Test-only — wraps a `registry.__resetForTests()`
 * that test harnesses can call between suites.
 */
export function __resetForTests() {
  BLOCKS.clear();
  libraryLoaded = false;
}

/**
 * Auto-load the block library on first use. The library module
 * (engine/blocks/library/index.js) imports each block file and calls
 * `register()`. We keep the import dynamic so non-runtime consumers
 * (spec validators, block-authoring tools) don't pay the import cost
 * unless they need it.
 */
export async function ensureLoaded() {
  if (libraryLoaded) return;
  libraryLoaded = true;
  try {
    await import('./library/index.js');
  } catch (e) {
    // Library file may not exist yet during chunk-by-chunk rollout.
    // Surface the error so it's debuggable, but don't crash callers
    // that only need the registry machinery.
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
}

function blockKey(id, version) {
  return `${id}@${version}`;
}
