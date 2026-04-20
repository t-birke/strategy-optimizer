/**
 * Library loader — imports every shipped block and registers it.
 *
 * Invoked lazily by `registry.ensureLoaded()` the first time the
 * registry is queried at runtime. Tests/authoring tools that don't
 * need the full library can skip this call.
 */

import { register } from '../registry.js';

// ── Entry ───────────────────────────────────────────────────
import stochCross         from './entry/stoch-cross.js';
import emaTrend           from './entry/ema-trend.js';
import bbSqueezeBreakout  from './entry/bb-squeeze-breakout.js';
import rsiPullback        from './entry/rsi-pullback.js';
import maPullback         from './entry/ma-pullback.js';
import donchianBreakout   from './entry/donchian-breakout.js';
import volumeSurge        from './entry/volume-surge.js';

// ── Filter ──────────────────────────────────────────────────
import htfTrendFilter     from './filter/htf-trend-filter.js';
import volatilityFloor    from './filter/volatility-floor.js';
import volumeFilter       from './filter/volume-filter.js';
import regimeGate         from './filter/regime-gate.js';
import adxFilter          from './filter/adx-filter.js';

// ── Regime ──────────────────────────────────────────────────
import htfTrendRegime     from './regime/htf-trend-regime.js';
import volRegime          from './regime/vol-regime.js';
import rangeRegime        from './regime/range-regime.js';

// ── Exit ────────────────────────────────────────────────────
import atrHardStop        from './exit/atr-hard-stop.js';
import atrScaleOutTarget  from './exit/atr-scale-out-target.js';
import structuralExit     from './exit/structural-exit.js';

// ── Sizing ──────────────────────────────────────────────────
import flat               from './sizing/flat.js';
import pctOfEquity        from './sizing/pct-of-equity.js';
import pctOfInitial       from './sizing/pct-of-initial.js';
import atrRisk            from './sizing/atr-risk.js';
import martingale         from './sizing/martingale.js';
import antiMartingale     from './sizing/anti-martingale.js';
import kelly              from './sizing/kelly.js';
import fixedFractional    from './sizing/fixed-fractional.js';
import equityCurveTrading from './sizing/equity-curve-trading.js';
import volTargetSizing    from './sizing/vol-target.js';

const BLOCKS = [
  // Entries
  stochCross,
  emaTrend,
  bbSqueezeBreakout,
  rsiPullback,
  maPullback,
  donchianBreakout,
  volumeSurge,
  // Filters
  htfTrendFilter,
  volatilityFloor,
  volumeFilter,
  regimeGate,
  adxFilter,
  // Regimes
  htfTrendRegime,
  volRegime,
  rangeRegime,
  // Exits
  atrHardStop,
  atrScaleOutTarget,
  structuralExit,
  // Sizing
  flat,
  pctOfEquity,
  pctOfInitial,
  atrRisk,
  martingale,
  antiMartingale,
  kelly,
  fixedFractional,
  equityCurveTrading,
  volTargetSizing,
];

for (const b of BLOCKS) register(b);
