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
    case 'run_status':
      onRunStatus(msg);
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

// ─── Phase 4.5b: compare-runs state + wiring ───────────────────
//
// UX: user clicks "Select to compare" → runs-table reveals a
// checkbox column (`.compare-col` `display:none` default, flipped via
// compareMode). When 2+ rows are checked, the "Compare (N)" button
// lights up and navigates to `#compare?ids=a,b`. The URL is the
// single source of truth for which runs are on screen — so the
// comparison is shareable/bookmarkable and Back works normally.
//
// Rebuilds of the runs table (auto-refresh every 10s, or after a
// new-run completion) re-apply compareMode via applyCompareModeToTable()
// at the tail of loadRuns, so the checkbox column doesn't vanish
// mid-selection. Selection state lives in `selectedRunIds` (Set) and
// survives rebuilds — checkboxes render `checked` for ids in the Set.
const selectedRunIds = new Set();
let compareMode = false;

function applyCompareModeToTable() {
  const show = compareMode;
  document.querySelectorAll('#runs-table .compare-col')
    .forEach(el => { el.style.display = show ? '' : 'none'; });
  const toggleBtn = document.getElementById('btn-compare-toggle');
  if (toggleBtn) toggleBtn.textContent = show ? 'Cancel select' : 'Select to compare';
}

function updateCompareButtons() {
  const n = selectedRunIds.size;
  const countEl = document.getElementById('compare-count');
  if (countEl) countEl.textContent = n;
  const goBtn = document.getElementById('btn-compare-go');
  const hint  = document.getElementById('compare-hint');
  if (!compareMode) {
    if (goBtn) goBtn.style.display = 'none';
    if (hint)  hint.style.display  = 'none';
  } else if (n >= 2) {
    if (goBtn) goBtn.style.display = '';
    if (hint)  hint.style.display  = 'none';
  } else {
    if (goBtn) goBtn.style.display = 'none';
    if (hint)  hint.style.display  = '';
  }
}

document.getElementById('btn-compare-toggle')?.addEventListener('click', () => {
  compareMode = !compareMode;
  if (!compareMode) {
    // Leaving compare mode clears the selection — "Cancel select" is
    // a reset, not just a hide. Otherwise a stale Set would resurface
    // next time the user re-enters compare mode.
    selectedRunIds.clear();
    document.querySelectorAll('.compare-row-check').forEach(cb => { cb.checked = false; });
  }
  applyCompareModeToTable();
  updateCompareButtons();
});

// Per-row checkbox changes via event delegation. The tbody is rebuilt
// on every loadRuns(); delegating avoids re-binding N listeners each
// refresh.
document.querySelector('#runs-table tbody')?.addEventListener('change', (e) => {
  const cb = e.target.closest('.compare-row-check');
  if (!cb) return;
  const id = Number(cb.dataset.runId);
  if (!Number.isFinite(id)) return;
  if (cb.checked) selectedRunIds.add(id);
  else selectedRunIds.delete(id);
  updateCompareButtons();
});

document.getElementById('compare-select-all')?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  document.querySelectorAll('.compare-row-check').forEach(cb => {
    cb.checked = checked;
    const id = Number(cb.dataset.runId);
    if (!Number.isFinite(id)) return;
    if (checked) selectedRunIds.add(id);
    else selectedRunIds.delete(id);
  });
  updateCompareButtons();
});

document.getElementById('btn-compare-go')?.addEventListener('click', () => {
  // MVP is 2-way — take the two lowest-numbered selections for a
  // deterministic URL. 3+ way compare deferred to 4.5c.
  const ids = [...selectedRunIds].sort((a, b) => a - b).slice(0, 2);
  if (ids.length < 2) return;
  location.hash = `#compare?ids=${ids.join(',')}`;
});

// Hash routing — #compare?ids=a,b opens the compare page. Separate
// branch from the standard nav-link router because this route carries
// query args (ids) and triggers an async fetch.
function routeCompareFromHash() {
  const hash = location.hash;
  if (!hash.startsWith('#compare')) return false;
  const m = hash.match(/ids=([^&]+)/);
  if (!m) return false;
  const ids = m[1].split(',').map(Number).filter(Number.isFinite);
  if (ids.length < 2) return false;
  openCompare(ids);
  return true;
}

window.addEventListener('hashchange', routeCompareFromHash);
// Initial route (e.g. user pasted a #compare URL).
routeCompareFromHash();

window.closeCompare = () => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-optimizer').classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.querySelector('[data-page="optimizer"]').classList.add('active');
  document.getElementById('nav-compare').style.display = 'none';
  history.pushState(null, '', '#optimizer');
};

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
  const phase = msg.phase === 'backfill' ? ' [backfill]' : '';
  $ingestStatus.textContent = `${msg.symbol}${phase}: ${msg.fetched.toLocaleString()} / ~${msg.total.toLocaleString()} candles (${msg.pct}%)`;
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

function onRunStatus(msg) {
  document.getElementById('live-gen').textContent = msg.detail;
}

function onGeneration(msg) {
  const pct = Math.round(msg.gen / msg.totalGens * 100);
  document.getElementById('live-progress-fill').style.width = pct + '%';
  const genText = (msg.minGen != null && msg.minGen !== msg.maxGen)
    ? `${msg.minGen}-${msg.maxGen} / ${msg.totalGens}`
    : `${msg.gen} / ${msg.totalGens}`;
  document.getElementById('live-gen').textContent = genText;
  const m_ = msg.metrics;
  const totalProfit = m_?.netProfit ?? 0;
  const netProfitPct = m_?.netProfitPct ?? 0;
  const years = msg.periodYears || 1;
  const annualized = (Math.pow(1 + netProfitPct, 1 / years) - 1) * 100;
  document.getElementById('live-best').innerHTML =
    `${annualized.toFixed(2)}%<span style="font-size:12px;color:#8b949e;display:block">$${Math.round(totalProfit).toLocaleString()} total</span>`;
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

  // Island / planet info
  const totalIslands = (msg.numPlanets || 1) * (msg.numIslands || 1);
  if (totalIslands > 1) {
    document.getElementById('live-islands-stat').style.display = '';
    document.getElementById('live-migrations-stat').style.display = '';
    const islandLabel = msg.numPlanets > 1
      ? `${msg.numPlanets}p × ${msg.numIslands}i`
      : msg.numIslands;
    document.getElementById('live-islands').textContent = islandLabel;
    const migLabel = msg.numPlanets > 1
      ? `${msg.totalMigrations}m / ${msg.totalSpaceTravels ?? 0}st`
      : msg.totalMigrations;
    document.getElementById('live-migrations').textContent = migLabel;
    if (msg.islands) renderIslandViz(msg);
  }

  // Abort status feedback
  if (msg.aborting) {
    const btn = document.getElementById('btn-abort');
    btn.disabled = true;
    btn.textContent = 'Aborting...';
    const titleEl = document.getElementById('live-title');
    if (!titleEl.textContent.includes('ABORTING')) {
      titleEl.textContent += ' — ABORTING';
    }
    // Show abort status in the generation field
    if (msg.abortStatus) {
      document.getElementById('live-gen').textContent = msg.abortStatus;
    }
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

window.triggerSuperMutator = async () => {
  if (!activeRunId) return;
  const btn = document.getElementById('btn-super-mutator');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '⚡ Firing...';
  try {
    await fetch(`/api/runs/${activeRunId}/hypermutate`, { method: 'POST' });
    // Re-enable after a short cooldown — the worker's per-island cooldown
    // already prevents spam at the evolution layer.
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = originalText;
    }, 1500);
  } catch (err) {
    console.error('Super Mutator failed:', err);
    btn.disabled = false;
    btn.textContent = originalText;
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

  const numPlanets = msg.numPlanets || 1;
  const numIslandsPerPlanet = msg.numIslands || n;

  // ── Multi-planet grid layout ──────────────────────────────
  if (numPlanets > 1) {
    renderPlanetGrid(msg, svg, numPlanets, numIslandsPerPlanet);
    return;
  }

  // ── Single-planet ellipse layout ─────────────────────────
  const W = svg.clientWidth || 500;
  const H = 220;
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const nodeR = 28;
  const cx = W / 2, cy = H / 2;
  const rx = Math.min(W * 0.38, 190);
  const ry = Math.min(H * 0.38, 70);
  const nodes = msg.islands.map((isl, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return { ...isl, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

  let bestIdx = 0, bestProfit = -Infinity;
  for (const nd of nodes) {
    if (nd.profit != null && nd.profit > bestProfit) { bestProfit = nd.profit; bestIdx = nd.idx; }
  }

  let html = `<defs>
    <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,3 L0,6 z" fill="#30363d"/>
    </marker>
    <marker id="arrow-hl" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,3 L0,6 z" fill="#58a6ff"/>
    </marker>
  </defs>`;

  const edges = msg.edges || [];
  if (edges.length > 0) {
    for (const [from, to] of edges) {
      const a = nodes[from], b = nodes[to];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      const isBestEdge = from === bestIdx;
      html += `<line x1="${a.x + ux*(nodeR+2)}" y1="${a.y + uy*(nodeR+2)}" x2="${b.x - ux*(nodeR+4)}" y2="${b.y - uy*(nodeR+4)}" stroke="${isBestEdge ? '#58a6ff' : '#30363d'}" stroke-width="${isBestEdge ? 1.5 : 1}" marker-end="url(#${isBestEdge ? 'arrow-hl' : 'arrow'})" opacity="${isBestEdge ? 0.8 : 0.5}"/>`;
    }
  } else if (msg.topology === 'random') {
    for (let i = 0; i < n; i++) {
      const a = nodes[i], b = nodes[(i+1)%n];
      const dx = b.x-a.x, dy = b.y-a.y, dist = Math.sqrt(dx*dx+dy*dy);
      if (dist < 1) continue;
      const ux = dx/dist, uy = dy/dist;
      html += `<line x1="${a.x+ux*(nodeR+2)}" y1="${a.y+uy*(nodeR+2)}" x2="${b.x-ux*(nodeR+4)}" y2="${b.y-uy*(nodeR+4)}" stroke="#30363d" stroke-width="1" stroke-dasharray="4,4" opacity="0.3"/>`;
    }
  }

  for (const nd of nodes) {
    const isBest = nd.idx === bestIdx;
    const profitStr = nd.profit != null ? '$' + Math.round(nd.profit).toLocaleString() : '-';
    html += `<circle cx="${nd.x}" cy="${nd.y}" r="${nodeR}" fill="${isBest ? '#1f6feb33' : '#21262d'}" stroke="${isBest ? '#58a6ff' : '#30363d'}" stroke-width="${isBest ? 2 : 1}"/>`;
    html += `<text x="${nd.x}" y="${nd.y-10}" text-anchor="middle" fill="${isBest ? '#58a6ff' : '#8b949e'}" font-size="9" font-weight="600">#${nd.idx}</text>`;
    html += `<text x="${nd.x}" y="${nd.y+3}" text-anchor="middle" fill="${nd.profit > 0 ? '#3fb950' : nd.profit != null ? '#f85149' : '#8b949e'}" font-size="9" font-weight="700">${profitStr}</text>`;
    if (nd.trades != null) html += `<text x="${nd.x}" y="${nd.y+14}" text-anchor="middle" fill="#8b949e" font-size="8">${nd.trades}t</text>`;
    if (nd.gen != null) html += `<text x="${nd.x}" y="${nd.y+23}" text-anchor="middle" fill="#6e7681" font-size="7">g${nd.gen}</text>`;
  }

  const topoLabel = msg.topology === 'ring' ? 'Ring' : msg.topology === 'torus' ? 'Torus' : 'Random';
  html += `<text x="${W-8}" y="14" text-anchor="end" fill="#8b949e" font-size="10">${topoLabel} topology</text>`;
  svg.innerHTML = html;
}

// ─── Planet Grid ───────────────────────────────────────────
function renderPlanetGrid(msg, svg, numPlanets, numIslandsPerPlanet) {
  const PLANET_COLORS = [
    '#58a6ff', '#3fb950', '#f0883e', '#d2a8ff',
    '#79c0ff', '#56d364', '#ffa657', '#bc8cff',
  ];

  // Grid dimensions
  const cols = numPlanets <= 2 ? 2 : numPlanets <= 4 ? 2 : numPlanets <= 6 ? 3 : 4;
  const rows = Math.ceil(numPlanets / cols);

  const W = svg.clientWidth || 800;
  const PAD = 12;
  const GAP = 10;
  const cellW = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const dotRows = numIslandsPerPlanet > 4 ? 2 : 1;
  const cellH = 160 + dotRows * 38;
  const H = PAD * 2 + rows * cellH + GAP * (rows - 1);

  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Build per-planet data from islands. Mutation factors (if present on
  // msg.planets[p]) are randomized per planet at optimizer start and
  // surface here for UI display.
  const planetMeta = msg.planets || [];
  const planetData = Array.from({ length: numPlanets }, (_, p) => {
    const planetIslands = msg.islands.filter(isl => (isl.planetIdx ?? Math.floor(isl.idx / numIslandsPerPlanet)) === p);
    let bestProfit = null, bestTrades = null, bestPf = null, maxGen = 0;
    let maxHyperActive = 0, hyperSource = null;
    for (const isl of planetIslands) {
      if (isl.profit != null && (bestProfit == null || isl.profit > bestProfit)) {
        bestProfit = isl.profit;
        bestTrades = isl.trades;
        bestPf = isl.pf;
      }
      if (isl.gen != null && isl.gen > maxGen) maxGen = isl.gen;
      if ((isl.hyperActive ?? 0) > maxHyperActive) {
        maxHyperActive = isl.hyperActive;
        hyperSource = isl.hyperSource;
      }
    }
    const meta = planetMeta[p] || {};
    return {
      p, islands: planetIslands, bestProfit, bestTrades, bestPf, maxGen,
      maxHyperActive, hyperSource,
      mutationRate: meta.mutationRate ?? null,
      perGeneMut: meta.perGeneMut ?? null,
      mutationMul: meta.mutationMul ?? null,
      frozenGenes: meta.frozenGenes ?? null,
    };
  });

  // Find global best planet
  let globalBestP = 0, globalBestProfit = -Infinity;
  for (const pd of planetData) {
    if (pd.bestProfit != null && pd.bestProfit > globalBestProfit) {
      globalBestProfit = pd.bestProfit;
      globalBestP = pd.p;
    }
  }

  let html = `<defs>
    <marker id="arrow-travel" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="7" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,3 L0,6 z" fill="#d2a8ff"/>
    </marker>
  </defs>`;

  // Cell positions lookup for space travel arrows
  const cellCentres = [];

  for (let p = 0; p < numPlanets; p++) {
    const col = p % cols;
    const row = Math.floor(p / cols);
    const x = PAD + col * (cellW + GAP);
    const y = PAD + row * (cellH + GAP);
    const color = PLANET_COLORS[p % PLANET_COLORS.length];
    const pd = planetData[p];
    const isBest = p === globalBestP;

    cellCentres.push({ x: x + cellW / 2, y: y + cellH / 2 });

    // Cell background
    html += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="8"
      fill="${isBest ? color + '18' : '#161b22'}"
      stroke="${isBest ? color : color + '40'}"
      stroke-width="${isBest ? 1.5 : 1}"/>`;

    // Planet label
    html += `<text x="${x+12}" y="${y+20}" fill="${color}" font-size="11" font-weight="700">Planet ${p}</text>`;

    // Mutation factor badge — randomized per planet at optimizer start.
    // Anchored top-right of the card, under the optional BEST badge row.
    if (pd.mutationRate != null) {
      const mutPct = Math.round(pd.mutationRate * 100);
      const genePct = pd.perGeneMut != null ? Math.round(pd.perGeneMut * 100) : null;
      const mulStr = pd.mutationMul != null ? `×${pd.mutationMul.toFixed(2)}` : '';
      const mutText = genePct != null
        ? `μ ${mutPct}% · g ${genePct}%  ${mulStr}`
        : `μ ${mutPct}%  ${mulStr}`;
      html += `<text x="${x+12}" y="${y+34}" fill="#8b949e" font-size="9" font-family="monospace">${mutText}</text>`;
    }

    // Knockout badge — frozen gene(s) for this planet's ablation run.
    // Control planet shows no badge; knockout planets show e.g. "🚫 rsiLen=14".
    if (pd.frozenGenes) {
      const parts = Object.entries(pd.frozenGenes).map(([k, v]) => `${k}=${v}`);
      const knockText = `🚫 ${parts.join(', ')}`;
      html += `<text x="${x+12}" y="${y+46}" fill="#ff7b72" font-size="9" font-family="monospace">${knockText}</text>`;
    }

    // Best profit — large
    const profitStr = pd.bestProfit != null ? '$' + Math.round(pd.bestProfit).toLocaleString() : '—';
    const profitColor = pd.bestProfit == null ? '#8b949e' : pd.bestProfit >= 0 ? '#3fb950' : '#f85149';
    html += `<text x="${x + cellW/2}" y="${y+62}" text-anchor="middle" fill="${profitColor}" font-size="22" font-weight="700">${profitStr}</text>`;

    // Generation
    const genStr = `Gen ${pd.maxGen} / ${msg.totalGens}`;
    html += `<text x="${x + cellW/2}" y="${y+82}" text-anchor="middle" fill="#8b949e" font-size="11">${genStr}</text>`;

    // Hypermutation countdown badge — pulses when an event is in flight.
    // Shows source (manual via Super Mutator button vs auto via diversity collapse).
    // Anchored top-right; shifts left by 48px if BEST badge also occupies that slot.
    if (pd.maxHyperActive > 0) {
      const label = pd.hyperSource === 'manual' ? 'SUPER' : 'AUTO';
      const badgeW = 76;
      const shiftLeft = isBest ? 48 : 0;
      const badgeX = x + cellW - badgeW - 8 - shiftLeft;
      const badgeY = y + 6;
      html += `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="14" rx="3" fill="#b26cff22" stroke="#b26cff" stroke-width="1">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="1s" repeatCount="indefinite"/>
      </rect>`;
      html += `<text x="${badgeX + badgeW/2}" y="${badgeY + 10}" text-anchor="middle" fill="#d2a8ff" font-size="9" font-weight="700" font-family="monospace">⚡ ${label} ${pd.maxHyperActive}/5</text>`;
    }

    // Trades + PF
    const statsStr = pd.bestTrades != null
      ? `${pd.bestTrades} trades${pd.bestPf != null ? '  ·  PF ' + pd.bestPf.toFixed(2) : ''}`
      : 'Warming up…';
    html += `<text x="${x + cellW/2}" y="${y+99}" text-anchor="middle" fill="#6e7681" font-size="10">${statsStr}</text>`;

    // Island dots — arranged in 1 or 2 rows to keep them readable
    const dotCount = pd.islands.length;
    const perRow = dotRows === 2 ? Math.ceil(dotCount / 2) : dotCount;
    const dotR = Math.min(16, Math.floor((cellW - 24) / (perRow * 2.5)));
    const dotSpacing = Math.min(dotR * 2.6, (cellW - 24) / perRow);
    const rowBaseY = y + cellH - (dotRows === 2 ? 60 : 28);

    // Find leading island index within this planet
    let leadingIslandIdx = -1, leadingProfit = -Infinity;
    for (let i = 0; i < dotCount; i++) {
      const isl = pd.islands[i];
      if (isl.profit != null && isl.profit > leadingProfit) {
        leadingProfit = isl.profit;
        leadingIslandIdx = i;
      }
    }

    for (let i = 0; i < dotCount; i++) {
      const row = dotRows === 2 ? Math.floor(i / perRow) : 0;
      const col = i % perRow;
      const rowCount = row === 0 ? Math.min(perRow, dotCount) : dotCount - perRow;
      const rowWidth = (rowCount - 1) * dotSpacing;
      const dx = x + cellW / 2 - rowWidth / 2 + col * dotSpacing;
      const dy = rowBaseY + row * (dotR * 2 + 6);

      const isl = pd.islands[i];
      const isLeading = i === leadingIslandIdx;
      const dotColor = isl.profit == null ? '#30363d' : isl.profit >= 0 ? '#3fb950' : '#f85149';
      const dotFill = isLeading
        ? (isl.profit >= 0 ? '#3fb95050' : '#f8514950')
        : (isl.profit == null ? '#21262d' : isl.profit >= 0 ? '#3fb95028' : '#f8514928');
      html += `<circle cx="${dx}" cy="${dy}" r="${dotR}" fill="${dotFill}" stroke="${dotColor}" stroke-width="${isLeading ? 3 : 1.5}"/>`;
      if (isLeading) {
        // Outer pulse ring
        html += `<circle cx="${dx}" cy="${dy}" r="${dotR + 4}" fill="none" stroke="${dotColor}" stroke-width="1.5" opacity="0.35"/>`;
      }
      if (isl.profit != null) {
        const k = Math.abs(isl.profit) >= 1000
          ? '$' + (isl.profit / 1000).toFixed(isl.profit < 10000 ? 1 : 0) + 'k'
          : '$' + Math.round(isl.profit);
        const fs = Math.max(6, Math.min(9, dotR * 0.62));
        html += `<text x="${dx}" y="${dy + fs * 0.38}" text-anchor="middle" fill="${isLeading ? '#ffffff' : dotColor}" font-size="${fs}" font-weight="700">${k}</text>`;
      }
    }

    // "best" badge
    if (isBest) {
      html += `<rect x="${x + cellW - 44}" y="${y + 6}" width="38" height="14" rx="3" fill="${color}33"/>`;
      html += `<text x="${x + cellW - 25}" y="${y + 16}" text-anchor="middle" fill="${color}" font-size="8" font-weight="700">BEST</text>`;
    }
  }

  // Space travel arrows between grid cells
  if ((msg.totalSpaceTravels ?? 0) > 0) {
    const drawn = new Set();
    for (let p = 0; p < numPlanets; p++) {
      const target = (p + 1) % numPlanets;
      const key = `${Math.min(p, target)}-${Math.max(p, target)}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const a = cellCentres[p], b = cellCentres[target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      const margin = 20;
      html += `<line x1="${a.x + ux*margin}" y1="${a.y + uy*margin}" x2="${b.x - ux*margin}" y2="${b.y - uy*margin}"
        stroke="#d2a8ff" stroke-width="1.5" stroke-dasharray="5,4"
        marker-end="url(#arrow-travel)" opacity="0.5"/>`;
    }
  }

  // Footer label
  const topoLabel = msg.topology === 'ring' ? 'Ring' : msg.topology === 'torus' ? 'Torus' : 'Random';
  html += `<text x="${W-8}" y="${H-6}" text-anchor="end" fill="#8b949e" font-size="10">${topoLabel} · ${numPlanets} planets · ${msg.totalSpaceTravels ?? 0} space travels</text>`;

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

      const isChecked = selectedRunIds.has(r.id) ? 'checked' : '';
      return `
        <tr onclick="toggleRunDetails(${r.id})" style="cursor:pointer" data-run-id="${r.id}">
          <td class="compare-col" style="display:none" onclick="event.stopPropagation()">
            <input type="checkbox" class="compare-row-check" data-run-id="${r.id}" ${isChecked} />
          </td>
          <td><span style="font-family:monospace;font-weight:700;color:#58a6ff">#${r.id}</span></td>
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
          <td><button onclick="event.stopPropagation();openRunDetail(${r.id})" style="font-size:11px;padding:2px 8px">Detail →</button></td>
        </tr>
        <tr class="expand-row" id="expand-${r.id}"><td colspan="16" id="expand-content-${r.id}">Loading...</td></tr>
      `;
    }).join('');

    // Phase 4.5b: if compare mode was on before the table rebuilt (e.g.
    // the auto-refresh interval fired), re-apply it so the user doesn't
    // lose their selection context. Hooked after innerHTML so the freshly-
    // added <td> cells get revealed.
    if (compareMode) applyCompareModeToTable();
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
      // Spec-mode runs carry a spec_hash and use qualified-ID gene keys
      // (e.g. "emaTrend.main.emaFast"); legacy GA runs use flat keys
      // (e.g. "emaFast"). The winner-config summary and "Send to TV"
      // button only make sense for legacy runs — the TV bridge pushes
      // into a hardcoded JM Simple 3TP Pine template whose input names
      // don't match spec-mode block IDs. Branch here so spec-mode runs
      // get a readable summary instead of "undefined undefined undefined"
      // and don't offer a broken TV button.
      const isSpecMode = !!run.spec_hash;
      html += `<div style="margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span>
          <strong>Winner config:</strong>
          ${formatWinnerConfig(gene, isSpecMode)}
        </span>`;
      if (isSpecMode) {
        html += `<button onclick="pushToTV(${id})" class="primary btn-tv" id="btn-tv-${id}" style="font-size:11px;padding:3px 10px;white-space:nowrap"
          title="Generate Pine indicator from the winning gene and push to TradingView Desktop">Send to TV</button>`;
      } else {
        html += `<button onclick="sendToTV(${id})" class="primary btn-tv" id="btn-tv-${id}" style="font-size:11px;padding:3px 10px;white-space:nowrap">Send to TV</button>`;
      }
      html += `
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

// Phase 4.3b: spec picker state. Keyed by filename so the POST body
// can include the exact server-resolvable string. `specs[filename]`
// holds { name, description, sizeBytes, mtime } for the description
// line under the picker.
let specsByFilename = {};

/**
 * Populate the `#modal-spec` <select> from GET /api/specs.
 * Graceful degradation: on error, keep only the "None (legacy mode)"
 * option and log to console — a spec-less run is always valid.
 * `malformed[]` entries become a small red warning under the picker.
 */
async function loadSpecsIntoModal() {
  const $select = document.getElementById('modal-spec');
  const $warn = document.getElementById('modal-spec-warn');
  const $desc = document.getElementById('modal-spec-desc');
  specsByFilename = {};
  // Preserve the None option; wipe any previously-loaded spec options.
  $select.innerHTML = '<option value="">None (legacy mode)</option>';
  $warn.style.display = 'none';
  $warn.textContent = '';
  $desc.textContent = '';
  try {
    const r = await fetch('/api/specs');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    for (const s of data.specs || []) {
      specsByFilename[s.filename] = s;
      const opt = document.createElement('option');
      opt.value = s.filename;
      opt.textContent = s.name;
      $select.appendChild(opt);
    }
    if (Array.isArray(data.malformed) && data.malformed.length > 0) {
      $warn.textContent =
        `${data.malformed.length} spec file(s) failed to parse: ` +
        data.malformed.map(m => m.filename).join(', ');
      $warn.style.display = '';
    }
  } catch (err) {
    console.warn('loadSpecsIntoModal failed:', err.message);
    // Leave the picker with only "None" — the modal still works.
  }
}

// Show the picked spec's description beneath the picker. Re-renders on
// change. Empty string when "None" is selected.
document.getElementById('modal-spec').addEventListener('change', (e) => {
  const $desc = document.getElementById('modal-spec-desc');
  const s = specsByFilename[e.target.value];
  $desc.textContent = s?.description || '';
});

// Tab wiring for the New Run modal. Clicking a .tab-btn activates it and
// the matching .tab-panel (data-tab on the button === data-panel on the
// panel). All other panels are hidden via CSS (.tab-panel without .active).
// No state persists between opens — the modal always lands on "Simulation
// control" because that's the tab marked .active in index.html.
document.querySelectorAll('#modal-new-run .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    const scope = document.getElementById('modal-new-run');
    scope.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === target);
    });
    scope.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === target);
    });
  });
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

  // Refresh the spec picker every time the modal opens so newly-saved
  // specs show up without a page reload.
  await loadSpecsIntoModal();

  // Reset tab state to "Simulation control" on every open — otherwise the
  // last-clicked tab from a prior open sticks around, which is confusing
  // when the user expects a consistent starting view.
  {
    const scope = document.getElementById('modal-new-run');
    scope.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === 'sim');
    });
    scope.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === 'sim');
    });
    // Also reset .modal-body scroll so a tall prior session doesn't leave
    // us halfway down the form.
    const body = scope.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }

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

document.getElementById('modal-max-dd').addEventListener('input', (e) => {
  document.getElementById('max-dd-val').textContent = e.target.value;
});

document.getElementById('modal-islands').addEventListener('input', (e) => {
  document.getElementById('island-options').style.display =
    parseInt(e.target.value) > 1 ? '' : 'none';
});

// Planets=1 → Space Travel fields are visible but disabled (irrelevant
// with a single planet). Planets>1 → enable them. We keep them in the DOM
// either way so the Planets tab isn't nearly-empty in single-planet mode.
document.getElementById('modal-planets').addEventListener('input', (e) => {
  const enabled = parseInt(e.target.value) > 1;
  document.getElementById('modal-space-interval').disabled = !enabled;
  document.getElementById('modal-space-count').disabled = !enabled;
});

document.getElementById('modal-start').addEventListener('click', async () => {
  const symbols = [...document.querySelectorAll('#modal-symbols input:checked')].map(i => i.value);
  const intervals = [...document.querySelectorAll('#modal-intervals input:checked')].map(i => i.value);
  const populationSize = parseInt(document.getElementById('modal-pop').value) || 80;
  const generations = parseInt(document.getElementById('modal-gen').value) || 80;
  const numIslands = parseInt(document.getElementById('modal-islands').value) || 4;
  const numPlanets = parseInt(document.getElementById('modal-planets').value) || 1;
  const migrationInterval = parseInt(document.getElementById('modal-mig-interval').value) || 0;
  const migrationCount = parseInt(document.getElementById('modal-mig-count').value) || 3;
  const migrationTopology = document.getElementById('modal-topology').value || 'ring';
  const spaceTravelInterval = parseInt(document.getElementById('modal-space-interval').value) || 2;
  const spaceTravelCount = parseInt(document.getElementById('modal-space-count').value) || 1;
  const minTrades = parseInt(document.getElementById('modal-min-trades').value) || 30;
  const maxDrawdownPct = parseInt(document.getElementById('modal-max-dd').value) || 50;
  const knockoutMode = document.getElementById('modal-knockout-mode')?.value || 'none';
  const knockoutValueMode = document.getElementById('modal-knockout-value')?.value || 'midpoint';
  // Phase 4.3b: spec filename (under strategies/) or empty string for legacy mode.
  // Server-side POST /api/runs treats null/undefined/absent identically, but we
  // omit the key entirely when empty to keep legacy-mode POSTs byte-identical.
  const specFilename = document.getElementById('modal-spec')?.value || '';

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
    const body = {
      symbols, intervals, startDate, endDate,
      populationSize, generations,
      numIslands, numPlanets,
      migrationInterval, migrationCount, migrationTopology,
      spaceTravelInterval, spaceTravelCount,
      minTrades, maxDrawdownPct,
      knockoutMode, knockoutValueMode,
    };
    if (specFilename) body.spec = specFilename;
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

// ─── Spec-mode Pine push ─────────────────────────────────
// Generates a Pine indicator from the spec-mode winning gene
// and pushes it to TradingView Desktop via CDP.

window.pushToTV = async (runId) => {
  const btn = document.getElementById(`btn-tv-${runId}`);
  const status = document.getElementById(`tv-status-${runId}`);
  const resultDiv = document.getElementById(`tv-result-${runId}`);

  btn.disabled = true;
  btn.textContent = 'Generating...';
  status.textContent = '';
  status.style.color = '#8b949e';
  resultDiv.style.display = 'none';

  try {
    btn.textContent = 'Pushing to TV...';
    const res = await fetch(`/api/runs/${runId}/pine-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to push to TV');

    btn.textContent = 'Send to TV';
    btn.disabled = false;

    if (data.compileErrors && data.compileErrors.length > 0) {
      status.innerHTML = `<span style="color:#f85149">${data.compileErrors.length} compile error(s)</span>`;
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="font-size:12px;margin-bottom:6px"><strong>${data.title}</strong> — ${data.lines} lines</div>
        <div style="font-size:12px;color:#f85149">${data.compileErrors.map(e => `Line ${e.line}: ${e.msg}`).join('<br>')}</div>
        <div style="font-size:11px;color:#8b949e;margin-top:6px">File: ${data.filename} | Button: ${data.buttonClicked}</div>`;
    } else {
      status.innerHTML = `<span style="color:#3fb950">Pushed to TV</span>`;
      resultDiv.style.display = 'block';
      resultDiv.innerHTML = `
        <div style="font-size:12px"><strong>${data.title}</strong> — ${data.lines} lines, compiled clean</div>
        <div style="font-size:11px;color:#8b949e;margin-top:4px">File: ${data.filename} | Button: ${data.buttonClicked}</div>`;
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

// ─── Run Detail Page ─────────────────────────────────────────

const PARAM_LABELS = {
  minEntry:      { label: 'Min Entry Signals', unit: '',   desc: 'How many conditions must align to open a trade (1–3)' },
  stochLen:      { label: 'Stoch Length',      unit: '',   desc: 'Bars for stochastic %K calculation' },
  stochSmth:     { label: 'Stoch Smooth',      unit: '',   desc: 'SMA smoothing applied to %K and %D' },
  rsiLen:        { label: 'RSI Length',         unit: '',   desc: 'Bars for RSI calculation' },
  emaFast:       { label: 'EMA Fast',           unit: '',   desc: 'Fast EMA period (trend filter)' },
  emaSlow:       { label: 'EMA Slow',           unit: '',   desc: 'Slow EMA period (trend filter)' },
  bbLen:         { label: 'BB Length',          unit: '',   desc: 'Bollinger Band SMA period' },
  bbMult:        { label: 'BB Multiplier',      unit: 'σ',  desc: 'Standard deviation multiplier for BB width' },
  atrLen:        { label: 'ATR Length',         unit: '',   desc: 'Bars for ATR calculation' },
  atrSL:         { label: 'ATR Stop Loss',      unit: '×',  desc: 'SL distance = ATR × this value' },
  tp1Mult:       { label: 'TP1 Multiplier',     unit: '×',  desc: 'TP1 price = entry ± ATR × this value' },
  tp2Mult:       { label: 'TP2 Multiplier',     unit: '×',  desc: 'TP2 price = entry ± ATR × this value' },
  tp3Mult:       { label: 'TP3 Multiplier',     unit: '×',  desc: 'TP3 price = entry ± ATR × this value' },
  tp1Pct:        { label: 'TP1 Close %',        unit: '%',  desc: 'Position % closed at TP1' },
  tp2Pct:        { label: 'TP2 Close %',        unit: '%',  desc: 'Position % closed at TP2' },
  riskPct:       { label: 'Risk %',             unit: '%',  desc: 'Equity % at risk on full stop-out (position size = risk / stop distance)' },
  maxBars:       { label: 'Max Bars',           unit: '',   desc: 'Time-based exit: close if open longer than this many bars' },
  emergencySlPct:{ label: 'Emergency SL',       unit: '%',  desc: 'Hard intra-bar circuit-breaker stop loss' },
};

let detailRunId = null;
let detailTradeList = [];

window.openRunDetail = async (id) => {
  detailRunId = id;
  detailTradeList = [];

  // Show the page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById('page-run-detail').classList.add('active');
  document.getElementById('nav-run-detail').style.display = '';
  document.getElementById('nav-run-detail').classList.add('active');

  // Reset state
  document.getElementById('detail-title').textContent = 'Loading…';
  document.getElementById('detail-run-id').textContent = '';
  document.getElementById('detail-params').innerHTML = '';
  document.getElementById('recalc-status').textContent = '';
  document.getElementById('recalc-metrics').innerHTML = '';
  document.getElementById('detail-trades-card').style.display = 'none';
  document.getElementById('detail-charts-card').style.display = 'none';
  document.getElementById('detail-periodic-card').style.display = 'none';
  // Phase 4.5a — hide spec-mode-only cards until we know the run has data.
  document.getElementById('detail-fitness-card').style.display = 'none';
  document.getElementById('detail-wf-card').style.display = 'none';
  document.getElementById('detail-regime-card').style.display = 'none';
  document.getElementById('btn-recalc').disabled = false;

  try {
    const res = await fetch(`/api/runs/${id}`);
    const run = await res.json();

    let gene = run.best_gene;
    if (typeof gene === 'string') try { gene = JSON.parse(gene); } catch { gene = null; }
    let cfg = run.config;
    if (typeof cfg === 'string') try { cfg = JSON.parse(cfg); } catch { cfg = {}; }

    document.getElementById('detail-title').textContent = `${run.symbol} ${tfLabel(run.timeframe)}`;
    document.getElementById('detail-run-id').textContent = `#${id}`;

    // Phase 4.5a: render the three spec-mode panels. Each renderer is
    // a no-op (hides its card) when the underlying JSON is absent, so
    // legacy GA runs simply skip these sections.
    renderFitnessBreakdown(run.fitness_breakdown_json);
    renderWalkForwardReport(run.wf_report_json);
    renderRegimeBreakdown(run.regime_breakdown_json, run.fitness_breakdown_json);

    // Render parameter cards. Spec-mode genes use qualified-ID keys
    // (`emaTrend.main.emaFast`) rather than the flat legacy keys in
    // PARAM_LABELS, so looking up by legacy key returns null for every
    // field and the panel renders empty. Branch on run.spec_hash and
    // walk the gene entries directly for spec-mode runs.
    const isSpecMode = !!run.spec_hash;
    if (gene) {
      const paramsHtml = isSpecMode
        ? renderSpecGeneCards(gene)
        : renderLegacyGeneCards(gene);
      document.getElementById('detail-params').innerHTML = paramsHtml;
    } else {
      document.getElementById('detail-params').innerHTML = '<span style="color:#8b949e">No gene data yet</span>';
    }

    // Phase 4.6: Pine-export button state. The codegen requires a
    // hydrated spec (i.e. spec-mode only) — the server returns 400 for
    // legacy runs, but disabling the button up-front with a tooltip is
    // a better UX than letting the user click into an error. Mirrors
    // the Send-to-TV button's legacy/spec guard on the expand row.
    const pineBtn = document.getElementById('btn-pine-export');
    const pineStatus = document.getElementById('pine-export-status');
    const pineResult = document.getElementById('pine-export-result');
    if (pineBtn) {
      if (isSpecMode) {
        pineBtn.disabled = false;
        pineBtn.title = 'Generate a Pine v5 entry-alerts indicator from this run';
      } else {
        pineBtn.disabled = true;
        pineBtn.title = 'Pine export is spec-mode only — legacy GA runs have no spec to codegen from';
      }
    }
    if (pineStatus) pineStatus.textContent = '';
    if (pineResult) pineResult.innerHTML = '';
  } catch (err) {
    document.getElementById('detail-title').textContent = 'Error loading run';
    console.error(err);
  }
};

window.closeRunDetail = () => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById('page-optimizer').classList.add('active');
  document.querySelector('[data-page="optimizer"]').classList.add('active');
  document.getElementById('nav-run-detail').style.display = 'none';
};

// ─── Phase 4.5a: spec-mode detail-page renderers ────────────
//
// Three helpers that turn the persisted WF / regime / fitness JSON
// into per-card DOM. Each is a no-op (hides its card) when the
// underlying field is null or shape-invalid, so legacy GA runs keep
// the pre-4.5 detail page and spec-mode runs gain three new cards.
//
// All formatters handle `Infinity` (PF with zero losing trades) and
// `NaN` (WFE when divisor is zero) since the underlying numeric
// sources can emit both — openRunDetail shouldn't crash on a well-
// formed but mathematically degenerate row.

/**
 * Format the one-line "Winner config" summary shown in the runs-list
 * expand panel. Branches on gene shape:
 *
 *   - Legacy GA runs use a flat gene object like
 *       { minEntry, stochLen, stochSmth, rsiLen, emaFast, emaSlow,
 *         bbLen, bbMult, atrLen, atrSL, tp1Mult, tp2Mult, tp3Mult,
 *         tp1Pct, tp2Pct, riskPct, maxBars }
 *     and render the compact JM Simple 3TP summary that's shipped since
 *     day one.
 *
 *   - Spec-mode runs (Phase 4.1+) use qualified-ID keys like
 *       "emaTrend.main.emaFast": 38
 *       "bbSqueezeBreakout.main.bbLen": 37
 *       "_meta.entries.threshold": 3
 *     because the gene is block-aware rather than hardcoded to one
 *     strategy. We group by the block prefix and render
 *     "E3 emaTrend(emaFast=38, emaSlow=40) · bbSqueezeBreakout(bbLen=37, …)".
 *
 * The branch is driven by `isSpecMode` (caller supplies it from
 * run.spec_hash) rather than shape-sniffing — avoids false positives on
 * odd legacy keys and matches how the TV-button branch is guarded.
 */
function formatWinnerConfig(gene, isSpecMode) {
  if (!gene) return '';

  if (!isSpecMode) {
    const tp3Pct = 100 - (gene.tp1Pct || 0) - (gene.tp2Pct || 0);
    return `E${gene.minEntry} St${gene.stochLen}/${gene.stochSmth} R${gene.rsiLen}
      EMA${gene.emaFast}/${gene.emaSlow} BB${gene.bbLen}x${gene.bbMult}
      ATR${gene.atrLen} SL${gene.atrSL}
      TP${gene.tp1Mult}/${gene.tp2Mult}/${gene.tp3Mult}
      @${gene.tp1Pct}/${gene.tp2Pct}/${tp3Pct}%
      R${gene.riskPct}% T${gene.maxBars}b`;
  }

  // Spec-mode. Group keys by block-id prefix (before first `.`). Drop
  // `_meta.*` — surface the entries threshold as a leading "E<n>" chip
  // since that's the one gene bit that isn't block-owned.
  const blocks = Object.create(null);
  let entryThreshold = null;
  for (const [k, v] of Object.entries(gene)) {
    if (k === '_meta.entries.threshold') { entryThreshold = v; continue; }
    if (k.startsWith('_meta.')) continue;
    const dot = k.indexOf('.');
    if (dot < 0) continue; // malformed — ignore rather than surface "undefined"
    const block = k.slice(0, dot);
    // Third segment is the param name; second is the instance id ("main").
    const parts = k.split('.');
    const param = parts.length >= 3 ? parts.slice(2).join('.') : parts[parts.length - 1];
    (blocks[block] ??= []).push(`${param}=${formatGeneNum(v)}`);
  }

  const groups = Object.entries(blocks).map(
    ([block, params]) => `${block}(${params.join(', ')})`
  );
  const prefix = entryThreshold != null ? `E${entryThreshold} ` : '';
  return prefix + groups.join(' · ');
}

/**
 * Legacy parameter cards — the pre-4.1 flat-gene layout. Each key in
 * PARAM_LABELS gets one card; missing keys are skipped. Preserved
 * verbatim (down to the tp3Pct footnote) so legacy-run detail pages
 * keep rendering exactly the way they did before the spec-mode split.
 */
function renderLegacyGeneCards(gene) {
  const tp3Pct = 100 - (gene.tp1Pct ?? 0) - (gene.tp2Pct ?? 0);
  return Object.entries(PARAM_LABELS).map(([key, meta]) => {
    const raw = gene[key];
    if (raw == null) return '';
    const displayVal = key === 'tp2Pct'
      ? `${raw}${meta.unit} <span style="color:#6e7681;font-size:11px">(TP3 gets ${tp3Pct}%)</span>`
      : `${typeof raw === 'number' && !Number.isInteger(raw) ? raw.toFixed(2) : raw}${meta.unit ? ' ' + meta.unit : ''}`;
    return `<div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:10px 12px">
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px">${meta.label}</div>
      <div style="font-size:16px;font-weight:700;color:#e6edf3;font-family:monospace">${displayVal}</div>
      <div style="font-size:10px;color:#6e7681;margin-top:4px">${meta.desc}</div>
    </div>`;
  }).join('');
}

/**
 * Spec-mode parameter cards. Gene keys are qualified IDs like
 * `emaTrend.main.emaFast` or `_meta.entries.threshold`. We parse each
 * key into block / instance / param, group cards under a block header,
 * and render every numeric value with the same compact formatter the
 * winner-config line uses. No label/desc dictionary yet — PARAM_LABELS
 * only covers legacy keys, and blocks ship param metadata separately.
 * For now the qualified-ID suffix doubles as the card title, which is
 * accurate and also matches what the user typed in the spec editor.
 */
function renderSpecGeneCards(gene) {
  // Surface the entries-threshold meta gene as a standalone card at
  // the top. It isn't owned by any block so the block-grouping pass
  // would otherwise drop it.
  const metaCards = [];
  const blocks = Object.create(null); // blockId -> Map<instance, [{param, value}]>

  for (const [k, v] of Object.entries(gene)) {
    if (k === '_meta.entries.threshold') {
      metaCards.push(paramCardHtml('Entries', 'min signals to open', v, '_meta.entries.threshold'));
      continue;
    }
    if (k.startsWith('_meta.')) continue;
    const parts = k.split('.');
    if (parts.length < 2) continue; // malformed — skip

    const blockId = parts[0];
    const instance = parts.length >= 3 ? parts[1] : 'main';
    const param = parts.length >= 3 ? parts.slice(2).join('.') : parts.slice(1).join('.');

    const byInstance = (blocks[blockId] ??= Object.create(null));
    (byInstance[instance] ??= []).push({ param, value: v, qid: k });
  }

  // Pre-compute normalized TP% for any block that has tpNPct params.
  // The GA stores raw weights (may sum > 100); the runtime normalizes.
  const tpNorm = Object.create(null); // qid -> normalized%
  for (const [blockId, byInstance] of Object.entries(blocks)) {
    for (const [instance, params] of Object.entries(byInstance)) {
      const tpPcts = params.filter(p => /^tp\d+Pct$/.test(p.param) && p.value > 0);
      if (tpPcts.length > 0) {
        const rawSum = tpPcts.reduce((s, p) => s + p.value, 0);
        if (rawSum !== 100) { // only annotate when sum != 100
          for (const p of tpPcts) {
            tpNorm[p.qid] = Math.round(p.value / rawSum * 100);
          }
        }
      }
    }
  }

  const blockSections = Object.entries(blocks).map(([blockId, byInstance]) => {
    const instanceSections = Object.entries(byInstance).map(([instance, params]) => {
      const label = instance === 'main' ? blockId : `${blockId} · ${instance}`;
      const cards = params
        .map(p => paramCardHtml(p.param, label, p.value, p.qid, tpNorm[p.qid]))
        .join('');
      return cards;
    }).join('');
    return instanceSections;
  }).join('');

  return metaCards.join('') + blockSections;
}

/**
 * Single-param card used by renderSpecGeneCards. Keeps the visual
 * shape in lock-step with renderLegacyGeneCards so the grid layout
 * (the caller's parent container) lines up whether the run is legacy
 * or spec-mode.
 */
function paramCardHtml(paramName, subtitle, value, qid, normalizedPct) {
  const displayVal = formatGeneNum(value);
  // When tpNPct raw weights don't sum to 100, show the effective split.
  const normNote = normalizedPct != null
    ? ` <span style="color:#d2a8ff;font-size:11px">(eff. ${normalizedPct}%)</span>`
    : '';
  return `<div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:10px 12px" title="${qid}">
    <div style="font-size:11px;color:#8b949e;margin-bottom:4px">${paramName}</div>
    <div style="font-size:16px;font-weight:700;color:#e6edf3;font-family:monospace">${displayVal}${normNote}</div>
    <div style="font-size:10px;color:#6e7681;margin-top:4px">${subtitle}</div>
  </div>`;
}

/** Compact number formatter for the winner-config line — strips
 *  trailing zeros and caps at 4 decimal places, preserving ints. */
function formatGeneNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * Format a profit-factor value. PF comes in as a non-negative number
 * or Infinity (no losing trades). We display ∞ for Infinity so the
 * user knows the strategy had no losses rather than seeing a
 * nonsense number like "1.79e+308".
 */
function fmtPf(pf) {
  if (pf == null || Number.isNaN(pf)) return '—';
  if (!Number.isFinite(pf)) return '∞';
  return pf.toFixed(2);
}

/** Format a signed percentage (WF netPct is a plain number like 12.5 = 12.5%). */
function fmtPct(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '+∞%' : '−∞%';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** Format a WFE value (OOS PF / IS PF). Can be NaN if IS PF is 0. */
function fmtWfe(wfe) {
  if (wfe == null || Number.isNaN(wfe)) return 'n/a';
  if (!Number.isFinite(wfe)) return '∞';
  return wfe.toFixed(2);
}

/**
 * Render the Fitness Breakdown card. Shows the composite score, the
 * three normalized metric terms with their weights, which gates (if
 * any) the gene failed, and — when the gene was eliminated — the
 * human-readable reason.
 *
 * Layout: a compact chip grid for score + eliminated flag + gates,
 * followed by a three-row mini-table for the normalized term ·
 * weight = contribution math so the user can see where the score
 * actually came from.
 */
function renderFitnessBreakdown(fit) {
  const card = document.getElementById('detail-fitness-card');
  const body = document.getElementById('detail-fitness-body');
  if (!fit || typeof fit !== 'object') { card.style.display = 'none'; return; }

  const score = typeof fit.score === 'number' ? fit.score : 0;
  const eliminated = fit.eliminated === true;
  const gatesFailed = Array.isArray(fit.gatesFailed) ? fit.gatesFailed : [];
  const b = fit.breakdown || {};
  const w = b.weightsN || { pf: 0, dd: 0, ret: 0 };

  // Score / status / gates chips.
  const scoreColor   = eliminated ? '#f85149' : score >= 0.5 ? '#3fb950' : '#d29922';
  const statusLabel  = eliminated ? 'ELIMINATED' : 'PASSED';
  const statusColor  = eliminated ? '#f85149' : '#3fb950';
  const gatesHtml = gatesFailed.length === 0
    ? '<span style="color:#3fb950">none</span>'
    : gatesFailed.map(g => `<span style="background:#f8514926;color:#f85149;border-radius:4px;padding:2px 6px;font-size:11px;margin-right:4px">${g}</span>`).join('');

  const chip = (label, value, color = '#e6edf3') => `
    <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:10px 12px;min-width:120px">
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px">${label}</div>
      <div style="font-size:16px;font-weight:700;color:${color};font-family:monospace">${value}</div>
    </div>`;

  // Normalized term rows: show raw norm, weight, and contribution
  // (norm · weight) so the user can verify the composite sum = score
  // (for non-eliminated genes).
  const termRow = (name, norm, weight, title) => {
    const contribution = (norm ?? 0) * (weight ?? 0);
    return `<tr title="${title}">
      <td style="padding:4px 8px;color:#c9d1d9">${name}</td>
      <td style="padding:4px 8px;text-align:right;font-family:monospace">${(norm ?? 0).toFixed(3)}</td>
      <td style="padding:4px 8px;text-align:right;font-family:monospace;color:#8b949e">× ${(weight ?? 0).toFixed(2)}</td>
      <td style="padding:4px 8px;text-align:right;font-family:monospace;color:#e6edf3">= ${contribution.toFixed(3)}</td>
    </tr>`;
  };

  let extras = '';
  if (typeof b.worstRegimePf === 'number') {
    extras += `<div style="font-size:12px;color:#8b949e;margin-top:8px">Worst regime PF: <span style="color:#e6edf3;font-family:monospace">${fmtPf(b.worstRegimePf)}</span>${b.regimeSource ? ` <span style="color:#6e7681">(${b.regimeSource})</span>` : ''}</div>`;
  }
  if (typeof b.wfe === 'number') {
    extras += `<div style="font-size:12px;color:#8b949e;margin-top:4px">WFE: <span style="color:#e6edf3;font-family:monospace">${fmtWfe(b.wfe)}</span></div>`;
  }
  if (eliminated && typeof fit.reason === 'string' && fit.reason.length > 0) {
    extras += `<div style="font-size:12px;color:#f85149;margin-top:10px;padding:8px 12px;background:#f8514916;border-left:3px solid #f85149;border-radius:4px">${fit.reason}</div>`;
  }

  body.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      ${chip('Score',  score.toFixed(3), scoreColor)}
      ${chip('Status', statusLabel,      statusColor)}
      <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:10px 12px;min-width:120px">
        <div style="font-size:11px;color:#8b949e;margin-bottom:4px">Gates failed</div>
        <div style="font-size:13px">${gatesHtml}</div>
      </div>
    </div>
    <table style="font-size:12px;border-collapse:collapse;min-width:320px">
      <thead><tr style="color:#8b949e;border-bottom:1px solid #30363d">
        <th style="text-align:left;padding:4px 8px">Term</th>
        <th style="text-align:right;padding:4px 8px">Normalized</th>
        <th style="text-align:right;padding:4px 8px">Weight</th>
        <th style="text-align:right;padding:4px 8px">Contribution</th>
      </tr></thead>
      <tbody>
        ${termRow('PF',  b.normPf,  w.pf,  'Normalized profit factor · PF weight')}
        ${termRow('DD',  b.normDd,  w.dd,  'Normalized drawdown term · DD weight')}
        ${termRow('ret', b.normRet, w.ret, 'Normalized return · ret weight')}
      </tbody>
    </table>
    ${extras}
  `;
  card.style.display = '';
}

/**
 * Render the Walk-Forward Report card. Top summary row with aggregate
 * WFE + mean IS/OOS PF + valid-window count; main body is the
 * per-window table.
 *
 * The WFE chip is coloured: green ≥ 0.5 (OOS keeps at least 50% of
 * IS performance), amber 0.3–0.5, red below 0.3. This matches the
 * semantic meaning of the default `wfeMin=0.5` gate.
 */
// Phase 4.5b: `idSuffix` lets the compare-runs page render two WF
// reports into parallel DOM trees (`detail-wf-card-a` and `-b`) using
// the same helper. Run-detail page passes no suffix; compare page
// passes '-a' / '-b'. The DOM in index.html mirrors both layouts.
function renderWalkForwardReport(wf, idSuffix = '') {
  const card = document.getElementById(`detail-wf-card${idSuffix}`);
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.windows)) {
    card.style.display = 'none'; return;
  }

  const wfe = wf.wfe;
  const wfeColor =
    !Number.isFinite(wfe) ? '#8b949e' :
    wfe >= 0.5 ? '#3fb950' :
    wfe >= 0.3 ? '#d29922' :
    '#f85149';

  const chip = (label, value, color = '#e6edf3', title = '') => `
    <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:10px 12px;min-width:110px" ${title ? `title="${title}"` : ''}>
      <div style="font-size:11px;color:#8b949e;margin-bottom:4px">${label}</div>
      <div style="font-size:16px;font-weight:700;color:${color};font-family:monospace">${value}</div>
    </div>`;

  document.getElementById(`detail-wf-summary${idSuffix}`).innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${chip('Scheme',       wf.scheme ?? '—', '#e6edf3',
        'anchored = expanding in-sample window; rolling = fixed-width in-sample window')}
      ${chip('Windows',      `${wf.validWindows ?? 0} / ${wf.nWindows ?? wf.windows.length}`, '#e6edf3',
        'valid windows / total windows (valid = both IS and OOS have trades)')}
      ${chip('WFE',          fmtWfe(wfe), wfeColor,
        'Walk-Forward Efficiency = mean(OOS PF) / mean(IS PF). Higher = more robust OOS.')}
      ${chip('Mean IS PF',   fmtPf(wf.meanIsPf),  '#e6edf3')}
      ${chip('Mean OOS PF',  fmtPf(wf.meanOosPf), '#e6edf3')}
      ${chip('Mean IS ret',  fmtPct(wf.meanIsNetPct),  '#e6edf3')}
      ${chip('Mean OOS ret', fmtPct(wf.meanOosNetPct), '#e6edf3')}
    </div>`;

  // Per-window rows. Coloured cells for OOS PF (red < 1.0) make
  // underperforming windows jump out without the user reading every
  // value.
  const tbody = document.getElementById(`detail-wf-tbody${idSuffix}`);
  tbody.innerHTML = wf.windows.map(w => {
    const oosColor = !Number.isFinite(w.oosPf) ? '#e6edf3'
      : w.oosPf >= 1.2 ? '#3fb950'
      : w.oosPf >= 1.0 ? '#e6edf3'
      : '#f85149';
    const oosNetColor = (w.oosNetPct ?? 0) >= 0 ? '#3fb950' : '#f85149';
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:6px 8px;color:#c9d1d9">#${w.index}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${w.isTrades}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${fmtPf(w.isPf)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;color:${(w.isNetPct ?? 0) >= 0 ? '#3fb950' : '#f85149'}">${fmtPct(w.isNetPct)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${w.oosTrades}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;color:${oosColor}">${fmtPf(w.oosPf)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;color:${oosNetColor}">${fmtPct(w.oosNetPct)}</td>
    </tr>`;
  }).join('');

  card.style.display = '';
}

// ─── Phase 4.5b: compare-runs renderers ────────────────────────
//
// openCompare(ids) drives the #page-compare view. Fetches both runs
// in parallel, fills the mirrored DOM (-a / -b) via
// renderWalkForwardReport with idSuffix, and then walks the two WF
// reports row-by-row to highlight winners/losers and flag mismatched
// WF schemes. Fetch failures surface as a "Run not found" header in
// the affected column rather than crashing the whole page — a missing
// or deleted run shouldn't eat both cards.

async function openCompare(ids) {
  // Reveal the page. nav-link `#nav-compare` was hidden by default in
  // index.html; un-hide it here so the user has a breadcrumb to come
  // back to this view (same pattern as #nav-run-detail).
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-compare').classList.add('active');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const nav = document.getElementById('nav-compare');
  if (nav) { nav.style.display = ''; nav.classList.add('active'); }
  document.getElementById('compare-title').textContent = `#${ids[0]} vs #${ids[1]}`;

  // Reset transient warnings.
  document.getElementById('compare-mismatch-banner').style.display = 'none';
  document.getElementById('compare-empty-note').style.display = 'none';

  const pickTwo = ids.slice(0, 2);
  const runs = await Promise.all(pickTwo.map(async (id) => {
    try {
      const r = await fetch(`/api/runs/${id}`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));
  const [runA, runB] = runs;

  renderCompareColumn(runA, '-a', pickTwo[0]);
  renderCompareColumn(runB, '-b', pickTwo[1]);

  // Empty-state note when a selected run has no WF data. The
  // renderWalkForwardReport helper already hides its card, but the
  // user deserves an explanation rather than a silent blank column.
  const missing = [];
  if (!runA?.wf_report_json) missing.push(`#${pickTwo[0]}`);
  if (!runB?.wf_report_json) missing.push(`#${pickTwo[1]}`);
  if (missing.length) {
    const note = document.getElementById('compare-empty-note');
    note.style.display = '';
    note.textContent =
      `${missing.join(' and ')} ${missing.length === 1 ? 'has' : 'have'} ` +
      'no walk-forward data. Legacy GA runs and spec-mode runs without ' +
      'a WF report can\u2019t be compared on WF metrics.';
  }

  // Mismatch banner. A silent side-by-side of apples and oranges is
  // misleading; surface it explicitly when both reports exist but
  // disagree on scheme or window count.
  const wfA = runA?.wf_report_json;
  const wfB = runB?.wf_report_json;
  if (wfA && wfB) {
    const mismatches = [];
    if (wfA.scheme !== wfB.scheme) {
      mismatches.push(`scheme (${wfA.scheme} vs ${wfB.scheme})`);
    }
    if (wfA.nWindows !== wfB.nWindows) {
      mismatches.push(`nWindows (${wfA.nWindows} vs ${wfB.nWindows})`);
    }
    if (mismatches.length) {
      const banner = document.getElementById('compare-mismatch-banner');
      banner.style.display = '';
      document.getElementById('compare-mismatch-body').innerHTML =
        `<strong style="color:#d29922">\u26a0 Walk-forward mismatch:</strong> ` +
        `${mismatches.join(', ')}. Per-window comparisons may not be meaningful ` +
        `\u2014 the two runs sliced time differently.`;
    }
    highlightCompareWindows(wfA, wfB);
  }
}

function renderCompareColumn(run, suffix, id) {
  const headerBody = document.getElementById(`compare-header-body${suffix}`);
  if (!run) {
    headerBody.innerHTML =
      `<div style="color:#f85149">Run #${id} not found.</div>`;
    renderWalkForwardReport(null, suffix);
    return;
  }
  const fit = run.fitness_breakdown_json;
  const fitChip = fit ? `
    <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 10px"
         title="Composite fitness score. Red = eliminated by a hard gate.">
      <div style="font-size:11px;color:#8b949e">Fitness</div>
      <div style="font-size:13px;font-family:monospace;color:${fit.eliminated ? '#f85149' : '#3fb950'}">${fit.score != null ? fit.score.toFixed(3) : '\u2014'}</div>
    </div>` : '';
  headerBody.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div>
        <div style="font-size:11px;color:#8b949e;margin-bottom:2px">Run</div>
        <div style="font-size:15px;font-weight:700">
          <span style="color:#58a6ff">#${run.id}</span>
          ${run.spec_name ? `<span style="margin-left:6px;font-family:monospace;font-size:13px;color:#c9d1d9">${run.spec_name}</span>` : '<span style="margin-left:6px;color:#8b949e;font-size:13px">&lt;legacy&gt;</span>'}
        </div>
      </div>
      <div style="margin-left:auto;display:flex;gap:10px;flex-wrap:wrap">
        <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 10px">
          <div style="font-size:11px;color:#8b949e">Symbol / TF</div>
          <div style="font-size:13px;font-family:monospace">${run.symbol} \u00b7 ${tfLabel(run.timeframe)}</div>
        </div>
        <div style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 10px">
          <div style="font-size:11px;color:#8b949e">Start</div>
          <div style="font-size:13px;font-family:monospace">${run.start_date}</div>
        </div>
        ${fitChip}
      </div>
    </div>`;
  renderWalkForwardReport(run.wf_report_json, suffix);
}

// Per-window highlight: green on the winner, red on the loser, only
// when OOS PF differs by more than 10% (keeps near-ties uncoloured so
// the eye focuses on real divergence). Handles different window counts
// by walking min(len_a, len_b) — extra windows on the longer side
// render plain.
function highlightCompareWindows(wfA, wfB) {
  const n = Math.min(wfA.windows.length, wfB.windows.length);
  const rowsA = document.querySelectorAll('#detail-wf-tbody-a tr');
  const rowsB = document.querySelectorAll('#detail-wf-tbody-b tr');
  for (let i = 0; i < n; i++) {
    const pfA = wfA.windows[i]?.oosPf;
    const pfB = wfB.windows[i]?.oosPf;
    if (!Number.isFinite(pfA) || !Number.isFinite(pfB)) continue;
    const denom = Math.max(Math.abs(pfA), Math.abs(pfB), 1e-9);
    const gap = Math.abs(pfA - pfB) / denom;
    if (gap < 0.10) continue;
    const aWins = pfA > pfB;
    if (rowsA[i]) rowsA[i].classList.add(aWins ? 'cmp-best' : 'cmp-worst');
    if (rowsB[i]) rowsB[i].classList.add(aWins ? 'cmp-worst' : 'cmp-best');
  }
}

/**
 * Render the Regime Breakdown card. One row per regime label with
 * trades / wins / win% / PF / net. Regimes with fewer than 5 trades
 * are muted because `fitness.js` considers them too noisy to count
 * toward the worst-regime gate — the UI should flag that context.
 */
function renderRegimeBreakdown(regimes, fit) {
  const card = document.getElementById('detail-regime-card');
  if (!regimes || typeof regimes !== 'object' || Array.isArray(regimes)) {
    card.style.display = 'none'; return;
  }
  const entries = Object.entries(regimes);
  if (entries.length === 0) { card.style.display = 'none'; return; }

  // Source label — "full-data" means regime stats came from the raw
  // backtest; "wf-oos-pooled" means they were aggregated across OOS
  // windows (the real robustness check).
  const source = fit?.breakdown?.regimeSource;
  document.getElementById('detail-regime-source').textContent = source
    ? `Source: ${source} — ${source === 'wf-oos-pooled' ? 'aggregated across out-of-sample windows (more robust)' : 'single full-data backtest'}`
    : '';

  // Sort: most-traded regime first. Low-trade regimes end up at the
  // bottom where they belong — they're visible but don't dominate.
  entries.sort(([, a], [, b]) => (b.trades ?? 0) - (a.trades ?? 0));

  const tbody = document.getElementById('detail-regime-tbody');
  tbody.innerHTML = entries.map(([label, r]) => {
    const trades = r.trades ?? 0;
    const lowConfidence = trades < 5;
    const muted = lowConfidence ? 'color:#6e7681' : '';
    const winPct = trades > 0 ? (100 * (r.wins ?? 0) / trades) : 0;
    const pfColor = !Number.isFinite(r.pf) ? '#e6edf3'
      : r.pf >= 1.2 ? '#3fb950'
      : r.pf >= 1.0 ? '#e6edf3'
      : '#f85149';
    const netColor = (r.net ?? 0) >= 0 ? '#3fb950' : '#f85149';
    return `<tr style="border-bottom:1px solid #21262d;${muted}" ${lowConfidence ? 'title="Fewer than 5 trades — low-confidence sample. The worst-regime gate ignores regimes below this threshold."' : ''}>
      <td style="padding:6px 8px">${label}${lowConfidence ? ' <span style="color:#6e7681;font-size:10px">(low-n)</span>' : ''}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${trades}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${r.wins ?? 0}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace">${winPct.toFixed(1)}%</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;color:${lowConfidence ? '#6e7681' : pfColor}">${fmtPf(r.pf)}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;color:${lowConfidence ? '#6e7681' : netColor}">${(r.net ?? 0).toFixed(2)}</td>
    </tr>`;
  }).join('');

  card.style.display = '';
}

// ─── Sizing toggle (compounding vs flat) ───────────────────
let detailSizing = 'compounding';

function initSizingToggle() {
  const toggle = document.getElementById('sizing-toggle');
  if (!toggle || toggle.dataset.bound) return;
  toggle.dataset.bound = '1';
  toggle.querySelectorAll('label').forEach(lbl => {
    lbl.addEventListener('click', (e) => {
      e.preventDefault();
      const choice = lbl.dataset.sizing;
      if (choice === detailSizing) return;
      detailSizing = choice;
      // Visual active state
      toggle.querySelectorAll('label').forEach(l => {
        const active = l.dataset.sizing === detailSizing;
        l.style.background = active ? '#21262d' : 'transparent';
        l.style.color = active ? '#e6edf3' : '#8b949e';
        l.querySelector('input').checked = active;
      });
      // Re-run with new sizing if we have a run open
      if (detailRunId) window.recalcRun();
    });
  });
}
initSizingToggle();

// ─── Collapsible charts card ───────────────────────────────
window.toggleChartsCollapsed = () => {
  const body = document.getElementById('detail-charts-body');
  const caret = document.getElementById('detail-charts-caret');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  caret.textContent = open ? '▸' : '▾';
  // Trigger chart reflow on expand (charts render 0-width if hidden)
  if (!open && priceChart && equityChart) {
    const priceEl = document.getElementById('price-chart');
    const equityEl = document.getElementById('equity-chart');
    priceChart.applyOptions({ width: priceEl.clientWidth });
    equityChart.applyOptions({ width: equityEl.clientWidth });
    priceChart.timeScale().fitContent();
    equityChart.timeScale().fitContent();
  }
};

window.recalcRun = async () => {
  if (!detailRunId) return;
  const btn = document.getElementById('btn-recalc');
  const status = document.getElementById('recalc-status');
  const metricsDiv = document.getElementById('recalc-metrics');
  btn.disabled = true;
  status.textContent = 'Recalculating…';
  metricsDiv.innerHTML = '';
  document.getElementById('detail-trades-card').style.display = 'none';
  document.getElementById('detail-periodic-card').style.display = 'none';

  try {
    const res = await fetch(`/api/runs/${detailRunId}/trades?sizing=${detailSizing}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const m = data.metrics;
    const profit = m.netProfit;
    metricsDiv.innerHTML = [
      ['Net Profit',  profit != null ? `<span class="${profit >= 0 ? 'positive' : 'negative'}">$${Math.round(profit).toLocaleString()}</span>` : '—'],
      ['Win Rate',    m.winRate != null ? (m.winRate * 100).toFixed(1) + '%' : '—'],
      ['PF',          m.pf != null ? m.pf.toFixed(2) : '—'],
      ['Max DD',      m.maxDDPct != null ? (m.maxDDPct * 100).toFixed(1) + '%' : '—'],
      ['Trades',      m.trades ?? '—'],
      ['Sharpe',      m.sharpe != null ? m.sharpe.toFixed(2) : '—'],
    ].map(([k, v]) => `<div style="text-align:center">
      <div style="font-size:11px;color:#8b949e">${k}</div>
      <div style="font-size:15px;font-weight:700">${v}</div>
    </div>`).join('');

    detailTradeList = data.tradeList ?? [];
    status.textContent = `Done — ${detailTradeList.length} trade executions (${data.sizing})`;
    renderPeriodicPerformance(data.equity ?? [], data.ohlc ?? [], data.sizing);
    renderCharts(data.ohlc ?? [], data.equity ?? [], detailTradeList);
    renderTradeTable(detailTradeList);
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
};

/**
 * Phase 4.6: Generate a Pine v5 entry-alerts indicator for the currently-
 * open run. POSTs to /api/runs/:id/pine-export; server writes a .pine
 * file under pine/generated/ (content-addressed by gene hash) and
 * returns the source. We surface a one-line summary + a `<details>`
 * collapsible preview so the user can spot-check without leaving the
 * page. Re-clicking a run that's already been exported is cheap —
 * the server returns `reused: true` when the file already exists.
 *
 * Errors render inline in red. Button is pre-disabled for legacy runs
 * in openRunDetail so the click path is only reached when the server
 * is expected to succeed; any error surfaced here is a real failure
 * (missing spec, gene/spec mismatch, disk write failure) rather than
 * a "you clicked on a legacy run" usability miss.
 */
window.generatePine = async () => {
  if (!detailRunId) return;
  const btn = document.getElementById('btn-pine-export');
  const status = document.getElementById('pine-export-status');
  const result = document.getElementById('pine-export-result');

  btn.disabled = true;
  status.textContent = 'Generating…';
  status.style.color = '#8b949e';
  result.innerHTML = '';

  try {
    const res = await fetch(`/api/runs/${detailRunId}/pine-export`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    status.style.color = '#3fb950';
    status.textContent = data.reused
      ? 'Already generated — reused existing file'
      : 'Generated';

    // Escape the source for the <pre> — don't interpret HTML from
    // the codegen even though we trust it, because Pine code can
    // contain characters like `<=` that look fine but let one slip
    // through and the DOM eats the rest of the page.
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    result.innerHTML = `
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-size:12px">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-family:monospace;margin-bottom:10px">
          <div style="color:#8b949e">title</div>         <div>${esc(data.title)}</div>
          <div style="color:#8b949e">shortTitle</div>    <div>${esc(data.shortTitle)}</div>
          <div style="color:#8b949e">filename</div>      <div>${esc(data.filename)}</div>
          <div style="color:#8b949e">hash</div>          <div>${esc(data.hash12)}</div>
          <div style="color:#8b949e">size</div>          <div>${data.bytes} bytes · ${data.lines} lines</div>
          <div style="color:#8b949e">path</div>          <div style="word-break:break-all;color:#6e7681">${esc(data.path)}</div>
        </div>
        <details>
          <summary style="cursor:pointer;color:#58a6ff;font-size:12px">Show Pine source</summary>
          <pre style="margin:8px 0 0;padding:10px;background:#010409;border:1px solid #30363d;border-radius:4px;max-height:400px;overflow:auto;font-size:11px;line-height:1.45">${esc(data.source)}</pre>
        </details>
        <div style="margin-top:10px;font-size:11px;color:#6e7681">
          Next step: push to TradingView via <code style="color:#8b949e">node scripts/pine-deploy.js --spec strategies/${esc(data.filename).replace(/-[0-9a-f]+\.pine$/,'.json')}</code>
          (reads MEMORY.md guardrails — won't overwrite an existing editor script without <code style="color:#8b949e">--allow-overwrite</code>).
        </div>
      </div>`;
  } catch (err) {
    status.style.color = '#f85149';
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
};

// ─── Charts ─────────────────────────────────────────────────
let priceChart = null;
let equityChart = null;

function renderCharts(ohlc, equity, trades) {
  const chartsCard = document.getElementById('detail-charts-card');
  const body = document.getElementById('detail-charts-body');
  const caret = document.getElementById('detail-charts-caret');
  if (!ohlc.length && !equity.length) {
    chartsCard.style.display = 'none';
    return;
  }
  chartsCard.style.display = '';
  // Temporarily show body to measure widths for chart init, then collapse.
  // (Lightweight Charts can't initialize inside a display:none container.)
  body.style.display = '';

  // Clean up previous charts
  const priceEl = document.getElementById('price-chart');
  const equityEl = document.getElementById('equity-chart');
  priceEl.innerHTML = '';
  equityEl.innerHTML = '';

  const chartColors = {
    background: '#0d1117',
    text: '#8b949e',
    grid: '#21262d',
  };

  // ── Price chart (candlestick + trade markers) ──
  priceChart = LightweightCharts.createChart(priceEl, {
    width: priceEl.clientWidth,
    height: 350,
    layout: { background: { type: 'solid', color: chartColors.background }, textColor: chartColors.text },
    grid: { vertLines: { color: chartColors.grid }, horzLines: { color: chartColors.grid } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: true },
  });

  const candleSeries = priceChart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor: '#3fb95088', wickDownColor: '#f8514988',
  });
  candleSeries.setData(ohlc);

  // Trade markers on price chart
  if (trades.length) {
    const markers = [];
    for (const t of trades) {
      // Entry marker
      markers.push({
        time: Math.floor(t.entryTs / 1000),
        position: t.direction === 'Long' ? 'belowBar' : 'aboveBar',
        color: t.direction === 'Long' ? '#3fb950' : '#f85149',
        shape: t.direction === 'Long' ? 'arrowUp' : 'arrowDown',
        text: t.direction === 'Long' ? 'L' : 'S',
      });
      // Exit marker
      const exitColor = t.pnl >= 0 ? '#3fb950' : '#f85149';
      const signalShort = (t.signal || '').slice(0, 3);
      markers.push({
        time: Math.floor(t.exitTs / 1000),
        position: t.direction === 'Long' ? 'aboveBar' : 'belowBar',
        color: exitColor,
        shape: 'circle',
        text: signalShort,
      });
    }
    // Sort by time (required by lightweight-charts)
    markers.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);
  }

  // ── Equity chart (area) ──
  equityChart = LightweightCharts.createChart(equityEl, {
    width: equityEl.clientWidth,
    height: 220,
    layout: { background: { type: 'solid', color: chartColors.background }, textColor: chartColors.text },
    grid: { vertLines: { color: chartColors.grid }, horzLines: { color: chartColors.grid } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: true },
  });

  const equitySeries = equityChart.addAreaSeries({
    topColor: '#58a6ff40',
    bottomColor: '#58a6ff08',
    lineColor: '#58a6ff',
    lineWidth: 2,
    priceFormat: { type: 'custom', formatter: v => '$' + Math.round(v).toLocaleString() },
  });
  equitySeries.setData(equity);

  // Sync visible range between the two charts
  priceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) equityChart.timeScale().setVisibleLogicalRange(range);
  });
  equityChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range) priceChart.timeScale().setVisibleLogicalRange(range);
  });

  // Sync crosshair (wrapped in try/catch — setCrosshairPosition may not be available in all versions)
  try {
    priceChart.subscribeCrosshairMove(param => {
      if (param.time) {
        try { equityChart.setCrosshairPosition(undefined, param.time, equitySeries); } catch {}
      } else {
        try { equityChart.clearCrosshairPosition(); } catch {}
      }
    });
    equityChart.subscribeCrosshairMove(param => {
      if (param.time) {
        try { priceChart.setCrosshairPosition(undefined, param.time, candleSeries); } catch {}
      } else {
        try { priceChart.clearCrosshairPosition(); } catch {}
      }
    });
  } catch {}

  // Resize handler
  const resizeObserver = new ResizeObserver(() => {
    if (priceChart) priceChart.applyOptions({ width: priceEl.clientWidth });
    if (equityChart) equityChart.applyOptions({ width: equityEl.clientWidth });
  });
  resizeObserver.observe(priceEl);
  resizeObserver.observe(equityEl);

  priceChart.timeScale().fitContent();
  equityChart.timeScale().fitContent();

  // Now collapse — charts are initialized with proper widths and will reflow
  // via toggleChartsCollapsed() when the user expands.
  body.style.display = 'none';
  caret.textContent = '▸';
}

// ─── Periodic performance (year / month breakdown) ─────────
//
// Computes monthly + yearly PnL (absolute $ and %) from the per-bar
// equity history. % basis differs by sizing mode:
//   - flat:        % = Δ$ / initialCapital   (constant base)
//   - compounding: % = Δ$ / equityAtPeriodStart
//
// Equity curve already reflects the chosen sizing (engine/strategy.js
// uses flatSizing to pick sizing base). We derive period boundaries by
// bucketing per-bar equity points; start-of-period equity = prior
// period's end equity (or initialCapital for the first).
const INITIAL_CAPITAL = 100000;

function computePeriodicPerformance(equityHistory) {
  if (!equityHistory.length) return { months: [], years: [] };

  // Bucket per-bar equity into { year, month } keys in chronological order.
  const monthMap = new Map(); // 'YYYY-MM' -> { year, month, endEq }
  const monthOrder = [];
  for (const pt of equityHistory) {
    const d = new Date(pt.time * 1000); // equity.time is seconds
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    let rec = monthMap.get(key);
    if (!rec) {
      rec = { year: d.getUTCFullYear(), month: d.getUTCMonth(), endEq: pt.value };
      monthMap.set(key, rec);
      monthOrder.push(key);
    }
    rec.endEq = pt.value; // overwritten until last point of the month wins
  }

  // Compute per-month $ and %, chaining start = prev.end (initial for first)
  let prev = INITIAL_CAPITAL;
  const months = monthOrder.map(key => {
    const r = monthMap.get(key);
    const dollar = r.endEq - prev;
    const pct = prev !== 0 ? dollar / prev : 0;
    const out = { year: r.year, month: r.month, dollar, pct, startEq: prev, endEq: r.endEq };
    prev = r.endEq;
    return out;
  });

  // Roll months into years (same chaining approach)
  const yearMap = new Map();
  const yearOrder = [];
  for (const m of months) {
    let rec = yearMap.get(m.year);
    if (!rec) { rec = { year: m.year, endEq: m.endEq }; yearMap.set(m.year, rec); yearOrder.push(m.year); }
    rec.endEq = m.endEq;
  }
  let prevY = INITIAL_CAPITAL;
  const years = yearOrder.map(y => {
    const r = yearMap.get(y);
    const dollar = r.endEq - prevY;
    const pct = prevY !== 0 ? dollar / prevY : 0;
    const out = { year: y, dollar, pct, startEq: prevY, endEq: r.endEq };
    prevY = r.endEq;
    return out;
  });

  return { months, years };
}

// Buy-and-hold instrument return per year. For partial years (edges of
// the trading window), uses first bar's open and last bar's close that
// actually fall inside that year.
function computeInstrumentByYear(ohlc) {
  const byYear = new Map();
  if (!ohlc || !ohlc.length) return byYear;
  for (const bar of ohlc) {
    const y = new Date(bar.time * 1000).getUTCFullYear();
    let rec = byYear.get(y);
    if (!rec) {
      rec = { firstOpen: bar.open, lastClose: bar.close };
      byYear.set(y, rec);
    } else {
      rec.lastClose = bar.close;
    }
  }
  return byYear;
}

function renderPeriodicPerformance(equity, ohlc, sizing) {
  const card = document.getElementById('detail-periodic-card');
  const body = document.getElementById('detail-periodic-body');
  const sizingLabel = document.getElementById('detail-periodic-sizing');
  if (!equity || !equity.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  sizingLabel.textContent = sizing === 'flat' ? 'flat sizing' : 'compounding';

  const { months, years } = computePeriodicPerformance(equity);
  const instrumentByYear = computeInstrumentByYear(ohlc);

  // Organize months by year → column (0–11)
  const byYear = new Map();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, new Array(12).fill(null));
    byYear.get(m.year)[m.month] = m;
  }
  const yearSummary = new Map(years.map(y => [y.year, y]));
  const sortedYears = [...byYear.keys()].sort((a, b) => a - b);

  const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Color scale: interpolate green/red by magnitude of pct (clamped at ±20%)
  const cellStyle = (pct) => {
    if (pct == null) return 'background:transparent;color:#6e7681';
    const clamp = Math.max(-0.20, Math.min(0.20, pct));
    const intensity = Math.min(1, Math.abs(clamp) / 0.20);
    const alpha = 0.12 + intensity * 0.55;
    const bg = pct >= 0
      ? `rgba(63,185,80,${alpha.toFixed(2)})`
      : `rgba(248,81,73,${alpha.toFixed(2)})`;
    const text = pct >= 0 ? '#b6f0c2' : '#ffc4c0';
    return `background:${bg};color:${text}`;
  };

  const fmtPct = (n) => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
  const fmtDollar = (n) => {
    const sign = n >= 0 ? '+' : '−';
    const v = Math.abs(n);
    if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(1)}k`;
    return `${sign}$${v.toFixed(0)}`;
  };

  const headerCells = ['<th style="text-align:left;padding:6px 10px;color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Year</th>',
    ...MONTH_LABELS.map(m => `<th style="text-align:center;padding:6px 6px;color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">${m}</th>`),
    '<th style="text-align:center;padding:6px 10px;color:#58a6ff;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-left:1px solid #30363d">Strategy</th>',
    '<th style="text-align:center;padding:6px 10px;color:#d2a8ff;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Buy &amp; Hold</th>'
  ].join('');

  // Compact price formatter — shared by instrument cells
  const fmtPrice = (p) => {
    if (p == null) return '—';
    if (p >= 1000) return '$' + (p / 1000).toFixed(p >= 10000 ? 1 : 2) + 'k';
    if (p >= 1) return '$' + p.toFixed(2);
    return '$' + p.toFixed(4);
  };

  const rows = sortedYears.map(y => {
    const monthCells = byYear.get(y).map(m => {
      if (!m) return '<td style="padding:6px 4px"></td>';
      return `<td style="${cellStyle(m.pct)};padding:6px 4px;text-align:center;font-family:monospace;font-size:11px;border-radius:4px">
        <div style="font-weight:700">${fmtPct(m.pct)}</div>
        <div style="font-size:10px;opacity:.8">${fmtDollar(m.dollar)}</div>
      </td>`;
    }).join('');

    const ys = yearSummary.get(y);
    const yearCell = ys ? `<td style="${cellStyle(ys.pct)};padding:6px 10px;text-align:center;font-family:monospace;font-size:12px;border-left:1px solid #30363d;border-radius:4px">
      <div style="font-weight:800">${fmtPct(ys.pct)}</div>
      <div style="font-size:10px;opacity:.85">${fmtDollar(ys.dollar)}</div>
    </td>` : '<td style="border-left:1px solid #30363d"></td>';

    // Instrument buy-and-hold for this calendar year, scoped to the bars
    // that actually fall inside the trading window (so partial years are
    // reported partially — first-bar open to last-bar close).
    const ins = instrumentByYear.get(y);
    const insPct = ins ? (ins.lastClose - ins.firstOpen) / ins.firstOpen : null;
    const insCell = ins ? `<td style="${cellStyle(insPct)};padding:6px 10px;text-align:center;font-family:monospace;font-size:12px;border-radius:4px">
      <div style="font-weight:800">${fmtPct(insPct)}</div>
      <div style="font-size:10px;opacity:.85">${fmtPrice(ins.firstOpen)} → ${fmtPrice(ins.lastClose)}</div>
    </td>` : '<td></td>';

    return `<tr>
      <td style="padding:6px 10px;font-family:monospace;font-weight:700;color:#e6edf3">${y}</td>
      ${monthCells}
      ${yearCell}
      ${insCell}
    </tr>`;
  }).join('');

  body.innerHTML = `<table style="width:100%;border-collapse:separate;border-spacing:3px;font-size:12px">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTradeTable(trades) {
  if (!trades.length) return;
  document.getElementById('detail-trades-card').style.display = '';
  document.getElementById('detail-trade-count').textContent = `(${trades.length})`;

  const SIGNAL_COLORS = {
    TP1: '#3fb950', TP2: '#3fb950', TP3: '#3fb950',
    SL: '#f85149', ESL: '#f85149',
    Time: '#8b949e', Structural: '#8b949e', Reversal: '#d2a8ff', End: '#6e7681',
  };

  const fmtDate = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fmtNum = (n, dec=2) => n != null ? n.toFixed(dec) : '—';

  document.getElementById('detail-trades-tbody').innerHTML = trades.map((t, i) => {
    const pnlColor = t.pnl > 0 ? '#3fb950' : t.pnl < 0 ? '#f85149' : '#8b949e';
    const sigColor = SIGNAL_COLORS[t.signal] ?? '#8b949e';
    const dirColor = t.direction === 'Long' ? '#3fb950' : '#f85149';
    return `<tr style="border-bottom:1px solid #21262d">
      <td style="padding:5px 8px;color:#6e7681">${i + 1}</td>
      <td style="padding:5px 8px;font-weight:700;color:${dirColor}">${t.direction}</td>
      <td style="padding:5px 8px;font-family:monospace;font-size:11px">${fmtDate(t.entryTs)}</td>
      <td style="padding:5px 8px;font-family:monospace;font-size:11px">${fmtDate(t.exitTs)}</td>
      <td style="padding:5px 8px"><span style="color:${sigColor};font-weight:600">${t.signal}</span></td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace">${fmtNum(t.entryPrice, 2)}</td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace">${fmtNum(t.exitPrice, 2)}</td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace">${fmtNum(t.sizeAsset, 4)}</td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace">$${fmtNum(t.sizeUsdt, 0)}</td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#d2a8ff">${t.riskUsdt != null ? '$' + fmtNum(t.riskUsdt, 0) : '—'}</td>
      <td style="padding:5px 8px;text-align:right;font-weight:700;font-family:monospace;color:${pnlColor}">$${fmtNum(t.pnl, 2)}</td>
      <td style="padding:5px 8px;text-align:right;font-family:monospace;color:${pnlColor}">${fmtNum(t.pnlPct * 100, 3)}%</td>
    </tr>`;
  }).join('');
}

window.exportTrades = () => {
  if (!detailTradeList.length) return;
  const fmtDate = ts => {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const header = ['#','Direction','Entry Date','Exit Date','Signal','Entry Price','Exit Price','Size Asset','Size USDT','Risk $','Net PnL','PnL %'];
  const rows = detailTradeList.map((t, i) => [
    i + 1, t.direction, fmtDate(t.entryTs), fmtDate(t.exitTs), t.signal,
    t.entryPrice?.toFixed(2), t.exitPrice?.toFixed(2),
    t.sizeAsset?.toFixed(4), t.sizeUsdt?.toFixed(2),
    t.riskUsdt != null ? t.riskUsdt.toFixed(2) : '',
    t.pnl?.toFixed(2), (t.pnlPct * 100)?.toFixed(3),
  ]);
  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `run-${detailRunId}-trades.csv`;
  a.click();
};

// ─── Spec Editor (Phase 4.3c) ──────────────────────────────
//
// Composes a strategy spec JSON from user picks. Block catalog comes
// from GET /api/blocks (same shape as the backlog 4.3a payload); each
// block's declared `params` array is emitted into the spec with its
// registry-declared range (min/max/step). Phase 4.3d will add per-param
// narrowing (pin, tighten bounds).
//
// Save/load: out of scope for 4.3c. The right-hand preview has a Copy
// JSON button; the user drops it into `strategies/<name>.json` by hand.
// POST /api/specs lands in Phase 4.3e.

// Flat catalog: block.id → full block object. Populated once by
// loadBlocksForEditor and then read synchronously by the pickers + the
// JSON emitter.
const blocksById = {};

async function loadBlocksForEditor() {
  try {
    const res = await fetch('/api/blocks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const b of data.blocks || []) blocksById[b.id] = b;
    populateSpecEditorPickers();
    renderSpecPreview();
  } catch (err) {
    console.warn('loadBlocksForEditor failed:', err.message);
    // Leave pickers empty; user sees "No … blocks registered" hints.
    populateSpecEditorPickers();
    renderSpecPreview();
  }
}

function blocksByKind(kind) {
  return Object.values(blocksById).filter(b => b.kind === kind);
}
function blocksByExitSlot(slot) {
  return Object.values(blocksById).filter(b => b.kind === 'exit' && b.exitSlot === slot);
}

// Look up a block's description, tolerating "None" (empty string) and
// unregistered ids. Returns '' when there's nothing to show so the caller
// can set textContent unconditionally.
function blockDescriptionFor(blockId) {
  if (!blockId) return '';
  const b = blocksById[blockId];
  return (b && typeof b.description === 'string') ? b.description : '';
}

// Populate a `#<selectId>-desc` element with the currently selected block's
// description. Reads the select's live value so it's safe to call from
// "change" handlers AND from populate-then-render paths.
function updateBlockDescription(selectId) {
  const sel = document.getElementById(selectId);
  const el  = document.getElementById(selectId + '-desc');
  if (!sel || !el) return;
  el.textContent = blockDescriptionFor(sel.value);
}

// Wipes and rebuilds a <select>'s options. Keeps the current value if
// it's still a valid option; otherwise falls back to `defaultValue`.
// An empty-value "None" option is included iff `includeNone` is true.
function populateSelect(id, items, { includeNone, defaultValue = '' } = {}) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  if (includeNone) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'None';
    sel.appendChild(opt);
  }
  for (const b of items) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.id;
    sel.appendChild(opt);
  }
  const valid = new Set([...sel.options].map(o => o.value));
  sel.value = valid.has(prev) ? prev : (valid.has(defaultValue) ? defaultValue : (sel.options[0]?.value ?? ''));
}

// Fills the fixed dropdowns (regime, three exit slots, sizing). Entry
// and filter rows build their own selects via addEntryRow/addFilterRow.
function populateSpecEditorPickers() {
  populateSelect('spec-regime', blocksByKind('regime'), { includeNone: true });
  const hasRegime = blocksByKind('regime').length > 0;
  document.getElementById('spec-regime-empty').style.display = hasRegime ? 'none' : '';

  populateSelect('spec-exit-hardstop', blocksByExitSlot('hardStop'), { includeNone: true });
  populateSelect('spec-exit-target',   blocksByExitSlot('target'),   { includeNone: true });
  populateSelect('spec-exit-trail',    blocksByExitSlot('trail'),    { includeNone: true });

  // Sizing is required (spec.sizing is not nullable), so no "None" option.
  // Default to `flat` if present — it's the safest no-op pick; otherwise
  // the first registered sizing block.
  const sizingBlocks = blocksByKind('sizing');
  populateSelect('spec-sizing', sizingBlocks, { includeNone: false, defaultValue: 'flat' });
  updateSizingReqHint();

  // Filters: if no filter blocks registered, hint the user so the empty
  // list doesn't look broken. The "+ Add" button is still clickable (it
  // just won't offer any options).
  const hasFilter = blocksByKind('filter').length > 0;
  document.getElementById('spec-filters-empty').style.display = hasFilter ? 'none' : '';

  // Seed the description line and per-param narrowing controls under each
  // fixed picker so they aren't blank on first render. The "change"
  // listeners keep them in sync thereafter.
  for (const id of ['spec-regime', 'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail', 'spec-sizing']) {
    updateBlockDescription(id);
    const sel = document.getElementById(id);
    renderParamControls(document.getElementById(id + '-params'), sel?.value || '');
  }
}

function updateSizingReqHint() {
  const id = document.getElementById('spec-sizing').value;
  const b = blocksById[id];
  const el = document.getElementById('spec-sizing-req');
  if (!b) { el.textContent = ''; return; }
  const reqs = b.sizingRequirements || [];
  if (reqs.length === 0) { el.textContent = 'no extra requirements'; return; }
  const human = reqs.map(r => {
    if (r === 'stopDistance') return 'stopDistance (requires a Hard Stop block)';
    if (r === 'tradeStats')   return 'tradeStats (uses recent trade history)';
    if (r === 'equityCurve')  return 'equityCurve (uses recent equity PnL)';
    return r;
  }).join(', ');
  el.textContent = `requires: ${human}`;
}

// ═══ Phase 4.3d: per-param narrowing controls ═══════════════════════════
//
// Every block instance in the spec can narrow the registry-declared param
// space. For each declared param we render one row:
//
//   [name]   [pin☐]   [min]  [max]  [step]   [↺ reset]
//            └─ when unchecked we emit { min, max, step }
//   [name]   [pin☑]   [       value        ]  [↺ reset]
//            └─ when checked we emit { value }
//
// State lives in the DOM (dataset attributes on the .param-row) so there's
// no parallel JS state array. The central readParamOverrides() function
// walks the DOM to produce the JSON fragment for a block instance.

// Format a number for display in the input, avoiding unnecessary trailing
// zeros on integers and keeping float precision sensible.
function formatParamNumber(n, type) {
  if (!Number.isFinite(n)) return '';
  if (type === 'int') return String(Math.round(n));
  // Floats: keep up to 6 significant digits, strip trailing zeros.
  return parseFloat(n.toPrecision(6)).toString();
}

// Clamp a raw user input to the registry's declared bounds.
// Returns null for non-finite input so the caller can decide what to do.
function clampToParam(raw, param) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  let v = n;
  if (typeof param.min === 'number') v = Math.max(v, param.min);
  if (typeof param.max === 'number') v = Math.min(v, param.max);
  if (param.type === 'int') v = Math.round(v);
  return v;
}

// Build the DOM node for one param's controls. `param` comes from the
// registry; `override` is optional and seeds the inputs from a prior state
// (used when re-rendering after a block change restores a known override).
function makeParamControlRow(param, override) {
  const row = document.createElement('div');
  row.className = 'param-row';
  row.dataset.paramId = param.id;
  row.dataset.paramType = param.type;
  // Store registry bounds so the JSON emitter and the reset button have
  // a source of truth without re-looking-up the block.
  row.dataset.registryMin  = String(param.min);
  row.dataset.registryMax  = String(param.max);
  row.dataset.registryStep = String(param.step);

  // Decide initial mode (pinned or range) from the override shape.
  const pinned = override && Object.prototype.hasOwnProperty.call(override, 'value');
  if (pinned) row.classList.add('pinned');

  // [name][type]
  const name = document.createElement('span');
  name.className = 'param-name';
  name.textContent = param.id;
  const type = document.createElement('span');
  type.className = 'param-type';
  type.textContent = param.type;
  name.appendChild(type);
  row.appendChild(name);

  // Pin checkbox
  const pinLabel = document.createElement('label');
  pinLabel.className = 'param-pin';
  pinLabel.title = 'Pin this param to a single value (removes from the GA genome)';
  const pinBox = document.createElement('input');
  pinBox.type = 'checkbox';
  pinBox.dataset.role = 'pin';
  pinBox.checked = pinned;
  pinLabel.appendChild(pinBox);
  const pinTxt = document.createElement('span');
  pinTxt.textContent = 'pin';
  pinLabel.appendChild(pinTxt);
  row.appendChild(pinLabel);

  // Range inputs: min / max / step
  const minIn = document.createElement('input');
  minIn.type = 'number';
  minIn.step = 'any';
  minIn.className = 'param-min';
  minIn.dataset.role = 'min';
  minIn.title = `registry min: ${param.min}`;
  minIn.value = formatParamNumber(
    override && 'min' in override ? override.min : param.min, param.type);

  const maxIn = document.createElement('input');
  maxIn.type = 'number';
  maxIn.step = 'any';
  maxIn.className = 'param-max';
  maxIn.dataset.role = 'max';
  maxIn.title = `registry max: ${param.max}`;
  maxIn.value = formatParamNumber(
    override && 'max' in override ? override.max : param.max, param.type);

  const stepIn = document.createElement('input');
  stepIn.type = 'number';
  stepIn.step = 'any';
  stepIn.className = 'param-step';
  stepIn.dataset.role = 'step';
  stepIn.title = `registry step: ${param.step}`;
  stepIn.value = formatParamNumber(
    override && 'step' in override ? override.step : param.step, param.type);

  // Pin value input — single value when pinned. Default to the midpoint
  // (clamped to a representable step) when user flips into pin mode.
  const valIn = document.createElement('input');
  valIn.type = 'number';
  valIn.step = 'any';
  valIn.className = 'param-value';
  valIn.dataset.role = 'value';
  const pinDefault = override && 'value' in override
    ? override.value
    : (param.min + param.max) / 2;
  valIn.value = formatParamNumber(pinDefault, param.type);

  row.appendChild(minIn);
  row.appendChild(maxIn);
  row.appendChild(stepIn);
  row.appendChild(valIn);

  // Reset button — restore registry defaults, clear pin.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'param-reset';
  reset.textContent = '↺';
  reset.title = 'Reset to registry defaults';
  row.appendChild(reset);

  // ── Validation + live preview ─────────────────────────────────
  const markInvalid = (el, bad) => el.classList.toggle('invalid', bad);

  const validateRange = () => {
    const mn = clampToParam(minIn.value, param);
    const mx = clampToParam(maxIn.value, param);
    const sp = parseFloat(stepIn.value);
    markInvalid(minIn,  mn === null);
    markInvalid(maxIn,  mx === null);
    markInvalid(stepIn, !(sp > 0));
    // min > max is a structural error worth flagging.
    if (mn !== null && mx !== null && mn > mx) {
      markInvalid(minIn, true);
      markInvalid(maxIn, true);
    }
  };
  const validateValue = () => {
    const v = clampToParam(valIn.value, param);
    markInvalid(valIn, v === null);
  };

  minIn.addEventListener('input',  () => { validateRange(); renderSpecPreview(); });
  maxIn.addEventListener('input',  () => { validateRange(); renderSpecPreview(); });
  stepIn.addEventListener('input', () => { validateRange(); renderSpecPreview(); });
  valIn.addEventListener('input',  () => { validateValue(); renderSpecPreview(); });

  // On blur, clamp the visible input text to registry bounds so the user
  // can see their entry got clipped. JSON emission re-clamps too.
  const clampAndWrite = (el, which) => {
    const c = clampToParam(el.value, param);
    if (c !== null) el.value = formatParamNumber(c, param.type);
    if (which === 'range') validateRange(); else validateValue();
    renderSpecPreview();
  };
  minIn.addEventListener('blur', () => clampAndWrite(minIn, 'range'));
  maxIn.addEventListener('blur', () => clampAndWrite(maxIn, 'range'));
  valIn.addEventListener('blur', () => clampAndWrite(valIn, 'value'));

  pinBox.addEventListener('change', () => {
    row.classList.toggle('pinned', pinBox.checked);
    renderSpecPreview();
  });

  reset.addEventListener('click', () => {
    pinBox.checked = false;
    row.classList.remove('pinned');
    minIn.value  = formatParamNumber(param.min,  param.type);
    maxIn.value  = formatParamNumber(param.max,  param.type);
    stepIn.value = formatParamNumber(param.step, param.type);
    valIn.value  = formatParamNumber((param.min + param.max) / 2, param.type);
    [minIn, maxIn, stepIn, valIn].forEach(el => el.classList.remove('invalid'));
    renderSpecPreview();
  });

  return row;
}

// Populate (or clear) a slot's param-controls container based on the
// currently-selected block. If blockId is empty, the container is emptied
// and CSS (`.spec-params:empty`) hides it entirely.
function renderParamControls(containerEl, blockId) {
  if (!containerEl) return;
  containerEl.innerHTML = '';
  if (!blockId) return;
  const block = blocksById[blockId];
  if (!block || !Array.isArray(block.params) || block.params.length === 0) return;
  for (const p of block.params) {
    containerEl.appendChild(makeParamControlRow(p));
  }
}

// Walk a param-controls container and return a {paramId: entry} dict
// matching the spec schema: `{min, max, step}` or `{value}` when pinned.
// Falls back to registry defaults for any paramId whose row is missing
// (e.g., the user hasn't yet filled the container on a fresh block pick).
function readParamOverrides(containerEl, block) {
  const out = {};
  if (!block) return out;
  const rowById = {};
  if (containerEl) {
    containerEl.querySelectorAll('.param-row').forEach(r => {
      rowById[r.dataset.paramId] = r;
    });
  }
  for (const p of (block.params || [])) {
    const row = rowById[p.id];
    if (!row) { out[p.id] = paramToSpecEntry(p); continue; }
    const pinBox = row.querySelector('input[data-role="pin"]');
    if (pinBox && pinBox.checked) {
      const v = clampToParam(row.querySelector('input[data-role="value"]').value, p);
      out[p.id] = { value: v ?? p.min };
    } else {
      const mn = clampToParam(row.querySelector('input[data-role="min"]').value,  p);
      const mx = clampToParam(row.querySelector('input[data-role="max"]').value,  p);
      const sp = parseFloat(row.querySelector('input[data-role="step"]').value);
      // If the narrowed range collapses to a single value, emit {value}
      // rather than {min,max,step} so the spec reads as intended.
      if (mn !== null && mx !== null && mn === mx) {
        out[p.id] = { value: mn };
      } else {
        out[p.id] = {
          min:  mn !== null ? mn : p.min,
          max:  mx !== null ? mx : p.max,
          step: (sp > 0)    ? sp : p.step,
        };
      }
    }
  }
  return out;
}

// Row management for entries + filters. Each row is a flex container
// with a <select> + a remove button. The select is kind-filtered.
//
// We track rows by reading the DOM on each preview render rather than
// keeping a parallel JS state array — simpler, and the DOM is the source
// of truth for what the user sees.
function makeBlockRow(kind, value = '') {
  // Outer wrapper holds the select-row AND the description line below it
  // so a row is visually one unit — description moves with the row when
  // it's reordered or removed. Spacing + the dashed separator between
  // rows live in style.css (#page-specs .spec-block-row) so the list is
  // easy to scan without inline noise.
  const wrap = document.createElement('div');
  wrap.className = 'spec-block-row';
  wrap.dataset.kind = kind;

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px';

  const select = document.createElement('select');
  select.style.cssText = 'flex:1;min-width:200px';
  select.dataset.role = 'block-select';

  // Include a placeholder "(pick one)" only if we have options; otherwise
  // show it as the only option so the row isn't useless.
  const items = blocksByKind(kind);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = items.length === 0
    ? `(no ${kind} blocks registered)`
    : '(pick a block)';
  select.appendChild(placeholder);
  for (const b of items) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.id;
    select.appendChild(opt);
  }
  if (value) select.value = value;

  // Per-row description line — updates when the selection changes so the
  // user sees what a block does without leaving the editor.
  const desc = document.createElement('div');
  desc.dataset.role = 'block-desc';
  desc.style.cssText = 'font-size:12px;color:#8b949e;line-height:1.5;margin:4px 0 0 0;min-height:14px';
  desc.textContent = blockDescriptionFor(select.value);

  // Per-row param controls — one row per declared param on the currently
  // selected block. Rebuilt whenever the select changes.
  const paramBox = document.createElement('div');
  paramBox.className = 'spec-params';
  paramBox.dataset.role = 'params';
  paramBox.style.cssText = 'margin-top:6px';
  renderParamControls(paramBox, select.value);

  select.addEventListener('change', () => {
    desc.textContent = blockDescriptionFor(select.value);
    renderParamControls(paramBox, select.value);
    renderSpecPreview();
  });
  row.appendChild(select);

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.textContent = '×';
  rm.title = 'Remove this block';
  rm.style.cssText = 'padding:4px 10px;font-size:14px;line-height:1';
  rm.addEventListener('click', () => {
    wrap.remove();
    renderSpecPreview();
  });
  row.appendChild(rm);

  wrap.appendChild(row);
  wrap.appendChild(desc);
  wrap.appendChild(paramBox);
  return wrap;
}

function addEntryRow() {
  document.getElementById('spec-entries-list').appendChild(makeBlockRow('entry'));
  renderSpecPreview();
}
function addFilterRow() {
  document.getElementById('spec-filters-list').appendChild(makeBlockRow('filter'));
  renderSpecPreview();
}

// Reads all rows of a given container and returns [{blockId, paramsEl}]
// for rows with a non-empty selection. Empty picks are skipped so the
// emitted spec is always a runnable-ish shape. The `paramsEl` lets the
// caller read per-row param overrides out of the DOM.
function readRows(containerId) {
  const out = [];
  document.querySelectorAll(`#${containerId} .spec-block-row`).forEach(row => {
    const sel = row.querySelector('select[data-role="block-select"]');
    if (sel && sel.value) {
      out.push({
        blockId: sel.value,
        paramsEl: row.querySelector('.spec-params[data-role="params"]'),
      });
    }
  });
  return out;
}
// Back-compat shim — some call sites and gates probe for this name.
function readRowBlockIds(containerId) {
  return readRows(containerId).map(r => r.blockId);
}

// Build a {min,max,step} (or {value} when min===max) fragment for one
// registry-declared param. This is the "no UI override" path — used as
// the fallback when a row's param-controls container hasn't been rendered
// yet (e.g., the select just changed but the preview ran first).
function paramToSpecEntry(p) {
  if (p.min !== undefined && p.max !== undefined && p.min === p.max) {
    return { value: p.min };
  }
  const out = {};
  if (p.min  !== undefined) out.min  = p.min;
  if (p.max  !== undefined) out.max  = p.max;
  if (p.step !== undefined) out.step = p.step;
  return out;
}

// Build a full spec-block dict {block, version, instanceId, params} from
// a registry block id. `paramsEl` is the `.spec-params` container whose
// rows describe this instance's overrides; if absent we fall back to the
// registry-declared defaults so the preview never crashes mid-render.
function blockRefToSpec(blockId, paramsEl) {
  const b = blocksById[blockId];
  if (!b) return null;
  const params = paramsEl
    ? readParamOverrides(paramsEl, b)
    : (() => {
        const out = {};
        for (const p of b.params || []) out[p.id] = paramToSpecEntry(p);
        return out;
      })();
  return {
    block: b.id,
    version: b.version ?? 1,
    instanceId: 'main', // 4.3c ships with a single instance per block; multi-instance is a later concern
    params,
  };
}

// Rebuild the full spec object from the current UI state and render it
// into the preview pre. Non-destructive — no side effects outside the
// preview pre and the validity indicator.
function buildSpecFromUi() {
  const name = (document.getElementById('spec-name').value || '').trim();
  const description = (document.getElementById('spec-desc').value || '').trim();

  // Shorthand: read a fixed slot (its <select> and its -params container)
  // and produce the spec-block dict. Returns null for the "None" pick.
  const fixedSlotSpec = (selectId, paramsId) => {
    const id = document.getElementById(selectId).value;
    if (!id) return null;
    return blockRefToSpec(id, document.getElementById(paramsId));
  };

  // Regime: single block, optional.
  const regime = fixedSlotSpec('spec-regime', 'spec-regime-params');

  // Entries.
  const entriesMode = document.getElementById('spec-entries-mode').value;
  const thrMin = parseInt(document.getElementById('spec-entries-threshold-min').value, 10) || 1;
  const thrMax = parseInt(document.getElementById('spec-entries-threshold-max').value, 10) || thrMin;
  const entries = {
    mode: entriesMode,
    blocks: readRows('spec-entries-list')
      .map(r => blockRefToSpec(r.blockId, r.paramsEl))
      .filter(Boolean),
  };
  if (entriesMode === 'score') {
    entries.threshold = thrMin === thrMax ? { value: thrMin } : { min: thrMin, max: thrMax, step: 1 };
  }

  // Filters.
  const filters = {
    mode: document.getElementById('spec-filters-mode').value,
    blocks: readRows('spec-filters-list')
      .map(r => blockRefToSpec(r.blockId, r.paramsEl))
      .filter(Boolean),
  };

  // Exits: three optional slots.
  const exits = {};
  const hardStop = fixedSlotSpec('spec-exit-hardstop', 'spec-exit-hardstop-params');
  const target   = fixedSlotSpec('spec-exit-target',   'spec-exit-target-params');
  const trail    = fixedSlotSpec('spec-exit-trail',    'spec-exit-trail-params');
  if (hardStop) exits.hardStop = hardStop;
  if (target)   exits.target   = target;
  if (trail)    exits.trail    = trail;

  // Sizing: required.
  const sizing = fixedSlotSpec('spec-sizing', 'spec-sizing-params');

  return {
    name,
    description,
    regime,
    entries,
    filters,
    exits,
    sizing,
    constraints: [],
    // Phase 4.4: fitness config is now UI-driven. Sliders/inputs emit
    // the same shape engine/spec.js normalizes; walkForward stays
    // hardcoded at the runner defaults (not yet exposed in the editor).
    fitness: readFitnessFromUi(),
    walkForward: { nWindows: 5, scheme: 'anchored' },
  };
}

/**
 * Read the current values from the Fitness card inputs into the spec's
 * `fitness` shape. Numbers are parsed defensively — if an input is blank
 * or non-numeric we fall back to the last known default (set at init
 * from GET /api/defaults), so the preview never emits `NaN` which would
 * poison the server-side validator.
 *
 * The sliders emit step=0.05 floats; we round to 2 decimals so the JSON
 * doesn't drift into noise like `0.30000000000000004`.
 */
function readFitnessFromUi() {
  const numOr = (id, fallback) => {
    const el = document.getElementById(id);
    const n = parseFloat(el?.value);
    return Number.isFinite(n) ? n : fallback;
  };
  const intOr = (id, fallback) => {
    const el = document.getElementById(id);
    const n = parseInt(el?.value, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const d = fitnessDefaults; // module-level cache, see loadFitnessDefaults
  return {
    weights: {
      pf:  round2(numOr('spec-fitness-w-pf',  d.weights.pf)),
      dd:  round2(numOr('spec-fitness-w-dd',  d.weights.dd)),
      ret: round2(numOr('spec-fitness-w-ret', d.weights.ret)),
    },
    caps: {
      pf:  numOr('spec-fitness-cap-pf',  d.caps.pf),
      ret: numOr('spec-fitness-cap-ret', d.caps.ret),
    },
    gates: {
      minTradesPerWindow: intOr('spec-fitness-gate-mintrades', d.gates.minTradesPerWindow),
      worstRegimePfFloor: numOr('spec-fitness-gate-regimepf',  d.gates.worstRegimePfFloor),
      wfeMin:             numOr('spec-fitness-gate-wfemin',    d.gates.wfeMin),
    },
  };
}

/**
 * Module-level cache of the defaults returned by GET /api/defaults. Used
 * both as fallback (readFitnessFromUi) and by the Reset button. Seeded
 * with the same values engine/spec.js defines so the editor is functional
 * even if the fetch is slow (or fails outright) — the endpoint is the
 * authoritative value, this is just a safety net.
 */
let fitnessDefaults = {
  weights: { pf: 0.5, dd: 0.3, ret: 0.2 },
  caps:    { pf: 4.0, ret: 2.0 },
  gates:   { minTradesPerWindow: 30, worstRegimePfFloor: 1.0, wfeMin: 0.5 },
};

/**
 * Fetch the server-side defaults once at init and populate the Fitness
 * card with them. The initial DOM values already mirror what the server
 * returns, so in the happy path nothing visibly changes — the point is
 * to route "recommended values" through a single source of truth so a
 * drift in engine/spec.js surfaces in the UI immediately.
 *
 * Graceful degradation: on fetch failure, keep the hardcoded fallback
 * and log. The user can still author and save specs; only the
 * "recommended" chip will be stale.
 */
async function loadFitnessDefaults() {
  try {
    const r = await fetch('/api/defaults');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data?.fitness) fitnessDefaults = data.fitness;
  } catch (err) {
    console.warn('[specs] loadFitnessDefaults failed, using fallback:', err);
  }
  applyFitnessDefaultsToUi(); // initial populate + recommended-value chips
  renderSpecPreview();        // reflect post-fetch values in the preview
}

/**
 * Write a fitness config object into the form inputs. Also refreshes the
 * live value labels for the weight sliders and the weights-sum indicator.
 */
function setFitnessInputs(fit) {
  const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  put('spec-fitness-w-pf',  fit.weights.pf);
  put('spec-fitness-w-dd',  fit.weights.dd);
  put('spec-fitness-w-ret', fit.weights.ret);
  put('spec-fitness-cap-pf',  fit.caps.pf);
  put('spec-fitness-cap-ret', fit.caps.ret);
  put('spec-fitness-gate-mintrades', fit.gates.minTradesPerWindow);
  put('spec-fitness-gate-regimepf',  fit.gates.worstRegimePfFloor);
  put('spec-fitness-gate-wfemin',    fit.gates.wfeMin);
  updateWeightLabels();
}

/**
 * Populate the grey "recommended: X" chips next to each input AND seed
 * the inputs themselves with the recommended values. Called once after
 * /api/defaults resolves, and each time the user clicks Reset.
 */
function applyFitnessDefaultsToUi() {
  const d = fitnessDefaults;
  const chip = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `recommended: ${val}`;
  };
  chip('spec-fitness-w-pf-def',          d.weights.pf.toFixed(2));
  chip('spec-fitness-w-dd-def',          d.weights.dd.toFixed(2));
  chip('spec-fitness-w-ret-def',         d.weights.ret.toFixed(2));
  chip('spec-fitness-cap-pf-def',        d.caps.pf);
  chip('spec-fitness-cap-ret-def',       d.caps.ret);
  chip('spec-fitness-gate-mintrades-def', d.gates.minTradesPerWindow);
  chip('spec-fitness-gate-regimepf-def',  d.gates.worstRegimePfFloor);
  chip('spec-fitness-gate-wfemin-def',    d.gates.wfeMin);
  setFitnessInputs(d);
}

/**
 * Update the live value labels that sit next to each weight slider and
 * the sum indicator underneath. Slider `value` is a string in the DOM;
 * parseFloat + toFixed normalizes display to 2 decimals.
 *
 * Weights should sum to ~1.0. engine/spec.js raises a validation warning
 * if the sum drifts more than 0.01 away — we mirror that tolerance here
 * by colouring the sum amber outside the window. (Soft hint only; the
 * authoritative gate is still server-side.)
 */
function updateWeightLabels() {
  const read = (id) => parseFloat(document.getElementById(id)?.value) || 0;
  const pf  = read('spec-fitness-w-pf');
  const dd  = read('spec-fitness-w-dd');
  const ret = read('spec-fitness-w-ret');
  const put = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v.toFixed(2); };
  put('spec-fitness-w-pf-val',  pf);
  put('spec-fitness-w-dd-val',  dd);
  put('spec-fitness-w-ret-val', ret);
  const sumEl = document.getElementById('spec-fitness-w-sum');
  if (sumEl) {
    const sum = pf + dd + ret;
    sumEl.textContent = `Sum: ${sum.toFixed(2)}`;
    sumEl.style.color = Math.abs(sum - 1) <= 0.01 ? '#6e7681' : '#d29922';
  }
}

// Light validation — surfaces obvious problems (missing name, no entry
// blocks, sizing needs stopDistance but no hard-stop picked) without
// blocking the preview. The real gate is the server-side validator we
// lean on for POST /api/specs in 4.3e.
function validateSpec(spec) {
  const issues = [];
  if (!spec.name) issues.push('name is required');
  if (!spec.entries.blocks.length) issues.push('at least one entry block is required');
  if (!spec.sizing)  issues.push('sizing block is required');

  if (spec.sizing) {
    const sb = blocksById[spec.sizing.block];
    const reqs = sb?.sizingRequirements || [];
    if (reqs.includes('stopDistance') && !spec.exits.hardStop) {
      issues.push(`sizing "${spec.sizing.block}" requires a Hard Stop block (stopDistance)`);
    }
  }
  return issues;
}

function renderSpecPreview() {
  const spec = buildSpecFromUi();
  const issues = validateSpec(spec);

  // Render JSON with a stable key order. JSON.stringify doesn't offer a
  // built-in sort, but our spec has a fixed top-level key order we want
  // to preserve (name, description, regime, entries, filters, exits,
  // sizing, constraints, fitness, walkForward) — we build the object in
  // that order in buildSpecFromUi, and JSON.stringify preserves it.
  const json = JSON.stringify(spec, null, 2);
  document.getElementById('spec-json-preview').textContent = json;

  const validity = document.getElementById('spec-preview-validity');
  const issuesEl = document.getElementById('spec-preview-issues');
  if (issues.length === 0) {
    validity.textContent = '✓ valid';
    validity.style.color = '#3fb950';
    issuesEl.textContent = '';
  } else {
    validity.textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'}`;
    validity.style.color = '#d29922';
    issuesEl.textContent = issues.join(' · ');
  }

  // Toggle threshold row visibility based on entries mode.
  const thrRow = document.getElementById('spec-entries-threshold-row');
  thrRow.style.display = spec.entries.mode === 'score' ? '' : 'none';
}

// ── Wire inputs ───────────────────────────────────────
// Every user-visible control that changes the spec shape triggers a
// preview rebuild. We don't debounce — the build is a couple of DOM reads
// + a JSON.stringify on a tiny object, well under 1ms.
['spec-name', 'spec-desc',
 'spec-regime',
 'spec-entries-mode', 'spec-entries-threshold-min', 'spec-entries-threshold-max',
 'spec-filters-mode',
 'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail',
 'spec-sizing',
 // Phase 4.4: fitness inputs also rebuild the preview live.
 'spec-fitness-w-pf',  'spec-fitness-w-dd',  'spec-fitness-w-ret',
 'spec-fitness-cap-pf', 'spec-fitness-cap-ret',
 'spec-fitness-gate-mintrades', 'spec-fitness-gate-regimepf', 'spec-fitness-gate-wfemin',
].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input',  renderSpecPreview);
  el.addEventListener('change', renderSpecPreview);
});

// Weight sliders: on every tick, update the inline value label AND the
// sum indicator. The listener loop above already fires renderSpecPreview,
// so this second listener is purely for the live decoration.
for (const id of ['spec-fitness-w-pf', 'spec-fitness-w-dd', 'spec-fitness-w-ret']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateWeightLabels);
}

// Reset to recommended: re-apply the cached defaults from /api/defaults,
// re-render the preview, and nudge the label updater so sliders re-paint.
document.getElementById('spec-fitness-reset').addEventListener('click', () => {
  applyFitnessDefaultsToUi();
  renderSpecPreview();
});
// Sizing change also updates the requirements hint.
document.getElementById('spec-sizing').addEventListener('change', updateSizingReqHint);

// Fixed-picker change refreshes its description line AND rebuilds the
// per-param narrowing controls for the newly selected block. The selects
// already bubble a preview rebuild via the listener loop above, so we
// only need to re-render the decoration here.
for (const id of ['spec-regime', 'spec-exit-hardstop', 'spec-exit-target', 'spec-exit-trail', 'spec-sizing']) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', () => {
      updateBlockDescription(id);
      renderParamControls(document.getElementById(id + '-params'), el.value);
    });
  }
}

document.getElementById('spec-entries-add').addEventListener('click', addEntryRow);
document.getElementById('spec-filters-add').addEventListener('click', addFilterRow);

document.getElementById('spec-copy-json').addEventListener('click', async () => {
  const json = document.getElementById('spec-json-preview').textContent;
  const status = document.getElementById('spec-copy-status');
  try {
    await navigator.clipboard.writeText(json);
    status.textContent = 'Copied to clipboard';
    status.style.color = '#3fb950';
  } catch {
    // Clipboard API requires a secure context; fall back to a visible
    // textarea + execCommand('copy') which works on http://localhost.
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      status.textContent = 'Copied to clipboard';
      status.style.color = '#3fb950';
    } catch (err) {
      status.textContent = `copy failed: ${err.message}`;
      status.style.color = '#f85149';
    } finally {
      ta.remove();
    }
  }
  setTimeout(() => { status.textContent = ''; }, 2000);
});

// ── Save spec to strategies/ (Phase 4.3e) ─────────────────
//
// POSTs the currently-previewed spec to /api/specs. The server re-runs
// the authoritative validator — the client-side clamps we do in the
// param-narrowing controls are advisory; the backend is the gate.
//
// Three interesting branches:
//   400 — validation failed. Server returns a newline-joined bullet
//         list; we render it verbatim so the user sees every issue.
//   409 — a file with that name already exists. Show a confirm()
//         prompt; on yes, re-POST with ?overwrite=1.
//   200/201 — happy path. Show "Saved ✓ as <filename>" and leave the
//         form alone so the user can keep iterating.
async function saveSpec({ overwrite = false } = {}) {
  const status = document.getElementById('spec-save-status');
  const setStatus = (text, color) => {
    status.textContent = text;
    status.style.color = color;
  };
  setStatus('Saving…', '#8b949e');

  // Always rebuild from the UI — don't trust the preview pre text, which
  // could be stale if the user somehow typed between build and save.
  const spec = buildSpecFromUi();
  const url = '/api/specs' + (overwrite ? '?overwrite=1' : '');
  let res, body;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    body = await res.json().catch(() => ({ error: 'non-JSON response' }));
  } catch (err) {
    setStatus(`Network error: ${err.message}`, '#f85149');
    return;
  }

  if (res.ok && body.ok) {
    const verb = body.overwritten ? 'Overwrote' : 'Saved';
    setStatus(`✓ ${verb} ${body.filename}`, '#3fb950');
    return;
  }

  if (res.status === 409 && body.filename) {
    // Duplicate — ask before clobbering the user's existing file.
    const go = confirm(
      `A spec named "${body.filename}" already exists.\n\nOverwrite it?`
    );
    if (!go) {
      setStatus('Save cancelled — existing file kept.', '#8b949e');
      return;
    }
    return saveSpec({ overwrite: true });
  }

  if (res.status === 400) {
    // validateSpec's message is newline-joined; rendering in a
    // white-space:pre-wrap block preserves the bullet layout.
    setStatus(body.error || 'Validation failed', '#f85149');
    return;
  }

  setStatus(body.error || `Save failed (HTTP ${res.status})`, '#f85149');
}
document.getElementById('spec-save').addEventListener('click', () => saveSpec());

// ─── Init ───────────────────────────────────────────────────
loadSymbols();
loadRuns();
loadQueue();
loadBlocksForEditor();
loadFitnessDefaults();

// Refresh periodically
setInterval(loadSymbols, 30000);
setInterval(loadRuns, 10000);
