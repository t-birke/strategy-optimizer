/**
 * Param space — derives the GA genome and GA operators from a validated spec.
 *
 * Replaces the old static `optimizer/params.js`. That file was hand-written
 * for one specific strategy with 18 hardcoded genes. This module builds the
 * equivalent machinery dynamically for ANY spec: it walks the spec, expands
 * each block's declared params (minus pinned values), applies spec-level
 * narrowings, and returns a closure-bound family of operators the GA and
 * runtime both consume.
 *
 * The GA stays blissfully ignorant of blocks — it sees only the PARAMS array
 * (qualified ids → min/max/step/type) and the operators below. Dynamic-ness
 * is contained here.
 *
 * Qualified param ID scheme:
 *   <blockId>.<instanceId>.<localParamId>          — block params
 *   _meta.<entries|filters>.threshold              — meta params (score thresholds)
 *
 * The `_meta.` prefix can't collide with block ids because block validator
 * rejects ids starting with a dot or underscore at the block level.
 */

import * as registry from '../engine/blocks/registry.js';

// ─── Top-level entry point ──────────────────────────────────

/**
 * Build the param space + GA operators for a spec.
 *
 * @param {Object} spec — already validated via engine/spec.js
 * @returns {Object} param-space bundle (see module docstring above)
 */
export function buildParamSpace(spec) {
  const PARAMS = [];
  const pinned = Object.create(null);  // qid -> literal value (not in genome)
  const originOf = Object.create(null); // qid -> origin descriptor (which slot/block)

  // ─── Walk the spec and collect every param ───────────
  addMeta('entries', spec.entries);
  if (spec.filters) addMeta('filters', spec.filters);

  walkRef(spec.regime,        { slot: 'regime' });
  spec.entries?.blocks?.forEach((ref, i) => walkRef(ref, { slot: 'entries', index: i }));
  spec.filters?.blocks?.forEach((ref, i) => walkRef(ref, { slot: 'filters', index: i }));
  if (spec.exits) {
    walkRef(spec.exits.hardStop, { slot: 'exits.hardStop' });
    walkRef(spec.exits.target,   { slot: 'exits.target' });
    walkRef(spec.exits.trail,    { slot: 'exits.trail' });
  }
  walkRef(spec.sizing, { slot: 'sizing' });

  // ─── Constraints ─────────────────────────────────────
  // Resolve qid references; literal rhs stays numeric. Rejects any
  // constraint whose lhs/rhs was pinned out of the genome — a pinned
  // param doesn't mutate, so constraining it serves no purpose.
  const constraints = (spec.constraints ?? []).map((c, i) => {
    const lhs = c.lhs;
    const rhs = c.rhs;
    const lhsInGenome = originOf[lhs] !== undefined && !(lhs in pinned);
    const rhsIsLiteral = typeof rhs === 'number';
    const rhsInGenome = rhsIsLiteral ? false : (originOf[rhs] !== undefined && !(rhs in pinned));

    if (!lhsInGenome && !(lhs in pinned)) {
      throw new Error(`Constraint[${i}]: lhs "${lhs}" not found in spec`);
    }
    if (!lhsInGenome && rhsIsLiteral) {
      throw new Error(`Constraint[${i}]: both lhs "${lhs}" pinned and rhs is literal — constraint is inert`);
    }
    if (!rhsIsLiteral && !rhsInGenome && !(rhs in pinned)) {
      throw new Error(`Constraint[${i}]: rhs "${rhs}" not found in spec`);
    }

    return {
      lhs,
      op: c.op,
      rhs,
      rhsIsLiteral,
      repair: c.repair ?? 'clamp-lhs',
    };
  });

  // ─── Operators ───────────────────────────────────────
  const paramById = new Map(PARAMS.map(p => [p.id, p]));

  function clamp(val, p) {
    const c = Math.max(p.min, Math.min(p.max, val));
    const snapped = Math.round((c - p.min) / p.step) * p.step + p.min;
    return p.type === 'int' ? Math.round(snapped) : roundToStep(snapped, p.step);
  }

  function randomParam(p) {
    const steps = Math.round((p.max - p.min) / p.step);
    const v = p.min + Math.floor(Math.random() * (steps + 1)) * p.step;
    return p.type === 'int' ? Math.round(v) : roundToStep(v, p.step);
  }

  function randomIndividual() {
    const g = Object.create(null);
    for (const p of PARAMS) g[p.id] = randomParam(p);
    enforceConstraints(g);
    return g;
  }

  /**
   * Mutate `input` into `output`. `perGeneMut` is the per-gene mutation
   * probability. Matches old params.js semantics: direction ±1, magnitude
   * 1-3 steps.
   */
  function mutate(input, output, perGeneMut = 0.2) {
    for (const p of PARAMS) {
      if (Math.random() < perGeneMut) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const magnitude = 1 + Math.floor(Math.random() * 3);
        output[p.id] = clamp(input[p.id] + dir * magnitude * p.step, p);
      } else {
        output[p.id] = input[p.id];
      }
    }
    enforceConstraints(output);
  }

  function crossover(a, b, child) {
    for (const p of PARAMS) {
      child[p.id] = Math.random() < 0.5 ? a[p.id] : b[p.id];
    }
    enforceConstraints(child);
  }

  /**
   * Apply a frozen-genes mask (knockout experiments). Returns the same gene
   * after mutation, so callers can chain. Unlike the legacy version, this
   * variant ignores frozen entries for pinned qids (they aren't in the
   * genome anyway).
   */
  function applyFrozen(gene, frozenGenes) {
    if (!frozenGenes) return gene;
    for (const id in frozenGenes) {
      if (paramById.has(id)) gene[id] = frozenGenes[id];
    }
    return gene;
  }

  /**
   * Enforce cross-param constraints by clamping. One pass is enough for
   * all constraint forms we currently support (pairwise ordering, literal
   * bounds). If a future use case requires iterative relaxation we'll add
   * it then.
   */
  function enforceConstraints(gene) {
    for (const c of constraints) {
      const lhsVal = gene[c.lhs];
      const rhsVal = c.rhsIsLiteral ? c.rhs : gene[c.rhs];
      if (lhsVal === undefined || rhsVal === undefined) continue;

      if (!evalOp(lhsVal, c.op, rhsVal)) {
        // Repair: shift one side by one step toward satisfying the op
        if (c.repair === 'clamp-rhs' && !c.rhsIsLiteral) {
          const rhsParam = paramById.get(c.rhs);
          gene[c.rhs] = clamp(shiftToSatisfy(rhsVal, lhsVal, c.op, rhsParam, /* isRhs */ true), rhsParam);
        } else {
          const lhsParam = paramById.get(c.lhs);
          gene[c.lhs] = clamp(shiftToSatisfy(lhsVal, rhsVal, c.op, lhsParam, /* isRhs */ false), lhsParam);
        }
      }
    }
  }

  function geneKey(gene) {
    // Stable CSV in PARAMS order — matches old geneKey contract so
    // fitness caches stay coherent across GA generations.
    return PARAMS.map(p => gene[p.id]).join(',');
  }

  /**
   * Rehydrate a flat gene into per-slot / per-block-instance params the
   * runtime consumes. Pinned values are folded in transparently — runtime
   * code never needs to know which params are in the genome vs. pinned.
   */
  function hydrate(gene) {
    const allValues = Object.create(null);
    for (const p of PARAMS) allValues[p.id] = gene[p.id];
    Object.assign(allValues, pinned);

    const pickBlockParams = (ref) => {
      if (!ref) return null;
      const block = registry.get(ref.block, ref.version);
      const out = Object.create(null);
      for (const p of block.declaredParams()) {
        const qid = `${ref.block}.${ref.instanceId}.${p.id}`;
        out[p.id] = allValues[qid];
      }
      return {
        blockId:    ref.block,
        version:    ref.version,
        instanceId: ref.instanceId,
        params:     out,
      };
    };

    return {
      regime:  pickBlockParams(spec.regime),
      entries: {
        mode:      spec.entries.mode,
        threshold: allValues['_meta.entries.threshold'],
        blocks:    spec.entries.blocks.map(pickBlockParams),
      },
      filters: spec.filters ? {
        mode:      spec.filters.mode,
        threshold: allValues['_meta.filters.threshold'],
        blocks:    spec.filters.blocks.map(pickBlockParams),
      } : null,
      exits: spec.exits ? {
        hardStop: pickBlockParams(spec.exits.hardStop),
        target:   pickBlockParams(spec.exits.target),
        trail:    pickBlockParams(spec.exits.trail),
      } : null,
      sizing: pickBlockParams(spec.sizing),
    };
  }

  return {
    PARAMS,
    pinned,
    constraints,
    clamp,
    randomParam,
    randomIndividual,
    mutate,
    crossover,
    enforceConstraints,
    applyFrozen,
    geneKey,
    hydrate,
  };

  // ─── Internal helpers (closures over PARAMS/pinned/originOf) ───

  function addMeta(slotName, slotConfig) {
    if (!slotConfig || slotConfig.mode !== 'score') return;
    const qid = `_meta.${slotName}.threshold`;
    addParam(qid, slotConfig.threshold,
      { id: 'threshold', type: 'int', min: 1, max: 100, step: 1 },
      { slot: slotName, meta: true });
  }

  function walkRef(ref, origin) {
    if (!ref) return;
    if (!registry.has(ref.block, ref.version)) return; // already caught by spec validator
    const block = registry.get(ref.block, ref.version);
    for (const decl of block.declaredParams()) {
      const qid = `${ref.block}.${ref.instanceId}.${decl.id}`;
      const supplied = ref.params?.[decl.id];
      addParam(qid, supplied, decl, { ...origin, blockId: ref.block, instanceId: ref.instanceId });
    }
  }

  function addParam(qid, supplied, decl, origin) {
    if (qid in originOf) {
      throw new Error(`Duplicate qualified param id: ${qid}`);
    }
    originOf[qid] = origin;

    // Pinned
    if (supplied && 'value' in supplied) {
      pinned[qid] = supplied.value;
      return;
    }

    // Resolve effective range: spec narrowing OR block default
    const min = supplied?.min ?? decl.min;
    const max = supplied?.max ?? decl.max;
    const step = supplied?.step ?? decl.step;

    PARAMS.push({
      id:    qid,
      type:  decl.type,
      min, max, step,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────

function evalOp(a, op, b) {
  switch (op) {
    case '<':  return a < b;
    case '<=': return a <= b;
    case '>':  return a > b;
    case '>=': return a >= b;
    case '!=': return a !== b;
    default: return true;
  }
}

/**
 * Return a value on the `isRhs ? rhs : lhs` side that (when combined with
 * the fixed side) would satisfy the op by one step in the right direction.
 * Caller should then clamp to the param's min/max/step grid.
 */
function shiftToSatisfy(selfVal, fixedVal, op, param, isRhs) {
  const step = param.step;
  // For pairwise ordering ops, nudge self to the correct side of fixed.
  switch (op) {
    case '<':  return isRhs ? Math.max(fixedVal + step, selfVal) : Math.min(fixedVal - step, selfVal);
    case '<=': return isRhs ? Math.max(fixedVal,         selfVal) : Math.min(fixedVal,       selfVal);
    case '>':  return isRhs ? Math.min(fixedVal - step, selfVal)  : Math.max(fixedVal + step, selfVal);
    case '>=': return isRhs ? Math.min(fixedVal,         selfVal) : Math.max(fixedVal,        selfVal);
    case '!=': return selfVal + step;
    default:   return selfVal;
  }
}

/**
 * Round a float to the precision implied by its step size (avoids
 * 0.1+0.2=0.30000000000000004 noise in stored gene values).
 */
function roundToStep(val, step) {
  // Precision digits = ceil(-log10(step)), capped at 10.
  const digits = Math.min(10, Math.max(0, Math.ceil(-Math.log10(step))));
  const factor = Math.pow(10, digits);
  return Math.round(val * factor) / factor;
}
