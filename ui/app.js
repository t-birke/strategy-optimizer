// ─── WebSocket ──────────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}`);
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  handleWsMessage(msg);
};
ws.onclose = () => setTimeout(() => location.reload(), 3000);

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'ingest_progress':
      updateIngestProgress(msg);
      break;
    case 'ingest_complete':
      onIngestComplete(msg);
      break;
    case 'ingest_error':
      onIngestError(msg);
      break;
    case 'run_started':
      onRunStarted(msg);
      break;
    case 'generation':
      onGeneration(msg);
      break;
    case 'run_completed':
      onRunCompleted(msg);
      break;
    case 'run_error':
      onRunError(msg);
      break;
    case 'run_cancelled':
      activeRunId = null;
      document.getElementById('btn-abort').disabled = true;
      document.getElementById('btn-abort').textContent = 'Aborted';
      loadRuns();
      loadQueue();
      break;
  }
}

// ─── Navigation ─────────────────────────────────────────────
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = link.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    link.classList.add('active');
    history.pushState(null, '', `#${page}`);
  });
});

// Route from hash
if (location.hash === '#optimizer') {
  document.querySelector('[data-page="optimizer"]').click();
}

// ─── Data Page ──────────────────────────────────────────────
const $newSymbol = document.getElementById('new-symbol');
const $checkResult = document.getElementById('check-result');
const $btnCheck = document.getElementById('btn-check');
const $btnIngest = document.getElementById('btn-ingest');
const $ingestProgress = document.getElementById('ingest-progress');
const $ingestStatus = document.getElementById('ingest-status');

$btnCheck.addEventListener('click', async () => {
  const symbol = $newSymbol.value.trim().toUpperCase();
  if (!symbol) return;
  $checkResult.textContent = 'Checking...';
  $btnIngest.disabled = true;
  try {
    const res = await fetch(`/api/symbols/${symbol}/check`);
    const data = await res.json();
    if (data.exists) {
      const since = new Date(data.earliestTs).toISOString().split('T')[0];
      $checkResult.textContent = `Available on Binance since ${since}`;
      $checkResult.style.color = '#3fb950';
      $btnIngest.disabled = false;
    } else {
      $checkResult.textContent = 'Not found on Binance';
      $checkResult.style.color = '#f85149';
    }
  } catch (err) {
    $checkResult.textContent = 'Error: ' + err.message;
    $checkResult.style.color = '#f85149';
  }
});

$btnIngest.addEventListener('click', async () => {
  const symbol = $newSymbol.value.trim().toUpperCase();
  if (!symbol) return;
  $btnIngest.disabled = true;
  $ingestProgress.style.display = 'block';
  $ingestProgress.querySelector('.fill').style.width = '0%';
  $ingestStatus.textContent = `Starting ingestion for ${symbol}...`;

  window._activeIngestSymbol = symbol;

  try {
    await fetch(`/api/symbols/${symbol}/ingest`, { method: 'POST' });
  } catch (err) {
    $ingestStatus.textContent = 'Error: ' + err.message;
  }
});

document.getElementById('btn-update-all').addEventListener('click', async () => {
  try {
    await fetch('/api/symbols/update-all', { method: 'POST' });
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

function updateIngestProgress(msg) {
  $ingestProgress.style.display = 'block';
  $ingestProgress.querySelector('.fill').style.width = msg.pct + '%';
  $ingestStatus.textContent = `${msg.symbol}: ${msg.fetched.toLocaleString()} / ~${msg.total.toLocaleString()} candles (${msg.pct}%)`;
}

function onIngestComplete(msg) {
  $ingestProgress.querySelector('.fill').style.width = '100%';
  $ingestStatus.textContent = `${msg.symbol}: Done! ${msg.candles.toLocaleString()} candles ingested.`;
  $ingestStatus.style.color = '#3fb950';
  $btnIngest.disabled = false;
  setTimeout(() => {
    $ingestProgress.style.display = 'none';
    $ingestStatus.textContent = '';
    $ingestStatus.style.color = '#8b949e';
  }, 5000);
  loadSymbols();
}

function onIngestError(msg) {
  $ingestStatus.textContent = `${msg.symbol}: Error - ${msg.error}`;
  $ingestStatus.style.color = '#f85149';
  $btnIngest.disabled = false;
}

async function loadSymbols() {
  try {
    const res = await fetch('/api/symbols');
    const data = await res.json();
    const tbody = document.querySelector('#symbols-table tbody');
    const noData = document.getElementById('no-data');

    if (data.symbols.length === 0) {
      tbody.innerHTML = '';
      noData.style.display = 'block';
      return;
    }

    noData.style.display = 'none';
    tbody.innerHTML = data.symbols.map(s => `
      <tr>
        <td><strong>${s.symbol}</strong></td>
        <td>${s.firstDate}</td>
        <td>${s.lastDate}</td>
        <td class="num">${s.candle_count.toLocaleString()}</td>
        <td class="num ${s.gapDays > 1 ? 'neutral' : ''}">${s.gapDays > 0 ? s.gapDays + 'd' : '-'}</td>
        <td>
          <button onclick="updateSymbol('${s.symbol}')" style="font-size:11px;padding:2px 8px">Update</button>
          <button onclick="deleteSymbol('${s.symbol}')" class="danger" style="font-size:11px;padding:2px 8px">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load symbols:', err);
  }
}

window.updateSymbol = async (symbol) => {
  await fetch(`/api/symbols/${symbol}/update`, { method: 'POST' });
};

window.deleteSymbol = async (symbol) => {
  if (!confirm(`Delete all data for ${symbol}?`)) return;
  await fetch(`/api/symbols/${symbol}`, { method: 'DELETE' });
  loadSymbols();
};

// ─── Optimizer Page ─────────────────────────────────────────
const $livePanel = document.getElementById('live-panel');
let activeRunId = null;

function onRunStarted(msg) {
  activeRunId = msg.runId;
  $livePanel.classList.add('active');
  document.getElementById('live-title').textContent = `${msg.symbol} ${msg.label || tfLabel(msg.timeframe)}`;
  document.getElementById('live-progress-fill').style.width = '0%';
  document.getElementById('btn-abort').disabled = false;
  document.getElementById('btn-abort').textContent = 'Abort';
  resetLiveStats();
  loadRuns();
  loadQueue();
}

function onGeneration(msg) {
  const pct = Math.round(msg.gen / msg.totalGens * 100);
  document.getElementById('live-progress-fill').style.width = pct + '%';
  const genText = (msg.minGen != null && msg.minGen !== msg.maxGen)
    ? `${msg.minGen}-${msg.maxGen} / ${msg.totalGens}`
    : `${msg.gen} / ${msg.totalGens}`;
  document.getElementById('live-gen').textContent = genText;
  document.getElementById('live-best').textContent = '$' + Math.round(msg.best).toLocaleString();
  document.getElementById('live-evals').textContent = msg.evalCount;
  document.getElementById('live-time').textContent = (msg.elapsedMs / 1000).toFixed(1) + 's';
  document.getElementById('live-config').textContent = msg.config;

  const m = msg.metrics;
  if (m && m.trades) {
    document.getElementById('live-pf').textContent = m.pf?.toFixed(2) || '-';
    document.getElementById('live-wr').textContent = (m.winRate * 100).toFixed(1) + '%';
    document.getElementById('live-dd').textContent = (m.maxDDPct * 100).toFixed(1) + '%';
    document.getElementById('live-trades').textContent = m.trades;
  }

  // Island info
  if (msg.numIslands > 1) {
    document.getElementById('live-islands-stat').style.display = '';
    document.getElementById('live-migrations-stat').style.display = '';
    document.getElementById('live-islands').textContent = msg.numIslands;
    document.getElementById('live-migrations').textContent = msg.totalMigrations;
    if (msg.islands) renderIslandViz(msg);
  }
}

function onRunCompleted(msg) {
  activeRunId = null;
  document.getElementById('live-progress-fill').style.width = '100%';
  document.getElementById('btn-abort').disabled = true;
  loadRuns();
  loadQueue();
  // Hide live panel after a delay if no more runs
  setTimeout(() => {
    fetch('/api/queue').then(r => r.json()).then(q => {
      if (!q.active && q.pending.length === 0) {
        $livePanel.classList.remove('active');
      }
    });
  }, 2000);
}

function onRunError(msg) {
  activeRunId = null;
  document.getElementById('live-title').textContent += ' - FAILED';
  document.getElementById('btn-abort').disabled = true;
  loadRuns();
  loadQueue();
}

window.abortRun = async () => {
  if (!activeRunId) return;
  const btn = document.getElementById('btn-abort');
  btn.disabled = true;
  btn.textContent = 'Aborting...';
  try {
    await fetch(`/api/runs/${activeRunId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('Abort failed:', err);
    btn.disabled = false;
    btn.textContent = 'Abort';
  }
};

function resetLiveStats() {
  for (const id of ['live-gen', 'live-best', 'live-pf', 'live-wr', 'live-dd', 'live-trades', 'live-evals', 'live-time']) {
    document.getElementById(id).textContent = '-';
  }
  document.getElementById('live-config').textContent = '';
  document.getElementById('live-islands-stat').style.display = 'none';
  document.getElementById('live-migrations-stat').style.display = 'none';
  document.getElementById('live-islands').textContent = '-';
  document.getElementById('live-migrations').textContent = '-';
  document.getElementById('island-viz').style.display = 'none';
}

// ─── Island Visualization ──────────────────────────────────
function renderIslandViz(msg) {
  const container = document.getElementById('island-viz');
  const svg = document.getElementById('island-svg');
  container.style.display = '';

  const n = msg.islands.length;
  if (n < 2) { container.style.display = 'none'; return; }

  const W = svg.clientWidth || 500;
  const H = 220;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const cx = W / 2;
  const cy = H / 2;
  const rx = Math.min(W * 0.38, 190);
  const ry = Math.min(H * 0.38, 70);
  const nodeR = 34;

  // Compute node positions in an ellipse
  const nodes = msg.islands.map((isl, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return {
      ...isl,
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    };
  });

  // Find best island
  let bestIdx = 0;
  let bestProfit = -Infinity;
  for (const nd of nodes) {
    if (nd.profit != null && nd.profit > bestProfit) {
      bestProfit = nd.profit;
      bestIdx = nd.idx;
    }
  }

  let html = '';

  // Arrowhead marker
  html += `<defs>
    <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,3 L0,6 z" fill="#30363d"/>
    </marker>
    <marker id="arrow-hl" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,3 L0,6 z" fill="#58a6ff"/>
    </marker>
  </defs>`;

  // Draw edges
  const edges = msg.edges || [];
  if (edges.length > 0) {
    for (const [from, to] of edges) {
      const a = nodes[from], b = nodes[to];
      if (!a || !b) continue;
      // Shorten line to not overlap nodes
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      const x1 = a.x + ux * (nodeR + 2), y1 = a.y + uy * (nodeR + 2);
      const x2 = b.x - ux * (nodeR + 4), y2 = b.y - uy * (nodeR + 4);
      const isBestEdge = from === bestIdx;
      html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isBestEdge ? '#58a6ff' : '#30363d'}" stroke-width="${isBestEdge ? 1.5 : 1}" marker-end="url(#${isBestEdge ? 'arrow-hl' : 'arrow'})" opacity="${isBestEdge ? 0.8 : 0.5}"/>`;
    }
  } else if (msg.topology === 'random') {
    // Random: draw dashed lines between all pairs to suggest dynamic connections
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const a = nodes[i], b = nodes[next];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      html += `<line x1="${a.x + ux * (nodeR + 2)}" y1="${a.y + uy * (nodeR + 2)}" x2="${b.x - ux * (nodeR + 4)}" y2="${b.y - uy * (nodeR + 4)}" stroke="#30363d" stroke-width="1" stroke-dasharray="4,4" opacity="0.3"/>`;
    }
  }

  // Draw nodes
  for (const nd of nodes) {
    const isBest = nd.idx === bestIdx;
    const fill = isBest ? '#1f6feb33' : '#21262d';
    const stroke = isBest ? '#58a6ff' : '#30363d';
    const profitStr = nd.profit != null ? '$' + Math.round(nd.profit).toLocaleString() : '-';
    const genStr = nd.gen != null ? 'g' + nd.gen : '';
    const tradesStr = nd.trades != null ? nd.trades + 't' : '';

    html += `<circle cx="${nd.x}" cy="${nd.y}" r="${nodeR}" fill="${fill}" stroke="${stroke}" stroke-width="${isBest ? 2 : 1}"/>`;
    html += `<text x="${nd.x}" y="${nd.y - 12}" text-anchor="middle" fill="${isBest ? '#58a6ff' : '#8b949e'}" font-size="10" font-weight="600">#${nd.idx}</text>`;
    html += `<text x="${nd.x}" y="${nd.y + 2}" text-anchor="middle" fill="${nd.profit > 0 ? '#3fb950' : nd.profit != null && nd.profit < 0 ? '#f85149' : '#8b949e'}" font-size="10" font-weight="700">${profitStr}</text>`;
    html += `<text x="${nd.x}" y="${nd.y + 14}" text-anchor="middle" fill="#8b949e" font-size="8">${tradesStr}</text>`;
    html += `<text x="${nd.x}" y="${nd.y + 24}" text-anchor="middle" fill="#6e7681" font-size="8">${genStr}</text>`;
  }

  // Topology label
  const topoLabel = msg.topology === 'ring' ? 'Ring' : msg.topology === 'torus' ? 'Torus' : 'Random';
  html += `<text x="${W - 8}" y="14" text-anchor="end" fill="#8b949e" font-size="10">${topoLabel} topology</text>`;

  svg.innerHTML = html;
}

let expandedRunId = null; // currently expanded row — survives table refreshes

function fmtDuration(totalSec) {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (s || parts.length === 0) parts.push(s + 's');
  return parts.join(' ');
}

function tfLabel(minutes) {
  if (minutes >= 60) return (minutes / 60) + 'H';
  return minutes + 'm';
}

async function loadRuns() {
  // Skip rebuild while a row is expanded — preserves expand content + TV results
  if (expandedRunId !== null) return;

  try {
    const res = await fetch('/api/runs');
    const data = await res.json();
    const tbody = document.querySelector('#runs-table tbody');
    const noRuns = document.getElementById('no-runs');

    if (data.runs.length === 0) {
      tbody.innerHTML = '';
      noRuns.style.display = 'block';
      return;
    }

    noRuns.style.display = 'none';
    tbody.innerHTML = data.runs.map(r => {
      let m = r.best_metrics;
      if (typeof m === 'string') try { m = JSON.parse(m); } catch { m = null; }
      const profit = m?.netProfit;
      const pf = m?.pf;
      const wr = m?.winRate;
      const dd = m?.maxDDPct;
      const trades = m?.trades;

      const toMs = (v) => v?.micros ? Number(v.micros) / 1000 : (typeof v === 'string' ? new Date(v).getTime() : NaN);
      const startMs = toMs(r.started_at);
      const endMs = toMs(r.completed_at);
      const elapsed = startMs && endMs ? fmtDuration((endMs - startMs) / 1000) : '-';

      const testFrom = r.start_date || '-';
      const cfg = typeof r.config === 'string' ? (() => { try { return JSON.parse(r.config); } catch { return {}; } })() : (r.config || {});
      const testTo = cfg.endDate || new Date(toMs(r.created_at)).toISOString().split('T')[0];
      const testDays = (testFrom !== '-' && testTo !== '-')
        ? Math.round((new Date(testTo) - new Date(testFrom)) / 86400000)
        : '-';

      return `
        <tr onclick="toggleRunDetails(${r.id})" style="cursor:pointer">
          <td>${r.id}</td>
          <td><strong>${r.symbol}</strong></td>
          <td>${tfLabel(r.timeframe)}</td>
          <td>${testFrom}</td>
          <td>${testTo}</td>
          <td class="num">${testDays !== '-' ? testDays + 'd' : '-'}</td>
          <td><span class="badge ${r.status}">${r.status}</span></td>
          <td class="num ${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}">${profit != null ? '$' + Math.round(profit).toLocaleString() : '-'}</td>
          <td class="num">${pf != null ? pf.toFixed(2) : '-'}</td>
          <td class="num">${wr != null ? (wr * 100).toFixed(1) + '%' : '-'}</td>
          <td class="num neutral">${dd != null ? (dd * 100).toFixed(1) + '%' : '-'}</td>
          <td class="num">${trades ?? '-'}</td>
          <td class="num">${r.generations_completed || '-'}</td>
          <td>${elapsed}</td>
        </tr>
        <tr class="expand-row" id="expand-${r.id}"><td colspan="14" id="expand-content-${r.id}">Loading...</td></tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load runs:', err);
  }
}

window.toggleRunDetails = async (id) => {
  const row = document.getElementById(`expand-${id}`);

  // Clicking the already-expanded row collapses it
  if (row.classList.contains('visible')) {
    row.classList.remove('visible');
    expandedRunId = null;
    return;
  }

  // Close any other expanded row
  document.querySelectorAll('.expand-row.visible').forEach(r => r.classList.remove('visible'));

  expandedRunId = id;
  row.classList.add('visible');

  const content = document.getElementById(`expand-content-${id}`);
  content.textContent = 'Loading...';

  try {
    const res = await fetch(`/api/runs/${id}`);
    const run = await res.json();

    let top = run.top_results;
    if (typeof top === 'string') try { top = JSON.parse(top); } catch { top = []; }
    if (!Array.isArray(top)) top = [];

    let gene = run.best_gene;
    if (typeof gene === 'string') try { gene = JSON.parse(gene); } catch { gene = null; }

    let html = `<div style="display:flex;justify-content:flex-end;margin:-8px -8px 8px 0">
      <button onclick="closeExpand(event)" style="background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer;padding:4px 8px;line-height:1" title="Close">&times;</button>
    </div>`;

    if (gene) {
      const tp3Pct = 100 - (gene.tp1Pct || 0) - (gene.tp2Pct || 0);
      html += `<div style="margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span>
          <strong>Winner config:</strong>
          E${gene.minEntry} St${gene.stochLen}/${gene.stochSmth} R${gene.rsiLen}
          EMA${gene.emaFast}/${gene.emaSlow} BB${gene.bbLen}x${gene.bbMult}
          ATR${gene.atrLen} SL${gene.atrSL}
          TP${gene.tp1Mult}/${gene.tp2Mult}/${gene.tp3Mult}
          @${gene.tp1Pct}/${gene.tp2Pct}/${tp3Pct}%
          R${gene.riskPct}% T${gene.maxBars}b
        </span>
        <button onclick="sendToTV(${id})" class="primary btn-tv" id="btn-tv-${id}" style="font-size:11px;padding:3px 10px;white-space:nowrap">Send to TV</button>
        <span id="tv-status-${id}" style="font-size:12px"></span>
      </div>
      <div id="tv-result-${id}" style="display:none;margin-bottom:12px"></div>`;
    }

    if (top.length > 0) {
      html += `<table style="font-size:12px">
        <thead><tr><th>Rank</th><th class="num">Profit</th><th class="num">PF</th><th class="num">WR</th><th class="num">DD</th><th class="num">Trades</th></tr></thead>
        <tbody>`;
      top.slice(0, 10).forEach((r, i) => {
        const m = r.metrics || {};
        html += `<tr>
          <td>${i + 1}</td>
          <td class="num ${m.netProfit > 0 ? 'positive' : 'negative'}">${m.netProfit != null ? '$' + Math.round(m.netProfit).toLocaleString() : '-'}</td>
          <td class="num">${m.pf?.toFixed(2) || '-'}</td>
          <td class="num">${m.winRate != null ? (m.winRate * 100).toFixed(1) + '%' : '-'}</td>
          <td class="num neutral">${m.maxDDPct != null ? (m.maxDDPct * 100).toFixed(1) + '%' : '-'}</td>
          <td class="num">${m.trades || '-'}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    if (!gene && top.length === 0) html += '<em>No detailed results available</em>';
    content.innerHTML = html;
  } catch (err) {
    content.textContent = 'Error loading details: ' + err.message;
  }
};

window.closeExpand = (event) => {
  event.stopPropagation();
  document.querySelectorAll('.expand-row.visible').forEach(r => r.classList.remove('visible'));
  expandedRunId = null;
};

async function loadQueue() {
  try {
    const res = await fetch('/api/queue');
    const q = await res.json();
    const card = document.getElementById('queue-card');
    const list = document.getElementById('queue-list');

    if (q.pending.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    list.innerHTML = q.pending.map(r => `
      <div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid #21262d">
        <span class="badge pending">pending</span>
        <span>${r.symbol} ${r.label || tfLabel(r.timeframe)}</span>
        <button onclick="cancelRun(${r.runId})" style="margin-left:auto;font-size:11px;padding:2px 8px">Cancel</button>
      </div>
    `).join('');
  } catch (err) {}
}

window.cancelRun = async (id) => {
  await fetch(`/api/runs/${id}/cancel`, { method: 'POST' });
};

// ─── New Run Modal ──────────────────────────────────────────
const $modal = document.getElementById('modal-new-run');

const PERIOD_DAYS = { '3M': 91, '6M': 183, '1y': 365, '2y': 730, '3y': 1096, '4y': 1461, '5y': 1826 };
const WARMUP_BARS = 200;
const INTERVAL_MINS = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1H': 60, '2H': 120, '3H': 180, '4H': 240, '6H': 360, '8H': 480,
};

let tlState = null; // { dataStartMs, dataEndMs, warmupMs, assessStartMs, assessEndMs }
let symbolsData = [];

function getSelectedTimeframeMins() {
  const checked = document.querySelector('#modal-intervals input:checked');
  return checked ? INTERVAL_MINS[checked.value] || 240 : 240;
}

function getWarmupMs() {
  return WARMUP_BARS * getSelectedTimeframeMins() * 60000;
}

function fmtDate(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

function getSelectedSymbolRange() {
  const checked = [...document.querySelectorAll('#modal-symbols input:checked')];
  if (!checked.length || !symbolsData.length) return null;
  const selected = checked.map(c => symbolsData.find(s => s.symbol === c.value)).filter(Boolean);
  if (!selected.length) return null;
  return {
    startMs: Math.min(...selected.map(s => s.first_ts)),
    endMs: Math.max(...selected.map(s => s.last_ts)),
  };
}

function initTimeline() {
  const range = getSelectedSymbolRange();
  const $hint = document.getElementById('tl-hint');
  const $warmup = document.getElementById('tl-warmup');
  const $bar = document.getElementById('tl-bar');

  if (!range) {
    $hint.style.display = '';
    $warmup.style.width = '0';
    $bar.style.display = 'none';
    tlState = null;
    return;
  }
  $hint.style.display = 'none';
  $bar.style.display = '';

  const warmupMs = getWarmupMs();
  const dataStartMs = range.startMs;
  const dataEndMs = range.endMs;
  const totalMs = dataEndMs - dataStartMs;

  const periodKey = document.getElementById('modal-period').value;
  const periodMs = PERIOD_DAYS[periodKey] * 86400000;
  const availableStartMs = dataStartMs + warmupMs;

  let assessEndMs = dataEndMs;
  let assessStartMs = Math.max(availableStartMs, assessEndMs - periodMs);

  if (assessStartMs < availableStartMs) assessStartMs = availableStartMs;
  if (assessEndMs - assessStartMs > totalMs - warmupMs) {
    assessEndMs = dataEndMs;
    assessStartMs = availableStartMs;
  }

  tlState = { dataStartMs, dataEndMs, warmupMs, assessStartMs, assessEndMs };
  renderTimeline();
}

function renderTimeline() {
  if (!tlState) return;
  const { dataStartMs, dataEndMs, warmupMs, assessStartMs, assessEndMs } = tlState;
  const totalMs = dataEndMs - dataStartMs;
  if (totalMs <= 0) return;

  const $track = document.getElementById('tl-track');
  const trackW = $track.offsetWidth;
  if (!trackW) return;

  const warmupPct = (warmupMs / totalMs) * 100;
  document.getElementById('tl-warmup').style.width = warmupPct + '%';

  const barLeftPct = ((assessStartMs - dataStartMs) / totalMs) * 100;
  const barWidthPct = ((assessEndMs - assessStartMs) / totalMs) * 100;

  const $bar = document.getElementById('tl-bar');
  $bar.style.left = barLeftPct + '%';
  $bar.style.width = barWidthPct + '%';

  document.getElementById('tl-bar-label').textContent = fmtDate(assessStartMs) + ' \u2192 ' + fmtDate(assessEndMs);

  const $ds = document.getElementById('tl-date-start');
  const $as = document.getElementById('tl-date-assess-start');
  const $ae = document.getElementById('tl-date-assess-end');
  const $de = document.getElementById('tl-date-end');

  $ds.textContent = fmtDate(dataStartMs);
  $ds.style.left = '0';

  $as.textContent = fmtDate(assessStartMs);
  $as.style.left = barLeftPct + '%';

  $ae.textContent = fmtDate(assessEndMs);
  $ae.style.left = (barLeftPct + barWidthPct) + '%';
  $ae.style.transform = 'translateX(-100%)';

  $de.textContent = fmtDate(dataEndMs);
  $de.style.right = '0';

  // Hide edge labels when they overlap with the bar labels
  $ds.style.display = barLeftPct > 12 ? '' : 'none';
  $de.style.display = (barLeftPct + barWidthPct) < 88 ? '' : 'none';
}

// Drag logic
(function setupDrag() {
  const $bar = document.getElementById('tl-bar');
  const $track = document.getElementById('tl-track');
  let dragging = false;
  let dragStartX = 0;
  let dragStartLeft = 0;

  $bar.addEventListener('mousedown', (e) => {
    if (!tlState) return;
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX;
    const trackW = $track.offsetWidth;
    const totalMs = tlState.dataEndMs - tlState.dataStartMs;
    dragStartLeft = tlState.assessStartMs - tlState.dataStartMs;
    $bar.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging || !tlState) return;
    const trackW = $track.offsetWidth;
    const totalMs = tlState.dataEndMs - tlState.dataStartMs;
    const pxPerMs = totalMs / trackW;
    const deltaMs = (e.clientX - dragStartX) * pxPerMs;

    const barDurationMs = tlState.assessEndMs - tlState.assessStartMs;
    const minStartMs = tlState.dataStartMs + tlState.warmupMs;
    const maxStartMs = tlState.dataEndMs - barDurationMs;

    let newStartMs = tlState.dataStartMs + dragStartLeft + deltaMs;
    newStartMs = Math.max(minStartMs, Math.min(maxStartMs, newStartMs));

    tlState.assessStartMs = newStartMs;
    tlState.assessEndMs = newStartMs + barDurationMs;
    renderTimeline();
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      $bar.classList.remove('dragging');
    }
  });
})();

function updateTimelineOnChange() {
  if (!tlState) { initTimeline(); return; }

  const warmupMs = getWarmupMs();
  const periodKey = document.getElementById('modal-period').value;
  const periodMs = PERIOD_DAYS[periodKey] * 86400000;
  const range = getSelectedSymbolRange();
  if (!range) { initTimeline(); return; }

  tlState.dataStartMs = range.startMs;
  tlState.dataEndMs = range.endMs;
  tlState.warmupMs = warmupMs;

  const availableStartMs = tlState.dataStartMs + warmupMs;
  const maxDuration = tlState.dataEndMs - availableStartMs;
  const barDuration = Math.min(periodMs, maxDuration);

  if (tlState.assessStartMs < availableStartMs) {
    tlState.assessStartMs = availableStartMs;
  }
  tlState.assessEndMs = tlState.assessStartMs + barDuration;
  if (tlState.assessEndMs > tlState.dataEndMs) {
    tlState.assessEndMs = tlState.dataEndMs;
    tlState.assessStartMs = tlState.assessEndMs - barDuration;
  }
  if (tlState.assessStartMs < availableStartMs) {
    tlState.assessStartMs = availableStartMs;
  }

  renderTimeline();
}

document.getElementById('modal-period').addEventListener('change', updateTimelineOnChange);

document.getElementById('modal-intervals').addEventListener('change', () => {
  updateTimelineOnChange();
});

document.getElementById('modal-symbols').addEventListener('change', () => {
  initTimeline();
});

document.getElementById('btn-new-run').addEventListener('click', async () => {
  const res = await fetch('/api/symbols');
  const data = await res.json();
  symbolsData = data.symbols;
  const container = document.getElementById('modal-symbols');

  if (data.symbols.length === 0) {
    alert('No data ingested. Go to the Data page first.');
    return;
  }

  container.innerHTML = data.symbols.map(s =>
    `<label><input type="checkbox" value="${s.symbol}" checked>${s.symbol}</label>`
  ).join('');

  $modal.classList.add('active');
  requestAnimationFrame(() => {
    initTimeline();
    const periodKey = document.getElementById('modal-period').value;
    if (!PERIOD_DAYS[periodKey]) document.getElementById('modal-period').value = '5y';
    initTimeline();
  });
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  $modal.classList.remove('active');
});

document.getElementById('modal-islands').addEventListener('input', (e) => {
  document.getElementById('island-options').style.display =
    parseInt(e.target.value) > 1 ? '' : 'none';
});

document.getElementById('modal-start').addEventListener('click', async () => {
  const symbols = [...document.querySelectorAll('#modal-symbols input:checked')].map(i => i.value);
  const intervals = [...document.querySelectorAll('#modal-intervals input:checked')].map(i => i.value);
  const populationSize = parseInt(document.getElementById('modal-pop').value) || 80;
  const generations = parseInt(document.getElementById('modal-gen').value) || 80;
  const numIslands = parseInt(document.getElementById('modal-islands').value) || 4;
  const migrationInterval = parseInt(document.getElementById('modal-mig-interval').value) || 0;
  const migrationCount = parseInt(document.getElementById('modal-mig-count').value) || 3;
  const migrationTopology = document.getElementById('modal-topology').value || 'ring';

  if (symbols.length === 0 || intervals.length === 0) {
    alert('Select at least one symbol and one interval.');
    return;
  }

  if (!tlState) {
    alert('No valid date range. Check symbol data.');
    return;
  }

  const startDate = fmtDate(tlState.assessStartMs);
  const endDate = fmtDate(tlState.assessEndMs);

  $modal.classList.remove('active');

  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, intervals, startDate, endDate, populationSize, generations, numIslands, migrationInterval, migrationCount, migrationTopology }),
    });
    const data = await res.json();
    console.log('Queued', data.totalRuns, 'runs:', data.runIds);
    loadRuns();
    loadQueue();
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

$modal.addEventListener('click', (e) => {
  if (e.target === $modal) $modal.classList.remove('active');
});

// ─── TradingView Bridge ────────────────────────────────────

window.sendToTV = async (runId) => {
  const btn = document.getElementById(`btn-tv-${runId}`);
  const status = document.getElementById(`tv-status-${runId}`);
  const resultDiv = document.getElementById(`tv-result-${runId}`);

  btn.disabled = true;
  btn.textContent = 'Connecting...';
  status.textContent = '';
  status.style.color = '#8b949e';
  resultDiv.style.display = 'none';

  try {
    // Fetch run details to get gene + symbol
    const runRes = await fetch(`/api/runs/${runId}`);
    const run = await runRes.json();

    let gene = run.best_gene;
    if (typeof gene === 'string') gene = JSON.parse(gene);
    if (!gene) throw new Error('No gene config found for this run');

    btn.textContent = 'Setting inputs...';

    const res = await fetch('/api/tv/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gene, symbol: run.symbol, timeframe: run.timeframe, startDate: run.start_date, endDate: run.config?.endDate }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to send to TV');

    btn.textContent = 'Send to TV';
    btn.disabled = false;

    if (data.tvMetrics) {
      const tv = data.tvMetrics;
      // Use live JS re-evaluation if available, fall back to cached GA metrics
      let gaMetrics = data.jsMetrics || run.best_metrics;
      if (typeof gaMetrics === 'string') gaMetrics = JSON.parse(gaMetrics);

      const gaProfit = gaMetrics?.netProfit;
      const tvProfit = tv.netProfit;
      const diff = gaProfit ? ((tvProfit - gaProfit) / Math.abs(gaProfit) * 100).toFixed(1) : null;
      const diffColor = Math.abs(diff) < 15 ? '#3fb950' : Math.abs(diff) < 30 ? '#d29922' : '#f85149';

      status.innerHTML = `<span style="color:${tvProfit >= 0 ? '#3fb950' : '#f85149'}">TV: $${Math.round(tvProfit).toLocaleString()}</span>` +
        (diff ? ` <span style="color:${diffColor}">(${diff > 0 ? '+' : ''}${diff}%)</span>` : '');

      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <table style="font-size:12px;max-width:600px">
          <thead><tr><th>Metric</th><th class="num">GA Optimizer</th><th class="num">TradingView</th><th class="num">Delta</th></tr></thead>
          <tbody>
            ${compareRow('Net Profit', gaProfit, tvProfit, v => '$' + Math.round(v).toLocaleString())}
            ${compareRow('Total Trades', gaMetrics?.trades, tv.totalTrades, v => v)}
            ${compareRow('Win Rate', gaMetrics?.winRate, tv.percentProfitable, v => (v * 100).toFixed(1) + '%')}
            ${compareRow('Profit Factor', gaMetrics?.pf, tv.profitFactor, v => v?.toFixed(2))}
            ${compareRow('Max Drawdown', gaMetrics?.maxDDPct, tv.maxDrawDownPercent, v => (v * 100).toFixed(1) + '%')}
            ${compareRow('Sharpe Ratio', gaMetrics?.sharpe, tv.sharpeRatio, v => v?.toFixed(2))}
          </tbody>
        </table>
        <div style="font-size:11px;color:#8b949e;margin-top:6px">Chart: ${data.chartInfo?.symbol} @ ${data.chartInfo?.resolution} | ${data.inputsChanged?.length || 0} inputs changed</div>
      `;
    } else {
      status.textContent = 'Inputs set, but could not read metrics';
      status.style.color = '#d29922';
    }
  } catch (err) {
    btn.textContent = 'Send to TV';
    btn.disabled = false;
    status.textContent = err.message;
    status.style.color = '#f85149';
  }
};

function compareRow(label, gaVal, tvVal, fmt) {
  const gaStr = gaVal != null ? fmt(gaVal) : '-';
  const tvStr = tvVal != null ? fmt(tvVal) : '-';
  let delta = '-';
  let deltaColor = '#8b949e';
  if (gaVal != null && tvVal != null && gaVal !== 0) {
    const pct = ((tvVal - gaVal) / Math.abs(gaVal) * 100).toFixed(1);
    delta = (pct > 0 ? '+' : '') + pct + '%';
    deltaColor = Math.abs(pct) < 15 ? '#3fb950' : Math.abs(pct) < 30 ? '#d29922' : '#f85149';
  }
  return `<tr><td>${label}</td><td class="num">${gaStr}</td><td class="num">${tvStr}</td><td class="num" style="color:${deltaColor}">${delta}</td></tr>`;
}

// Check TV connection on load
(async () => {
  try {
    const res = await fetch('/api/tv/status');
    const data = await res.json();
    const badge = document.getElementById('tv-badge');
    if (badge) {
      badge.style.display = '';
      badge.textContent = data.connected ? 'TV Connected' : 'TV Offline';
      badge.className = 'badge ' + (data.connected ? 'completed' : 'failed');
    }
  } catch {}
})();

// ─── Init ───────────────────────────────────────────────────
loadSymbols();
loadRuns();
loadQueue();

// Refresh periodically
setInterval(loadSymbols, 30000);
setInterval(loadRuns, 10000);
