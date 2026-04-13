/**
 * Compare JS indicator values vs TradingView at specific bars.
 * Connects to TV via CDP to read indicator values for the same candle data.
 */
import { loadCandles } from '../db/candles.js';
import {
  sma, ema, rsi, stoch, atr, stdev, percentrank,
  crossover, crossunder,
} from '../engine/indicators.js';

BigInt.prototype.toJSON = function() { return Number(this); };

const PARAMS = {
  stochLen: 39, stochSmth: 6, rsiLen: 16,
  emaFast: 14, emaSlow: 135, bbLen: 40, bbMult: 3, atrLen: 24,
};

async function main() {
  // 1. Load candles from our DB
  const startTs = new Date('2021-04-12').getTime();
  const candles = await loadCandles('BTCUSDT', 240, startTs);
  const len = candles.close.length;
  console.log(`Loaded ${len} bars`);

  // 2. Compute JS indicators
  const stochRaw = stoch(candles.close, candles.high, candles.low, PARAMS.stochLen);
  const stochK = sma(stochRaw, PARAMS.stochSmth);
  const stochD = sma(stochK, PARAMS.stochSmth);
  const rsiArr = rsi(candles.close, PARAMS.rsiLen);
  const emaF = ema(candles.close, PARAMS.emaFast);
  const emaS = ema(candles.close, PARAMS.emaSlow);
  const bbBasis = sma(candles.close, PARAMS.bbLen);
  const bbStd = stdev(candles.close, PARAMS.bbLen);
  const atrArr = atr(candles.high, candles.low, candles.close, PARAMS.atrLen);
  const stochCrossUp = crossover(stochK, stochD);
  const stochCrossDown = crossunder(stochK, stochD);

  // 3. Pick specific bars to compare — last 20 bars (most recent, easy to verify on TV)
  const checkBars = [];
  for (let i = len - 20; i < len; i++) checkBars.push(i);

  console.log('\n=== JS Indicator Values (last 20 bars) ===');
  console.log('Bar   | Date       | Close       | StochK  | StochD  | RSI     | EMA14   | EMA135  | ATR     | BB_basis | CrossUp | CrossDn');
  for (const i of checkBars) {
    const date = new Date(Number(candles.ts[i])).toISOString().slice(0, 16);
    console.log(
      `${String(i).padStart(5)} | ${date} | ${candles.close[i].toFixed(2).padStart(11)} | ` +
      `${stochK[i]?.toFixed(2).padStart(7)} | ${stochD[i]?.toFixed(2).padStart(7)} | ` +
      `${rsiArr[i]?.toFixed(2).padStart(7)} | ${emaF[i]?.toFixed(2).padStart(7)} | ${emaS[i]?.toFixed(2).padStart(7)} | ` +
      `${atrArr[i]?.toFixed(2).padStart(7)} | ${bbBasis[i]?.toFixed(2).padStart(8)} | ` +
      `${stochCrossUp[i] ? 'YES' : '   '} | ${stochCrossDown[i] ? 'YES' : '   '}`
    );
  }

  // 4. Check candle data difference: our first and last candle vs what TV shows
  console.log('\n=== Candle Data Checks ===');
  console.log('First bar:', {
    ts: new Date(Number(candles.ts[0])).toISOString(),
    O: candles.open[0], H: candles.high[0], L: candles.low[0], C: candles.close[0]
  });
  console.log('Last bar:', {
    ts: new Date(Number(candles.ts[len-1])).toISOString(),
    O: candles.open[len-1], H: candles.high[len-1], L: candles.low[len-1], C: candles.close[len-1]
  });

  // 5. Count signal occurrences
  const bbWidth = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    bbWidth[i] = bbBasis[i] > 0 ? ((bbBasis[i] + PARAMS.bbMult * bbStd[i]) - (bbBasis[i] - PARAMS.bbMult * bbStd[i])) / bbBasis[i] * 100 : 0;
  }
  const bbPctRank = percentrank(bbWidth, 100);
  const squeeze = new Uint8Array(len);
  for (let i = 0; i < len; i++) squeeze[i] = bbPctRank[i] < 25 ? 1 : 0;

  let longSignals = 0, shortSignals = 0;
  const warmup = Math.max(PARAMS.stochLen + PARAMS.stochSmth * 2, PARAMS.rsiLen + 1, PARAMS.emaSlow, PARAMS.bbLen + 100, PARAMS.atrLen) + 5;

  for (let i = warmup; i < len; i++) {
    if (isNaN(stochK[i]) || isNaN(emaF[i]) || isNaN(emaS[i]) || isNaN(atrArr[i])) continue;

    // Long score
    let ls = 0;
    if (stochCrossUp[i] && stochK[i] < 40) ls++;
    if (emaF[i] > emaS[i]) ls++;
    const sq = squeeze[i] || (i > 0 && squeeze[i - 1]) || (i > 1 && squeeze[i - 2]);
    if (sq && candles.close[i] > bbBasis[i]) ls++;
    if (ls >= 2) longSignals++;

    // Short score
    let ss = 0;
    if (stochCrossDown[i] && stochK[i] > 60) ss++;
    if (emaF[i] < emaS[i]) ss++;
    if (sq && candles.close[i] < bbBasis[i]) ss++;
    if (ss >= 2) shortSignals++;
  }

  console.log(`\n=== Signal Counts (minEntry=2) ===`);
  console.log(`  Long signals:  ${longSignals}`);
  console.log(`  Short signals: ${shortSignals}`);
  console.log(`  Total:         ${longSignals + shortSignals}`);
  console.log(`  (But many overlap with existing positions, actual entries depend on position state)`);

  // 6. Stoch crossover analysis — what threshold does TV use?
  console.log('\n=== Stoch Crossover Details (first 20) ===');
  let crossCount = 0;
  for (let i = warmup; i < len && crossCount < 20; i++) {
    if (stochCrossUp[i] || stochCrossDown[i]) {
      const dir = stochCrossUp[i] ? 'UP  ' : 'DOWN';
      const date = new Date(Number(candles.ts[i])).toISOString().slice(0, 16);
      const qualifies = stochCrossUp[i] ? (stochK[i] < 40 ? 'YES' : 'NO (K>40)') : (stochK[i] > 60 ? 'YES' : 'NO (K<60)');
      console.log(`  ${date} | ${dir} | K=${stochK[i].toFixed(2)} D=${stochD[i].toFixed(2)} K[-1]=${stochK[i-1]?.toFixed(2)} D[-1]=${stochD[i-1]?.toFixed(2)} | ${qualifies}`);
      crossCount++;
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
