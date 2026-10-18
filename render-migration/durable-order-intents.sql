-- Migration staging: durable, audit-friendly order intent table for an EXISTING
-- Cloudflare D1 database. NOT deployed. No real orders will be enabled by this file.
-- Each account can have at most one intent per 5-minute round.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS render_order_intents (
  id TEXT PRIMARY KEY NOT NULL,
  account_id_hash TEXT NOT NULL,
  round_start_ms INTEGER NOT NULL CHECK (round_start_ms > 0 AND round_start_ms % 300000=0),
  strategy_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  predicted_direction TEXT NOT NULL CHECK(predicted_direction IN ('UP','DOWN')),
  execution_direction TEXT NOT NULL CHECK(execution_direction IN ('UP','DOWN')),
  amount_usdt TEXT NOT NULL,
  intent_nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN (
    'CREATED','READY','SUBMITTING','SUBMISSION_UNKNOWN',
    'CONFIRMED_FILLED','CONFIRMED_FAILED','CANCELED','RECONCILIATION_REQUIRED'
  )),
  exchange_order_id TEXT UNIQUE,
  exchange_status TEXT,
  last_api_http_code INTEGER,
  expected_quote_expires_at_ms INTEGER,
  submitted_at_ms INTEGER,
  reconciled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  error_class TEXT,
  UNIQUE(account_id_hash,round_start_ms)
);
CREATE INDEX IF NOT EXISTS idx_render_order_intents_unresolved
ON render_order_intents(state,created_at_ms);

CREATE TABLE IF NOT EXISTS render_order_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  intent_id TEXT NOT NULL REFERENCES render_order_intents(id),
  event_type TEXT NOT NULL,
  event_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_render_order_events_intent
ON render_order_events(intent_id,event_at_ms);

-- Invariants before any money is used:
-- 1. Claim unique account+round BEFORE any external order submission.
-- 2. Persist SUBMITTING before invoking Binance.
-- 3. On timeout/unknown outcome persist SUBMISSION_UNKNOWN, reconcile via
--    an authenticated read-only exchange query; never blindly retry.
-- 4. Keep a mandatory review/audit trail of original Binance order IDs/status.
-- 5. Halt automatic trading if D1 isn't reachable or any write fails.
-- 6. Configure authenticated internal-only access, not the public panel PIN alone.
