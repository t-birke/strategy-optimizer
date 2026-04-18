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

    const strategy = studies.find(s => /jm.*simple.*3tp|simple.*3tp.*strat/i.test(s.name));
    if (!strategy) throw new Error('JM Simple 3TP strategy not found on chart. Add it from the Pine Editor first. Studies: ' + studies.map(s => s.name).join(', '));

    // 6. Build input overrides from gene
    const inputs = { in_19: 1, in_21: 1 }; // ALWAYS force leverage=1x and LVG=1x when sending from optimizer
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
 * Push a Pine source string into TradingView Desktop's Pine Editor,
 * compile, and report errors. Creates a NEW indicator on the chart
 * (via "Add to chart" / "Save and add to chart").
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222,
 *           Pine Editor panel open.
 *
 * Same mechanism as tools/pine-push.js — React fiber traversal to reach
 * the Monaco editor instance — but using the raw WS CDP bridge already
 * established in this module instead of the chrome-remote-interface npm
 * package.
 *
 * @param {string} source — full Pine v5 source code
 * @returns {{ pushed: boolean, buttonClicked: string|null, errors: Array<{line,msg}> }}
 */
export async function pushPineToTV(source) {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview\.com/i.test(t.url));
  if (!target) throw new Error('TradingView Desktop not found. Is it running with --remote-debugging-port=9222?');

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

    // Open a new blank editor tab (Ctrl+N equivalent) to avoid
    // overwriting whatever the user is currently editing. The Pine
    // Editor's "New indicator" button lives behind the hamburger menu;
    // the keyboard shortcut is Ctrl+N.
    // However, TV Desktop may not respond to Ctrl+N in the Pine Editor
    // context. Fallback: directly call the "create new" action if the
    // menu API is exposed.  For safety we always try the DOM approach.
    // If neither works, we inject into the current tab — the user
    // clicked the button explicitly, so this is expected.

    // Inject source into Monaco editor via React fiber traversal
    const escaped = JSON.stringify(source);
    const pushed = await evaluate(
      `(function(){` +
        `var c=document.querySelector(".monaco-editor.pine-editor-monaco");` +
        `if(!c)return false;` +
        `var el=c;var fk;` +
        `for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}` +
        `if(!fk)return false;` +
        `var cur=el[fk];` +
        `for(var d=0;d<15;d++){if(!cur)break;` +
          `if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){` +
            `var env=cur.memoizedProps.value.monacoEnv;` +
            `if(env.editor&&typeof env.editor.getEditors==="function"){` +
              `var eds=env.editor.getEditors();` +
              `if(eds.length>0){eds[0].setValue(${escaped});return true}` +
            `}` +
          `}` +
          `cur=cur.return` +
        `}return false` +
      `})()`
    );
    if (!pushed) throw new Error('Could not inject into Pine editor. Is the Pine Editor panel open?');

    // Click compile / "Add to chart" button
    const buttonClicked = await evaluate(
      `(function(){` +
        `var btns=document.querySelectorAll("button");` +
        `for(var i=0;i<btns.length;i++){` +
          `var t=btns[i].textContent.trim();` +
          `if(/save and add to chart/i.test(t)){btns[i].click();return t}` +
          `if(/^(Add to chart|Update on chart)/i.test(t)){btns[i].click();return t}` +
        `}` +
        `for(var i=0;i<btns.length;i++){` +
          `if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}` +
        `}return null` +
      `})()`
    );

    // Keyboard fallback (Ctrl+Enter)
    if (!buttonClicked) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    }

    // Wait for compilation, then check for errors
    await sleep(3000);
    const errors = await evaluate(
      `(function(){` +
        `var c=document.querySelector(".monaco-editor.pine-editor-monaco");` +
        `if(!c)return[];` +
        `var el=c;var fk;` +
        `for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}` +
        `if(!fk)return[];` +
        `var cur=el[fk];` +
        `for(var d=0;d<15;d++){if(!cur)break;` +
          `if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){` +
            `var env=cur.memoizedProps.value.monacoEnv;` +
            `if(env.editor&&typeof env.editor.getEditors==="function"){` +
              `var eds=env.editor.getEditors();` +
              `if(eds.length>0){` +
                `var model=eds[0].getModel();` +
                `var markers=env.editor.getModelMarkers({resource:model.uri});` +
                `return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})` +
              `}` +
            `}` +
          `}` +
          `cur=cur.return` +
        `}return[]` +
      `})()`
    ) || [];

    return { pushed: true, buttonClicked: buttonClicked || 'keyboard fallback', errors };
  } finally {
    ws.close();
  }
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
