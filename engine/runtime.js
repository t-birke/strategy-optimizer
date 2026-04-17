/**
 * Composable runtime — the bar-by-bar engine that drives any spec.
 *
 * Replaces the old hardcoded `engine/strategy.js` (JM Simple 3TP).
 * The runtime knows nothing about specific strategies — it orchestrates
 * blocks slotted into a spec by:
 *
 *   1. Hydrating the gene into per-block params via the param-space
 *   2. Collecting + computing all unique indicator deps once
 *   3. Calling `prepare()` on every active block
 *   4. Walking bars: pending-close → pending-entry → exits → entries
 *   5. Closing any open position at the last bar
 *   6. Emitting metrics in the same shape the legacy engine returned
 *
 * ── Pine-parity quirks preserved ────────────────────────────
 *
 * • Next-bar-open fills for entries and "deferred" closes (Pine's
 *   strategy.entry / strategy.close fill on the NEXT bar's open).
 * • 2-tick × $0.01 slippage applied to MARKET fills (entries, market
 *   closes, ESL-style intra-bar stops) but NOT to LIMIT fills (TPs).
 * • 0.06% commission per side.
 * • Equity floored at zero on bankruptcy; no further trades after that.
 * • DD tracked on every bar, including unrealized PnL of the open
 *   position (mark-to-market).
 *
 * ── Block return shapes ─────────────────────────────────────
 *
 *   Entry block:  { long: 0|1, short: 0|1 }
 *   Filter block: { long: bool, short: bool }
 *   Regime block: string label (or null = unknown)
 *   Exit block:   null  // no action this bar
 *               | { action: 'closeIntraBar',   fillPrice, signal }   // limit/stop with KNOWN price (TP, exact-price stop)
 *               | { action: 'closeMarket',     fillPrice, signal }   // intra-bar market close (slippage will NOT be re-added — block applies its own)
 *               | { action: 'closeNextBarOpen', signal }              // deferred to next bar's open with market slippage
 *               | { action: 'closeSubs', closes: [{ subIndex, fillPrice, signal }] }
 *
 *   The runtime evaluates exit blocks in slot order: hardStop → target → trail.
 *   A `closeAll`-flavored action ends evaluation for the bar.
 *   A `closeSubs` action does NOT end evaluation (other slots still run, e.g.
 *   a trail can fire on the same bar a partial TP fills).
 *
 * ── Sub-positions (tranches) ────────────────────────────────
 *
 * Every position starts with a single "main" sub holding the full size.
 * Target blocks may implement an optional `onPositionOpen(position, params,
 * state, ctx)` hook that REPLACES `position.subs` with N tranches, each
 * carrying whatever metadata the block needs (e.g., per-tranche TP price).
 * The runtime treats subs uniformly for PnL accounting — the block decides
 * which sub closes when via `closeSubs` actions.
 */

import * as registry from './blocks/registry.js';
import { KINDS } from './blocks/contract.js';
import { collectDeps, buildIndicatorCache } from './indicator-cache.js';
import { COMMISSION_PCT, SLIPPAGE } from './execution-costs.js';

// ─── Public entry point ─────────────────────────────────────

/**
 * Run a hydrated strategy spec on a data bundle and return metrics.
 *
 * @param {Object} args
 * @param {Object} args.spec        — validated spec (engine/spec.js)
 * @param {Object} args.paramSpace  — buildParamSpace(spec) result
 * @param {Object} args.bundle      — loadDataBundle(...) result
 * @param {Object} args.gene        — flat gene { qid: value, ... }
 * @param {Object} [args.opts]
 * @param {number} [args.opts.initialCapital=100000]
 * @param {number} [args.opts.leverage=1]
 * @param {boolean}[args.opts.flatSizing=false] — sizing block decides; this is a hint
 * @param {boolean}[args.opts.collectTrades=false]
 * @param {boolean}[args.opts.collectEquity=false]
 * @param {boolean}[args.opts.collectRegimeLabels=false]
 * @returns {Object} metrics
 */
export function runSpec({ spec, paramSpace, bundle, gene, opts = {} }) {
  const initialCapital      = opts.initialCapital ?? 100000;
  const leverage            = opts.leverage ?? 1;
  const collectTrades       = opts.collectTrades ?? false;
  const collectEquity       = opts.collectEquity ?? false;
  const collectRegimeLabels = opts.collectRegimeLabels ?? false;

  // ─── 1. Hydrate gene → per-block params ────────────────
  const hydrated = paramSpace.hydrate(gene);

  // ─── 2. Build indicator cache ──────────────────────────
  const deps  = collectDeps(hydrated);
  const cache = buildIndicatorCache(bundle, deps);

  // ─── 3. Resolve every active block & call prepare() ────
  const ctx = { bundle, indicators: cache, hydrated };
  const slots = resolveSlots(spec, hydrated, ctx);

  // Figure out what the sizing block needs — gates runtime work.
  const sizingRequires = new Set(
    slots.sizing?.block?.sizingRequirements?.() ?? []
  );
  const sizingNeedsEquityCurve = sizingRequires.has('equityCurve');

  // ─── 4. Bar loop state ─────────────────────────────────
  const base   = bundle.base;
  const len    = base.close.length;
  const startBar = bundle.tradingStartBar ?? 0;

  // GA train/test split: if fitnessStartBar is set, fitness metrics only
  // accumulate from trades whose exit bar >= fitnessStartBar. The bar loop
  // still runs from startBar (indicators + positions need full history),
  // but the reported metrics reflect only the OOS portion.
  const fitnessStartBar = opts.fitnessStartBar ?? 0;

  let equity      = initialCapital;
  let peakEquity  = initialCapital;
  let maxDD       = 0;
  let maxDDPct    = 0;

  // Position state
  let position = null;         // see makePosition() below
  let pendingEntry = null;     // { isLong } — fills next bar
  let pendingClose = null;     // { signal } — fills next bar's open with slippage

  // Metrics accumulators (only OOS trades when fitnessStartBar > 0)
  let totalTrades = 0;
  let totalPositions = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  // Sizing stats — richer than win/gross counters; exposed to sizing blocks.
  // Kept up-to-date incrementally in closeSubAtPrice so computing ctx.stats
  // at position-open time is O(1).
  const sizingStats = {
    tradeCount: 0, wins: 0, losses: 0,
    sumWin: 0, sumLoss: 0,          // sum of positive PnLs / abs(negative PnLs)
    biggestWin: 0, biggestLoss: 0,  // both positive magnitudes
    currentStreak: { kind: 'none', length: 0 },
    lastTradePnl: null,
  };

  // Equity curve — only populated if any sizing block declares it as a
  // requirement. Snapshot is taken at each closed trade (not each bar) —
  // that's the granularity sizing blocks actually care about.
  const sizingEquitySnapshots = []; // { ts, equity }
  const tradeReturns = [];
  const tradeList    = collectTrades ? [] : null;
  const equityHistory = collectEquity ? [] : null;
  const regimeLabels  = collectRegimeLabels ? new Array(len) : null;

  // Per-regime stratified bookkeeping (always on — cheap, useful for fitness)
  const regimeStats = new Map(); // label -> { trades, wins, grossProfit, grossLoss }

  // ─── Helpers (closures over the state above) ───────────
  function recordRegime(label) {
    if (!regimeStats.has(label)) {
      regimeStats.set(label, { trades: 0, wins: 0, grossProfit: 0, grossLoss: 0 });
    }
    return regimeStats.get(label);
  }

  function updateDdAfterEquityChange() {
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peakEquity > 0 ? dd / peakEquity : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  function closeSubAtPrice(subIndex, exitPrice, signal, exitBar) {
    const sub = position.subs[subIndex];
    if (!sub || sub.closed) return;
    const isLong = position.dir > 0;
    const entryPrice = position.entryPrice;
    const entryComm = sub.units * entryPrice * COMMISSION_PCT;
    const exitComm  = sub.units * exitPrice * COMMISSION_PCT;
    const pnl = isLong
      ? sub.units * (exitPrice - entryPrice) - entryComm - exitComm
      : sub.units * (entryPrice - exitPrice) - entryComm - exitComm;

    // Equity ALWAYS updates (positions opened in IS still affect the account
    // balance during OOS), but fitness metrics only count OOS exits.
    equity += pnl;
    if (equity < 0) equity = 0;
    sub.closed = true;

    const inFitnessRegion = exitBar >= fitnessStartBar;
    if (inFitnessRegion) {
      totalTrades++;
      if (pnl > 0) { wins++; grossProfit += pnl; }
      else         { grossLoss += Math.abs(pnl); }
      tradeReturns.push(pnl / initialCapital);
    }

    // Update sizing-stats accumulator ----
    sizingStats.tradeCount++;
    sizingStats.lastTradePnl = pnl;
    if (pnl > 0) {
      sizingStats.wins++;
      sizingStats.sumWin += pnl;
      if (pnl > sizingStats.biggestWin) sizingStats.biggestWin = pnl;
      if (sizingStats.currentStreak.kind === 'W') sizingStats.currentStreak.length++;
      else sizingStats.currentStreak = { kind: 'W', length: 1 };
    } else if (pnl < 0) {
      sizingStats.losses++;
      const absPnl = -pnl;
      sizingStats.sumLoss += absPnl;
      if (absPnl > sizingStats.biggestLoss) sizingStats.biggestLoss = absPnl;
      if (sizingStats.currentStreak.kind === 'L') sizingStats.currentStreak.length++;
      else sizingStats.currentStreak = { kind: 'L', length: 1 };
    } // pnl == 0 leaves streak untouched (rare; breakeven)

    if (sizingNeedsEquityCurve && base.ts) {
      sizingEquitySnapshots.push({ ts: Number(base.ts[exitBar]), equity });
    }

    // Per-regime tally — use the regime AT ENTRY so we measure
    // "how does the strategy perform in regime X" rather than splitting
    // a trade across regime changes. Only count OOS trades.
    if (inFitnessRegion && position.entryRegime !== undefined) {
      const r = recordRegime(position.entryRegime ?? '_unknown');
      r.trades++;
      if (pnl > 0) { r.wins++; r.grossProfit += pnl; }
      else         { r.grossLoss += Math.abs(pnl); }
    }

    if (collectTrades) {
      // riskUsdt: pro-rata share of the position's total risk at entry.
      // If the position has N subs, each sub's risk = entryRisk × (subUnits / totalUnits).
      const totalPosUnits = position.subs.reduce((s, sb) => s + sb.units, 0);
      const subRisk = (position.entryRisk != null && totalPosUnits > 0)
        ? position.entryRisk * (sub.units / totalPosUnits)
        : null;
      tradeList.push({
        direction: isLong ? 'Long' : 'Short',
        entryTs:   base.ts ? Number(base.ts[position.entryBar]) : null,
        exitTs:    base.ts ? Number(base.ts[exitBar]) : null,
        signal:    signal ?? 'Close',
        entryPrice,
        exitPrice,
        sizeAsset: sub.units,
        sizeUsdt:  sub.units * exitPrice,
        riskUsdt:  subRisk,
        pnl,
        pnlPct:    pnl / initialCapital,
        regime:    position.entryRegime ?? null,
      });
    }
    updateDdAfterEquityChange();
  }

  function closeAllSubsAtPrice(exitPrice, signal, exitBar) {
    if (!position) return;
    for (let s = 0; s < position.subs.length; s++) {
      if (!position.subs[s].closed) closeSubAtPrice(s, exitPrice, signal, exitBar);
    }
    position = null;
  }

  function allSubsClosed() {
    return !position || position.subs.every(s => s.closed);
  }

  function openPosition(isLong, fillPrice, atBar) {
    // Sizing block computes total units; target block (if any) may split into tranches.
    const sizingState = slots.sizing?.state;
    const sizingBlock = slots.sizing?.block;
    if (!sizingBlock) throw new Error('Spec has no sizing block — runtime cannot open a position');

    // --- Ask hardStop for its planned SL so risk-based sizing can size to it.
    let stopPrice = null, stopDistance = null;
    const hs = slots.exits?.hardStop;
    if (hs?.block?.planStop) {
      try {
        const planned = hs.block.planStop(bundle, atBar, hs.state, hs.params, isLong, fillPrice);
        if (planned && typeof planned.price === 'number' && typeof planned.distance === 'number') {
          stopPrice = planned.price;
          stopDistance = planned.distance;
        }
      } catch (e) {
        // planStop is a cooperative hint; a buggy hardStop shouldn't block entries.
        // The sizing block will see stopDistance=null and decide what to do.
      }
    }

    // --- Build running trade stats (stable shape; zero-initialized is fine).
    const stats = {
      tradeCount:     sizingStats.tradeCount,
      wins:           sizingStats.wins,
      losses:         sizingStats.losses,
      winRate:        sizingStats.tradeCount > 0 ? sizingStats.wins / sizingStats.tradeCount : 0,
      avgWin:         sizingStats.wins   > 0 ? sizingStats.sumWin  / sizingStats.wins   : 0,
      avgLoss:        sizingStats.losses > 0 ? sizingStats.sumLoss / sizingStats.losses : 0,
      biggestWin:     sizingStats.biggestWin,
      biggestLoss:    sizingStats.biggestLoss,
      currentStreak:  { ...sizingStats.currentStreak },
      lastTradePnl:   sizingStats.lastTradePnl,
      netEquityMultiple: initialCapital > 0 ? equity / initialCapital : 1,
    };

    const sizingCtx = {
      i: atBar,
      fillPrice,
      equity,
      initialCapital,
      leverage,
      isLong,
      bundle,
      indicators: cache,
      stopPrice,
      stopDistance,
      stats,
      ...(sizingNeedsEquityCurve ? { equityCurve: sizingEquitySnapshots } : {}),
    };
    const totalUnits = sizingBlock.computeSize(sizingCtx, sizingState ?? {}, slots.sizing.params);
    if (!(totalUnits > 0)) return; // sizing block declined — e.g., missing stopDistance

    // Cap by leverage & equity (defensive — sizing block SHOULD enforce this,
    // but a buggy block shouldn't blow the account).
    const sizingBase = equity > 0 ? equity : initialCapital;
    const maxUnits = (sizingBase * leverage) / fillPrice;
    const units = Math.min(totalUnits, maxUnits);
    if (!(units > 0)) return;

    // Risk $ at entry — units × stopDistance is the dollar loss on a full stop-out
    // (before commissions). Stored on the position so each sub-trade can report it.
    const entryRisk = stopDistance != null ? units * stopDistance : null;

    position = makePosition({
      isLong,
      entryPrice: fillPrice,
      entryBar: atBar,
      entryRegime: collectRegimeLabels && regimeLabels ? regimeLabels[atBar] : labelAt(atBar),
      totalUnits: units,
      entryRisk,
    });

    // Count position opens in the fitness region (used for the
    // minTradesPerWindow gate which counts positions, not sub-exits).
    if (atBar >= fitnessStartBar) totalPositions++;

    // Optional: target block splits the position into tranches.
    const target = slots.exits?.target;
    if (target?.block?.onPositionOpen) {
      const openCtx = { i: atBar, fillPrice, isLong, bundle, indicators: cache };
      target.block.onPositionOpen(position, target.params, target.state, openCtx);
    }

    // Optional: every active block can react to an open via onPositionOpen
    // (e.g., a hardStop block recording the entry-bar ATR for SL distance).
    for (const s of slots.allBlocks) {
      if (s === target) continue; // already called above
      if (s.block.onPositionOpen) {
        const openCtx = { i: atBar, fillPrice, isLong, bundle, indicators: cache };
        s.block.onPositionOpen(position, s.params, s.state, openCtx);
      }
    }
  }

  function labelAt(i) {
    if (regimeLabels) return regimeLabels[i];
    if (!slots.regime) return null;
    // Compute on demand if we're not collecting (entry-bar lookup)
    return slots.regime.block.onBar(bundle, i, slots.regime.state, slots.regime.params) ?? null;
  }

  // OOS equity snapshot — captured once at the first fitness-region bar.
  // Used to compute netProfitPct relative to the OOS starting equity
  // (not initialCapital) when a train/test split is active.
  let oosEquityStart = fitnessStartBar <= startBar ? initialCapital : null;

  // ─── 5. Main bar loop ──────────────────────────────────
  for (let i = startBar; i < len; i++) {
    // Snapshot OOS starting equity the first time we enter the fitness region.
    if (oosEquityStart === null && i >= fitnessStartBar) {
      oosEquityStart = equity;
      // Reset DD tracking so it measures OOS drawdown only.
      peakEquity = equity;
      maxDD = 0;
      maxDDPct = 0;
    }
    const o = base.open[i];
    const c = base.close[i];

    // --- 5a. Execute pendingClose at this bar's open ---
    if (pendingClose && position) {
      const isLong = position.dir > 0;
      const fill = isLong ? o - SLIPPAGE : o + SLIPPAGE;
      closeAllSubsAtPrice(fill, pendingClose.signal, i);
      pendingClose = null;
    } else if (pendingClose) {
      pendingClose = null; // stale
    }

    // --- 5b. Execute pendingEntry at this bar's open ---
    if (pendingEntry && equity <= 0) pendingEntry = null;
    if (pendingEntry && !position) {
      const isLong = pendingEntry.isLong;
      const fill = isLong ? o + SLIPPAGE : o - SLIPPAGE;
      pendingEntry = null;
      if (fill > 0) openPosition(isLong, fill, i);
    }

    // --- 5c. Compute regime label (cheap, useful for fitness even if unused) ---
    let regimeLabel = null;
    if (slots.regime) {
      regimeLabel = slots.regime.block.onBar(bundle, i, slots.regime.state, slots.regime.params) ?? null;
    }
    if (regimeLabels) regimeLabels[i] = regimeLabel;

    // --- 5d. Compute entry + filter signals ONCE per bar ---
    // They're needed in two places: (a) exit blocks can consult them for
    // reversal-on-opposite-signal logic, (b) the entry-queueing step below.
    // Entry block onBar is pure (typed-array reads) so computing unconditionally
    // is cheap and preserves a consistent call pattern for each block.
    const entrySignals  = aggregateEntries(slots.entries, bundle, i);
    const filterSignals = aggregateFilters(slots.filters, bundle, i);
    const runtimeCtx = { entrySignals, filterSignals, slippage: SLIPPAGE };

    // --- 5e. Exits ---
    if (position) {
      let positionStillOpen = true;

      // Slot evaluation order: hardStop → target → trail
      for (const slotName of ['hardStop', 'target', 'trail']) {
        if (!positionStillOpen) break;
        const slot = slots.exits?.[slotName];
        if (!slot) continue;
        // Direction filter — exit blocks declare direction; both/long/short
        const dir = slot.block.direction;
        if (dir !== 'both' && ((dir === 'long' && position.dir < 0) || (dir === 'short' && position.dir > 0))) continue;

        const result = slot.block.onBar(bundle, i, slot.state, slot.params, position, runtimeCtx);
        if (!result) continue;

        if (result.action === 'closeSubs') {
          for (const cl of result.closes ?? []) {
            if (typeof cl.subIndex !== 'number') continue;
            closeSubAtPrice(cl.subIndex, cl.fillPrice, cl.signal ?? slotName, i);
          }
          if (allSubsClosed()) {
            position = null;
            positionStillOpen = false;
          }
          // Other slots may still fire on this bar
          continue;
        }

        if (result.action === 'closeIntraBar' || result.action === 'closeMarket') {
          // closeMarket: block has already applied any slippage it wanted,
          // so we use fillPrice as-is. (Same accounting as closeIntraBar.)
          closeAllSubsAtPrice(result.fillPrice, result.signal ?? slotName, i);
          positionStillOpen = false;
          continue;
        }

        if (result.action === 'closeNextBarOpen') {
          if (!pendingClose) pendingClose = { signal: result.signal ?? slotName };
          // Position stays open for this bar; will close at next bar's open.
          // Stop evaluating further slots — once a deferred close is queued,
          // no other slot can override it.
          break;
        }
      }
    }

    // --- 5f. Entry queueing ---
    // Allowed when:
    //   • flat and no pendingEntry, OR
    //   • position open AND pendingClose queued (reversal scenario):
    //     entry signal must oppose position direction.
    // entrySignals/filterSignals were already computed once in 5d.
    const reversalEligible = position && pendingClose;
    if (!pendingEntry && (!position || reversalEligible) && equity > 0) {
      // Apply filter mask
      const longOk  = filterSignals.long  && entrySignals.long;
      const shortOk = filterSignals.short && entrySignals.short;

      // Long takes precedence when both fire (preserves legacy behavior)
      let chosen = null;
      if (longOk)  chosen = true;
      else if (shortOk) chosen = false;

      if (chosen !== null) {
        if (reversalEligible) {
          // Only queue if the chosen direction OPPOSES the open position
          if ((chosen && position.dir < 0) || (!chosen && position.dir > 0)) {
            pendingEntry = { isLong: chosen };
          }
        } else {
          pendingEntry = { isLong: chosen };
        }
      }
    }

    // --- 5g. DD tracking on equity (mark-to-market) ---
    let mtm = equity;
    if (position) {
      for (const sub of position.subs) {
        if (sub.closed) continue;
        const unrealized = position.dir > 0
          ? sub.units * (c - position.entryPrice)
          : sub.units * (position.entryPrice - c);
        mtm += unrealized;
      }
    }
    if (mtm > peakEquity) peakEquity = mtm;
    {
      const dd = peakEquity - mtm;
      if (dd > maxDD) maxDD = dd;
      const ddPct = peakEquity > 0 ? dd / peakEquity : 0;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
    }
    if (collectEquity && base.ts) equityHistory.push({ ts: Number(base.ts[i]), equity: mtm });
  }

  // ─── 6. Force-close any open position at last bar ──────
  if (position) {
    const lastBar = len - 1;
    closeAllSubsAtPrice(base.close[lastBar], 'End', lastBar);
  }

  // ─── 7. Compute final metrics ──────────────────────────
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // When a GA train/test split is active (fitnessStartBar > 0), compute
  // netProfit relative to the equity at OOS start, not initialCapital.
  // This gives a meaningful "return during OOS" metric.
  const oosBase = oosEquityStart ?? initialCapital;
  const netProfit    = equity - oosBase;
  const netProfitPct = oosBase > 0 ? netProfit / oosBase : 0;

  let sharpe = 0;
  if (tradeReturns.length > 1) {
    const mean = tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length;
    const variance = tradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (tradeReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(tradeReturns.length) : 0;
  }

  // Per-regime PFs (used by fitness gates downstream)
  const regimeBreakdown = {};
  for (const [label, r] of regimeStats) {
    const rPf = r.grossLoss > 0 ? r.grossProfit / r.grossLoss : r.grossProfit > 0 ? Infinity : 0;
    regimeBreakdown[label ?? '_unknown'] = {
      trades:      r.trades,
      wins:        r.wins,
      pf:          rPf,
      net:         r.grossProfit - r.grossLoss,
      grossProfit: r.grossProfit,
      grossLoss:   r.grossLoss,
    };
  }

  // Annualized return (CAGR). Used by computeFitness so the return cap
  // is duration-independent: a 3-month run and a 5-year run are scored
  // on the same scale. periodYears comes from the bundle; 0 or missing
  // means "unknown" — fitness falls back to total return in that case.
  const periodYears = bundle.periodYears ?? 0;
  const annualizedReturnPct = periodYears > 0 && netProfitPct > -1
    ? Math.pow(1 + netProfitPct, 1 / periodYears) - 1
    : netProfitPct;

  return {
    trades: totalTrades,
    totalPositions,
    wins,
    winRate,
    pf,
    netProfit,
    netProfitPct,
    annualizedReturnPct,
    periodYears,
    maxDD,
    maxDDPct,
    sharpe,
    equity,
    regimeBreakdown,
    ...(collectTrades ? { tradeList } : {}),
    ...(collectEquity ? { equityHistory } : {}),
    ...(collectRegimeLabels ? { regimeLabels } : {}),
  };
}

// ─── Slot resolution ────────────────────────────────────────

/**
 * Build a per-slot view of the spec with each block's module, its
 * hydrated params, and a fresh state object initialized via `prepare()`.
 * Stored once at the top of runSpec — the inner loop just reads from
 * these and never re-resolves blocks.
 */
function resolveSlots(spec, hydrated, ctx) {
  const slots = {
    regime:  null,
    entries: { mode: hydrated.entries.mode, threshold: hydrated.entries.threshold, blocks: [] },
    filters: hydrated.filters
      ? { mode: hydrated.filters.mode, threshold: hydrated.filters.threshold, blocks: [] }
      : null,
    exits:   { hardStop: null, target: null, trail: null },
    sizing:  null,
    allBlocks: [], // every non-null active block, for hooks like onPositionOpen
  };

  const make = (slotRef) => {
    if (!slotRef) return null;
    const block = registry.get(slotRef.blockId, slotRef.version);
    const state = Object.create(null);
    if (block.kind !== KINDS.SIZING) {
      // Sizing has optional prepare; non-sizing blocks are required to.
      block.prepare(ctx.bundle, slotRef.params, ctx.indicators, state);
    } else if (block.prepare) {
      block.prepare(ctx.bundle, slotRef.params, ctx.indicators, state);
    }
    const entry = { block, params: slotRef.params, state, instanceId: slotRef.instanceId };
    slots.allBlocks.push(entry);
    return entry;
  };

  slots.regime = make(hydrated.regime);
  slots.entries.blocks = hydrated.entries.blocks.map(make);
  if (hydrated.filters) slots.filters.blocks = hydrated.filters.blocks.map(make);
  if (hydrated.exits) {
    slots.exits.hardStop = make(hydrated.exits.hardStop);
    slots.exits.target   = make(hydrated.exits.target);
    slots.exits.trail    = make(hydrated.exits.trail);
  }
  slots.sizing = make(hydrated.sizing);

  return slots;
}

// ─── Aggregation ────────────────────────────────────────────

/**
 * Collapse N entry blocks into a per-direction `{ long, short }` boolean.
 * Mode semantics:
 *   - 'score': sum each direction's votes; pass if sum >= threshold.
 *   - 'all':   every direction-eligible block must vote 1 for that side.
 *   - 'any':   at least one direction-eligible block must vote 1.
 * A block's `direction` ('long'|'short'|'both') restricts which side's
 * vote it can contribute to.
 */
function aggregateEntries(entrySlot, bundle, i) {
  if (!entrySlot || !entrySlot.blocks?.length) return { long: false, short: false };
  const mode = entrySlot.mode;
  let longSum = 0, shortSum = 0;
  let longEligible = 0, shortEligible = 0;
  let longAllPass = true, shortAllPass = true;

  for (const e of entrySlot.blocks) {
    if (!e) continue;
    const dir = e.block.direction;
    const r = e.block.onBar(bundle, i, e.state, e.params) ?? { long: 0, short: 0 };
    if (dir === 'long' || dir === 'both') {
      longEligible++;
      if (r.long) longSum++;
      else longAllPass = false;
    }
    if (dir === 'short' || dir === 'both') {
      shortEligible++;
      if (r.short) shortSum++;
      else shortAllPass = false;
    }
  }

  if (mode === 'score') {
    const t = entrySlot.threshold ?? 1;
    return { long: longSum >= t, short: shortSum >= t };
  }
  if (mode === 'all') {
    return {
      long:  longEligible  > 0 && longAllPass,
      short: shortEligible > 0 && shortAllPass,
    };
  }
  // 'any'
  return { long: longSum > 0, short: shortSum > 0 };
}

/**
 * Collapse N filter blocks into a per-direction `{ long, short }` mask
 * applied to entries. Default filter behavior when no filters defined =
 * permit both sides.
 *
 * Mode semantics mirror entries; 'score' counts the number of filters
 * voting `true` for each direction.
 */
function aggregateFilters(filterSlot, bundle, i) {
  if (!filterSlot || !filterSlot.blocks?.length) return { long: true, short: true };
  const mode = filterSlot.mode;
  let longTrue = 0, shortTrue = 0;
  let longEligible = 0, shortEligible = 0;
  let longAll = true, shortAll = true;

  for (const f of filterSlot.blocks) {
    if (!f) continue;
    const dir = f.block.direction;
    const r = f.block.onBar(bundle, i, f.state, f.params) ?? { long: false, short: false };
    if (dir === 'long' || dir === 'both') {
      longEligible++;
      if (r.long) longTrue++;
      else longAll = false;
    }
    if (dir === 'short' || dir === 'both') {
      shortEligible++;
      if (r.short) shortTrue++;
      else shortAll = false;
    }
  }

  if (mode === 'score') {
    const t = filterSlot.threshold ?? 1;
    return { long: longTrue >= t, short: shortTrue >= t };
  }
  if (mode === 'any') {
    return { long: longTrue > 0, short: shortTrue > 0 };
  }
  // 'all' (default) — note: zero-eligible direction passes by default, since
  // "no opinion" is not the same as "veto". Authors who want strict gating
  // should use 'score' with threshold=1.
  return {
    long:  longEligible  === 0 || longAll,
    short: shortEligible === 0 || shortAll,
  };
}

// ─── Position factory ───────────────────────────────────────

function makePosition({ isLong, entryPrice, entryBar, entryRegime, totalUnits, entryRisk }) {
  return {
    dir: isLong ? 1 : -1,
    entryPrice,
    entryBar,
    entryRegime: entryRegime ?? null,
    entryRisk: entryRisk ?? null,
    // Default: one sub holding the full size. Target block can replace
    // this with N tranches via its onPositionOpen hook.
    subs: [{ units: totalUnits, closed: false, meta: { tag: 'main' } }],
    // Per-position scratch space — exit blocks may stash data here keyed
    // by their instanceId so concurrent active blocks don't collide.
    state: Object.create(null),
  };
}
