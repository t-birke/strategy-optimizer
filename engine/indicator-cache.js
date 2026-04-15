/**
 * Indicator cache — computes each unique indicator dep once per backtest.
 *
 * Blocks declare their dependencies as { key, tf, indicator, source?, args }.
 * Two blocks requesting the same ema-close-20 share one Float64Array. The
 * cache key is the block author's responsibility — name it precisely
 * (`base:ema:close:20`) so logical duplicates collapse.
 *
 * Non-close sources supported: open / high / low / close / volume / hlc3 /
 * ohlc4 / hl2. Volume-based indicators (VWAP, OBV, volume-MA, volume-percentile)
 * slot in naturally — they just use source: 'volume'. Source-less indicators
 * (stoch, atr) take the full candle bundle and don't set `source`.
 *
 * Indicator results live on the SAME timeline as their TF's candles. A
 * weekly SMA has length == weekly bars. Blocks consuming HTF indicators
 * look up `bundle.htfs[tfMin].htfBarIndex[i]` to map base bar -> htf bar
 * before reading the indicator array — see engine/blocks/contract.js.
 */

import {
  sma, ema, rsi, stoch, atr, stdev, percentrank, crossover, crossunder,
} from './indicators.js';
import * as registry from './blocks/registry.js';
import { tfToMin } from './data-bundle.js';

// ─── Indicator dispatcher ───────────────────────────────────

// Each entry:
//   fn:        (input, args) => Float64Array
//   inputMode: 'source' — input is a single Float64Array (close/volume/etc.)
//              'candles' — input is the per-TF candle bundle (needs H/L/C)
const INDICATORS = {
  sma:         { fn: (src, a)    => sma(src, a.period),        inputMode: 'source'  },
  ema:         { fn: (src, a)    => ema(src, a.period),        inputMode: 'source'  },
  rsi:         { fn: (src, a)    => rsi(src, a.period),        inputMode: 'source'  },
  stdev:       { fn: (src, a)    => stdev(src, a.period),      inputMode: 'source'  },
  percentrank: { fn: (src, a)    => percentrank(src, a.period), inputMode: 'source' },
  stoch:       { fn: (c, a)      => stoch(c.close, c.high, c.low, a.period), inputMode: 'candles' },
  atr:         { fn: (c, a)      => atr(c.high, c.low, c.close, a.period),   inputMode: 'candles' },
};

/**
 * Compute a derived price source (hlc3 / ohlc4 / hl2) once per TF.
 * Keyed on the candle bundle object identity so the same TF doesn't
 * recompute across blocks.
 */
const derivedCache = new WeakMap();

function derivedSource(candles, kind) {
  let perTf = derivedCache.get(candles);
  if (!perTf) { perTf = {}; derivedCache.set(candles, perTf); }
  if (perTf[kind]) return perTf[kind];

  const len = candles.close.length;
  const out = new Float64Array(len);
  switch (kind) {
    case 'hlc3':  for (let i = 0; i < len; i++) out[i] = (candles.high[i] + candles.low[i] + candles.close[i]) / 3; break;
    case 'ohlc4': for (let i = 0; i < len; i++) out[i] = (candles.open[i] + candles.high[i] + candles.low[i] + candles.close[i]) / 4; break;
    case 'hl2':   for (let i = 0; i < len; i++) out[i] = (candles.high[i] + candles.low[i]) / 2; break;
    default: throw new Error(`Unknown derived source: ${kind}`);
  }
  perTf[kind] = out;
  return out;
}

function resolveSource(candles, source) {
  switch (source) {
    case 'close':  return candles.close;
    case 'open':   return candles.open;
    case 'high':   return candles.high;
    case 'low':    return candles.low;
    case 'volume': return candles.volume;
    case 'hlc3':
    case 'ohlc4':
    case 'hl2':    return derivedSource(candles, source);
    default:
      throw new Error(`Unknown price source: ${JSON.stringify(source)}`);
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Walk a hydrated params bundle, ask each block for its indicator deps,
 * and return the deduped list (order-preserving; first seen wins).
 *
 * @param {Object} hydrated — result of paramSpace.hydrate(gene)
 * @returns {Array<IndicatorDep>}
 */
export function collectDeps(hydrated) {
  const deps = [];
  const seen = new Set();

  const visit = (slotRef) => {
    if (!slotRef) return;
    const block = registry.get(slotRef.blockId, slotRef.version);
    const blockDeps = block.indicatorDeps(slotRef.params) ?? [];
    for (const d of blockDeps) {
      if (!d?.key) throw new Error(`Block ${slotRef.blockId} returned a dep without a key`);
      if (seen.has(d.key)) continue;
      seen.add(d.key);
      deps.push(d);
    }
  };

  visit(hydrated.regime);
  hydrated.entries?.blocks?.forEach(visit);
  hydrated.filters?.blocks?.forEach(visit);
  if (hydrated.exits) {
    visit(hydrated.exits.hardStop);
    visit(hydrated.exits.target);
    visit(hydrated.exits.trail);
  }
  visit(hydrated.sizing);

  return deps;
}

/**
 * Compute each dep's indicator exactly once. Returns a Map<depKey, Float64Array>.
 *
 * @param {Object} bundle — from engine/data-bundle.js
 * @param {Array<IndicatorDep>} deps — typically the result of collectDeps()
 * @returns {Map<string, Float64Array>}
 */
export function buildIndicatorCache(bundle, deps) {
  const cache = new Map();
  for (const dep of deps) {
    if (cache.has(dep.key)) continue;

    const tfCandles = resolveTfCandles(bundle, dep.tf);
    const impl = INDICATORS[dep.indicator];
    if (!impl) {
      throw new Error(`Unknown indicator "${dep.indicator}" in dep "${dep.key}". ` +
        `Register it in engine/indicator-cache.js INDICATORS.`);
    }

    let result;
    if (impl.inputMode === 'candles') {
      result = impl.fn(tfCandles, dep.args ?? {});
    } else {
      const src = resolveSource(tfCandles, dep.source ?? 'close');
      result = impl.fn(src, dep.args ?? {});
    }
    cache.set(dep.key, result);
  }
  return cache;
}

/**
 * Lookup helper — returns the per-TF candle object for a dep's tf spec.
 * 'base' and 0 map to bundle.base; other aliases/minutes map to bundle.htfs[x].
 */
function resolveTfCandles(bundle, tf) {
  if (tf === undefined || tf === null || tf === 'base' || tf === 0) return bundle.base;
  const tfMin = tfToMin(tf);
  const htf = bundle.htfs?.[tfMin];
  if (!htf) {
    const available = Object.keys(bundle.htfs ?? {}).join(', ') || 'none';
    throw new Error(`TF ${tfMin}min not loaded in bundle (available HTFs: ${available}). ` +
      `Does computeDataRequirements() see the dep?`);
  }
  return htf;
}

// ─── Convenience re-exports (blocks commonly need cross / crossunder
//     on computed arrays, e.g. sma(stoch) crossing sma(stoch)) ──
export { crossover, crossunder };
