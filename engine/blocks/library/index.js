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

// ── Exit ────────────────────────────────────────────────────
import atrHardStop        from './exit/atr-hard-stop.js';
import atrScaleOutTarget  from './exit/atr-scale-out-target.js';
import structuralExit     from './exit/structural-exit.js';

// ── Sizing ──────────────────────────────────────────────────
import flat               from './sizing/flat.js';
import pctOfEquity        from './sizing/pct-of-equity.js';
import atrRisk            from './sizing/atr-risk.js';
import martingale         from './sizing/martingale.js';
import antiMartingale     from './sizing/anti-martingale.js';
import kelly              from './sizing/kelly.js';
import fixedFractional    from './sizing/fixed-fractional.js';
import equityCurveTrading from './sizing/equity-curve-trading.js';

const BLOCKS = [
  // Entries
  stochCross,
  emaTrend,
  bbSqueezeBreakout,
  // Exits
  atrHardStop,
  atrScaleOutTarget,
  structuralExit,
  // Sizing
  flat,
  pctOfEquity,
  atrRisk,
  martingale,
  antiMartingale,
  kelly,
  fixedFractional,
  equityCurveTrading,
  // Regime / filter blocks — to be added in later chunks.
];

for (const b of BLOCKS) register(b);
