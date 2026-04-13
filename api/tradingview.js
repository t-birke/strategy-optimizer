/**
 * TradingView Desktop CDP bridge.
 * Connects to TradingView Desktop via Chrome DevTools Protocol (port 9222)
 * to set strategy inputs and read performance metrics.
 */

const CDP_PORT = 9222;

// Pine input ID mapping for JM Simple 3TP
// in_0 = startDate (time), in_1 = endDate (time), then gene params from in_2+
const GENE_TO_INPUT = {
  minEntry:  'in_2',
  stochLen:  'in_3',
  stochSmth: 'in_4',
  rsiLen:    'in_5',
  emaFast:   'in_6',
  emaSlow:   'in_7',
  bbLen:     'in_8',
  bbMult:    'in_9',
  atrLen:    'in_10',
  atrSL:     'in_11',
  tp1Mult:   'in_12',
  tp2Mult:   'in_13',
  tp3Mult:   'in_14',
  tp1Pct:    'in_15',
  tp2Pct:    'in_16',
  riskPct:        'in_17',
  maxBars:        'in_18',
  emergencySlPct: 'in_20',
};

/**
 * Send gene config to TradingView and read back metrics.
 * @param {Object} gene - Gene config with keys like minEntry, stochLen, etc.
 * @param {string} [symbol] - Optional symbol to switch to (e.g. 'BINANCE:BTCUSDT')
 * @param {number} [timeframe] - Optional timeframe in minutes (e.g. 240 for 4H)
 * @param {Object} [dateRange] - { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 * @returns {{ tvMetrics, chartInfo, inputsChanged }}
 */
export async function sendToTradingView(gene, symbol, timeframe, dateRange) {
  // 1. Find TradingView chart tab
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!target) throw new Error('TradingView Desktop not found. Is it running with --remote-debugging-port=9222?');

  // 2. Connect via WebSocket CDP
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('Failed to connect to TradingView CDP')));
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
      setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || 'TradingView eval error');
    }
    return res.result?.result?.value;
  }

  try {
    await send('Runtime.enable');

    // 3. Switch symbol if needed
    if (symbol) {
      const currentSymbol = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
      const targetSymbol = symbol.includes(':') ? symbol : `BINANCE:${symbol}`;

      if (currentSymbol !== targetSymbol) {
        await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setSymbol('${targetSymbol}')`);
        await sleep(5000); // wait for chart to load new symbol
      }
    }

    // 3b. Switch timeframe/resolution if needed
    if (timeframe) {
      const targetRes = String(timeframe);
      const currentRes = await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().resolution()`);
      if (currentRes !== targetRes) {
        await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('${targetRes}')`);
        await sleep(5000);
      }
    }

    // 4. Get chart info
    const chartInfo = await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        return { symbol: chart.symbol(), resolution: chart.resolution() };
      })()
    `);

    // 5. Find strategy study
    const studies = await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        return chart.getAllStudies().map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      })()
    `);

    const strategy = studies.find(s => /jm|simple.*3tp/i.test(s.name));
    if (!strategy) throw new Error('JM Simple 3TP strategy not found on chart. Studies: ' + studies.map(s => s.name).join(', '));

    // 6. Build input overrides from gene
    const inputs = { in_19: 1 }; // ALWAYS force leverage to 1x (in_19 after ID shift)
    for (const [geneName, inputId] of Object.entries(GENE_TO_INPUT)) {
      if (gene[geneName] !== undefined) inputs[inputId] = gene[geneName];
    }

    // Set date range — Pine input.time() expects Unix timestamp in seconds * 1000
    if (dateRange?.startDate) {
      inputs.in_0 = new Date(dateRange.startDate).getTime();
    }
    if (dateRange?.endDate) {
      inputs.in_1 = new Date(dateRange.endDate).getTime();
    } else {
      inputs.in_1 = new Date('2099-12-31').getTime();
    }

    // 7. Read current inputs and track changes
    const currentInputs = await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var study = chart.getStudyById('${strategy.id}');
        return study.getInputValues();
      })()
    `);

    const inputsChanged = [];
    for (const inp of currentInputs) {
      if (inputs[inp.id] !== undefined && inp.value !== inputs[inp.id]) {
        inputsChanged.push({ id: inp.id, from: inp.value, to: inputs[inp.id] });
      }
    }

    // 8. Set inputs
    await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var study = chart.getStudyById('${strategy.id}');
        var vals = study.getInputValues();
        var ov = ${JSON.stringify(inputs)};
        for (var i = 0; i < vals.length; i++) {
          if (ov.hasOwnProperty(vals[i].id)) vals[i].value = ov[vals[i].id];
        }
        study.setInputValues(vals);
        return true;
      })()
    `);

    // 9. Wait for recalculation to settle
    await sleep(4000);
    let lastKey = null, stableCount = 0, tvMetrics = null;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const m = await readMetrics(evaluate);
      if (!m) continue;
      const key = `${m.netProfit}_${m.totalTrades}`;
      if (key === lastKey) {
        stableCount++;
        if (stableCount >= 2) { tvMetrics = m; break; }
      } else {
        stableCount = 0;
        lastKey = key;
        tvMetrics = m;
      }
    }

    return { tvMetrics, chartInfo, inputsChanged, strategy: strategy.name };
  } finally {
    ws.close();
  }
}

async function readMetrics(evaluate) {
  return evaluate(`
    (function() {
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
      } catch(e) { return null; }
    })()
  `);
}

/**
 * Check if TradingView Desktop is reachable via CDP.
 */
export async function checkTradingViewConnection() {
  try {
    const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
    const targets = await resp.json();
    const chart = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
    return { connected: !!chart, url: chart?.url || null };
  } catch {
    return { connected: false, url: null };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
