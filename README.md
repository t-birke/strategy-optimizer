# Strategy Optimizer

Local genetic algorithm optimizer for the **JM Simple 3TP** trading strategy. Replaces the TradingView CDP-based approach (~2-5s/eval) with a pure JavaScript backtester (~0.6ms/eval on 4H data), enabling 16-run batch optimizations in minutes instead of hours.

## Architecture

```
Binance REST API --> DuckDB (1-minute candles, ~2.6M per symbol)
                         |
                    SQL aggregation (1m -> any timeframe via integer division)
                         |
                    Backtest Engine (pure JS, Float64Array)
                         |
                    GA Optimizer (island model, worker_threads)
                         |
                Express + WebSocket server
                         |
                Browser UI (live dashboard)
```

## Quick Start

```bash
npm install
npm start          # http://localhost:3000
```

1. **Data tab** -- enter a symbol (e.g., `BTCUSDT`), check Binance, ingest 5 years of 1-minute candles
2. **Optimizer tab** -- click "New Run", select symbols + intervals + period, configure GA, start

## Project Structure

```
strategy-optimizer/
  server.js                    # Express + WebSocket entry point
  db/
    schema.sql                 # DuckDB tables: candles + runs
    connection.js              # DuckDB singleton, query/exec/appender helpers
    candles.js                 # Insert, aggregate, load candle data
  data/
    ingest.js                  # Binance API fetcher (backfill + incremental)
  engine/
    indicators.js              # SMA, EMA, RSI, Stoch, ATR, BB, %Rank, crossover
    strategy.js                # JM Simple 3TP bar-by-bar simulation
    backtest.js                # Orchestrator (load candles + run strategy)
  optimizer/
    params.js                  # 17-gene parameter space, constraints, GA operators
    runner.js                  # Multi-threaded island GA coordinator (main thread)
    island-worker.js           # Island GA executor (worker thread)
  api/
    routes.js                  # REST API + run queue processor
    websocket.js               # WebSocket broadcast for live progress
  ui/
    index.html                 # Single-page dashboard
    app.js                     # Client-side logic + island SVG visualization
    style.css                  # Dark theme (GitHub-inspired)
```

## Strategy: JM Simple 3TP

Bar-by-bar state machine replicating the PineScript strategy. Entry signals combine Stochastic crossover, EMA trend alignment, and Bollinger Band squeeze. Three take-profit levels with partial position exits, ATR-based stop-loss with breakeven move after TP1, and time-based exit.

### 17 Optimizable Parameters

| Gene | Range | Purpose |
|------|-------|---------|
| `minEntry` | 1-3 | Signal score threshold (1=loose, 3=strict) |
| `stochLen` | 5-40 | Stochastic oscillator period |
| `stochSmth` | 1-8 | Stochastic smoothing |
| `rsiLen` | 5-25 | RSI period |
| `emaFast` | 8-40 | Fast EMA period |
| `emaSlow` | 30-150 | Slow EMA period |
| `bbLen` | 10-40 | Bollinger Band period |
| `bbMult` | 1.0-3.5 | BB standard deviation multiplier |
| `atrLen` | 5-30 | ATR period |
| `atrSL` | 0.5-4.0 | Stop-loss distance (ATR multiples) |
| `tp1Mult` | 0.5-3.0 | TP1 distance (ATR multiples) |
| `tp2Mult` | 1.5-6.0 | TP2 distance (ATR multiples) |
| `tp3Mult` | 3.0-12.0 | TP3 distance (ATR multiples) |
| `tp1Pct` | 10-50% | Position % closed at TP1 |
| `tp2Pct` | 10-50% | Position % closed at TP2 |
| `riskPct` | 0.5-5.0% | Risk per trade as % of equity |
| `maxBars` | 5-40 | Max holding period in bars |

Constraints enforced: `emaFast < emaSlow`, `tp1 < tp2 < tp3`, `tp1Pct + tp2Pct <= 90%`.

## GA Optimizer

### Island Model with Worker Threads

Each island runs in its own OS thread via `worker_threads`. Candle data is shared across workers via `SharedArrayBuffer` (zero-copy). The main thread stays free for Express/WebSocket.

**Defaults:** 4 islands, ring topology, migration every 25% of generations.

### Heterogeneous Islands

Islands vary in mutation rate (base +/-50%) and per-gene mutation probability (0.12 to 0.30). This maintains population diversity -- high-mutation islands explore broadly while low-mutation islands exploit locally.

### Migration

Based on academic research (Frahnow & Kotzing 2018, Lassig & Sudholt 2011, Chideme et al. 2025):

- **Ring topology** (default): slow information propagation preserves diversity. Proven mathematically optimal for problems with local optima.
- **Torus topology**: 2D grid with wrap-around. Balanced exploration/exploitation.
- **Random topology**: dynamic target selection each migration event.
- **Elitist guard**: migrants only replace worst individuals if strictly better, preventing local optima from poisoning other islands.
- **Rare migration**: defaults to every 25% of total generations. Literature shows rare migration gives exponential speedup vs logarithmic for frequent migration.

### Fitness Function

```
fitness = netProfit           (if trades >= 10)
        = -1000 + trades*10  (if 3 <= trades < 10, ramp toward valid)
        = -5000              (if trades < 3)
        = -10000             (if error)
```

## API

### Data Management

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/symbols` | List ingested symbols with date ranges |
| `GET` | `/api/symbols/:symbol/check` | Check availability on Binance |
| `POST` | `/api/symbols/:symbol/ingest` | Start full backfill (5 years, 1m candles) |
| `POST` | `/api/symbols/:symbol/update` | Incremental update to present |
| `POST` | `/api/symbols/update-all` | Update all symbols |
| `DELETE` | `/api/symbols/:symbol` | Delete all data for symbol |

### Optimization

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/runs` | List all optimization runs |
| `GET` | `/api/runs/:id` | Full run details + top results |
| `POST` | `/api/runs` | Queue new optimization run(s) |
| `POST` | `/api/runs/:id/cancel` | Cancel active or queued run |
| `GET` | `/api/queue` | Active run + pending queue |

### WebSocket Messages

```
<- ingest_progress  { symbol, fetched, total, pct }
<- ingest_complete  { symbol, candles }
<- run_started      { runId, symbol, timeframe }
<- generation       { gen, best, metrics, islands[], edges[], topology }
<- run_completed    { runId, bestScore, bestMetrics }
```

## Data Layer

DuckDB stores 1-minute candles from Binance. Higher timeframes are derived on-the-fly via SQL aggregation:

```sql
SELECT
  (ts // 14400000) * 14400000 AS bar_ts,   -- floor to 4H boundary
  FIRST(open ORDER BY ts) AS open,
  MAX(high) AS high,
  MIN(low) AS low,
  LAST(close ORDER BY ts) AS close,
  SUM(volume) AS volume
FROM candles
GROUP BY (ts // 14400000) * 14400000
```

Note: DuckDB uses `//` for integer division. The `/` operator does float division on BIGINT, which breaks the floor operation.

## Dependencies

- **@duckdb/node-api** -- NAPI-based DuckDB (works with Node.js v25+)
- **express** v5 -- HTTP server
- **ws** -- WebSocket for live progress
- **ga-island** -- Genetic algorithm with synchronous `evolve()` and population access

No frontend build tools. Vanilla JS served as static files.
