#!/usr/bin/env node
/**
 * Read or dump all strategy input values from TradingView Desktop.
 * Useful for verifying what inputs are currently set, and for mapping
 * input IDs (in_0, in_1, ...) to their names and values.
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 *           A strategy must be loaded on the chart.
 *
 * Usage:
 *   node tools/tv-inputs.js               # dump all inputs as a table
 *   node tools/tv-inputs.js --json        # dump as JSON
 *
 * Origin: tradingview-mcp-jackson sendToTradingView input reading (adapted)
 */
import CDP from 'chrome-remote-interface';

const asJson = process.argv.includes('--json');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target found.'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const result = (await c.Runtime.evaluate({
  expression: `(function() {
    try {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies().map(function(s) {
        return { id: s.id, name: s.name || s.title || 'unknown' };
      });
      var strat = studies.find(function(s) { return /jm|simple.*3tp/i.test(s.name); });
      if (!strat) return { error: 'Strategy not found. Studies: ' + studies.map(function(s) { return s.name; }).join(', ') };

      var study = chart.getStudyById(strat.id);
      var vals = study.getInputValues();
      return { strategy: strat.name, inputs: vals };
    } catch(e) { return { error: e.message }; }
  })()`,
  returnByValue: true,
})).result?.value;

if (result?.error) {
  console.error('Error:', result.error);
  await c.close();
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Strategy: ${result.strategy}\n`);
  console.log('ID'.padEnd(8) + 'Type'.padEnd(10) + 'Value'.padEnd(24) + 'Name');
  console.log('-'.repeat(60));
  for (const inp of result.inputs) {
    const val = inp.value instanceof Object ? JSON.stringify(inp.value) : String(inp.value);
    console.log(
      String(inp.id).padEnd(8) +
      String(inp.type || '-').padEnd(10) +
      val.padEnd(24) +
      (inp.name || '-')
    );
  }
}

await c.close();
