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
