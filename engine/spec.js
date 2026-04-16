/**
 * Strategy spec — the declarative description of a composable strategy.
 *
 * A spec is a JSON file under strategies/ that wires block instances into
 * slots. It describes strategy LOGIC only — symbol, timeframe, and date
 * range are supplied per run by the runner. That way one spec can be
 * optimized against BTCUSDT/1h, ETHUSDT/4h, etc., without duplication.
 *
 * ── Spec shape ───────────────────────────────────────────────────────
 *
 * {
 *   "name":        "20260414-001-jm-simple-3tp-legacy",
 *   "description": "Legacy JM Simple 3TP ported into composable framework",
 *
 *   "regime": { "block": "htfTrendRegime", "version": 1, "instanceId": "trend",
 *               "params": { "maPeriod": { "value": 200 } } },
 *
 *   "entries": {
 *     "mode": "score",
 *     "threshold": { "min": 1, "max": 3, "step": 1 },
 *     "blocks": [
 *       { "block": "stochCross", "version": 1, "instanceId": "main",
 *         "params": {
 *           "stochLen":  { "min": 5, "max": 40, "step": 1 },
 *           "stochSmth": { "min": 1, "max": 8,  "step": 1 }
 *         } },
 *       ...
 *     ]
 *   },
 *
 *   "filters": { "mode": "all", "blocks": [] },
 *
 *   "exits": {
 *     "hardStop": { "block": "atrHardStop", ... } | null,
 *     "target":   { "block": "atrScaleOutTarget", ... } | null,
 *     "trail":    { "block": "structuralExit", ... } | null
 *   },
 *
 *   "sizing": { "block": "atrRiskSizing", "version": 1, "instanceId": "main",
 *               "params": { "riskPct": { "min": 0.5, "max": 5.0, "step": 0.5 } } },
 *
 *   "constraints": [
 *     { "lhs": "emaTrend.main.emaFast", "op": "<",
 *       "rhs": "emaTrend.main.emaSlow", "repair": "clamp-rhs" }
 *   ],
 *
 *   "fitness": {
 *     "weights": { "pf": 0.5, "dd": 0.3, "ret": 0.2 },
 *     "caps":    { "pf": 4.0, "ret": 2.0 },
 *     "gates":   { "minTradesPerWindow": 30, "worstRegimePfFloor": 1.0, "wfeMin": 0.5 }
 *   },
 *
 *   "walkForward": { "nWindows": 5, "scheme": "anchored" }
 * }
 *
 * ── Param modes ──────────────────────────────────────────────────────
 * Each entry under a block's "params" is one of:
 *   { "min": N, "max": N, "step": N }   — GA-optimized, narrows block's declared range
 *   { "value": N }                      — pinned literal, excluded from genome
 *   (omitted key)                        — GA-optimized over block's full declared range
 *
 * Spec-level ranges MUST be within the block's declared range. Step must
 * be a positive multiple compatible with the block's step (validator checks).
 *
 * ── Identity ─────────────────────────────────────────────────────────
 * spec.name    — human-readable id, must match /^\d{8}-\d+-[a-z0-9-]+$/
 *                (YYYYMMDD-<numeric id>-<kebab-case short name>)
 * spec.hash    — SHA-256 of the canonicalized spec JSON (stable key-ordering,
 *                no whitespace). Computed at load time; used as spec_hash in DB.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as registry from './blocks/registry.js';
import { KINDS, EXIT_SLOTS, DIRECTIONS, parseParamId } from './blocks/contract.js';

// ─── Format constants ───────────────────────────────────────
export const SPEC_NAME_REGEX = /^\d{8}-\d+-[a-z0-9-]+$/;
export const ENTRY_MODES  = Object.freeze(['score', 'all', 'any']);
export const FILTER_MODES = Object.freeze(['all', 'any', 'score']);
export const CONSTRAINT_OPS = Object.freeze(['<', '<=', '>', '>=', '!=']);
export const REPAIR_MODES = Object.freeze(['clamp-lhs', 'clamp-rhs']);

export const DEFAULT_FITNESS = Object.freeze({
  weights: { pf: 0.5, dd: 0.3, ret: 0.2 },
  caps:    { pf: 4.0, ret: 2.0 },
  gates:   { minTradesPerWindow: 30, worstRegimePfFloor: 1.0, wfeMin: 0.5 },
  // GA train/test split: fraction of bars reserved for out-of-sample scoring.
  // During GA evolution, indicators compute on ALL bars but fitness metrics
  // only accumulate from trades whose exit bar falls in the last `gaOosRatio`
  // of the data. Set 0 to disable (score on full data as before).
  gaOosRatio: 0.3,
});

export const DEFAULT_WALK_FORWARD = Object.freeze({
  nWindows: 5,
  scheme:   'anchored',  // 'anchored' (expanding IS) | 'rolling' (fixed-width IS)
});

// ─── Load + validate ────────────────────────────────────────

/**
 * Load and validate a spec from disk, attaching a stable content hash.
 * Registry must be populated (call `registry.ensureLoaded()` first, or
 * register blocks manually in tests).
 *
 * @param {string} filepath — absolute or relative path to .json
 * @returns {Promise<Object>} validated spec with `.hash` attached
 */
export async function loadSpec(filepath) {
  const raw = await readFile(filepath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`Spec ${filepath}: invalid JSON — ${e.message}`); }
  return validateSpec(parsed, { sourcePath: filepath });
}

/**
 * Validate an already-parsed spec object. Throws an aggregated error
 * listing all violations (validator is fail-loud on every issue it finds,
 * not fail-fast on the first).
 *
 * @param {Object} spec
 * @param {Object} [opts]
 * @param {string} [opts.sourcePath] — for error context
 * @returns {Object} same spec with `.hash` attached and internal fields normalized
 */
export function validateSpec(spec, opts = {}) {
  const errs = [];
  const ctx = opts.sourcePath ? ` (${opts.sourcePath})` : '';
  const push = (msg) => errs.push(msg);

  if (!spec || typeof spec !== 'object') {
    throw new Error(`Spec${ctx}: must be an object`);
  }

  // Name
  if (typeof spec.name !== 'string' || !SPEC_NAME_REGEX.test(spec.name)) {
    push(`spec.name must match YYYYMMDD-<id>-<kebab-name>, got: ${JSON.stringify(spec.name)}`);
  }

  // Description — optional, just a string
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    push('spec.description must be a string if provided');
  }

  // ─── Slots ─────────────────────────────────────────
  validateRegimeSlot(spec.regime, push);
  validateEntriesSlot(spec.entries, push);
  validateFiltersSlot(spec.filters, push);
  validateExitsSlot(spec.exits, push);
  validateSizingSlot(spec.sizing, push);

  // ─── Constraints ─────────────────────────────────────
  if (spec.constraints !== undefined) {
    if (!Array.isArray(spec.constraints)) {
      push('spec.constraints must be an array if provided');
    } else {
      const qualified = collectQualifiedParamIds(spec);
      spec.constraints.forEach((c, i) => validateConstraint(c, i, qualified, push));
    }
  }

  // ─── Fitness + walk-forward ──────────────────────────
  validateFitnessConfig(spec.fitness, push);
  validateWalkForwardConfig(spec.walkForward, push);

  // ─── Cross-checks ────────────────────────────────────
  // Must have at least one entry block
  if (Array.isArray(spec.entries?.blocks) && spec.entries.blocks.length === 0) {
    push('spec.entries.blocks: at least one entry block is required');
  }
  // Must have sizing (no default — explicit)
  if (!spec.sizing) push('spec.sizing is required');

  // At least one exit slot must be filled, or positions never close except by data end
  if (spec.exits && !spec.exits.hardStop && !spec.exits.target && !spec.exits.trail) {
    push('spec.exits: at least one of hardStop/target/trail must be configured');
  }

  // Sizing requirements — cross-check against active slots so a spec using
  // atrRisk sizing without a hardStop fails loud at load time, not silently
  // at the first entry.
  validateSizingRequirements(spec, push);

  if (errs.length) {
    throw new Error(`Spec "${spec?.name ?? '(unnamed)'}"${ctx} failed validation:\n  - ${errs.join('\n  - ')}`);
  }

  // Fill defaults and attach hash
  const normalized = normalizeSpec(spec);
  normalized.hash = hashSpec(normalized);
  return normalized;
}

// ─── Slot validators ────────────────────────────────────────

function validateRegimeSlot(regime, push) {
  if (regime === undefined || regime === null) return; // optional
  validateBlockRef(regime, {
    expectedKind: KINDS.REGIME,
    slotPath: 'regime',
    requireDirection: false,
  }, push);
}

function validateEntriesSlot(entries, push) {
  if (!entries || typeof entries !== 'object') {
    push('spec.entries is required and must be an object');
    return;
  }
  if (!ENTRY_MODES.includes(entries.mode)) {
    push(`spec.entries.mode must be one of ${ENTRY_MODES.join(', ')}`);
  }
  if (entries.mode === 'score') {
    validateParamValue('spec.entries.threshold', entries.threshold,
      { type: 'int', min: 1, max: 100, step: 1 }, push);
  }
  if (!Array.isArray(entries.blocks)) {
    push('spec.entries.blocks must be an array');
    return;
  }
  entries.blocks.forEach((ref, i) => validateBlockRef(ref, {
    expectedKind: KINDS.ENTRY,
    slotPath: `entries.blocks[${i}]`,
    requireDirection: true,
  }, push));
}

function validateFiltersSlot(filters, push) {
  if (filters === undefined) return; // optional
  if (!filters || typeof filters !== 'object') {
    push('spec.filters must be an object if provided');
    return;
  }
  if (!FILTER_MODES.includes(filters.mode)) {
    push(`spec.filters.mode must be one of ${FILTER_MODES.join(', ')}`);
  }
  if (filters.mode === 'score') {
    validateParamValue('spec.filters.threshold', filters.threshold,
      { type: 'int', min: 1, max: 100, step: 1 }, push);
  }
  if (!Array.isArray(filters.blocks)) {
    push('spec.filters.blocks must be an array');
    return;
  }
  filters.blocks.forEach((ref, i) => validateBlockRef(ref, {
    expectedKind: KINDS.FILTER,
    slotPath: `filters.blocks[${i}]`,
    requireDirection: true,
  }, push));
}

function validateExitsSlot(exits, push) {
  if (!exits || typeof exits !== 'object') {
    push('spec.exits is required and must be an object');
    return;
  }
  for (const slot of Object.values(EXIT_SLOTS)) {
    const ref = exits[slot];
    if (ref === undefined || ref === null) continue; // slot is optional
    validateBlockRef(ref, {
      expectedKind: KINDS.EXIT,
      expectedExitSlot: slot,
      slotPath: `exits.${slot}`,
      requireDirection: true,
    }, push);
  }
  // Reject unknown slot keys — catches typos like "stoploss"
  for (const key of Object.keys(exits)) {
    if (!Object.values(EXIT_SLOTS).includes(key)) {
      push(`spec.exits: unknown slot "${key}" (valid: ${Object.values(EXIT_SLOTS).join(', ')})`);
    }
  }
}

function validateSizingSlot(sizing, push) {
  if (!sizing) return; // top-level check already pushed if missing
  validateBlockRef(sizing, {
    expectedKind: KINDS.SIZING,
    slotPath: 'sizing',
    requireDirection: false,
  }, push);
}

// ─── Block ref + params ─────────────────────────────────────

function validateBlockRef(ref, opts, push) {
  const path = opts.slotPath;

  if (!ref || typeof ref !== 'object') {
    push(`spec.${path}: must be an object`);
    return;
  }
  if (typeof ref.block !== 'string' || !ref.block) {
    push(`spec.${path}.block: required string`);
  }
  if (!Number.isInteger(ref.version) || ref.version < 1) {
    push(`spec.${path}.version: must be a positive integer`);
  }
  if (typeof ref.instanceId !== 'string' || !/^[a-z0-9_-]+$/i.test(ref.instanceId || '')) {
    push(`spec.${path}.instanceId: must be an identifier matching /^[a-z0-9_-]+$/i`);
  }
  if (ref.params !== undefined && (typeof ref.params !== 'object' || Array.isArray(ref.params))) {
    push(`spec.${path}.params: must be an object`);
  }

  // Resolve the block in the registry
  if (typeof ref.block !== 'string') return;
  if (!registry.has(ref.block, ref.version)) {
    const available = registry.listVersions(ref.block);
    const hint = available.length
      ? `available versions: ${available.join(', ')}`
      : 'block is not registered';
    push(`spec.${path}: block "${ref.block}" v${ref.version} not found (${hint})`);
    return;
  }
  const block = registry.get(ref.block, ref.version);

  if (block.kind !== opts.expectedKind) {
    push(`spec.${path}: block "${ref.block}" has kind="${block.kind}", expected "${opts.expectedKind}"`);
  }
  if (opts.expectedExitSlot && block.exitSlot !== opts.expectedExitSlot) {
    push(`spec.${path}: exit block "${ref.block}" fills slot "${block.exitSlot}", expected "${opts.expectedExitSlot}"`);
  }
  if (opts.requireDirection && !DIRECTIONS.BOTH && block.direction === undefined) {
    push(`spec.${path}: block "${ref.block}" missing direction`);
  }

  // Validate each param entry against the block's declaredParams
  const declared = block.declaredParams();
  const declaredById = new Map(declared.map(p => [p.id, p]));
  const suppliedParams = ref.params || {};

  // Unknown param keys — catches typos
  for (const key of Object.keys(suppliedParams)) {
    if (!declaredById.has(key)) {
      push(`spec.${path}.params.${key}: not declared by block "${ref.block}" v${ref.version} ` +
           `(available: ${[...declaredById.keys()].join(', ') || '(none)'})`);
    }
  }

  // Per-param validation
  for (const [key, val] of Object.entries(suppliedParams)) {
    const decl = declaredById.get(key);
    if (!decl) continue; // already reported above
    validateParamValue(`spec.${path}.params.${key}`, val, decl, push);
  }
}

/**
 * Validate a param value entry. Three forms accepted:
 *   { min, max, step }  — GA-optimized sub-range (must fit within decl range)
 *   { value }           — pinned literal (must satisfy decl range + step)
 *   undefined           — use the block's declared range (nothing to validate)
 */
function validateParamValue(path, val, decl, push) {
  if (val === undefined || val === null) {
    push(`${path}: must be an object with { min,max,step } or { value }`);
    return;
  }
  if (typeof val !== 'object') {
    push(`${path}: must be an object, got ${typeof val}`);
    return;
  }

  const hasRange = 'min' in val || 'max' in val || 'step' in val;
  const hasValue = 'value' in val;

  if (hasRange && hasValue) {
    push(`${path}: specify either { min,max,step } OR { value }, not both`);
    return;
  }

  if (hasValue) {
    if (typeof val.value !== 'number' || !isFinite(val.value)) {
      push(`${path}.value: must be a finite number`);
      return;
    }
    if (val.value < decl.min || val.value > decl.max) {
      push(`${path}.value: ${val.value} outside block's declared range [${decl.min}, ${decl.max}]`);
    }
    if (!stepAligned(val.value - decl.min, decl.step)) {
      push(`${path}.value: ${val.value} not aligned to block's step ${decl.step} from min ${decl.min}`);
    }
    if (decl.type === 'int' && !Number.isInteger(val.value)) {
      push(`${path}.value: declared as int, got non-integer ${val.value}`);
    }
    return;
  }

  // Range mode
  const { min, max, step } = val;
  if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') {
    push(`${path}: min/max/step must all be numbers`);
    return;
  }
  if (!(min < max)) push(`${path}: min (${min}) must be < max (${max})`);
  if (!(step > 0)) push(`${path}: step must be > 0`);
  if (min < decl.min) push(`${path}.min (${min}) below block's declared min (${decl.min})`);
  if (max > decl.max) push(`${path}.max (${max}) above block's declared max (${decl.max})`);
  if (!stepAligned(step, decl.step)) {
    push(`${path}.step (${step}) not a positive multiple of block's step (${decl.step})`);
  }
  if (decl.type === 'int') {
    if (!Number.isInteger(min)) push(`${path}.min: int-typed param, got ${min}`);
    if (!Number.isInteger(max)) push(`${path}.max: int-typed param, got ${max}`);
    if (!Number.isInteger(step)) push(`${path}.step: int-typed param, got ${step}`);
  }
}

/**
 * True iff `value` is a (near-)integer multiple of `step`. Tolerant of
 * float math noise — e.g. 1.5 / 0.5 should be 3 but may round to 2.9999...
 */
function stepAligned(value, step) {
  if (step <= 0) return false;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

// ─── Constraints ────────────────────────────────────────────

function validateConstraint(c, i, qualifiedIds, push) {
  const path = `spec.constraints[${i}]`;
  if (!c || typeof c !== 'object') { push(`${path}: must be an object`); return; }
  if (typeof c.lhs !== 'string' || !qualifiedIds.has(c.lhs)) {
    push(`${path}.lhs: "${c.lhs}" is not a qualified param id in this spec`);
  }
  if (!CONSTRAINT_OPS.includes(c.op)) {
    push(`${path}.op: must be one of ${CONSTRAINT_OPS.join(' | ')}`);
  }
  if (typeof c.rhs === 'string') {
    if (!qualifiedIds.has(c.rhs)) {
      push(`${path}.rhs: "${c.rhs}" is not a qualified param id in this spec`);
    }
  } else if (typeof c.rhs !== 'number') {
    push(`${path}.rhs: must be a qualified param id or a numeric literal`);
  }
  if (c.repair !== undefined && !REPAIR_MODES.includes(c.repair)) {
    push(`${path}.repair: must be one of ${REPAIR_MODES.join(' | ')}`);
  }
}

/**
 * Walk the spec, collect the set of fully-qualified param ids that will
 * end up in the genome. Used by constraint validation so constraints
 * can only reference parameters that actually exist.
 */
function collectQualifiedParamIds(spec) {
  const ids = new Set();
  const addRef = (ref) => {
    if (!ref || typeof ref !== 'object') return;
    if (!registry.has(ref.block, ref.version)) return;
    const block = registry.get(ref.block, ref.version);
    for (const p of block.declaredParams()) {
      ids.add(`${ref.block}.${ref.instanceId}.${p.id}`);
    }
  };
  addRef(spec.regime);
  spec.entries?.blocks?.forEach(addRef);
  spec.filters?.blocks?.forEach(addRef);
  if (spec.exits) {
    addRef(spec.exits.hardStop);
    addRef(spec.exits.target);
    addRef(spec.exits.trail);
  }
  addRef(spec.sizing);
  return ids;
}

// ─── Fitness + walk-forward ─────────────────────────────────

function validateFitnessConfig(fit, push) {
  if (fit === undefined) return; // optional; defaults filled in normalize
  if (!fit || typeof fit !== 'object') { push('spec.fitness must be an object'); return; }

  if (fit.weights) {
    for (const k of ['pf', 'dd', 'ret']) {
      if (!(k in fit.weights)) continue;
      if (typeof fit.weights[k] !== 'number' || fit.weights[k] < 0) {
        push(`spec.fitness.weights.${k}: must be a non-negative number`);
      }
    }
    const sum = (fit.weights.pf ?? 0) + (fit.weights.dd ?? 0) + (fit.weights.ret ?? 0);
    if (sum > 0 && Math.abs(sum - 1) > 0.01) {
      // Soft warning via push — not fatal but likely unintentional
      push(`spec.fitness.weights sum to ${sum.toFixed(3)}, expected ~1.0 ` +
           `(weights are normalized at fitness time, but this is usually a mistake)`);
    }
  }
  if (fit.caps) {
    for (const k of ['pf', 'ret']) {
      if (k in fit.caps && (typeof fit.caps[k] !== 'number' || fit.caps[k] <= 0)) {
        push(`spec.fitness.caps.${k}: must be a positive number`);
      }
    }
  }
  if (fit.gates) {
    const g = fit.gates;
    if ('minTradesPerWindow' in g && (!Number.isInteger(g.minTradesPerWindow) || g.minTradesPerWindow < 0)) {
      push('spec.fitness.gates.minTradesPerWindow: non-negative integer');
    }
    if ('worstRegimePfFloor' in g && (typeof g.worstRegimePfFloor !== 'number' || g.worstRegimePfFloor < 0)) {
      push('spec.fitness.gates.worstRegimePfFloor: non-negative number');
    }
    if ('wfeMin' in g && (typeof g.wfeMin !== 'number' || g.wfeMin < 0 || g.wfeMin > 1)) {
      push('spec.fitness.gates.wfeMin: number in [0, 1]');
    }
  }
}

/**
 * Validate that the sizing block's declared requirements are satisfiable.
 *
 * Recognized requirements:
 *   'stopDistance' — requires a hardStop slot whose block implements planStop().
 *   'tradeStats'   — always satisfied (runtime provides stats). No-op.
 *   'equityCurve'  — always satisfiable (runtime opts-in when seen).
 */
function validateSizingRequirements(spec, push) {
  const ref = spec.sizing;
  if (!ref || typeof ref.block !== 'string') return;
  if (!registry.has(ref.block, ref.version)) return; // earlier error already pushed
  const block = registry.get(ref.block, ref.version);
  const reqs = typeof block.sizingRequirements === 'function'
    ? block.sizingRequirements()
    : [];
  if (!Array.isArray(reqs)) {
    push(`spec.sizing: block "${ref.block}" v${ref.version} sizingRequirements() must return an array`);
    return;
  }
  const allowed = new Set(['stopDistance', 'tradeStats', 'equityCurve']);
  for (const r of reqs) {
    if (!allowed.has(r)) {
      push(`spec.sizing: block "${ref.block}" requires unknown capability "${r}" ` +
           `(valid: ${[...allowed].join(', ')})`);
    }
  }

  if (reqs.includes('stopDistance')) {
    const hs = spec.exits?.hardStop;
    if (!hs) {
      push(`spec.sizing: block "${ref.block}" requires 'stopDistance' but no hardStop slot is filled`);
    } else if (registry.has(hs.block, hs.version)) {
      const hsBlock = registry.get(hs.block, hs.version);
      if (typeof hsBlock.planStop !== 'function') {
        push(`spec.sizing: block "${ref.block}" requires 'stopDistance' but ` +
             `hardStop block "${hs.block}" v${hs.version} does not implement planStop()`);
      }
    }
  }
}

function validateWalkForwardConfig(wf, push) {
  if (wf === undefined) return; // optional; defaults filled in normalize
  if (!wf || typeof wf !== 'object') { push('spec.walkForward must be an object'); return; }
  if (wf.nWindows !== undefined && (!Number.isInteger(wf.nWindows) || wf.nWindows < 2)) {
    push('spec.walkForward.nWindows: integer >= 2');
  }
  if (wf.scheme !== undefined && !['anchored', 'rolling'].includes(wf.scheme)) {
    push(`spec.walkForward.scheme: must be 'anchored' or 'rolling'`);
  }
}

// ─── Normalize (fill defaults) ──────────────────────────────

/**
 * Returns a deep-cloned spec with defaults filled in for optional sections.
 * Applied AFTER validation so defaults don't mask user errors.
 */
function normalizeSpec(spec) {
  const clone = structuredClone(spec);

  clone.filters ??= { mode: 'all', blocks: [] };
  clone.regime ??= null;
  clone.exits  ??= { hardStop: null, target: null, trail: null };
  clone.constraints ??= [];

  clone.fitness = {
    weights:    { ...DEFAULT_FITNESS.weights, ...(clone.fitness?.weights) },
    caps:       { ...DEFAULT_FITNESS.caps,    ...(clone.fitness?.caps) },
    gates:      { ...DEFAULT_FITNESS.gates,   ...(clone.fitness?.gates) },
    gaOosRatio: clone.fitness?.gaOosRatio ?? DEFAULT_FITNESS.gaOosRatio,
  };
  clone.walkForward = { ...DEFAULT_WALK_FORWARD, ...(clone.walkForward ?? {}) };

  return clone;
}

// ─── Content hash ───────────────────────────────────────────

/**
 * Stable SHA-256 hash of a spec. Uses a canonical JSON representation
 * (sorted keys, no whitespace, omitting the transient `.hash` field
 * itself) so logically-identical specs always hash the same regardless
 * of file formatting.
 */
export function hashSpec(spec) {
  const { hash: _ignore, ...rest } = spec; // exclude any prior hash
  const canonical = canonicalJson(rest);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonical JSON: recursively sort object keys, preserve array order,
 * stringify with no whitespace. NaN/Infinity intentionally forbidden
 * (they'd already fail JSON.parse, but guard for clarity).
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Spec contains non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]));
  return '{' + parts.join(',') + '}';
}
