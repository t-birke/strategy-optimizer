#!/usr/bin/env node
/**
 * Extract OHLC bar data from TradingView Desktop via CDP.
 *
 * Usage:  node tools/tv-bars.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N]
 */

import CDP from 'chrome-remote-interface';

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const fromDate = getArg('--from', '2022-10-20');
const toDate   = getArg('--to',   '2022-11-30');
const limit    = parseInt(getArg('--limit', '100'));

async function main() {
  const client = await CDP({ port: 9222 });
  const { Runtime } = client;

  // Step 1: Find the path to bar data
  const explore = await Runtime.evaluate({
    expression: `
      (function() {
        try {
          const collection = window._exposed_chartWidgetCollection;
          if (!collection) return JSON.stringify({ error: 'No chart widget collection' });

          const charts = collection.getAll();
          if (!charts || charts.length === 0) return JSON.stringify({ error: 'No charts' });

          const chart = charts[0];
          const cw = chart._chartWidget;
          if (!cw) return JSON.stringify({ error: 'No chart widget' });

          const panes = cw._paneWidgets;
          if (!panes || panes.length === 0) return JSON.stringify({ error: 'No panes' });

          const pane = panes[0];

          // Walk the object tree to find something with bars
          function findProperty(obj, depth, visited) {
            if (depth > 6 || !obj || typeof obj !== 'object' || visited.has(obj)) return null;
            visited.add(obj);

            const keys = Object.keys(obj);

            // Look for _barBuilder, bars, _bars, _data
            for (const k of keys) {
              if (k === '_bars' || k === 'bars' || k === '_barBuilder') {
                return { key: k, type: typeof obj[k] };
              }
            }

            // Recursively check _model, _mainSeries, etc
            for (const k of ['_model', '_mainSeries', 'model', 'mainSeries', '_series', '_state']) {
              if (obj[k] && typeof obj[k] === 'object') {
                const found = findProperty(obj[k], depth + 1, visited);
                if (found) return { ...found, path: k + '.' + (found.path || found.key) };
              }
            }

            return null;
          }

          const found = findProperty(pane, 0, new Set());

          // Try a more direct approach - navigate model -> mainSeries -> bars
          let model = null;
          for (const k of Object.keys(pane)) {
            if (k === '_model' || k === 'model' || k.includes('odel')) {
              model = pane[k];
              break;
            }
          }

          if (!model) return JSON.stringify({ error: 'No model', found, paneKeys: Object.keys(pane).slice(0, 30) });

          // Find main series in model
          let mainSeries = null;
          let mainKey = null;
          for (const k of Object.keys(model)) {
            if (k.includes('ainSeries') || k.includes('ain_series') || k === '_mainSeries') {
              mainSeries = model[k];
              mainKey = k;
              break;
            }
          }

          if (!mainSeries) {
            // List all model keys for debugging
            return JSON.stringify({
              error: 'No main series',
              found,
              modelKeys: Object.keys(model).slice(0, 50)
            });
          }

          // Get bars from main series
          const msKeys = Object.keys(mainSeries).slice(0, 50);

          // Try various methods to get bars
          let bars = null;
          if (typeof mainSeries.bars === 'function') {
            bars = mainSeries.bars();
          } else if (mainSeries._bars) {
            bars = mainSeries._bars;
          } else if (mainSeries._data) {
            const d = mainSeries._data;
            if (d._bars) bars = d._bars;
            else if (typeof d.bars === 'function') bars = d.bars();
          }

          if (!bars) {
            return JSON.stringify({
              info: 'Found main series but no bars method',
              mainKey,
              mainSeriesKeys: msKeys,
              found,
            });
          }

          // Extract bars
          const result = [];
          if (typeof bars.size === 'function') {
            const size = bars.size();
            for (let i = 0; i < Math.min(size, 500); i++) {
              const bar = bars.valueAt(i);
              if (bar) result.push({ ts: bar.time || bar[0], o: bar.open || bar[1], h: bar.high || bar[2], l: bar.low || bar[3], c: bar.close || bar[4] });
            }
          } else if (Array.isArray(bars)) {
            for (const bar of bars.slice(0, 500)) {
              result.push({ ts: bar.time || bar[0], o: bar.open || bar[1], h: bar.high || bar[2], l: bar.low || bar[3], c: bar.close || bar[4] });
            }
          }

          return JSON.stringify({ method: 'mainSeries', barCount: result.length, bars: result });
        } catch (e) {
          return JSON.stringify({ error: e.message, stack: e.stack?.split('\\n').slice(0, 5) });
        }
      })()
    `,
    returnByValue: true,
  });

  const data = JSON.parse(explore.result.value);
  console.log(JSON.stringify(data, null, 2));

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
