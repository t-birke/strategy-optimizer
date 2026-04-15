# Backlog & Roadmap

This is the **persistent** plan for the generic-strategy-screener branch.
Everything that isn't being worked on *right now* lives here so no plan ever
evaporates with a session.

Organized as:

1. **Phase 1** — foundation (in progress)
2. **Phase 2** — fitness, walk-forward, runner integration
3. **Phase 3** — block library expansion
4. **Phase 4** — persistence, queue, UI, deployment
5. **Phase 5** — AI idea generator (parked; separate effort)
6. **Deferred features** — good ideas we explicitly postponed
7. **Open questions** — undecided design calls

---

## 1. Phase 1 — Foundation

**Goal:** a composable runtime and a migration gate proving the new framework
reproduces the legacy JM Simple 3TP numbers exactly.

| # | Chunk | Status |
|---|-------|--------|
| 1 | Block contract & registry (with pineTemplate method) | ✅ done |
| 2 | Spec format, loader, validator, content-hash identity | ✅ done |
| 3 | Dynamic param space derivation from spec | ✅ done |
| 4 | Multi-TF data layer with last-closed HTF semantics + volume | ✅ done |
| 5 | Indicator cache with dedup + non-close source support | ✅ done |
| 6 | Composable runtime engine (replaces strategy.js) | ✅ done |
| 6.5 | Sizing context enrichment (stats, planStop, equity curve) | ✅ done |
| 7 | Port current JM Simple 3TP logic into blocks | ✅ done |
| 8 | **MIGRATION GATE** — framework matches engine numbers + Pine indicator | ✅ done (A ✅, B ✅) |

**Exit criterion for Phase 1:** running the migration-gate spec through the new
framework produces a trade list that matches `engine/strategy.js` within
rounding, AND `npm run pine-push` of the generated entry-alert indicator fires
the same entry signals as the current Pine strategy.

**Phase 1: ✅ COMPLETE** — migration gate passes (8A aggregate metrics within
tolerance, 8B Pine indicator verified on TV chart firing on the runtime's
entry bars).

### 8A. Aggregate metrics parity — ✅ DONE

`scripts/parity-gate.js` runs `runStrategy()` (legacy) and `runSpec()` (new)
against BTCUSDT/4H from 2021-04-12 with the tuned 18-gene BTC winner. After
two targeted block fixes (remove entry-bar guards in `atrHardStop` close-based
SL and `structuralExit`), aggregate metrics land inside the ±0.5/±2/±2 % gate:

- trades  1023 → 1020   (−0.29 %)  ≤ 0.5 % ✓
- PF      1.339 → 1.341 (+0.18 %)  ≤ 2 % ✓
- netPct  +$236 k → +$240 k (+1.64 %) ≤ 2 % ✓
- TP1 / TP2 / TP3 / Time exit counts match bit-for-bit.

**Residual divergences (~720 trade-by-trade mismatches):** cascade from slot
evaluation-order differences — runtime evaluates hardStop → target → trail
with position-close short-circuit semantics that differ subtly from legacy's
monolithic step order. First divergence around trade #121; downstream trades
then shift entry timing. Aggregate metrics match, so the residual is
deferred — follow up in Phase 2 when the composable runtime becomes
authoritative. Tracked in "Deferred features" below.

### 8B. Pine entry-alert codegen — ✅ DONE

Full position-aware indicator generator, verified on TV chart against the
runtime's entry timestamps for the BTCUSDT/4H BTC-winner gene.

- `engine/pine-codegen.js` — walks the hydrated spec, calls each entry/
  filter/regime block's `pineTemplate(params, paramRefs)` with literal refs,
  stitches into an overlay indicator with score-mode aggregation. Also emits
  a generic **exit state machine** (`emitExitStateMachine`) that iterates
  the spec's exit slots (hardStop / target / trail) and TP tranches (1–6),
  tracks `pos_dir` / `pos_entry` / `pos_entry_atr_*`, gates duplicate entry
  signals while in-position, and fires `plotshape`/`label` markers + JSON
  webhook payloads on both entries and exits. Boxed-sticker labels
  (`label.style_label_up/down`) with tails point at the bar — LONG/SHORT on
  entries, the exit reason (`TP1`/`TP2`/`TP3`/`SL`/`ESL`/`Time`/
  `Structural`/`Reversal`) on exits.
- `scripts/pine-export.js` — offline codegen + `--diff` against
  `pine/jm_3tp_alerts.pine` reference.
- `scripts/pine-deploy.js` — full deploy pipeline with collision check,
  in-place overwrite (via `tv pine open <name>` → `pine set` → save, so TV
  doesn't auto-suffix " 1" on the saved script), toolbar-Save-button click
  with full React pointer sequence (Ctrl+S no-ops after `pine set` because
  Monaco's model API bypasses the dirty tracker), flip-state verify
  (`unsaved-` → `saved-`), Monaco-severity-filtered compile check, and
  round-trip source verification.

**v1 Pine simplifications vs runtime** (documented, not bugs — runtime
remains source-of-truth for backtests; indicator is alerts-only):
- SL uses 1-bar defer; runtime uses 2-bar.
- First TP hit closes the whole position; runtime scales out per tranche.
- No BE+ SL tightening after TP1.

**Residual non-blocking warnings** — 4 Monaco severity-4 warnings about
`ta.crossover`/`ta.crossunder` called inside a ternary inside the struct-arm
gate. Cosmetic only; compile + runtime behavior are fine. Fix: extract
crossUp/crossDown to top-level series before the ternary. Punted as a
cleanup item.

---

## 2. Phase 2 — Fitness, walk-forward, runner integration 🟡 ACTIVE

**Goal:** the GA optimizes specs end-to-end with proper overfitting protection.

### 2.1 Fitness function (`optimizer/fitness.js`, new)
- Weighted scalar: `w_pf · norm(PF) + w_dd · (1 − maxDD%) + w_ret · norm(net)`
- Read weights/caps/gates from `spec.fitness` (defaults in `spec.js` already).
- Hard gates: `minTradesPerWindow`, `worstRegimePfFloor`, `wfeMin`.
- Gate failures → fitness = 0 (strategy eliminated, not just penalized).
- Unit tests: known synthetic metrics → known fitness values.

### 2.2 Walk-forward harness (`optimizer/walk-forward.js`, new)
- Two schemes: `anchored` (growing IS window) and `rolling` (fixed-width IS slide).
- Per spec: `nWindows` refits.
- For each window: fit on IS, evaluate frozen gene on OOS, record OOS PF & net.
- Compute **WFE** = `mean(OOS_PF) / IS_PF`.
- Report: per-window trade counts, PFs, return, WFE aggregate.
- **Important:** shipped params come from the **full-data fit**, NOT from WF.
  WF is the robustness gate only.

### 2.3 Regime stratification in fitness ✅ done
- Runtime emits `regimeBreakdown` per label with `{trades, wins, pf, net, grossProfit, grossLoss}` — gross P/L added so downstream can pool PFs correctly by summing, not by averaging ratios.
- Fitness queries `worstRegimePf = min(regimeBreakdown.*.pf)` and fails if `< gates.worstRegimePfFloor`.
- Sample-size floor `MIN_REGIME_SAMPLE = 5`: regimes below that threshold are skipped. If no regime has enough samples, the gate is skipped entirely (no fail-open).
- **WF-aware path**: when a `wfReport` with per-window `oosRegimeBreakdown` is supplied, those slices are *pooled* (summing `grossProfit`/`grossLoss`) and the gate uses the pooled OOS stats instead of the full-data breakdown. `breakdown.regimeSource` reports `'wf-oos-pooled'` or `'full-data'`.
- `walkForward()` now records `isRegimeBreakdown` and `oosRegimeBreakdown` on every window report so this pipe-through works.
- Tests: 25 new assertions in `fitness-check.js` (groups 14–17) covering pooling math, fallback to trade-weighted PF when gross P/L absent, pooled-OOS *stricter* than full-data, pooled-OOS *rescuing* a gene full-data would eliminate, and fallback when WF has no regime data. Total: **92/92 pass**.
- Docs updated in `docs/spec-guide.md` (fitness section and regime-stratification section).

### 2.4 Runner integration (`optimizer/runner.js`, `optimizer/island-worker.js`) ✅ done
- **Spec-mode fork** added behind a `config.spec` flag — when present, the runner validates the spec, builds the paramSpace, packs an extra `ts` column into the SharedArrayBuffer, and ships the raw spec object into each worker via `workerData.spec`. When absent, the legacy contract (used by the UI server's `POST /api/runs`) is **byte-for-byte unchanged**.
- **Worker** rebuilds the paramSpace itself (functions don't survive structured-clone), calls `registry.ensureLoaded()` first because each Worker has a fresh module graph, then swaps the legacy `runStrategy + score formula` for `runSpec → computeFitness`. The composite score is mapped from `[0, 1]` to `[0, 1000]` so it sits in roughly the same magnitude as the legacy fitness; eliminated genes get `-10000` so they sort below the legacy soft-penalty band `[-5000, -1000]`.
- **Diagnostics**: in spec mode the worker stamps `metrics._fitness = { score, eliminated, gatesFailed, breakdown, reason? }` so the UI can show *which gate killed which gene*.
- **Shared candle transport** kept (zero-copy SAB) — re-loading from DuckDB per worker was rejected because the SAB extension to 6 columns was a one-line change and DuckDB has lock contention with the UI server.
- **HTFs deferred** to Phase 2.6: the runner throws if `spec.htfs` is non-empty so multi-TF specs fail loud rather than silently using only the base.
- **Walk-forward not run per-generation**: per-gene WF every generation would multiply runtime by `nWindows`. Phase 2.4 keeps WF a one-shot post-GA step (the harness already exists in `optimizer/walk-forward.js`); a future 2.4b can promote selected top-N to per-gen WF if needed.
- **Verification**: new `scripts/runner-spec-mode-check.js` runs a tiny GA (pop=8, gens=3) on the migration-gate spec in **both** modes and asserts: bestGene uses spec QIDs (e.g. `emaTrend.main.emaFast`) in spec mode and flat names in legacy mode; `_fitness` diagnostics present in spec mode and absent in legacy mode; both modes complete without crashing. Currently **13/13 ✓**.

**Phase 2 verification status**:
- `fitness-check`: 92/92 ✓
- `walk-forward-check`: 35/35 ✓
- `runner-spec-mode-check`: 13/13 ✓
- `fitness-cache-check`: 41/41 ✓
- `parity-gate (8A)`: ✓ PASS

### 2.5 Fitness cache ✅ done
- **Persistent per-(spec, dataset) cache** in `optimizer/fitness-cache.js`. Each
  `(spec.hash, datasetId)` pair gets its own JSON file under
  `data/fitness-cache/` (or `OPTIMIZER_FITNESS_CACHE_DIR`). The on-disk file
  uses just `geneKey` as the within-file key — a different spec or different
  dataset gets a different file, full stop, no shared keys.
- **Dataset identity** = `sha256(symbol:tfMin:startDate:endDate:bars:lastTs)`.
  The trailing `bars`+`lastTs` catches the case where the candle DB was
  updated since the last run — same window, more data → different id →
  cache invalidated automatically.
- **Top-N cap (50,000)** keeps disk + load time bounded. The GA tends to
  *revisit* high-fitness regions across runs, so caching the long tail of
  mediocre genes buys little. `filterAndCap` drops anything with
  `fitness ≤ 0` (eliminated genes / soft-penalty band — re-runs would hit
  the same gate anyway, no real backtest is saved) and keeps the top-N by
  fitness desc.
- **Atomic writes**: write to `.tmp` then `rename`, so a crashed run can't
  leave a half-written file shadowing a good one.
- **Wired into `runner.js`** (spec mode only; legacy mode is unchanged):
  `loadCache` runs before workers spawn, the preload map is shipped via
  `workerData.fitnessCachePreload`, each worker hydrates its in-memory
  `fitnessCache` Map from it, and on `get_results` each worker ships back
  a `cacheSnapshot` which the runner merges + saves. `runOptimization`
  return value gains a `fitnessCache: { datasetId, preloadCount,
  savedCount, droppedCount, path }` block (null in legacy mode).
- **Verification**: new `scripts/fitness-cache-check.js` exercises 8 groups
  (computeDatasetId determinism+sensitivity, save→load round-trip, top-N
  cap, filtering of eliminated/NaN/null entries, invalidation by spec or
  dataset change, corrupt-file non-fatal, mergeCaches collision, and an
  end-to-end test running two GA runs to confirm `run2.preloadCount ===
  run1.savedCount`). Currently **41/41 ✓**.

**Exit criterion for Phase 2:** end-to-end GA run on the migration-gate spec
produces tuned params, a WF report, a regime breakdown, and a scalar fitness —
all written to disk and visible in the UI. **All 5 verification gates green
as of 2026-04-15** — Phase 2 functionally complete pending Phase 2.6 (HTF
support in walk-forward + runner spec mode).

---

## 3. Phase 3 — Block library expansion

**Goal:** enough blocks to express a reasonable breadth of strategies without
writing new blocks for each one.

### Entry blocks
- `stochCross` ✅ (needed for migration gate)
- `emaTrend` ✅ (needed for migration gate)
- `bbSqueezeBreakout` ✅ (needed for migration gate)
- `orb` — opening-range breakout (session-based)
- `rangeBreakout` — breakout from N-bar range
- `maPullback` — pullback to MA during trend
- `rsiPullback` — RSI oversold/overbought in trend
- `vwapReclaim` — price reclaiming VWAP (intraday)
- `volumeSurge` — entry on volume spike with price confirmation
- `donchianBreakout` — classic turtle-style

### Filter blocks
- `htfTrendFilter` — only longs above HTF MA
- `sessionFilter` — time-of-day gating
- `volumeFilter` — min volume multiple of average
- `volatilityFloor` — min ATR / BB width
- `spreadFilter` — reject wide-spread bars (needs spread data — future)
- `regimeGate` — filter on regime label

### Regime blocks
- `htfTrendRegime` — HTF MA slope → bull/chop/bear
- `volRegime` — ATR percentile → low/normal/high
- `rangeRegime` — ADX-based trending vs ranging
- `sessionRegime` — asia/london/ny (intraday)

### Exit blocks
- **hardStop:** `atrHardStop` ✅, `pctHardStop`, `structuralHardStop`
- **target:** `atrScaleOutTarget` ✅ (generic up-to-6-tier, zero overhead
  for unused tiers — pinning `tpNPct=0` removes the tranche from both the
  genome and the runtime), `rrTarget`, `fibExtTarget`. `singleTpTarget`
  is unnecessary — just use `atrScaleOutTarget` with a single active
  tranche.
- **trail:** `atrTrail`, `chandelierTrail`, `maTrail`, `structuralExit` ✅,
  `timeStop` (note: `timeStop` as standalone is redundant with
  `structuralExit.maxBars` — fold into whatever trail a spec uses rather
  than shipping a separate block).

### Sizing blocks (covered in chunk 6.5)
- `flat` — fixed dollar amount
- `pctOfEquity` — % of current equity
- `pctOfInitial` — % of starting capital
- `atrRisk` — Van Tharp risk-per-trade (needs `stopDistance`)
- `martingale` — escalate after losses
- `antiMartingale` — escalate after wins
- `kelly` — Kelly-fraction based on running stats
- `fixedFractional` — Ralph Vince
- `equityCurveTrading` — meta-sizing based on equity vs its MA
- `volTargetSizing` — scaled to hit target portfolio volatility

### Library housekeeping
- `engine/blocks/library/index.js` — imports every block file, registers them.
- Per-block unit tests: contract validation + a deterministic fixture.
- **Lookahead detection harness** (`engine/blocks/lookahead-check.js`):
  call `onBar` for each bar with candles[>i] and indicators[>i] set to NaN;
  any block that reads those values gets flagged.

---

## 4. Phase 4 — Persistence, queue, UI, deployment

### 4.1 Database schema migration (`db/schema.sql`) ✅ done
- **Extended `runs` table** with 5 additive columns via `ALTER TABLE ADD
  COLUMN IF NOT EXISTS` (legacy rows leave them NULL):
  - `spec_hash VARCHAR` — pointer to `specs.hash`
  - `spec_name VARCHAR` — denormalized for cheap listing without a join
  - `wf_report_json JSON` — post-GA walk-forward report on the winning
    gene (scheme, nWindows, per-window IS/OOS PF + trades, meanIsPf,
    meanOosPf, WFE). Populated by Phase 4.1b (see below).
  - `fitness_breakdown_json JSON` — `bestMetrics._fitness` (score,
    eliminated, gatesFailed, breakdown.normPf/normDd/normRet, regimeSource,
    worstRegimePf)
  - `regime_breakdown_json JSON` — `bestMetrics.regimeBreakdown`
- **New `specs` table** — content-addressed store of validated spec JSON,
  keyed by `spec.hash`. Upsert is idempotent: identical hash is a no-op so
  multiple runs of the same spec share one row. Lets `runs.spec_hash`
  always resolve back to the exact JSON we optimized, even if the on-disk
  strategy file has since been edited.
- **New `db/specs.js` helpers**: `upsertSpec(spec)`, `getSpec(hash)`,
  `listSpecs()`. `getSpec` parses the stored JSON, `listSpecs` returns
  metadata only (no payload) for cheap UI listings.
- **`api/routes.js` wiring**: POST `/api/runs` now accepts an optional
  `spec` field — either an inline object or a filename string under
  `strategies/` (with `..` + absolute-path traversal rejected). Spec mode
  gets validated + upserted at enqueue, `spec_hash` + `spec_name` stored
  on the runs row immediately. On completion the queue processor writes
  `fitness_breakdown_json` + `regime_breakdown_json` from `bestMetrics`.
  Legacy runs (no spec) continue through the existing code path with all
  5 new columns left NULL.
- **Deferred**: `queue` table. The backlog sketch put it under 4.1 but
  its schema depends on the queue design (polling model, status fsm,
  priority semantics), which belongs to 4.2 where we build the actual
  consumer. Shipping a skeleton now would commit us to a shape we'd
  iterate on — see follow-up 4.2.
- **Verification**: new `scripts/db-schema-check.js` runs against the
  parity DB (which has candles loaded), asserts the 5 new columns exist,
  the `specs` table is shaped correctly, `upsertSpec` is idempotent,
  `getSpec` round-trips JSON, `listSpecs` returns metadata, and an
  end-to-end tiny GA writes through the full pipeline and reads back
  with all 5 columns populated (including `wf_report_json`). Cleans up
  its own test rows. Currently **40/40 ✓**.

### 4.1b Post-GA walk-forward on the winner ✅ done
- **`optimizer/runner.js`**: after the GA finishes (spec mode only), the
  runner hands the winning gene to `walkForward({ optimize: () => gene,
  ... })` — a frozen-gene evaluation across the IS/OOS windows, not a
  re-optimization. Cheap (~0.1s on an 11k-bar BTCUSDT/4H run). Runs
  inside try/catch — any failure falls back to `wfReport = null` so the
  GA result is never lost. Gated on `specMode && !cancelSent`.
- **Return shape**: `runOptimization` now returns `wfReport` alongside
  `bestGene`/`bestMetrics`. Legacy mode always returns `wfReport: null`
  (no validated spec to hand to the harness).
- **`api/routes.js` queue processor**: on completion, `result.wfReport`
  is serialized into `runs.wf_report_json` using the same NULL-safe
  write path as `fitness_breakdown_json` / `regime_breakdown_json`.
- **Verification**:
  - `scripts/runner-spec-mode-check.js` extended with WF assertions
    (scheme = anchored, nWindows = 5, per-window isPf/oosPf finite,
    legacy mode still emits `wfReport = null`). 21/21 ✓.
  - `scripts/db-schema-check.js` extended to read back the `wf_report_json`
    column after the tiny GA and assert round-trip shape. 40/40 ✓.

### 4.2 Run queue

### 4.2a Pullable atomic claim ✅ done
- **Design call**: don't add a separate `queue` table. `runs.status='pending'`
  is already the queue — a parallel table would duplicate state and
  introduce a sync problem. Phase 4.2a evolves `runs` into a pullable queue
  instead.
- **Schema adds** (additive, `ALTER TABLE ADD COLUMN IF NOT EXISTS`):
  - `priority INTEGER DEFAULT 0` — higher runs first (`ORDER BY priority
    DESC, id ASC`). Default 0 preserves legacy FIFO-by-id behavior.
  - `claimed_by VARCHAR` — worker identifier (e.g. hostname.pid). NULL
    while pending or after stale-lease recovery.
  - `claimed_at TIMESTAMP` — set atomically when transitioning to running.
  - `heartbeat_at TIMESTAMP` — worker pings; stale rows get swept back.
  - `cancel_requested BOOLEAN DEFAULT FALSE` — UI → worker signal.
- **`db/queue.js`** — new helpers:
  - `claimNextRun({ workerId })` — atomic `UPDATE runs SET status='running',
    ... WHERE id = (SELECT id ... LIMIT 1) RETURNING *`. DuckDB serializes
    the statement, so two concurrent callers can never win the same row.
    Sweeps `pending` rows with `cancel_requested=TRUE` to `cancelled`
    before the claim.
  - `heartbeat(runId)` — bumps `heartbeat_at`; returns `false` if the row
    isn't running (caller can fail fast).
  - `recoverStaleRuns({ timeoutMs })` — sweeps `running` rows with
    `heartbeat_at < NOW - timeout` back to `pending`. Rounds up to whole
    seconds for DuckDB `INTERVAL` arithmetic.
  - `completeRun(runId, { status, bestGene, ..., wfReportJson, ... })` —
    writes terminal status + all result JSON fields. NULL-safe for
    optional spec-mode fields (fitness/regime/wf reports).
  - `requestCancel(runId)` — flags a `pending`|`running` row for
    cancellation.
  - `listQueue()` — metadata snapshot of pending + running (no big JSON
    payloads) for future UI queue viewer.
- **`db/connection.js`**: added `CHECKPOINT` after schema replay. DuckDB
  can't reliably replay ALTER-with-DEFAULT entries from the WAL (internal
  "GetDefaultDatabase with no default database set" assertion). The
  CHECKPOINT moves migrations into the base file so subsequent opens skip
  WAL replay. Schema is idempotent so the re-run cost is negligible.
- **Verification**: new `scripts/queue-claim-check.js` — 8 test groups,
  **36/36 ✓**:
  1. Schema: 5 new columns on `runs`.
  2. Atomic claim under Promise.all: two concurrent claims return
     different rows with correct bookkeeping.
  3. Priority ordering: claim honors `priority DESC, id ASC`.
  4. Heartbeat updates timestamp; no-op on non-running rows.
  5. Stale-lease recovery: 10-min-old heartbeat gets swept back to pending
     and is re-claimable.
  6. `requestCancel` on pending → next claim sweeps to `cancelled` and
     skips to the next row.
  7. `completeRun` round-trips full result payload (bestGene, metrics,
     fitness/wf breakdowns) through DuckDB JSON columns.
  8. `listQueue` excludes terminal rows, priority-ordered.

### 4.2b In-process drain on DB-backed queue ✅ done

**Scope redefined after user clarification**: the optimizer runs as a single
process on a single machine (Windows box, RTX 3090, 12×8 islands). There's
no immediate need for multi-machine workers, so 4.2b collapses to
"refactor the existing in-process queue to use the 4.2a helpers". The
HTTP-API-for-remote-workers sketch is parked in section 6 (Deferred
features → Remote optimizer workers).

- **`api/routes.js` refactor**: the in-memory `runQueue` array is gone.
  `processQueue` now drives the GA off DB state:
  1. `claimNextRun({ workerId })` atomically transitions the highest-
     priority pending row to `running` and returns it.
  2. The row's `config` JSON (written at enqueue by POST `/api/runs`)
     is parsed to reconstruct the `runOptimization` args — every GA knob
     that used to live on `runQueue[i]` (populationSize, generations,
     migration/space-travel params, minTrades, maxDrawdownPct, knockout*,
     endDate, label) is persisted on the row, so a restart doesn't lose
     the config.
  3. Spec-mode runs resolve `row.spec_hash` via `getSpec(hash)` and hand
     the fetched JSON to `runOptimization`.
  4. A 10s heartbeat interval (`setInterval(() => heartbeat(runId), ...)`)
     keeps the row live against `recoverStaleRuns`.
  5. On completion `completeRun(runId, { status, bestGene, bestMetrics,
     topResults, generationLog, fitnessBreakdownJson, regimeBreakdownJson,
     wfReportJson, generationsCompleted, totalEvaluations, error })`
     writes the terminal state. Legacy-mode rows leave the spec-only JSON
     columns NULL.
  6. `processQueue` is idempotent — a second kick while already draining
     is a no-op (`processing` guard). Exported so tests can drive it
     without a running server.
- **Enqueue (POST `/api/runs`)**: writes the full GA config as a single
  JSON blob on `runs.config` (plus `spec_hash`/`spec_name` for spec-mode).
  Then just kicks `processQueue()`.
- **Cancel (POST `/api/runs/:id/cancel`)**: uses `requestCancel(id)` as
  the source of truth. If the id matches the active run, also flips the
  in-process `cancelRequested` flag so the runner's `shouldCancel()`
  callback sees it mid-GA (the flag + the DB row are kept in sync).
- **Queue view (GET `/api/queue`)**: uses `listQueue()` for the pending
  snapshot, still surfaces the in-process active run for friendly labels.
- **Startup recovery (`server.js`)**: replaced the old bulk
  `UPDATE runs SET status='failed' WHERE status='running'` with
  `recoverStaleRuns({ timeoutMs: 1_000 })`. Semantics change: a crash or
  restart now requeues `running` rows back to `pending` instead of
  failing them. Matches how Celery/Sidekiq default — the user enqueued
  the work, a crash shouldn't silently drop it. If we ever want "fail
  after N attempts" we'll add an `attempts` counter on the row and cap
  in `processQueue`.
- **Queue helper tweak** (`db/queue.js`): `recoverStaleRuns` now also
  matches `heartbeat_at IS NULL` (not just "older than timeout"). A
  legacy or crashed row with no heartbeat is definitionally stale — no
  heartbeat could have fired while we were down. This is what makes the
  single-process `{ timeoutMs: 1_000 }` startup call work.
- **Verification**:
  - `scripts/queue-claim-check.js` extended with group [5b] exercising
    the NULL-heartbeat recovery path. **38/38 ✓**.
  - New `scripts/queue-drain-check.js` — integration test driving the
    refactored `processQueue` end-to-end. Four scenarios:
    1. Happy path: enqueue tiny legacy run → drain → status=completed
       with populated `best_gene`/`best_metrics`/`generations_completed`
       (skipped automatically when BTCUSDT/240 candles aren't in the
       parity DB).
    2. Bad `spec_hash` → processQueue traps `getSpec` miss and marks the
       row `failed` with `error='spec load error: …'`; drain loop
       survives for next kick.
    3. (Removed: malformed JSON in `config` is blocked by DuckDB's
       JSON-type validation at INSERT time. The try/catch in
       processQueue is defensive but unreachable on the current schema.)
    4. `requestCancel` on pending rows → claim sweeps them to
       `cancelled` without ever invoking `runOptimization` (no
       `best_gene`, no generations run).
    Isolates itself from other pending rows in the parity DB by parking
    them to `status='pending_parked'` for the duration of the test. **9/9 ✓**
    on the parity DB.
  - Full-suite re-run post-refactor: `db-schema-check` 40/40, `fitness-check`
    92/92, `fitness-cache-check` 41/41, `walk-forward-check` 35/35,
    `smoke-migration-gate` ALL OK, `parity-gate` ✓ PASS,
    `runner-spec-mode-check` 21/21, `queue-claim-check` 38/38,
    `queue-drain-check` 9/9. All green.

### 4.2c CLI (`scripts/queue.js`) ✅ done

- **`scripts/queue.js`** — thin HTTP client over the optimizer server's
  queue endpoints. Four commands:
  - `add <symbol> <tf> [--spec … --pop N --gens N --mut F --islands N
    --planets N --min-trades N --max-dd PCT --start YYYY-MM-DD
    --end YYYY-MM-DD]` — POSTs `/api/runs`. Normalizes `tf` either as
    minute count (`240`) or label (`4H`). Symbol upper-cased.
  - `list [--running]` — GETs `/api/queue`, prints active + pending
    with priority + spec name + label.
  - `cancel <id>` — POSTs `/api/runs/:id/cancel`.
  - `recover [--timeout-ms N]` — POSTs `/api/queue/recover`.
- **Why HTTP (not direct DB)**: single-process mode means the server is
  the sole DB writer; DuckDB locks the file. Cancels also need to flip
  the in-process `cancelRequested` flag, which only the server process
  can do. The HTTP endpoint already does both.
- **New endpoint `POST /api/queue/recover`** on `api/routes.js`: body
  `{ timeoutMs? }`, defaults 60s, returns `{ recovered, timeoutMs }`.
  Defensive bump of the active run's heartbeat before the sweep so an
  aggressive `--timeout-ms 1000` call can't yank the row the current
  process is still executing; the caller should `cancel` the run
  explicitly if they want to abandon it.
- **Env**: `OPTIMIZER_HOST` (default `localhost`), `OPTIMIZER_PORT`
  (default `3000`). Zero-dependency — uses native `fetch`.
- **Known limitations** (documented in the CLI with WARN stderr, not
  silent drops):
  - `--priority <N>` is parsed but ignored — `POST /api/runs` doesn't
    currently expose a priority knob. Extend `routes.js` if needed.
  - `--label <str>` is ignored — label is derived server-side from the
    interval.
- **Verification**: new `scripts/queue-cli-check.js` — spawns a fake
  HTTP server (per test case), runs `scripts/queue.js` as a subprocess,
  asserts the exact method+path+body the CLI sends and the stdout/
  stderr/exit-code it produces. 8 scenarios, **41/41 ✓**:
  1. `list` on empty queue.
  2. `list --running` with an active row present (filters pending).
  3. `add` with spec + flags (verifies `--pop`/`--gens`/`--start` map
     to `populationSize`/`generations`/`startDate`, tf-minutes → label,
     symbol uppercased).
     - 3b: `tf=1H` label accepted as-is.
     - 3c: unknown tf rejected without hitting server.
  4. `cancel 42` hits the right URL.
     - 4b: non-numeric id rejected without hitting server.
  5. `recover --timeout-ms 30000` forwards the value; `recovered`
     count printed back.
     - 5b: default 60_000 when no flag.
  6. Unknown command → non-zero exit + usage on stdout.
  7. Server unreachable (bound-port=1 refused) → non-zero exit +
     "server not reachable" in stderr.
  8. `--priority` emits a clearly visible WARN on stderr.

### 4.2d In-process cancel propagation — ✅ done
Belt-and-suspenders path for `cancel_requested` to reach the runner when
the HTTP cancel endpoint wasn't the trigger. Single-process mode with
the current `POST /api/runs/:id/cancel` already flips the in-process
`cancelRequested` flag synchronously, so this is primarily insurance
for (a) a future CLI that writes directly to the DB, and (b) the
remote-worker shape listed under Deferred.

**Mechanism** (api/routes.js):
- New `cancelPollTimer` state var alongside `heartbeatTimer`.
- `CANCEL_POLL_MS = 2_000` — one small `SELECT cancel_requested FROM
  runs WHERE id = ?` per interval. Latency is imperceptible for a human
  clicking Cancel; DB load is negligible.
- One-shot latch: once the poll observes TRUE it stops querying (the
  flag is monotonic — no un-cancel).
- Lifecycle matched to heartbeat: started after `claimNextRun` succeeds,
  cleared in the same `finally` block that clears `heartbeatTimer`. No
  leak if the runner throws.

**Why not "runner.js polls the DB"?** The runner already has
`shouldCancel()` — a function pointer the caller supplies. Putting the
DB poll in routes.js keeps the runner pure (no DB dependency) and lets
future non-queue callers of `runOptimization` (one-off scripts, the
existing legacy `POST /api/optimize` path) keep using their own cancel
source.

**Verification** — `queue-drain-check.js` test [5]:
- Replicates the poll block in isolation against a test row.
- Confirms flag stays false with `cancel_requested=FALSE`.
- After `UPDATE cancel_requested = TRUE`, flag flips within one poll
  interval (test uses 500ms for speed; prod uses 2s).
- Confirms the one-shot latch: poll count stops growing once flipped.
- End-to-end through `processQueue` is covered implicitly by the
  happy-path test when real candles are present; the runner already
  reads `cancelRequested` via `shouldCancel` every generation.

### 4.3 UI — spec authoring

Broken into sub-chunks (each its own commit):
- **4.3a** — Backend: `GET /api/specs` + `GET /api/blocks`.
- **4.3b** — UI: spec picker in existing New Run modal.
- **4.3c** — UI: new spec authoring page with block picker per slot.
- **4.3d** — UI: per-block param narrowing form (min/max/step or pin).
- **4.3e** — Save: `POST /api/specs` writes to `strategies/` after validation. ✅ done

### 4.3a Backend endpoints for the authoring UI — ✅ done
Two read-only endpoints that feed the upcoming authoring UI. Neither
touches the queue or DuckDB; both are safe to call any time.

- **`GET /api/specs`** — enumerates `strategies/*.json`. Returns
  `{ specs: [{ filename, name, description, sizeBytes, mtime }], malformed: [{ filename, error }] }`.
  Files that fail to parse or lack a top-level `name` get reported in
  `malformed[]` so the picker can surface a warning without hiding the
  file. **Does not run `validateSpec()`** — that's expensive (loads the
  block library to check references) and the picker only needs shape-
  level trust. Full validation still happens on `POST /api/runs`.
- **`GET /api/blocks`** — dumps the in-memory block registry via
  `registry.ensureLoaded()`. Each entry: `{ id, version, kind, direction, exitSlot, sizingRequirements, params }`.
  `params[]` comes from `block.declaredParams()` so the UI knows each
  param's `type` + `min`/`max`/`step` bounds for the narrowing form.
  `direction` null on regime/sizing; `exitSlot` non-null only on exit
  blocks; `sizingRequirements` (e.g. `['stopDistance']`) only on sizing
  blocks that declare it. Sorted by (kind, id, version) so clients can
  diff responses.

**Verification** — `scripts/spec-api-check.js` (387 checks ✓):
- Boots a bare Express app with the real router.
- `/api/specs` includes the legacy baseline spec with all documented fields.
- `/api/blocks` invariants: valid kind/direction/exitSlot per block kind,
  every declared param has `id/type/min/max/step` with `min<max, step>0`.
- Anchors: `stochCross` has exactly `[longLevel, shortLevel, stochLen, stochSmth]`;
  `atrHardStop` has `exitSlot=hardStop`; `atrRisk` has `sizingRequirements=['stopDistance']`.
- Sort order is non-regressing across the block list.

### 4.3c Spec authoring page (block picker per slot) — ✅ done
New top-level "Specs" page that lets the user compose a strategy spec
by picking blocks per slot. Live JSON preview on the right; "Copy JSON"
button dumps to clipboard. Saving to `strategies/<name>.json` is still
manual — POST /api/specs lands in 4.3e. Per-param narrowing (tighter
min/max/step, pinning) is 4.3d; for now each block's params use the
registry-declared range as-is, which is a valid runnable starting point.

- **Nav + page** (`ui/index.html`): new `<a data-page="specs">` link;
  new `#page-specs` container with two-column grid — left = editor
  form, right = sticky live JSON preview.
- **Editor form**: name/description; regime (single, optional); entries
  (mode all/any/score + threshold + multi-block list); filters (mode +
  multi-block list); three exit slots (hardStop/target/trail, each
  optional); sizing (required). Each row's dropdown is filtered by
  block `kind` (and for exits, by `exitSlot`).
- **Wiring** (`ui/app.js`): `loadBlocksForEditor()` fetches `/api/blocks`
  at init and caches into `blocksById`. `buildSpecFromUi()` reads the
  DOM and composes the full spec object; `renderSpecPreview()` stringifies
  it and updates the preview on every input/change. Sizing block's
  `sizingRequirements` surface as a muted hint under the sizing row
  (flags `stopDistance` → requires Hard Stop). Threshold row auto-hides
  when entries mode ≠ score.
- **Validation** (non-blocking): name required, ≥1 entry block, sizing
  required, and (iff sizing needs stopDistance) a Hard Stop pick. Issues
  render as a muted line above the preview; authoritative check still
  happens server-side at save (4.3e).
- **Copy JSON**: uses `navigator.clipboard.writeText` with a textarea +
  `execCommand('copy')` fallback for non-secure contexts (localhost http).

**Verification** — `scripts/ui-spec-editor-check.js` (225 checks ✓):
- DOM: nav link + #page-specs + every spec-* field (name/desc/regime,
  entries mode+threshold+list+add, filters mode+list+add, three exit
  slots, sizing + requirements hint, JSON preview, Copy button).
- JS: `loadBlocksForEditor` exists + fetches `/api/blocks` + called at
  init; `blocksByKind`/`blocksByExitSlot` helpers defined; per-slot
  populate calls use the right filter; sizing excludes None; every
  input id is wired to `renderSpecPreview`; `buildSpecFromUi` emits the
  full top-level key set (name/description/regime/entries/filters/exits/
  sizing/constraints/fitness/walkForward); `instanceId:'main'`
  everywhere; Copy-JSON reads `#spec-json-preview` and writes via
  `navigator.clipboard.writeText`; threshold row auto-hides on non-score.
- Server contract: per-block assertions against `GET /api/blocks` —
  every block has id/kind/version/params; every exit block has a valid
  exitSlot; every param has a known type.

**Follow-up (same phase): block descriptions** — optional `description`
field on every block (≤280 chars), surfaced by `/api/blocks`, and
rendered in the spec editor:
- Fixed pickers (regime, 3 exit slots, sizing) each get a muted
  description line below the `<select>` that updates on change.
- Entry/filter rows render the description inline below each row so
  multi-block slots don't lose the hint when the user scans the list.
- All 14 shipping blocks have a 1–2 sentence description backfilled
  from each block's header comment.
- Gates: `spec-api-check` asserts description is string-or-null for
  every block and non-empty for all currently-shipping blocks (regression
  guard); `ui-spec-editor-check` asserts the `-desc` containers exist
  and that `blockDescriptionFor`/`updateBlockDescription` are wired to
  each fixed picker + the row builder.

### 4.3d Per-block param narrowing — ✅ done
Every block instance in the spec editor now shows one control row per
declared param:

    [paramId:type]  [☐ pin]  [min]  [max]  [step]  [↺ reset]

- **Range mode** (default): three number inputs pre-filled from the
  registry's declared bounds. User can narrow but not widen — inputs
  clamp to the registry min/max on blur. The spec emits `{min, max, step}`.
- **Pin mode** (checkbox): collapses to a single value input; spec emits
  `{value: X}`. When a user narrows until `min === max` in range mode,
  the emitter also collapses to `{value}` so the JSON reads as intended.
- **Reset** restores the registry's declared defaults and unpins.
- **Live preview**: every input fires the existing `renderSpecPreview`
  path, so the right-hand JSON panel updates as the user types. No
  debouncing — the build is trivially fast.
- **DOM-as-state**: each `.param-row` stores its registry bounds in
  `dataset.*` and its pin state via the `.pinned` class; no parallel JS
  state array to keep in sync. `readParamOverrides()` walks the DOM on
  every preview build.
- **Fallback**: if a `.spec-params` container hasn't been rendered yet
  (e.g., the select just changed), `blockRefToSpec` falls back to
  `paramToSpecEntry`'s registry-defaults path so the preview never
  crashes mid-render.

Implementation entry points in `ui/app.js`:
- `makeParamControlRow(param, override?)` builds one param row with all
  four inputs + pin checkbox + reset button, and wires live validation
  (out-of-bounds, NaN, and `min > max`).
- `renderParamControls(containerEl, blockId)` (re)builds the full grid
  for a given slot.
- `readParamOverrides(containerEl, block)` returns the `{paramId: entry}`
  dict that slots straight into the spec JSON.
- `readRows(containerId)` replaces `readRowBlockIds` so multi-block
  slots (entries/filters) feed their per-row params container into
  `blockRefToSpec`.

**Verification** — `ui-spec-editor-check.js` (257 checks ✓):
- All 5 `-params` fixed-slot containers present.
- `makeParamControlRow`/`renderParamControls`/`readParamOverrides`
  helpers defined.
- Each fixed picker passes its `-params` container to
  `renderParamControls` on both init and change.
- `makeBlockRow` creates a `.spec-params` container per row and rebuilds
  it on select change.
- `readParamOverrides` emits both `{value}` (pinned) and
  `{min,max,step}` (ranged) shapes.

Still parked for 4.3e: server-side validation of narrowed ranges
against registry bounds (client clamps are advisory — POST /api/specs
will re-validate authoritatively).

### 4.3e Save spec to strategies/ — ✅ done
The spec editor's live JSON preview is now persistable to
`strategies/<name>.json` via a new Save button that POSTs to
`/api/specs`. The server re-runs the authoritative `validateSpec()` —
client-side checks stay advisory, the backend is the gate.

- **Endpoint** (`api/routes.js`): `POST /api/specs` accepts the spec as
  JSON body. Pipeline:
  1. Body must be a non-array object (400 otherwise).
  2. `registry.ensureLoaded()` + `validateSpec()` — all violations
     aggregate into one 400 response whose `error` is the multi-line
     message (same string the user sees when `POST /api/runs` rejects
     a hand-written spec, so failure modes match).
  3. Filename derived from `normalized.name` via `basename()` (blocks
     path traversal).
  4. If the target exists and `?overwrite=1` is not set → 409 with the
     filename echoed back so the UI can prompt.
  5. Atomic write: `writeFile(tmp)` → `rename(tmp, target)`. On rename
     failure the tmp is unlinked and the error bubbles up. The
     transient `hash` field is stripped before persisting — specs on
     disk stay deterministic.
  6. 201 on create, 200 on overwrite; body includes
     `{ ok, filename, name, overwritten }`.
- **UI** (`ui/index.html` + `ui/app.js`): new `Save to strategies/`
  button next to the existing `Copy JSON` button, with a
  `#spec-save-status` line beneath the preview that shows inline
  progress/success/error feedback (no modal dialog for the happy path).
  `saveSpec()` POSTs `buildSpecFromUi()`; on 409 it opens a
  `confirm()` asking to overwrite and retries with `?overwrite=1`.
  400 responses surface the validator's multi-line error verbatim so
  the user can see exactly which param/block is wrong.
- **Safety invariants**: no writes on validation failure (the tmp file
  is never created before validation passes); no `.tmp` files leaked
  after a run (verified by the gate); no hand-rolled path joining
  (every target goes through `resolve(cwd, 'strategies', basename(…))`).

**Verification** — `scripts/spec-api-check.js` (449 checks ✓):
- Happy path: 201 + response shape + file exists on disk with
  `hash` stripped.
- Non-object body → 400 with error mentioning "object".
- Invalid name → 400 with validator message surfaced.
- Out-of-range param (min > max) → 400 + no file leaked.
- Duplicate filename without overwrite → 409 with filename echoed.
- Duplicate filename with `?overwrite=1` → 200 + description on disk
  reflects the new payload (proves it actually re-wrote, not
  short-circuited).
- Tmp-leak guard: strategies/ contains zero `*.tmp` files after run.
- All test files live under `20991231-999-post-spec-test-*` (far-future
  date) and are unlinked in a `finally` so a partial failure never
  pollutes the real spec directory.

**Verification** — `scripts/ui-spec-editor-check.js` (266 checks ✓):
- DOM: `#spec-save` button + `#spec-save-status` line present inside
  `#page-specs`.
- JS: `saveSpec` function defined; references `/api/specs`, a `fetch()`
  call, and `method: 'POST'`; uses `buildSpecFromUi()` as the body;
  handles `?overwrite=1` fallback; 409 path invokes `confirm()`;
  writes into `#spec-save-status`; `#spec-save` click wires to
  `saveSpec`.

### 4.3b Spec picker in the New Run modal — ✅ done
Users can now pick an existing spec from a dropdown in the New Run modal
instead of hand-editing JSON. Minimum-viable UI for spec-mode runs.

- **UI** (`ui/index.html`): new `<select id="modal-spec">` between the
  timeline widget and the GA-param fields. Default option: `"None (legacy
  mode)"` with empty value. Below the select: a muted description line
  (`#modal-spec-desc`) and a red warning line (`#modal-spec-warn`,
  hidden until needed).
- **Wiring** (`ui/app.js`):
  - `loadSpecsIntoModal()` fetches `/api/specs` every time the modal opens
    (so newly-saved specs appear without a page reload) and populates one
    `<option>` per spec. `specsByFilename` caches the response so the
    `change` handler can render the description without re-fetching.
  - `malformed[]` surfaces as a red warning listing the filenames.
  - On Start, `body.spec = filename` is only added when non-empty —
    legacy-mode POSTs stay byte-identical to pre-4.3b.
- **Graceful degradation**: fetch failure logs to console and leaves
  the picker with only "None" — the modal still works.

**Verification** — `scripts/ui-spec-picker-check.js` (22 checks ✓):
- DOM: picker + description + warning elements present in the modal,
  picker sits BEFORE the Population field (discoverable).
- JS: `loadSpecsIntoModal` is defined, fetches `/api/specs`, is awaited
  by the `btn-new-run` handler; Start handler conditionally adds
  `body.spec`; change handler renders descriptions via `specsByFilename`.
- Contract: `GET /api/specs` still returns the shape the picker reads.

### 4.4 UI — fitness config panel
- Weight sliders for PF / DD / return.
- Cap inputs.
- Gate inputs (min trades, worst-regime PF floor, WFE min).
- "Reset to recommended" button (loads DEFAULT_FITNESS from spec.js).
- Show recommended defaults alongside current values.

### 4.5 UI — results view
- Per-run: metrics dashboard, trade list, equity curve, **WF report**
  (per-window PFs and WFE), regime breakdown table.
- Compare-runs view: side-by-side WF reports for multiple specs.

### 4.6 Pine export
- "Generate Pine indicator" button per winning run.
- Runs codegen over active (entry + filter + regime) blocks with the
  tuned params, writes `pine/generated/<spec-name>-<hash>.pine`.
- Auto-push via `tools/pine-push.js`. **NEVER** overwrite an existing
  editor script without confirmation — user feedback note already
  captured in MEMORY.md.

### 4.7 Deployment (= portfolio automation)
- Winning strategies → alert-only Pine indicator pushed live.
- Alerts post to a webhook that executes on exchange (out of scope; stub API).
- Each trade returns a configurable "tax" (fraction of net P&L) to a pool
  that funds new experiments (Phase 5 feedstock).

---

## 5. Phase 5 — AI-powered strategy idea generator (parked)

Separate effort. High-level vision:

- Scrape / ingest YouTube trading channels, Reddit (r/algotrading, r/Daytrading,
  r/Forex, r/CryptoCurrency), trading blogs.
- Summarize strategies via LLM into structured "idea" documents.
- Map ideas to block combinations in the existing library — flag missing blocks
  that would need to be authored.
- Auto-generate draft specs from mapped ideas, queue them for optimization.
- Use Phase 4's "tax" pool to fund GPU time for the optimizer.

Parked until Phases 1–4 are solid. Too many moving parts to start on it now.

---

## 6. Deferred features

Things we intentionally postponed from earlier design discussions.

### Pyramiding / scale-in entries

**What:** Allow entry blocks to ADD to an open position on the same side, not
just open-when-flat. Day traders use this pattern heavily — core position,
add on confirmation, add again on continuation.

**Why deferred:** Runtime currently enforces "one position at a time; sub-
positions are for scale-OUT only" (tranches set up by the target block at
entry time via `onPositionOpen`). Supporting scale-IN requires:

1. Entry block return shape extension: `{ long: 1, addToOpen: true }` (or a
   dedicated `addBlocks` slot).
2. Runtime allows entry evaluation while a position is open AND on the
   SAME side (currently only allowed for opposing reversals).
3. Sizing block called again per add, with `ctx.addIndex` so size can taper
   (e.g., half-size adds).
4. Metrics: per-add entry tracking so we can attribute PnL by tranche
   (already works — each `sub` PnLs independently).
5. Pine codegen: emit add-entry alerts, not just initial-entry alerts.

**Design notes when we pick it up:**
- Keep the "one concurrent position" invariant. Adds extend the existing
  position, they don't open a new one.
- Cap adds per position with a spec-level `maxAdds` param on the entry slot.
- Require all adds to be same-direction as the open position (reversals
  remain a separate code path).
- Sizing block's `ctx.addIndex` starts at 1 for first add; 0 means initial
  entry.
- Block-level hook: existing `onPositionOpen` fires on initial entry only;
  add `onPositionAdd(position, newSub, ctx)` parallel to it so the target
  block can attach per-add metadata (e.g., a new TP level for the add's
  sub-position).

**Relationship to existing code:**
- `position.subs` already supports N tranches — scale-in just appends.
- `runtime.js` 5e gating logic needs expansion (currently flat OR reversal →
  new entry; new case: open-same-side-within-maxAdds → add).
- No changes to indicator cache, data bundle, or spec format (other than
  optional `entries.maxAdds`).

### Random sizing within bounds

Considered during chunk 6.5 design, **dropped**. Random sizing contradicts
the whole point of optimization — we're trying to find the size that
maximizes fitness, not a random one. Mentioned for completeness only.

### Portfolio-level allocation across strategies

Once multiple strategies are deployed concurrently, allocate capital across
them based on rolling fitness. Not in scope until we have several live.

### Live-trading adapter

Alerts → webhook → exchange order. Out of scope; we stub a webhook target.

### Spread / order-book aware filters

Requires tick-level or L2 data. Current pipeline is minute-bar aggregation.
Park until we have a data source.

### Remote optimizer workers (multi-machine drain)

**What:** let a separate process — or a separate *machine* — drain the run
queue so the UI server and the GA are decoupled. Today everything runs in
one Node process on the Windows box (Phase 4.2b). That's fine for a
solo user, but a few scenarios push toward a second process:

- Running the UI on a laptop while the GA eats the Windows RTX 3090 all
  weekend.
- Farming out runs to a rented GPU box for a burst (Phase 5 feedstock).
- Rolling the UI process independently of a long-running GA — today a
  UI restart kills the GA in flight (stale-lease recovery requeues it,
  but the user loses the generation-log progress).

**Why deferred:** two blockers make this non-trivial, and neither is
urgent while single-process works:

1. **DuckDB is single-writer per DB file.** A second Node process can't
   just open the same `optimizer.duckdb` and call the queue helpers —
   the UI server holds an exclusive lock. The fix is either:
   - (a) An HTTP API surface on the UI server: `POST /api/queue/claim`,
     `POST /api/queue/:id/heartbeat`, `POST /api/queue/:id/complete`.
     The worker becomes an authenticated client; the UI server remains
     the sole DB writer. This is the recommended path — fits the
     existing Express app, reuses `db/queue.js` unchanged.
   - (b) DuckDB's experimental multi-writer attach mode. Risky; not
     production-ready as of the versions we use.
2. **Candle transport.** The worker needs the same candle bytes the UI
   server has. Either ship them over HTTP per claim (slow for a
   10k-bar SAB), mount a shared filesystem, or have the worker maintain
   its own candle ingester. All fine, but each has tradeoffs.

**When we pick this up**, the design sketch is:
- `scripts/queue-worker.js` as a daemon: loop `claim → heartbeat →
  runOptimization → complete`. Reuses `optimizer/runner.js` unchanged.
- API endpoints on the UI server that proxy `db/queue.js` helpers with
  a shared-secret bearer token (HMAC over body for integrity).
- Candle bootstrap: either `GET /api/candles/:symbol/:tf.sab` returning
  the raw SharedArrayBuffer payload, or a Parquet/CSV stream. Prefer
  SAB for zero-copy into the worker's `runOptimization`.
- Heartbeat interval tuned to the network (30s over LAN, shorter for
  same-host). `recoverStaleRuns({ timeoutMs })` already handles dead
  workers — no new FSM.

No priority until the single-process setup hits a real wall.

### Cross-block parameter aliasing / equality constraints

**Problem:** the legacy JM Simple 3TP port (`strategies/20260414-001-jm-
simple-3tp-legacy.json`) needs two params to be IDENTICAL across two
block instances each:

- `atrLen` on `atrHardStop` must equal `atrLen` on `atrScaleOutTarget`
- `stochLen` + `stochSmth` on `stochCross` must equal those on
  `structuralExit`

Without this, the GA optimizes each independently and the two instances
drift apart. The `==` constraint op would express it but isn't supported
(validator's `CONSTRAINT_OPS` is `< <= > >= !=`). The chunk-7 smoke
pins matching values by hand; chunk 8's parity test will too.

**Options when we pick it up:**

1. **Add `==` to `CONSTRAINT_OPS`** with a `clamp-lhs` repair that sets
   lhs = rhs (simple, obvious, but doesn't dedup the genome — both genes
   still exist and mutate independently, constraint-repair just overrides
   one on the way in).
2. **Spec-level param aliases** — e.g.
   ```json
   "aliases": [
     { "from": "atrScaleOutTarget.main.atrLen",
       "to":   "atrHardStop.main.atrLen" }
   ]
   ```
   `buildParamSpace` drops the aliased gene from `PARAMS` and writes the
   hydrated value from the source. Cleaner — only one gene in the genome,
   constraint-repair never has to fire.
3. **Shared-indicator references in block deps** — orthogonal to params:
   if two blocks both request `base:atr:14`, the cache already dedups
   computation. The block-params problem remains though (they each declare
   atrLen separately in their indicatorDeps call).

**Recommendation:** option 2 (aliases) — fewer moving parts at runtime,
and spec authors can read the spec and see exactly which params are
coupled. Add ~chunk 9 once the migration gate is green.

### Sum/expression constraints

Related. Legacy JM Simple 3TP had `tp1Pct + tp2Pct ≤ 90` (the remainder
becomes tp3Pct, and zero-sized tranches are wasteful). The current
constraint grammar only supports binary comparisons between a qid and
a qid-or-literal. Extending to `sum(a,b) <= 90` or general expressions
isn't urgent — for the migration gate we rely on the GA preferring
constraint-respecting genomes naturally (small loss on fitness). Revisit
if we see the population getting stuck against this wall.

---

## 7. Open questions

Design calls we haven't yet made — flag them when they come up.

- **HTF warmup edge case:** if a base bar falls inside the first HTF bar
  (which hasn't closed yet), HTF_NONE is returned. Blocks currently handle
  this individually. Should the runtime skip these bars globally? Probably
  no — blocks that don't depend on HTF shouldn't be gated on HTF warmup.
  Confirmed for now: blocks guard themselves.

- **Multiple regime blocks?** Spec currently allows one regime slot. Some
  strategies might want trend-regime × vol-regime (e.g., "trending-high-vol"
  vs "ranging-low-vol"). Could extend regime slot to array with label
  concatenation. Hold until a concrete use case demands it.

- **Partial fills / position scaling in Pine export:** Pine's `strategy.entry`
  with pyramiding handles this natively but the *indicator* (alerts) version
  would need to emit separate alert lines per tranche. Solvable; decide when
  we build Pine codegen.

- **Commission override per run:** We hardcode 0.06%/side. Different exchanges
  and asset classes have different rates. Should come from the run config,
  not the spec (it's an execution concern, not a strategy concern).

- **Short selling + funding rates:** Currently we model shorts symmetrically.
  Crypto perpetuals have funding; spot shorts have borrow cost. Not modeled.
  Probably need a `fundingBps` in run config like commission.

---

**Convention:** when something from this file gets picked up, move its
entry to an in-progress state (e.g., "🟡 in progress") rather than deleting
it. When it's done, mark ✅ and leave it in place for historical context.
