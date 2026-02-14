-- ============================================================
-- Supabase Migration: PolyMarketBot
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ─── PORTFOLIO (single-row) ─────────────────────────────

CREATE TABLE IF NOT EXISTS portfolio (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  initial_balance DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO portfolio (id, balance, initial_balance, total_pnl)
VALUES (1, 100.0, 100.0, 0.0)
ON CONFLICT (id) DO NOTHING;

-- ─── ORDERS ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL DEFAULT '',
  market_question TEXT NOT NULL,
  market_slug TEXT,
  outcome TEXT NOT NULL,
  outcome_index INT NOT NULL,
  side TEXT NOT NULL DEFAULT 'buy',
  price DOUBLE PRECISION NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  total_cost DOUBLE PRECISION NOT NULL,
  potential_payout DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','filled','resolved','cancelled','won','lost')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_date TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  pnl DOUBLE PRECISION,
  resolution_price DOUBLE PRECISION,
  last_checked_at TIMESTAMPTZ,
  ai_reasoning JSONB
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);

-- ─── ACTIVITIES ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activities (
  id BIGSERIAL PRIMARY KEY,
  timestamp TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  message TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'Info',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);

-- ─── AI COST TRACKER (single-row aggregates) ────────────

CREATE TABLE IF NOT EXISTS ai_cost_tracker (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_calls INT NOT NULL DEFAULT 0,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0
);

INSERT INTO ai_cost_tracker (id, total_calls, total_input_tokens, total_output_tokens, total_cost_usd)
VALUES (1, 0, 0, 0, 0.0)
ON CONFLICT (id) DO NOTHING;

-- ─── AI USAGE HISTORY ───────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_usage_history (
  id BIGSERIAL PRIMARY KEY,
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_usd DOUBLE PRECISION NOT NULL,
  model TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt TEXT,
  raw_response TEXT,
  response_time_ms INT DEFAULT 0,
  summary TEXT,
  recommendations INT DEFAULT 0
);

-- ─── CYCLE LOGS ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cycle_logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_markets INT NOT NULL DEFAULT 0,
  pool_breakdown JSONB,
  short_term_list JSONB,
  prompt TEXT,
  raw_response TEXT,
  model TEXT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cost_usd DOUBLE PRECISION DEFAULT 0,
  response_time_ms INT DEFAULT 0,
  summary TEXT,
  recommendations INT DEFAULT 0,
  results JSONB,
  bets_placed INT DEFAULT 0,
  next_scan_secs INT DEFAULT 600,
  error TEXT
);

-- ─── BOT STATE (single-row) ────────────────────────────

CREATE TABLE IF NOT EXISTS bot_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_running BOOLEAN NOT NULL DEFAULT false,
  start_time TIMESTAMPTZ,
  cycle_count INT NOT NULL DEFAULT 0,
  dynamic_interval INT NOT NULL DEFAULT 600
);

INSERT INTO bot_state (id, is_running, cycle_count, dynamic_interval)
VALUES (1, false, 0, 600)
ON CONFLICT (id) DO NOTHING;

-- ─── ROW LEVEL SECURITY ────────────────────────────────
-- Disable RLS for now (bot uses service key, not user auth)

ALTER TABLE portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_cost_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state ENABLE ROW LEVEL SECURITY;

-- Service-role bypass policies (allows full access from backend/edge functions)
CREATE POLICY "service_all" ON portfolio FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON activities FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON ai_cost_tracker FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON ai_usage_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON cycle_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all" ON bot_state FOR ALL USING (true) WITH CHECK (true);

-- ─── FUNCTION: deduct_balance ────────────────────────────

CREATE OR REPLACE FUNCTION deduct_balance(amount DOUBLE PRECISION)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE portfolio
  SET balance = balance - amount, last_updated = now()
  WHERE id = 1;
END;
$$;

-- ─── FUNCTION: add_balance ──────────────────────────────

CREATE OR REPLACE FUNCTION add_balance(amount DOUBLE PRECISION)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE portfolio
  SET balance = balance + amount, last_updated = now()
  WHERE id = 1;
END;
$$;

-- ─── FUNCTION: cleanup_old_activities (keep last 500) ───

CREATE OR REPLACE FUNCTION cleanup_old_activities()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM activities
  WHERE id NOT IN (
    SELECT id FROM activities ORDER BY id DESC LIMIT 500
  );
END;
$$;

-- ─── FUNCTION: cleanup_old_cycle_logs (keep last 50) ────

CREATE OR REPLACE FUNCTION cleanup_old_cycle_logs()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cycle_logs
  WHERE id NOT IN (
    SELECT id FROM cycle_logs ORDER BY id DESC LIMIT 50
  );
END;
$$;

-- ============================================================
-- Done! All 7 tables created + seeded + RLS policies set.
-- ============================================================
