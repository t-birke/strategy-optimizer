/**
 * Block contract — the unit of composition in the generic strategy framework.
 *
 * A "spec" (strategies/*.json) references blocks by id and wires them into slots:
 *   entries, filters, regime, exits (hardStop / target / trail), sizing.
 * The GA optimizes only the declared params of *active* blocks in a spec.
 *
 * Design invariants:
 *
 * 1. **No lookahead.** A block's onBar at bar `i` may only read candles[j] and
 *    indicator[j] for j <= i. Breaking this makes the strategy unbacktest-able
 *    in live mode AND untranslatable to Pine. Enforced by convention + the
 *    no-lookahead test harness (see engine/blocks/lookahead-check.js).
 *
 * 2. **Pine parity.** Every block must implement pineTemplate() so that a
 *    tuned (spec, params) pair can be one-click exported to a TradingView
 *    indicator that fires alerts on entries. Only entry / filter / regime
 *    blocks need a Pine template — exits/sizing are backtest-only concerns
 *    that don't appear in the alerting indicator.
 *
 * 3. **Two-phase execution.** `prepare()` runs once per backtest with full
 *    columnar candles, and pre-computes everything vectorizable (indicators
 *    are supplied deduped via the indicator cache). `onBar()` runs in the
 *    hot inner loop and should do O(1) work per bar. This preserves the
 *    Float64Array speed path we have today.
 *
 * 4. **Direction is a first-class block property.** Entry / filter / exit
 *    blocks declare `direction: 'long' | 'short' | 'both'`. Score-mode
 *    entry aggregation sums only direction-eligible blocks for each side.
 *
 * 5. **Multi-instance.** The same blockId may appear multiple times in a
 *    spec with different instance ids (e.g., "ema.fast", "ema.slow"). The
 *    block module is stateless — per-instance state lives in the state
 *    object passed to prepare/onBar. Param ids are namespaced:
 *       `<blockId>.<instanceId>.<paramId>`
 *    so two instances never collide.
 */

// ─── Kinds ──────────────────────────────────────────────────
export const KINDS = Object.freeze({
  ENTRY:   'entry',
  FILTER:  'filter',
  REGIME:  'regime',
  EXIT:    'exit',
  SIZING:  'sizing',
});

export const ALL_KINDS = Object.freeze(Object.values(KINDS));

// ─── Exit slots ─────────────────────────────────────────────
// When kind === 'exit', the block must declare which slot it fills.
// The runtime allows at most one block per slot per spec. First-to-trigger
// within a bar wins; across slots, evaluation order is hardStop → target → trail.
export const EXIT_SLOTS = Object.freeze({
  HARD_STOP: 'hardStop',   // SL, emergency SL, catastrophic close — protects capital
  TARGET:    'target',     // TP, scale-out, R:R target — banks profit
  TRAIL:     'trail',      // MA trail, chandelier, structural exit — lets winners run
});

export const ALL_EXIT_SLOTS = Object.freeze(Object.values(EXIT_SLOTS));

// ─── Directions ─────────────────────────────────────────────
export const DIRECTIONS = Object.freeze({
  LONG:  'long',
  SHORT: 'short',
  BOTH:  'both',
});

export const ALL_DIRECTIONS = Object.freeze(Object.values(DIRECTIONS));

/**
 * @typedef {Object} ParamSpec
 * @property {string}  id      — local-to-block param id (e.g., 'period')
 * @property {'int'|'float'} type
 * @property {number}  min
 * @property {number}  max
 * @property {number}  step
 * @property {number}  [default] — used when a spec pins the param to a literal
 */

/**
 * @typedef {Object} IndicatorDep
 * @property {string} key        — canonical dedup key, e.g., 'base:ema:close:20'
 * @property {string} tf         — 'base' | 'daily' | 'weekly' | 'monthly' | custom
 * @property {string} indicator  — name in the indicator registry (ema, rsi, stoch, atr, sma, stdev, percentrank, custom...)
 * @property {string} [source]   — 'close' (default) | 'open' | 'high' | 'low' | 'hlc3' | 'ohlc4' | 'volume' | 'hl2'
 * @property {Object} [args]     — indicator-specific args (e.g., { period: 20 })
 */

/**
 * @typedef {Object} ParamConstraint
 * @property {string}  lhs      — fully-qualified param id
 * @property {'<'|'<='|'>'|'>='|'!='} op
 * @property {string|number} rhs  — fully-qualified param id OR literal
 * @property {string}  [repair] — 'clamp-lhs' | 'clamp-rhs' (default 'clamp-lhs')
 */

/**
 * @typedef {Object} BarContext
 * Present here for documentation. The runtime passes the full candles bundle
 * and the bar index `i` to onBar rather than constructing a ctx object — this
 * is a hot-path perf choice. Blocks read directly from pre-resolved typed
 * arrays captured in `state` during prepare().
 */

/**
 * @typedef {Object} EntryResult
 * @property {number} long   — 0 or 1 (contributes to per-direction score sum)
 * @property {number} short  — 0 or 1
 *
 * @typedef {Object} FilterResult
 * @property {boolean} long   — true = long entries permitted this bar
 * @property {boolean} short  — true = short entries permitted this bar
 *
 * @typedef {Object} ExitResult
 * @property {boolean} close       — true if the block is firing now
 * @property {number}  [fillPrice] — optional hint (e.g., target price for limit fill)
 * @property {string}  [signal]    — tag recorded on the trade (e.g., 'TP1', 'ATR-SL')
 *
 * Regime blocks return a string label (or null for "unknown").
 * Sizing is special — see SizingContract below.
 */

/**
 * @typedef {Object} Block
 * @property {string}  id
 * @property {number}  version
 * @property {keyof KINDS} kind
 * @property {keyof DIRECTIONS} [direction]  — required unless kind is regime/sizing
 * @property {keyof EXIT_SLOTS} [exitSlot]   — required iff kind === 'exit'
 * @property {string}  [description]  — optional 1-2 sentence human-readable
 *      summary of what the block does. Surfaced in the spec authoring UI's
 *      block pickers so users don't have to remember what every block id
 *      means. Keep it compact (≤280 chars is a reasonable guideline).
 *
 * @property {() => ParamSpec[]} declaredParams
 *      Returns this block's GA param space. Called once at spec-load time to
 *      derive the genome. No arguments — the param space is static per block
 *      version. (Per-instance customization is done by spec-level overrides,
 *      not by reshaping the param space.)
 *
 * @property {(params: Object) => IndicatorDep[]} indicatorDeps
 *      Given resolved params for this instance, declare which pre-computed
 *      indicators this block needs. Deps with the same `key` are computed
 *      once across the whole spec.
 *
 * @property {(params: Object) => ParamConstraint[]} [constraints]
 *      Optional cross-param constraints this block wants enforced
 *      (e.g., emaFast < emaSlow for an MA-cross block). Spec-level
 *      constraints (across instances) are declared in the spec itself.
 *
 * @property {(candles, params, indicators, state) => void} prepare
 *      One-time setup at backtest start. `candles` = { base, daily, weekly, ... }
 *      bundle. `indicators` = Map<key, Float64Array> of pre-computed deps.
 *      `state` is a plain object the block populates with anything it'll
 *      read per bar (typed-array refs, derived arrays, counters).
 *
 * @property {(candles, i, state, params, position?, runtimeCtx?) => any} onBar
 *      Hot path. Return shape depends on kind — see typedefs above.
 *      MUST NOT read candles[j] or indicators[j] for j > i.
 *      Exit blocks additionally receive `position` and `runtimeCtx`:
 *        position   — the open position object (subs, entryPrice, etc.)
 *        runtimeCtx — { entrySignals, filterSignals, slippage } computed
 *                     once per bar; lets exits react to opposite-side
 *                     signals (reversal), apply correct slippage, etc.
 *
 * @property {(params: Object, paramRefs: Object) => {code: string, long?: string, short?: string, regime?: string}} [pineTemplate]
 *      Emit a Pine v5 snippet computing this block's per-bar signal and tell
 *      the codegen orchestrator which variable names in the snippet hold the
 *      per-direction boolean signals.
 *
 *      `paramRefs` maps param.id → either a Pine input variable name or a
 *      literal numeric value. Blocks interpolate `${paramRefs.foo}` into
 *      their Pine code, so both input-driven and frozen-literal modes
 *      produce valid Pine.
 *
 *      Return:
 *        - `code`:   the Pine snippet (multi-line string).
 *        - `long`:   name of the boolean variable the block assigns for LONG
 *                    eligibility on the current bar (entry / filter).
 *        - `short`:  ditto for SHORT.
 *        - `regime`: name of the string regime label variable (regime blocks).
 *
 *      Required for entry / filter / regime blocks; optional for exit /
 *      sizing (the generated indicator is entry-alerts-only). If omitted on
 *      a required block, Pine codegen throws.
 */

/**
 * Sizing contract — separate because sizing fires once per entry, not per bar.
 *
 * @typedef {Object} SizingBlock
 * @property {string}  id
 * @property {number}  version
 * @property {'sizing'} kind
 * @property {() => ParamSpec[]} declaredParams
 * @property {(params: Object) => IndicatorDep[]} [indicatorDeps]
 * @property {(candles, params, indicators, state) => void} [prepare]
 * @property {() => string[]} [sizingRequirements]
 *      Optional. Declare which optional ctx fields this block depends on.
 *      Valid strings: 'stopDistance' | 'tradeStats' | 'equityCurve'.
 *      The spec validator uses this to reject specs where e.g. atrRisk
 *      sizing is used without a hardStop block providing planStop().
 *
 * @property {(ctx, state, params) => number} computeSize
 *      Called when the runtime is about to open a position.
 *      Returns position size in asset units (can be fractional).
 *
 *      ctx fields (always present):
 *        i               — base bar index of the entry fill
 *        fillPrice       — actual entry price (after slippage)
 *        equity          — account equity at fill time
 *        initialCapital  — starting equity
 *        leverage        — leverage cap from runtime opts
 *        isLong          — direction of the entry
 *        bundle          — full data bundle (for HTF / volume / etc.)
 *        indicators      — cached indicator Map
 *        stats           — running trade stats (zero-initialized until first close):
 *                          { tradeCount, wins, losses, winRate,
 *                            avgWin, avgLoss, biggestWin, biggestLoss,
 *                            currentStreak: { kind: 'W'|'L'|'none', length },
 *                            lastTradePnl, netEquityMultiple }
 *
 *      ctx fields (conditionally present):
 *        stopPrice       — planned SL price (present iff hardStop block
 *                          implements planStop() and returned non-null)
 *        stopDistance    — |fillPrice - stopPrice| (same condition)
 *        equityCurve     — { ts: Float64Array, equity: Float64Array }
 *                          (present iff opts.provideEquityCurve === true)
 */

/**
 * Hard-stop blocks MAY implement planStop to cooperate with risk-based sizing.
 *
 * @typedef {Object} HardStopPlanner
 * @property {(bundle, i, state, params, isLong, fillPrice) => ({ price: number, distance: number } | null)} [planStop]
 *      Return the SL price this block intends to use at position open, plus
 *      the distance from fillPrice. Return null if the stop isn't
 *      fillPrice-distance-predictable (e.g., close-based trailing SL), in
 *      which case risk-based sizing falls back to a declared default.
 */

// ─── Validation helpers ─────────────────────────────────────

const PARAM_TYPES = new Set(['int', 'float']);

/**
 * Validate a block module at registration time. Throws on any contract
 * violation so bad blocks never reach the runtime.
 */
export function validateBlock(block) {
  const errs = [];
  const require = (cond, msg) => { if (!cond) errs.push(msg); };

  require(typeof block?.id === 'string' && block.id.length > 0, 'block.id must be a non-empty string');
  require(Number.isInteger(block?.version) && block.version >= 1, 'block.version must be a positive integer');
  require(ALL_KINDS.includes(block?.kind), `block.kind must be one of: ${ALL_KINDS.join(', ')}`);

  // Description is optional — legacy blocks may not have it — but if
  // present it must be a string so the UI can render it safely.
  if (block?.description !== undefined) {
    require(typeof block.description === 'string',
      'block.description must be a string when present');
  }

  if (block?.kind === KINDS.EXIT) {
    require(ALL_EXIT_SLOTS.includes(block?.exitSlot),
      `exit blocks must declare exitSlot (one of: ${ALL_EXIT_SLOTS.join(', ')})`);
  }

  if (block?.kind === KINDS.ENTRY || block?.kind === KINDS.FILTER || block?.kind === KINDS.EXIT) {
    require(ALL_DIRECTIONS.includes(block?.direction),
      `${block?.kind} blocks must declare direction (one of: ${ALL_DIRECTIONS.join(', ')})`);
  }

  require(typeof block?.declaredParams === 'function', 'block.declaredParams must be a function');
  require(typeof block?.indicatorDeps === 'function',  'block.indicatorDeps must be a function');

  if (block?.kind === KINDS.SIZING) {
    require(typeof block?.computeSize === 'function', 'sizing block must implement computeSize');
  } else {
    require(typeof block?.prepare === 'function', 'block.prepare must be a function');
    require(typeof block?.onBar === 'function',   'block.onBar must be a function');
  }

  // Pine template is mandatory for blocks that show up in the alerting indicator
  const needsPine = block?.kind === KINDS.ENTRY ||
                    block?.kind === KINDS.FILTER ||
                    block?.kind === KINDS.REGIME;
  if (needsPine) {
    require(typeof block?.pineTemplate === 'function',
      `${block?.kind} blocks must implement pineTemplate (entry-alert Pine codegen)`);
  }

  // Validate declaredParams shape
  if (typeof block?.declaredParams === 'function') {
    let params;
    try { params = block.declaredParams(); } catch (e) { errs.push(`declaredParams() threw: ${e.message}`); }
    if (Array.isArray(params)) {
      const seen = new Set();
      for (const p of params) {
        if (!p || typeof p.id !== 'string' || p.id.length === 0) {
          errs.push('each declared param needs a non-empty string id');
          continue;
        }
        if (seen.has(p.id)) errs.push(`duplicate param id within block: ${p.id}`);
        seen.add(p.id);
        if (!PARAM_TYPES.has(p.type)) errs.push(`param ${p.id}: type must be 'int' or 'float'`);
        if (typeof p.min !== 'number' || typeof p.max !== 'number' || typeof p.step !== 'number') {
          errs.push(`param ${p.id}: min/max/step must be numbers`);
        } else if (p.min >= p.max) {
          errs.push(`param ${p.id}: min (${p.min}) must be < max (${p.max})`);
        } else if (p.step <= 0) {
          errs.push(`param ${p.id}: step (${p.step}) must be > 0`);
        }
      }
    } else {
      errs.push('declaredParams() must return an array');
    }
  }

  if (errs.length) {
    throw new Error(`Invalid block "${block?.id ?? '(unknown)'}" v${block?.version ?? '?'}:\n  - ${errs.join('\n  - ')}`);
  }
}

/**
 * Fully-qualified param id used by the GA genome.
 * Format: `<blockId>.<instanceId>.<localParamId>`.
 */
export function qualifyParamId(blockId, instanceId, localParamId) {
  return `${blockId}.${instanceId}.${localParamId}`;
}

/**
 * Parse a qualified param id back into its parts.
 * Returns null if the id isn't in the expected shape.
 */
export function parseParamId(qid) {
  const parts = qid.split('.');
  if (parts.length < 3) return null;
  // Block ids and instance ids are single tokens; any extra dots belong to
  // the local param id (rare but allowed).
  const [blockId, instanceId, ...rest] = parts;
  return { blockId, instanceId, localParamId: rest.join('.') };
}
