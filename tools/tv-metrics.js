#!/usr/bin/env node
/**
 * Read strategy performance metrics from TradingView Desktop's Strategy Tester.
 * Prints the metrics as JSON to stdout — useful for quick comparisons and piping.
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 *           A strategy must be loaded on the chart.
 *
 * Usage:
 *   node tools/tv-metrics.js              # print metrics JSON
 *   node tools/tv-metrics.js --pretty     # pretty-print
 *
 * Origin: tradingview-mcp-jackson/src/core/data.js getStrategyResults (adapted)
 */
import CDP from 'chrome-remote-interface';

const pretty = process.argv.includes('--pretty');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target found.'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const metrics = (await c.Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources = chart.model().model().dataSources();
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        if (!s.reportData) continue;
        var rd = typeof s.reportData === 'function' ? s.reportData() : s.reportData;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        if (!rd || !rd.performance) continue;
        var a = rd.performance.all;
        if (!a) continue;
        return {
          netProfit: a.netProfit,
          netProfitPercent: a.netProfitPercent,
          totalTrades: a.totalTrades,
          percentProfitable: a.percentProfitable,
          profitFactor: a.profitFactor,
          grossProfit: a.grossProfit,
          grossLoss: a.grossLoss,
          avgTrade: a.avgTrade,
          maxDrawDown: rd.performance.maxStrategyDrawDown,
          maxDrawDownPercent: rd.performance.maxStrategyDrawDownPercent,
          sharpeRatio: rd.performance.sharpeRatio,
          sortinoRatio: rd.performance.sortinoRatio,
        };
      }
      return null;
    } catch(e) { return { error: e.message }; }
  })()`,
  returnByValue: true,
})).result?.value;

if (!metrics) {
  console.error('No strategy metrics found. Is a strategy loaded on the chart?');
  await c.close();
  process.exit(1);
}

console.log(JSON.stringify(metrics, null, pretty ? 2 : 0));
await c.close();
