/**
 * Cross-validate GA optimizer winner against TradingView Desktop via CDP.
 * Zero dependencies — uses native fetch + WebSocket.
 */
// Winner config: E2 St39/6 R16 EMA14/135 BB40x3 ATR24 SL3.25 TP2.5/6/7 @10/10/80% R5% T25b
const WINNER_INPUTS = {
  in_2:  2,      // minEntry
  in_3:  39,     // stochLen
  in_4:  6,      // stochSmth
  in_5:  16,     // rsiLen
  in_6:  14,     // emaFast
  in_7:  135,    // emaSlow
  in_8:  40,     // bbLen
  in_9:  3,      // bbMult
  in_10: 24,     // atrLen
  in_11: 3.25,   // atrSL
  in_12: 2.5,    // tp1Mult
  in_13: 6,      // tp2Mult
  in_14: 7,      // tp3Mult
  in_15: 10,     // tp1Pct
  in_16: 10,     // tp2Pct
  in_17: 5,      // riskPct
  in_18: 25,     // maxBars
  in_19: 1,      // leverage — FORCE TO 1x to avoid leverage leak
};

async function main() {
  // 1. Find TradingView chart tab
  const resp = await fetch('http://localhost:9222/json/list');
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!target) { console.error('No TradingView chart tab found'); process.exit(1); }
  console.log(`Connecting to: ${target.url}`);

  // 2. Connect via raw WebSocket CDP protocol
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || 'eval error');
    }
    return res.result?.result?.value;
  }

  await send('Runtime.enable');

  // 3. Check what symbol/timeframe is active
  const chartInfo = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return { symbol: chart.symbol(), resolution: chart.resolution() };
    })()
  `);
  console.log(`Chart: ${chartInfo.symbol} @ ${chartInfo.resolution}`);

  // 4. Find the strategy study
  const studies = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return chart.getAllStudies().map(function(s) {
        return { id: s.id, name: s.name || s.title || 'unknown' };
      });
    })()
  `);
  console.log('Studies:', studies.map(s => `${s.name} (${s.id})`).join(', '));

  const strategy = studies.find(s => /jm|simple.*3tp|strategy/i.test(s.name));
  if (!strategy) { console.error('No strategy found on chart'); ws.close(); process.exit(1); }
  console.log(`\nUsing strategy: "${strategy.name}" (${strategy.id})`);

  // 5. Read current inputs
  const currentInputs = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById('${strategy.id}');
      return study.getInputValues();
    })()
  `);
  console.log('\nInput changes:');
  for (const inp of currentInputs) {
    const override = WINNER_INPUTS[inp.id];
    if (override !== undefined && inp.value !== override) {
      console.log(`  ${inp.id}: ${inp.value} → ${override}`);
    }
  }

  // 6. Read metrics BEFORE
  const metricsBefore = await readMetrics(evaluate);
  console.log('\nBEFORE:', metricsBefore ? `$${Number(metricsBefore.netProfit).toLocaleString()} | ${metricsBefore.totalTrades} trades` : '(none)');

  // 7. Set winner inputs
  console.log('\nSetting winner inputs...');
  await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById('${strategy.id}');
      var inputs = study.getInputValues();
      var overrides = ${JSON.stringify(WINNER_INPUTS)};
      for (var i = 0; i < inputs.length; i++) {
        if (overrides.hasOwnProperty(inputs[i].id)) {
          inputs[i].value = overrides[inputs[i].id];
        }
      }
      study.setInputValues(inputs);
      return true;
    })()
  `);

  // 8. Wait for recalculation
  console.log('Waiting for recalculation...');
  await sleep(3000); // initial wait for strategy to start recalculating

  // Poll until metrics stabilize
  let lastMetrics = null;
  let stableCount = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const m = await readMetrics(evaluate);
    const key = m ? `${m.netProfit}_${m.totalTrades}` : null;
    const lastKey = lastMetrics ? `${lastMetrics.netProfit}_${lastMetrics.totalTrades}` : null;
    if (key && key === lastKey) {
      stableCount++;
      if (stableCount >= 2) { lastMetrics = m; break; }
    } else {
      stableCount = 0;
      lastMetrics = m;
    }
  }

  // 9. Display results
  console.log('\n' + '='.repeat(60));
  console.log('TradingView Results for Winner Config');
  console.log('E2 St39/6 R16 EMA14/135 BB40x3 ATR24 SL3.25');
  console.log('TP2.5/6/7 @10/10/80% R5% T25b');
  console.log('='.repeat(60));
  if (lastMetrics) {
    const m = lastMetrics;
    console.log(`  Net Profit:       $${fmt(m.netProfit)}`);
    console.log(`  Net Profit %:     ${num(m.netProfitPercent)}%`);
    console.log(`  Total Trades:     ${m.totalTrades}`);
    console.log(`  Win Rate:         ${num(m.percentProfitable)}%`);
    console.log(`  Profit Factor:    ${num(m.profitFactor)}`);
    console.log(`  Max Drawdown:     $${fmt(m.maxDrawDown)}`);
    console.log(`  Max DD %:         ${num(m.maxDrawDownPercent)}%`);
    console.log(`  Gross Profit:     $${fmt(m.grossProfit)}`);
    console.log(`  Gross Loss:       $${fmt(m.grossLoss)}`);
    console.log(`  Sharpe Ratio:     ${num(m.sharpeRatio)}`);
    console.log('='.repeat(60));

    // Comparison
    const tvProfit = Number(m.netProfit);
    const gaProfit = 367000;
    const diff = ((tvProfit - gaProfit) / gaProfit * 100).toFixed(1);
    console.log(`\nGA Optimizer:  +$367,000`);
    console.log(`TradingView:   +$${fmt(tvProfit)}`);
    console.log(`Difference:    ${diff}%`);
  } else {
    console.log('  (Could not read metrics)');
  }
  console.log('');

  ws.close();
}

async function readMetrics(evaluate) {
  return evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo() && s.metaInfo().is_price_study === false && s.reportData) {
            strat = s; break;
          }
        }
        if (!strat) return null;
        var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        if (!rd || !rd.performance) return null;
        var perf = rd.performance;
        var all = perf.all || perf;
        return {
          netProfit: all.netProfit,
          netProfitPercent: all.netProfitPercent,
          totalTrades: all.totalClosedTrades || all.totalTrades,
          percentProfitable: all.percentProfitable,
          profitFactor: all.profitFactor,
          maxDrawDown: all.maxStrategyDrawDown,
          maxDrawDownPercent: all.maxStrategyDrawDownPercent,
          grossProfit: all.grossProfit,
          grossLoss: all.grossLoss,
          sharpeRatio: all.sharpeRatio,
        };
      } catch(e) { return null; }
    })()
  `);
}

function fmt(v) { return v != null ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; }
function num(v) { return v != null ? Number(v).toFixed(2) : '—'; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
