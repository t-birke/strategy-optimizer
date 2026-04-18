/**
 * adversarialSplit — Build Alpha style "random-split concentration" check.
 *
 * See `docs/backlog.md` §6.1 term 5. One of five O(1) robustness terms that
 * run post-hoc on the trade list (no extra backtests) and multiply into the
 * final fitness score to reorder surviving genes by how real their edge is.
 *
 *
 * ─── What this term measures ───────────────────────────────────────
 *
 * Flip a fair coin for every trade. Coin = heads → group A; tails → group B.
 * Sum `pnlPct` independently in each group. Report:
 *
 *     gap = |netA − netB| / max(|netTotal|, epsilon)
 *
 * If the strategy's edge is spread evenly across many trades, any random
 * 50/50 split will produce two groups with very similar nets — `gap` is
 * small. If 3 winners are carrying the year, a random split will (with
 * high probability) land all three in ONE group, making netA and netB
 * diverge wildly — `gap` is large. The larger the gap, the more
 * concentrated the profit, and the more likely the "edge" is really just
 * a few lucky trades.
 *
 * `concentration = min(1, gap)` — clipped to [0, 1] so the caller can use
 * `1 - concentration` directly as a geomean-multiplier term in the
 * composite fitness formula (see §6.1).
 *
 *
 * ─── Why this is the adversarial term ──────────────────────────────
 *
 * The split is drawn fresh PER GENE EVALUATION — the call site passes a
 * per-evaluation seed like `hash(geneKey) ^ runSalt`. The GA cannot
 * overfit to the split because the split literally changes every time
 * the gene is scored. Compare to walk-forward, where the window
 * boundaries are fixed and a clever GA could in principle learn to do
 * well on those specific boundaries; here there are no fixed boundaries
 * to fit to. This is one of the hardest robustness terms to game, and
 * also one of the cheapest to compute (O(trades), no extra backtest).
 *
 * The default `seed = 42` baked in here is ONLY for the unit-test gate
 * in `scripts/robustness-adversarial-split-check.js` — production code
 * must pass a per-evaluation seed.
 *
 *
 * ─── Determinism ───────────────────────────────────────────────────
 *
 * We use mulberry32 for the PRNG so unit tests can assert bit-for-bit
 * reproducibility given a seed. mulberry32 is a 32-bit-state, fast,
 * decent-quality generator — well-suited to this use (we just need
 * Bernoulli trials, not cryptography).
 *
 *
 * ─── Edge cases ────────────────────────────────────────────────────
 *
 *   - Empty trade list  → all zeros. No trades, no signal.
 *   - Single trade      → put it deterministically in group A.
 *                         sizeA=1, sizeB=0, gap=1, concentration=1.
 *                         A single trade IS maximally concentrated —
 *                         that's the correct answer, not a bug.
 *   - netTotal ≈ 0      → divide-by-zero guarded by the 1e-9 epsilon;
 *                         in that degenerate case `gap` becomes
 *                         `|netA − netB| * 1e9` which clips to
 *                         concentration=1. Fine — zero total profit
 *                         with any per-group imbalance is maximally
 *                         suspect.
 */

const EPSILON = 1e-9;

/**
 * mulberry32 PRNG — 32-bit state, returns a float in [0, 1).
 * Chosen for compactness + determinism + speed; we only need a
 * Bernoulli draw per trade, not crypto-grade randomness.
 *
 * @param {number} seed  32-bit integer seed.
 * @returns {() => number}
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Partition a trade list into two random groups and measure how
 * unevenly the net profit splits between them.
 *
 * @param {Array<{pnlPct:number}>} tradeList — output of `runSpec(...).trades`
 *   or equivalent. Only `pnlPct` is read; other fields (direction, ts,
 *   signal, prices, sizes, pnl, regime) are ignored.
 * @param {Object} [opts]
 * @param {number} [opts.seed=42] — RNG seed. Production callers MUST pass
 *   a per-evaluation seed; the default exists only for reproducible
 *   unit tests (see the module header's "adversarial term" section).
 *
 * @returns {{
 *   netA: number,           // sum of pnlPct in group A
 *   netB: number,           // sum of pnlPct in group B
 *   netTotal: number,       // netA + netB
 *   gap: number,            // |netA − netB| / max(|netTotal|, epsilon); [0, large)
 *   concentration: number,  // min(1, gap); ready for (1 - concentration) multiplier
 *   sizeA: number,          // trade count in group A
 *   sizeB: number,          // trade count in group B
 * }}
 */
export function adversarialSplit(tradeList, { seed = 42 } = {}) {
  // ── Empty: no information, neutral answer ──
  if (!tradeList || tradeList.length === 0) {
    return {
      netA:          0,
      netB:          0,
      netTotal:      0,
      gap:           0,
      concentration: 0,
      sizeA:         0,
      sizeB:         0,
    };
  }

  // ── Single trade: maximally concentrated by definition ──
  // Deterministic placement in group A so the answer doesn't depend on
  // the coin flip. gap = |pnl - 0| / |pnl| = 1 (concentration=1) unless
  // pnl=0, which falls through to the general path and still concentrates.
  if (tradeList.length === 1) {
    const only = Number(tradeList[0].pnlPct) || 0;
    const denom = Math.max(Math.abs(only), EPSILON);
    const gap   = Math.abs(only) / denom;        // 1 unless only=0
    return {
      netA:          only,
      netB:          0,
      netTotal:      only,
      gap,
      concentration: Math.min(1, gap),
      sizeA:         1,
      sizeB:         0,
    };
  }

  // ── General case: Bernoulli(0.5) per trade ──
  const rng = mulberry32(seed >>> 0);
  let netA = 0;
  let netB = 0;
  let sizeA = 0;
  let sizeB = 0;

  for (let i = 0; i < tradeList.length; i++) {
    const p = Number(tradeList[i].pnlPct) || 0;
    if (rng() < 0.5) {
      netA += p;
      sizeA++;
    } else {
      netB += p;
      sizeB++;
    }
  }

  const netTotal = netA + netB;
  const denom    = Math.max(Math.abs(netTotal), EPSILON);
  const gap      = Math.abs(netA - netB) / denom;
  const concentration = Math.min(1, gap);

  return {
    netA,
    netB,
    netTotal,
    gap,
    concentration,
    sizeA,
    sizeB,
  };
}
