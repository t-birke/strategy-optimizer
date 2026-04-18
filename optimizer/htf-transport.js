/**
 * HTF SAB transport — helpers for packing higher-timeframe candles +
 * precomputed htfBarIndex into SharedArrayBuffers, and for unpacking
 * them back into the `bundle.htfs[tfMin]` shape that
 * `engine/data-bundle.js` produces.
 *
 * Why this module exists:
 *   - The runner (main thread) loads HTF candles from DuckDB, computes
 *     `makeHtfBarIndex(baseTs, htfTs, htfTfMs)`, and needs to ship both
 *     to worker threads without a full structured clone.
 *   - The worker needs to reassemble a bundle that the runtime (via
 *     indicator-cache.js → resolveTfCandles) treats identically to the
 *     bundle a direct `loadDataBundle` call would have produced.
 *   - Both sides need to agree on the SAB layout, so the pack/unpack
 *     functions live together here.
 *
 * Layout per HTF:
 *   candleBuffer      : SharedArrayBuffer, 6 Float64 cols × htfLen
 *                       [ts | open | high | low | close | volume]
 *   htfBarIndexBuffer : SharedArrayBuffer, Uint32 × baseLen
 *                       — sentinel 0xFFFFFFFF = HTF_NONE (no HTF bar
 *                       closed yet at this base bar)
 *
 * The payload object returned by packHtfPayload is structured-cloneable
 * (SharedArrayBuffers are transferable / shared without copy). Small
 * metadata fields (tfMin, tfMs, htfLen) travel alongside.
 */

/**
 * Pack HTF candles + htfBarIndex into a shared payload.
 *
 * @param {Object} args
 * @param {number} args.tfMin          — HTF timeframe in minutes
 * @param {number} args.tfMs           — HTF timeframe in milliseconds
 * @param {Object} args.candles        — { ts, open, high, low, close, volume } arrays
 * @param {Uint32Array} args.htfBarIndex — length == base candle count
 * @returns {Object} payload { tfMin, tfMs, htfLen, candleBuffer, htfBarIndexBuffer }
 */
export function packHtfPayload({ tfMin, tfMs, candles, htfBarIndex }) {
  const htfLen = candles.close.length;
  const cBuf = new SharedArrayBuffer(htfLen * 6 * 8);
  new Float64Array(cBuf, htfLen * 0 * 8, htfLen).set(candles.ts);
  new Float64Array(cBuf, htfLen * 1 * 8, htfLen).set(candles.open);
  new Float64Array(cBuf, htfLen * 2 * 8, htfLen).set(candles.high);
  new Float64Array(cBuf, htfLen * 3 * 8, htfLen).set(candles.low);
  new Float64Array(cBuf, htfLen * 4 * 8, htfLen).set(candles.close);
  new Float64Array(cBuf, htfLen * 5 * 8, htfLen).set(candles.volume);

  const iBuf = new SharedArrayBuffer(htfBarIndex.length * 4);
  new Uint32Array(iBuf).set(htfBarIndex);

  return {
    tfMin,
    tfMs,
    htfLen,
    candleBuffer:      cBuf,
    htfBarIndexBuffer: iBuf,
  };
}

/**
 * Unpack a payload into the `bundle.htfs[tfMin]` shape. Zero-copy —
 * typed-array views wrap the SABs directly.
 *
 * @param {Object} p — payload from packHtfPayload
 * @returns {Object} htf object matching engine/data-bundle.js output
 */
export function unpackHtfPayload(p) {
  const h = p.htfLen;
  return {
    ts:     new Float64Array(p.candleBuffer, h * 0 * 8, h),
    open:   new Float64Array(p.candleBuffer, h * 1 * 8, h),
    high:   new Float64Array(p.candleBuffer, h * 2 * 8, h),
    low:    new Float64Array(p.candleBuffer, h * 3 * 8, h),
    close:  new Float64Array(p.candleBuffer, h * 4 * 8, h),
    volume: new Float64Array(p.candleBuffer, h * 5 * 8, h),
    tfMin:  p.tfMin,
    tfMs:   p.tfMs,
    htfBarIndex: new Uint32Array(p.htfBarIndexBuffer),
  };
}

/**
 * Convenience: unpack a list of payloads into an `htfs` dict keyed by tfMin.
 * Empty list or falsy input returns an empty dict — callers can always
 * assign the result to `bundle.htfs` without null-guarding.
 */
export function unpackHtfPayloads(payloads) {
  const out = {};
  if (!payloads) return out;
  for (const p of payloads) {
    out[p.tfMin] = unpackHtfPayload(p);
  }
  return out;
}
