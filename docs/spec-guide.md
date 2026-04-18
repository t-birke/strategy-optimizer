# Strategy Spec Author's Guide

> Audience: someone authoring a new strategy spec, or building a new block to plug into an existing spec. Assumes you've read this codebase's `README` once.

This guide explains the *generic strategy screener* framework end-to-end:

1. The mental model — what a "spec" is and what it is not.
2. The slot architecture — what each slot does and how blocks fill them.
3. A walk-through of every section of a spec file.
4. A complete real-world spec, line by line.
5. How blocks work (anatomy + a worked example).
6. The runtime — what happens at each bar.
7. Constraints, walk-forward, regime stratification, fitness.
8. Common patterns and gotchas.

---

## 1. The mental model

A **spec** is a JSON file that describes ONE strategy as a wiring diagram of reusable building blocks ("blocks"). The optimizer picks block parameter values; the runtime executes the wiring bar-by-bar.

A spec describes **only the strategy logic**. It says nothing about:

- Which symbol to trade — that's a runtime arg.
- Which timeframe to backtest on — that's a runtime arg.
- Which date range to use — that's a runtime arg.

That's the central design choice. One spec, run against many `(symbol, baseTfMin, dateRange)` triplets, gives you a **portfolio-grade screen** instead of a one-off backtest.

A spec contains five kinds of slot:

| Slot       | What it answers                                | Required?       |
|------------|------------------------------------------------|-----------------|
| `regime`   | "What kind of market are we in right now?"     | Optional (recommended) |
| `entries`  | "Should we be opening a position right now?"   | Required (≥1 block) |
| `filters`  | "If yes, is it actually allowed?"              | Optional        |
| `exits`    | "When should we get out?"                      | At least one of `hardStop`/`target`/`trail` |
| `sizing`   | "How big should the position be?"              | Required        |

A **block** is a self-contained module that fills one of those slots. Blocks are versioned. The same block can be used multiple times in one spec by giving each instance a unique `instanceId`.

---

## 2. The slot architecture

### regime (one block, optional)

Outputs a *label string per bar* describing what the market is doing — `"bull"`, `"chop"`, `"bear"`, `"trending-up"`, `"high-vol"`, etc. The set of labels is decided BY THE BLOCK, not the spec.

The runtime records the label at entry time, then at the end of the run computes per-regime PF, win rate, and trade count. The fitness function uses this for **regime stratification**: a strategy that prints PF=2.5 overall but PF=0.3 in `"bear"` regime gets penalized for being fragile.

The regime block does **not** itself gate entries. If you want regime-based gating, write a `filter` block that reads the regime label.

### entries (≥1 block, required)

Each entry block answers per-bar: *"Do I, personally, want to be long? Short?"* by returning `{ long: 0|1, short: 0|1 }`.

The spec aggregates the votes via `entries.mode`:

- **`"score"`** — sum the votes; pass if sum ≥ `threshold`. Use this for "majority of confirmations" entries (the JM 3TP style: stoch crossing + EMA trend + bollinger squeeze breakout).
- **`"all"`** — every direction-eligible block must vote yes. Use this for "all confirmations required".
- **`"any"`** — any single block voting yes is enough. Use this for "fire on any of these signals".

Each entry block also declares a `direction`: `long` / `short` / `both`. A `long`-only block contributes only to the long score; a `both` block contributes to both sides.

### filters (≥0 blocks, optional)

Filters return per-bar booleans `{ long: bool, short: bool }`: *"Is a long entry permitted right now? A short entry?"*. They don't generate signals, they veto them.

Aggregation modes mirror entries:

- **`"all"`** (default) — every direction-eligible filter must permit; one veto blocks. This is what you usually want.
- **`"any"`** — at least one filter must permit. Rare; mostly useful for OR-of-permissions.
- **`"score"`** — count permits ≥ threshold. Used for "soft" filters where you want N-of-M.

Typical filters: session-of-day filter, volatility-floor filter, volume-surge filter, HTF-trend filter ("only longs when daily EMA50 > EMA200").

### exits (3 slots, ≥1 filled)

Exit blocks fill one of three named slots, each independently:

| Slot       | Purpose                                                    | Typical block          |
|------------|------------------------------------------------------------|------------------------|
| `hardStop` | Capital protection. Hard SL, ESL, "wrong-side" close.     | `atrHardStop`          |
| `target`   | Banking profit. Single TP, scale-out at multiple TPs.     | `atrScaleOutTarget`    |
| `trail`    | Letting winners run. Trailing MA, chandelier, structural. | `maTrail`, `structuralExit` |

The runtime evaluates them in order **hardStop → target → trail** every bar. A "close-everything" action from any slot ends the bar's evaluation; a "close-one-tranche" action (from the target slot, when scaling out) does NOT — other slots still get to fire on the same bar.

A spec needs **at least one** filled exit slot, otherwise positions only ever close on the last bar of data ("End" signal) and the metrics are useless.

### sizing (one block, required)

Called once at position open. Receives an **enriched context** (see below) and returns position size in asset units. Sizing blocks can optionally declare `sizingRequirements()` — if `stopDistance` is required but the spec has no hardStop block that implements `planStop()`, the spec validator rejects the spec at load time.

#### Sizing context

Every sizing block sees:

| Field | Meaning |
|---|---|
| `i` | base bar index of the entry fill |
| `fillPrice` | actual entry price (after slippage) |
| `equity` | account equity at fill time |
| `initialCapital` | starting equity |
| `leverage` | leverage cap from runtime opts |
| `isLong` | direction of the entry |
| `bundle`, `indicators` | data/indicator refs for custom calculations |
| `stats` | `{ tradeCount, wins, losses, winRate, avgWin, avgLoss, biggestWin, biggestLoss, currentStreak:{kind,length}, lastTradePnl, netEquityMultiple }` — running counters updated after every closed trade |
| `stopPrice`, `stopDistance` | present iff the active hardStop block implements `planStop()` and returned a valid plan at this entry |
| `equityCurve` | `[{ts, equity}, ...]` sampled at each closed trade — present iff the sizing block declares `'equityCurve'` in its requirements |

#### Built-in sizing blocks

All of these live under `engine/blocks/library/sizing/`:

| Block | What it does | Key params | Requires |
|---|---|---|---|
| `flat` | Fixed dollar amount per trade | `amountUsd` | — |
| `pctOfEquity` | % of current equity (compounds) | `pct` | — |
| `atrRisk` | Van Tharp — risk %Eq per trade, sized to SL distance | `riskPct`, `useInitialCapital` | `stopDistance` |
| `martingale` | Escalate after losing streak, capped | `basePct`, `stepMult`, `maxMult` | `tradeStats` |
| `antiMartingale` | Escalate after winning streak, capped | `basePct`, `stepMult`, `maxMult` | `tradeStats` |
| `kelly` | Kelly-fraction sized to running edge | `fraction`, `maxFraction`, `minTrades`, `warmupPct` | `tradeStats` |
| `fixedFractional` | Ralph Vince — anchor to biggest historical loss | `f`, `minWorstLoss` | `tradeStats` |
| `equityCurveTrading` | Meta-sizing: on/off based on equity-vs-MA | `basePct`, `onPct`, `offPct`, `maLen`, `minTrades` | `tradeStats`, `equityCurve` |

Rules of thumb:

- **Start with `atrRisk`** for any strategy that has a defined SL. It's the most universally defensible sizing.
- **`pctOfEquity`** is fine when you're comparing strategies head-to-head and want compounding to matter.
- **`flat`** is best for "how does this strategy look with no compounding noise?" diagnostics.
- **`martingale` / `antiMartingale`** only make sense when the underlying strategy has known serial dependence (streaks mean something). Optimizer WILL find the sweet spot, but test robustness aggressively — these are fragile.
- **`kelly`** is theoretically optimal but needs `minTrades` ≥ ~30 before its estimates stabilize.
- **`equityCurveTrading`** is a "turn the strategy off during drawdowns" meta-sizer. Powerful on slow-timeframe strategies with clear good/bad periods; noisy garbage on high-frequency ones.

---

## 3. Walk-through of a spec file

```jsonc
{
  // ── Identity ──────────────────────────────────────────
  "name":        "20260414-001-jm-simple-3tp-legacy",
  "description": "Legacy JM Simple 3TP ported into composable framework",
```

The `name` is the canonical identifier and **must** match `YYYYMMDD-<numeric id>-<kebab-case short name>`. Keep the date when you create it; bump the numeric id if you create multiple specs in one day; the short name is for humans. The validator rejects anything else.

The spec also gets a `.hash` (SHA-256 of canonicalized JSON) attached at load time. Two specs with logically identical content always hash the same regardless of key order or whitespace.

```jsonc
  // ── Regime classifier ─────────────────────────────────
  "regime": {
    "block":      "htfTrendRegime",
    "version":    1,
    "instanceId": "trend",
    "params": {
      "maPeriod": { "value": 200 }
    }
  },
```

A block reference has four parts:
- `block` — the registered id (e.g., `"htfTrendRegime"`).
- `version` — pinned integer; the registry stores multiple versions in parallel so old specs keep working when a block's semantics change.
- `instanceId` — unique per slot. Used to namespace param ids in the genome (`htfTrendRegime.trend.maPeriod`). Pattern: `^[a-z0-9_-]+$`.
- `params` — per-param overrides (see "Param modes" below).

```jsonc
  // ── Entry signals ─────────────────────────────────────
  "entries": {
    "mode":      "score",
    "threshold": { "min": 1, "max": 3, "step": 1 },
    "blocks": [
      {
        "block":      "stochCross",
        "version":    1,
        "instanceId": "main",
        "params": {
          "stochLen":  { "min": 5, "max": 40, "step": 1 },
          "stochSmth": { "min": 1, "max": 8,  "step": 1 }
        }
      },
      {
        "block":      "emaTrend",
        "version":    1,
        "instanceId": "main",
        "params": {
          "emaFast": { "min": 3,   "max": 50,  "step": 1 },
          "emaSlow": { "min": 100, "max": 250, "step": 1 }
        }
      },
      {
        "block":      "bbSqueezeBreakout",
        "version":    1,
        "instanceId": "main",
        "params": {
          "bbLen":  { "min": 10, "max": 50,  "step": 1 },
          "bbMult": { "min": 1.0, "max": 3.0, "step": 0.1 }
        }
      }
    ]
  },
```

Three entry blocks, all in `"score"` mode. With `threshold` ranging `[1, 3]`, the GA is also tuning the strictness — a value of 1 means "any block firing is enough", 3 means "all three must agree".

```jsonc
  // ── Filters ───────────────────────────────────────────
  "filters": {
    "mode": "all",
    "blocks": [
      { "block": "volumeFilter", "version": 1, "instanceId": "vol",
        "params": { "minMultiple": { "min": 1.0, "max": 3.0, "step": 0.1 } } }
    ]
  },
```

One filter: bar must have ≥`minMultiple`× the rolling-average volume. With `mode: "all"`, this filter is a hard veto. If you wanted it to be optional, you'd flip to `"score"` with `threshold` 0 or 1 and add more filters.

```jsonc
  // ── Exits ─────────────────────────────────────────────
  "exits": {
    "hardStop": {
      "block": "atrHardStop", "version": 1, "instanceId": "sl",
      "params": {
        "atrLen":   { "min": 5,  "max": 50, "step": 1 },
        "atrMult":  { "min": 1.0, "max": 5.0, "step": 0.1 },
        "emergencyPct": { "value": 25 }
      }
    },
    "target": {
      "block": "atrScaleOutTarget", "version": 1, "instanceId": "tp",
      "params": {
        "tp1Mult": { "min": 0.5, "max": 3.0, "step": 0.1 },
        "tp2Mult": { "min": 1.0, "max": 5.0, "step": 0.1 },
        "tp3Mult": { "min": 2.0, "max": 8.0, "step": 0.1 },
        "tp1Pct":  { "min": 10,  "max": 50, "step": 5 },
        "tp2Pct":  { "min": 10,  "max": 50, "step": 5 }
      }
    },
    "trail": {
      "block": "structuralExit", "version": 1, "instanceId": "struct",
      "params": {
        "maxBars": { "min": 20, "max": 200, "step": 10 }
      }
    }
  },
```

All three exit slots filled. The hardStop has an emergency-SL-pct param **pinned** to `25` — the GA won't touch it. The target uses ATR-based scale-outs (tp1/tp2/tp3 in ATR multiples, tp1/tp2 percentages of the position closed at each tier; tp3 takes the remainder). The trail block here is a structural exit with a max-bars cap.

```jsonc
  // ── Sizing ────────────────────────────────────────────
  "sizing": {
    "block": "atrRiskSizing", "version": 1, "instanceId": "main",
    "params": {
      "riskPct": { "min": 0.5, "max": 5.0, "step": 0.5 }
    }
  },
```

Risk per trade as a percentage of equity. Sized to the SL distance from the hardStop slot — meaning sizing and hardStop are coupled and both consume the same ATR. (Each block computes its own ATR independently, but they dedupe via the indicator cache so it's only computed once.)

```jsonc
  // ── Cross-block constraints ───────────────────────────
  "constraints": [
    { "lhs": "emaTrend.main.emaFast", "op": "<",
      "rhs": "emaTrend.main.emaSlow", "repair": "clamp-rhs" },

    { "lhs": "atrScaleOutTarget.tp.tp1Mult", "op": "<",
      "rhs": "atrScaleOutTarget.tp.tp2Mult" },

    { "lhs": "atrScaleOutTarget.tp.tp2Mult", "op": "<",
      "rhs": "atrScaleOutTarget.tp.tp3Mult" }
  ],
```

Constraints prevent the GA from generating nonsense like `emaFast=200, emaSlow=50`. They reference parameters by their fully-qualified id (`<blockId>.<instanceId>.<paramId>`).

The `repair` field tells the constraint enforcer which side to nudge:
- `"clamp-lhs"` (default) — when the constraint is violated, modify the LHS to satisfy.
- `"clamp-rhs"` — modify the RHS instead. Useful when you want one side anchored.

```jsonc
  // ── Fitness ───────────────────────────────────────────
  "fitness": {
    "weights": { "pf": 0.5, "dd": 0.3, "ret": 0.2 },
    "caps":    { "pf": 4.0, "ret": 2.0 },
    "gates":   {
      "minTradesPerWindow": 30,
      "worstRegimePfFloor": 1.0,
      "wfeMin":             0.5
    }
  },

  // ── Walk-forward harness ──────────────────────────────
  "walkForward": { "nWindows": 5, "scheme": "anchored" }
}
```

Fitness:
- `weights` — relative importance of profit factor / drawdown / return. Should sum to 1.
- `caps` — saturate normalized values so a 10× PF outlier doesn't drown out drawdown/return signal.
- `gates` — hard rejection criteria: a strategy with fewer than 30 trades in any walk-forward window, or PF<1 in its worst regime, or walk-forward efficiency below 0.5, gets fitness=0.

Regime gate sample floor: only regimes with **≥ 5 trades** contribute to the worst-regime PF gate (`MIN_REGIME_SAMPLE` in `optimizer/fitness.js`). A 2-trade "bear" regime can't kill an otherwise strong gene. If *no* regime has enough samples, the gate is skipped rather than failing open or closed.

Walk-forward:
- `nWindows: 5` — five refit windows.
- `scheme: "anchored"` — IS window grows from one start point (vs. `"rolling"` = fixed-width sliding).

The shipped params come from the **full-data** fit. The walk-forward refits act as a **robustness gate** — they tell the optimizer "this strategy isn't just data-snooped".

**WF-aware regime gating.** When a walk-forward report is piped into `computeFitness`, the per-window OOS `regimeBreakdown`s are *pooled* (summing `grossProfit`/`grossLoss`, not averaging ratios) and the worst-regime gate is evaluated on the pooled OOS stats instead of the full-data breakdown. This catches genes that look fine on the full training set but have a losing regime in the OOS slices. The result exposes `breakdown.regimeSource = "wf-oos-pooled" | "full-data"` so you can see which source the gate actually used.

---

## 4. A complete real-world spec

```jsonc
// strategies/20260414-001-jm-simple-3tp-legacy.json
{
  "name": "20260414-001-jm-simple-3tp-legacy",
  "description": "Direct port of the JM Simple 3TP strategy — used as the migration-gate parity reference.",

  "regime": {
    "block": "htfTrendRegime", "version": 1, "instanceId": "trend",
    "params": { "tf": { "value": "weekly" }, "maPeriod": { "value": 200 } }
  },

  "entries": {
    "mode": "score",
    "threshold": { "value": 1 },
    "blocks": [
      { "block": "stochCross",        "version": 1, "instanceId": "main",
        "params": {
          "stochLen":  { "min": 5,  "max": 40, "step": 1 },
          "stochSmth": { "min": 1,  "max": 8,  "step": 1 }
        } },
      { "block": "emaTrend",          "version": 1, "instanceId": "main",
        "params": {
          "emaFast": { "min": 3,   "max": 50,  "step": 1 },
          "emaSlow": { "min": 100, "max": 250, "step": 1 }
        } },
      { "block": "bbSqueezeBreakout", "version": 1, "instanceId": "main",
        "params": {
          "bbLen":     { "min": 10, "max": 60,  "step": 1 },
          "bbMult":    { "min": 1.0,"max": 3.0, "step": 0.1 },
          "squeezePctile": { "value": 25 },
          "lookbackBars":  { "value": 3 }
        } }
    ]
  },

  "filters": { "mode": "all", "blocks": [] },

  "exits": {
    "hardStop": { "block": "atrHardStop", "version": 1, "instanceId": "sl",
      "params": {
        "atrLen":       { "min": 5,  "max": 50, "step": 1 },
        "atrMult":      { "min": 1.0,"max": 5.0,"step": 0.1 },
        "breakevenAfterTp1": { "value": true },
        "breakevenBufferPct": { "value": 0.3 },
        "emergencyPct":      { "value": 25 }
      } },

    "target":   { "block": "atrScaleOutTarget", "version": 1, "instanceId": "tp",
      "params": {
        "tp1Mult": { "min": 0.5, "max": 3.0, "step": 0.1 },
        "tp2Mult": { "min": 1.0, "max": 5.0, "step": 0.1 },
        "tp3Mult": { "min": 2.0, "max": 8.0, "step": 0.1 },
        "tp1Pct":  { "min": 10,  "max": 60,  "step": 5 },
        "tp2Pct":  { "min": 10,  "max": 60,  "step": 5 }
      } },

    "trail":    { "block": "structuralExit", "version": 1, "instanceId": "struct",
      "params": {
        "maxBars":           { "min": 20, "max": 200, "step": 10 },
        "rsiExitLevel":      { "value": 40 },
        "rsiHistoryLookback":{ "value": 3 },
        "rsiHistoryLevel":   { "value": 55 },
        "stochExitLevel":    { "value": 60 },
        "allowReversal":     { "value": true }
      } }
  },

  "sizing": {
    "block": "atrRiskSizing", "version": 1, "instanceId": "main",
    "params": { "riskPct": { "min": 0.5, "max": 5.0, "step": 0.5 } }
  },

  "constraints": [
    { "lhs": "emaTrend.main.emaFast",        "op": "<", "rhs": "emaTrend.main.emaSlow",        "repair": "clamp-rhs" },
    { "lhs": "atrScaleOutTarget.tp.tp1Mult", "op": "<", "rhs": "atrScaleOutTarget.tp.tp2Mult" },
    { "lhs": "atrScaleOutTarget.tp.tp2Mult", "op": "<", "rhs": "atrScaleOutTarget.tp.tp3Mult" }
  ],

  "fitness": {
    "weights": { "pf": 0.5, "dd": 0.3, "ret": 0.2 },
    "caps":    { "pf": 4.0, "ret": 2.0 },
    "gates":   { "minTradesPerWindow": 30, "worstRegimePfFloor": 1.0, "wfeMin": 0.5 }
  },

  "walkForward": { "nWindows": 5, "scheme": "anchored" }
}
```

This is what the **migration gate** spec will look like — when the runtime, fed this spec, produces the same trade list (within rounding) as the legacy `engine/strategy.js`, we know the framework is faithful.

### Param modes

Every entry under a block's `params` is one of three forms:

| Form                    | Meaning                                                        |
|-------------------------|----------------------------------------------------------------|
| `{ "min": N, "max": N, "step": N }` | GA-optimized within this **sub-range** (must fit inside the block's declared range). |
| `{ "value": N }`        | **Pinned** literal — excluded from the genome entirely.        |
| (omitted key)           | GA-optimized over the block's full declared range.             |

The validator rejects narrowed ranges that escape the block's declared bounds (e.g., a block declares `period: 5..200`, the spec asks for `period: 1..200` — fail) or steps that aren't multiples of the block's step.

---

## 5. How blocks work

A block is just a JS module. Look at `engine/blocks/contract.js` for the canonical typedefs. Here's the anatomy with a worked example.

### The contract

```js
{
  id:        'stochCross',     // unique within registry per (id, version)
  version:   1,                // bump if you change semantics
  kind:      'entry',          // entry | filter | regime | exit | sizing
  direction: 'both',           // long | short | both — required for entry/filter/exit

  // --- Static metadata ---
  declaredParams() { return [ { id, type, min, max, step }, ... ]; },
  indicatorDeps(params) { return [ { key, tf, indicator, source?, args? }, ... ]; },
  constraints?(params)  { return [ { lhs, op, rhs, repair? }, ... ]; },

  // --- Per-run setup (called once before the bar loop) ---
  prepare(bundle, params, indicatorCache, state) {
    // Pull indicator refs out of the cache and stash on `state` for
    // O(1) per-bar access in the hot loop.
    state.k = indicatorCache.get('base:sma:stoch:14:3');
    state.d = indicatorCache.get('base:sma:stoch:14:3:smoothed');
  },

  // --- Per-bar work (the hot loop) ---
  onBar(bundle, i, state, params /*, position — only for exit blocks */) {
    // Return shape depends on `kind` — see below.
  },

  // --- Optional: PineScript codegen for entry/filter/regime blocks ---
  pineTemplate(params, paramRefs) {
    // paramRefs maps param id → pine input variable name
    return `
      stochK = ta.sma(ta.stoch(close, high, low, ${paramRefs.stochLen}), ${paramRefs.stochSmth})
      stochD = ta.sma(stochK, ${paramRefs.stochSmth})
      longSig  = ta.crossover(stochK, stochD)  and stochK < 40
      shortSig = ta.crossunder(stochK, stochD) and stochK > 60
    `;
  }
}
```

### Return shapes by kind

```
entry:   { long: 0|1, short: 0|1 }
filter:  { long: bool, short: bool }
regime:  string | null
exit:    null
       | { action: 'closeIntraBar',   fillPrice, signal }    // limit/stop with KNOWN price
       | { action: 'closeMarket',     fillPrice, signal }    // intra-bar market — block applies own slippage
       | { action: 'closeNextBarOpen', signal }              // deferred to next bar's open + market slippage
       | { action: 'closeSubs', closes: [{ subIndex, fillPrice, signal }] }
sizing:  number — asset units (called via computeSize, not onBar)
```

### A worked example: an entry block

```js
// engine/blocks/library/stoch-cross.js
import { register } from '../registry.js';
import { KINDS, DIRECTIONS } from '../contract.js';
import { sma, stoch, crossover, crossunder } from '../../indicators.js';

register({
  id: 'stochCross', version: 1,
  kind: KINDS.ENTRY, direction: DIRECTIONS.BOTH,

  declaredParams() {
    return [
      { id: 'stochLen',  type: 'int', min: 5,  max: 40, step: 1 },
      { id: 'stochSmth', type: 'int', min: 1,  max: 8,  step: 1 },
      { id: 'longLevel', type: 'int', min: 10, max: 50, step: 1, default: 40 },
      { id: 'shortLevel',type: 'int', min: 50, max: 90, step: 1, default: 60 },
    ];
  },

  // Tell the indicator cache what we need. The `key` is the dedup handle —
  // two blocks asking for `base:stoch:14` share one Float64Array.
  indicatorDeps(params) {
    return [
      { key: `base:stoch:${params.stochLen}`,
        tf: 'base', indicator: 'stoch', args: { period: params.stochLen } },
    ];
  },

  prepare(bundle, params, cache, state) {
    const stochRaw = cache.get(`base:stoch:${params.stochLen}`);
    // smoothed K and D — computed once at prepare time
    state.k = sma(stochRaw, params.stochSmth);
    state.d = sma(state.k, params.stochSmth);
    // pre-compute crossover boolean arrays so onBar is O(1)
    state.crossUp   = crossover(state.k, state.d);
    state.crossDown = crossunder(state.k, state.d);
  },

  onBar(_bundle, i, state, params) {
    return {
      long:  (state.crossUp[i]   && state.k[i] < params.longLevel)  ? 1 : 0,
      short: (state.crossDown[i] && state.k[i] > params.shortLevel) ? 1 : 0,
    };
  },

  pineTemplate(_params, refs) {
    return `
      _k = ta.sma(ta.stoch(close, high, low, ${refs.stochLen}), ${refs.stochSmth})
      _d = ta.sma(_k, ${refs.stochSmth})
      longSig_${refs.__instanceId}  = ta.crossover(_k,  _d) and _k < ${refs.longLevel}
      shortSig_${refs.__instanceId} = ta.crossunder(_k, _d) and _k > ${refs.shortLevel}
    `;
  },
});
```

Things to notice:

1. **`prepare()` does heavy lifting once.** All vectorized array work (smoothing, crossovers) happens up-front. `onBar` is just typed-array reads — that's how we keep the inner loop cache-friendly.
2. **`indicatorDeps()` is the dedup key.** If `stochCross` and `stochExit` both ask for `base:stoch:14`, the cache computes it once and both blocks read the same Float64Array.
3. **No lookahead.** `onBar(bundle, i, ...)` may only read `bundle.base.close[j]` for `j ≤ i` and same for any indicator array. Breaking this makes the strategy unbacktest-able in live mode AND untranslatable to Pine. The runtime trusts blocks here; we'll add a lookahead-detection harness as a CI check later.
4. **`pineTemplate()` is required for entry/filter/regime blocks.** Every tuned strategy must be exportable to a TradingView indicator that fires entry alerts. If a block can't express its logic in Pine, it can't be in the screener.

### Multi-instance blocks

Same block id, different `instanceId`s:

```jsonc
"entries": {
  "mode": "all",
  "blocks": [
    { "block": "emaCross", "version": 1, "instanceId": "fast",
      "params": { "shortLen": { "value": 5  }, "longLen": { "value": 21 } } },
    { "block": "emaCross", "version": 1, "instanceId": "slow",
      "params": { "shortLen": { "value": 50 }, "longLen": { "value": 200 } } }
  ]
}
```

Two `emaCross` instances with different parameter values, both must fire (mode=all). Param ids in the genome become `emaCross.fast.shortLen` and `emaCross.slow.shortLen` — no collision.

### HTF blocks

If a block needs higher-timeframe data, it declares the TF in its `indicatorDeps`:

```js
indicatorDeps(params) {
  return [
    { key: `weekly:ema:close:${params.maPeriod}`,
      tf: 'weekly', indicator: 'ema', args: { period: params.maPeriod } },
  ];
},
```

Then in `onBar`, it maps the base bar index to the right HTF bar:

```js
onBar(bundle, i, state, params) {
  const htf = bundle.htfs[10080];                        // 10080 min = weekly
  const j   = htf.htfBarIndex[i];                        // last-closed weekly bar at base bar i
  if (j === 0xFFFFFFFF) return null;                     // no weekly bar closed yet
  const wEma = state.weeklyEma[j];
  return wEma > htf.close[j] ? 'bull' : 'bear';
}
```

`htfBarIndex[i]` returns the index of the most recent fully-closed HTF bar at base bar `i`'s timestamp — exactly what Pine's `request.security(..., barmerge.lookahead_off)` does. The sentinel `HTF_NONE = 0xFFFFFFFF` means "no HTF bar has closed yet"; blocks must guard against it during warmup.

---

## 6. The runtime — what happens at each bar

Once the spec is loaded, the param space is built, and a gene is generated, the runtime (`engine/runtime.js`) does this for each bar `i`:

```
1. pendingClose? → close all subs at this bar's open ± slippage, record trades
2. pendingEntry? → call sizing block, open position at this bar's open ± slippage,
                   call optional onPositionOpen hooks (e.g. target sets up tranches)
3. evaluate regime block → record label
4. if position open:
     for slot in [hardStop, target, trail]:
       call exit block onBar(...)
       handle the returned action:
         null                → next slot
         closeIntraBar/Market → close all subs at fillPrice, exit slot loop
         closeNextBarOpen     → set pendingClose, exit slot loop
         closeSubs            → close named tranches at their fillPrices,
                                continue to next slot
5. if flat OR (open with pendingClose queued for reversal):
     run filter aggregation        → { long, short } booleans
     run entry  aggregation        → { long, short } booleans
     intersect; long takes precedence on ties
     if reversal-eligible, only queue if direction OPPOSES open position
     set pendingEntry
6. mark-to-market the open position into mtm, update peakEquity & maxDD
```

At the end of all bars, any open position is force-closed at the last bar's close with signal `"End"`.

### Pine-parity quirks the runtime preserves

- **Next-bar-open fills.** Both entries and "deferred" exits (`closeNextBarOpen`) fill at the next bar's open, mirroring `strategy.entry()` and `strategy.close()` in Pine.
- **2-tick × $0.01 slippage** on market fills (entries, market closes); none on limit fills (`closeIntraBar` with a known price like a TP).
- **0.06% commission** per side.
- **2-step SL deferral** for close-based stops is implemented by the SL block itself: it tracks an internal `triggered` flag, returns null on bar `i` (detection), then `closeNextBarOpen` on bar `i+1`. The runtime fills on bar `i+2`'s open. This matches Pine's `slTriggered := close < slPrice` pattern exactly.
- **Equity floor at zero** — bankruptcy is permanent; no further trades after the account zeroes.

### Sub-positions (tranches)

Every position starts with a single sub holding the full size. Target blocks that scale out (e.g., `atrScaleOutTarget`) implement `onPositionOpen(position, params, state, ctx)` to **replace** `position.subs` with N tranches:

```js
onPositionOpen(position, params, state, ctx) {
  const total = position.subs[0].units;
  const u1 = total * params.tp1Pct / 100;
  const u2 = total * params.tp2Pct / 100;
  const u3 = total - u1 - u2;
  position.subs = [
    { units: u1, closed: false, meta: { tag: 'TP1', tpPrice: ctx.fillPrice + atr * params.tp1Mult } },
    { units: u2, closed: false, meta: { tag: 'TP2', tpPrice: ctx.fillPrice + atr * params.tp2Mult } },
    { units: u3, closed: false, meta: { tag: 'TP3', tpPrice: ctx.fillPrice + atr * params.tp3Mult } },
  ];
},
```

Then in `onBar`, the block returns `closeSubs` actions referencing tranche indices:

```js
onBar(bundle, i, state, params, position) {
  const closes = [];
  for (let s = 0; s < position.subs.length; s++) {
    const sub = position.subs[s];
    if (sub.closed) continue;
    if (bundle.base.high[i] >= sub.meta.tpPrice) {
      closes.push({ subIndex: s, fillPrice: sub.meta.tpPrice, signal: sub.meta.tag });
    }
  }
  return closes.length ? { action: 'closeSubs', closes } : null;
},
```

The runtime applies them, and once all subs are closed it transitions the position to flat naturally.

---

## 7. Constraints, walk-forward, regime stratification, fitness

### Constraints

Cross-param ordering rules. Operators: `<`, `<=`, `>`, `>=`, `!=`. RHS is either another qualified param id or a numeric literal. Repair modes:

- **`"clamp-lhs"`** (default): violator clamps toward satisfying the constraint by one step, then is re-clamped to its declared `[min, max]`.
- **`"clamp-rhs"`**: same but the OTHER side moves. Useful when one parameter is "anchor" and the other should yield.

A pinned param that's referenced in a constraint where the other side is also pinned/literal is rejected as inert by the validator.

### Walk-forward

Configured via `walkForward: { nWindows, scheme }`:

- `nWindows: 5` — five OOS validation windows.
- `scheme: "anchored"` — IS window starts at the beginning of data and grows. OOS window is the chunk immediately after.
- `scheme: "rolling"` — IS window is a fixed width that slides forward.

The optimizer fits on the **full** data; the walk-forward refits act as a *robustness gate*. The reported metric is **walk-forward efficiency (WFE)** = `mean(OOS_PF) / IS_PF`. A WFE near 1.0 means the strategy generalizes; near 0 means it's data-snooped.

### Regime stratification

The runtime records the regime label at entry time and tallies per-regime trade count, win rate, PF, and `grossProfit`/`grossLoss`. The fitness function uses `worstRegimePfFloor` as a hard gate — a strategy with PF=0.4 in `"high-vol"` regime fails even if its overall PF is 2.0.

**Sample-size floor.** A regime must have at least `MIN_REGIME_SAMPLE` (= 5) trades before its PF counts toward the gate. A 2- or 3-trade regime PF is pure randomness and gets ignored. If *no* regime has enough samples, the gate is skipped.

**WF-aware gating.** When a walk-forward report is supplied to `computeFitness`, the per-window OOS `regimeBreakdown`s are pooled — summing `grossProfit`/`grossLoss` across windows — and the gate is evaluated on the pooled OOS stats instead of the full-data breakdown. Pooling is the mathematically correct way to get the union PF; a trade-weighted average of per-window PFs would be wrong because PF is a ratio. The result exposes `breakdown.regimeSource` so UIs can show whether the gate fired on full-data or on the pooled OOS slices.

If you don't define a regime block, everything is bucketed under `"_unknown"` and the gate is effectively disabled.

### Fitness

Default weights and caps live in `engine/spec.js` as `DEFAULT_FITNESS`:

```js
{
  weights: { pf: 0.5, dd: 0.3, ret: 0.2 },
  caps:    { pf: 4.0, ret: 2.0 },
  gates:   { minTradesPerWindow: 30, worstRegimePfFloor: 1.0, wfeMin: 0.5 },
}
```

The actual fitness function (computed in `optimizer/fitness.js`, to be built in Phase 2) does:

```
norm_pf  = min(OOS_PF, caps.pf) / caps.pf
norm_dd  = 1 - OOS_maxDDPct
norm_ret = min(max(OOS_netReturn, 0), caps.ret) / caps.ret
fitness  = w_pf * norm_pf + w_dd * norm_dd + w_ret * norm_ret

if any gate fails (trade count, worst-regime PF, WFE): fitness = 0
```

Spec-level overrides let the strategy author bias the search.

---

## 8. Common patterns and gotchas

### Gotcha: pinned params can't be in genome-only constraints

If you pin `emaTrend.main.emaSlow = 200`, you can't write a constraint `emaTrend.main.emaSlow > 100`, because `emaSlow` isn't in the genome and the constraint can never be a real check. The validator rejects this.

### Gotcha: at least one filled exit slot

A spec with all three exit slots null is rejected by the validator. Otherwise positions only ever close on the last bar, and the metrics are meaningless.

### Pattern: regime that gates entries

The regime block doesn't gate entries directly. To say "only longs in bull regime", write a filter:

```js
{
  id: 'regimeGate', version: 1, kind: KINDS.FILTER, direction: DIRECTIONS.BOTH,
  declaredParams() { return []; },
  indicatorDeps()  { return []; },
  prepare(bundle, _params, _cache, state) {
    state.regime = bundle.regimeLabels;  // populated by runtime if collectRegimeLabels:true
  },
  onBar(_bundle, i, state) {
    const r = state.regime?.[i];
    return { long: r === 'bull', short: r === 'bear' };
  },
  pineTemplate() { /* ... */ },
}
```

Currently the regime label isn't auto-exposed to filter blocks; cleanest path is for the filter block to compute its own classifier indicator (same one the regime block uses) since the indicator cache will dedupe.

### Pattern: Time stop without a hardStop

Put a "max bars held" check in your `target` slot via a `closeNextBarOpen` action. The legacy strategy did it inside the SL logic; the cleaner block decomposition is one block per concern.

### Pattern: Reversal entries

The runtime allows entry evaluation when a position is open AND a `closeNextBarOpen` action is queued, but ONLY if the new entry direction OPPOSES the current position. So you can build a "stop-and-reverse" by:

1. A trail block returning `closeNextBarOpen` when the structural exit fires.
2. Your entry blocks naturally voting for the opposite side on the same bar.

The runtime queues the close (next bar open), and on that same evaluation tick queues the opposing entry (which will fill the bar after the close). No special "reversal" API required.

### Pattern: Position-state coordination across blocks

Both `position.state` (per-position scratch) and the block's own `state` (per-instance, persistent across bars) exist. Convention: a block stashes per-position data in `position.state[block.instanceId]` so two instances of the same block never collide. Per-run state (e.g., a precomputed Float64Array) goes on the block's own state.

---

## TL;DR

- A **spec** is a JSON wiring diagram of blocks slotted into `regime / entries / filters / exits / sizing`.
- A **block** is a versioned reusable module with `declaredParams`, `indicatorDeps`, `prepare`, `onBar`, and (for entry/filter/regime) `pineTemplate`.
- The **GA** optimizes only the params of the active blocks in a spec; ranges are narrowed per-spec; values can be **pinned**.
- The **runtime** orchestrates blocks bar-by-bar, manages sub-positions for scale-outs, and preserves Pine-parity fill quirks.
- **Walk-forward** is a robustness gate, not the source of shipped params.
- **Regime stratification** rejects strategies that work on average but fail in their worst regime.
- Every shipped strategy is one-click exportable to a TradingView entry-alert indicator via the `pineTemplate` codegen.
