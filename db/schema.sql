-- Minute candles from Binance
CREATE TABLE IF NOT EXISTS candles (
  symbol    VARCHAR NOT NULL,
  ts        BIGINT NOT NULL,      -- Unix milliseconds
  open      DOUBLE NOT NULL,
  high      DOUBLE NOT NULL,
  low       DOUBLE NOT NULL,
  close     DOUBLE NOT NULL,
  volume    DOUBLE NOT NULL,
  PRIMARY KEY (symbol, ts)
);

-- Optimization run metadata
CREATE SEQUENCE IF NOT EXISTS run_id_seq START 1;

CREATE TABLE IF NOT EXISTS runs (
  id                    INTEGER PRIMARY KEY DEFAULT nextval('run_id_seq'),
  symbol                VARCHAR NOT NULL,
  timeframe             INTEGER NOT NULL,
  start_date            VARCHAR NOT NULL,
  status                VARCHAR DEFAULT 'pending',
  config                JSON,
  best_gene             JSON,
  best_metrics          JSON,
  top_results           JSON,
  generation_log        JSON,
  generations_completed INTEGER DEFAULT 0,
  total_evaluations     INTEGER DEFAULT 0,
  error                 VARCHAR,
  started_at            TIMESTAMP,
  completed_at          TIMESTAMP,
  created_at            TIMESTAMP DEFAULT current_timestamp
);

-- Phase 4.1 spec-mode columns. Additive migration, legacy rows leave these NULL.
--   spec_hash              — spec.hash of the optimized spec (links to specs.hash).
--   spec_name              — denormalized spec.name for cheap listing without a join.
--   wf_report_json         — serialized walk-forward report for the winning gene
--                            (NULL until the runner emits a post-GA WF report).
--   fitness_breakdown_json — bestMetrics._fitness from spec-mode runs: score,
--                            eliminated flag, gatesFailed, breakdown.normPf/normDd/normRet,
--                            regimeSource, worstRegimePf, etc.
--   regime_breakdown_json  — bestMetrics.regimeBreakdown: per-regime trades, wins, pf,
--                            net, grossProfit, grossLoss map.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS spec_hash              VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS spec_name              VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS wf_report_json         JSON;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS fitness_breakdown_json JSON;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS regime_breakdown_json  JSON;

-- Phase 4.2a queue columns. Additive migration, legacy rows leave these NULL
-- or at the default. Turns runs.status into a pullable queue rather than keeping
-- a parallel queue table.
--   priority          — higher value runs first (ORDER BY priority DESC, id ASC).
--                       Default 0 matches legacy behavior of FIFO-by-id.
--   claimed_by        — worker identifier (hostname.pid or similar) that claimed
--                       the row. NULL while pending or after a stale-lease recovery.
--   claimed_at        — set atomically when a worker transitions pending to running.
--   heartbeat_at      — worker pings on an interval. Stale rows (heartbeat older
--                       than the timeout) are swept back to pending by recoverStaleRuns.
--   cancel_requested  — UI or CLI sets this TRUE. In-flight runner checks it and
--                       stops gracefully. Pending rows with this flag are skipped
--                       by claimNextRun and marked cancelled.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS priority         INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS claimed_by       VARCHAR;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMP;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at     TIMESTAMP;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN DEFAULT FALSE;

-- Canonical spec store. Keyed by spec.hash — the same content-hash used to
-- invalidate the fitness cache. Lets `runs.spec_hash` resolve back to the
-- exact JSON we optimized, so a run from last month can always be replayed
-- or diffed even if the strategy file on disk has since been edited.
--
-- `json` is the full validated-spec payload (what `engine/spec.js::validateSpec`
-- returns). `name` and `version` are denormalized from `json` for UI convenience.
CREATE TABLE IF NOT EXISTS specs (
  hash        VARCHAR PRIMARY KEY,
  name        VARCHAR NOT NULL,
  version     INTEGER,
  json        JSON NOT NULL,
  created_at  TIMESTAMP DEFAULT current_timestamp
);
