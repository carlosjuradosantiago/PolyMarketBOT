/**
 * Backend API — Express + SQLite (better-sqlite3)
 * 
 * Base de datos real en disco: ./data/bot.db
 * Guarda: portfolio, órdenes, actividades, ciclos IA, costos IA, estado del bot
 */

const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const PORT = 3001;
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "bot.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Open DB ──────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // faster writes
db.pragma("foreign_keys = ON");

console.log(`[DB] SQLite database at: ${DB_PATH}`);

// ─── Schema ───────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL DEFAULT 100.0,
    initial_balance REAL NOT NULL DEFAULT 100.0,
    total_pnl REAL NOT NULL DEFAULT 0.0,
    last_updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    condition_id TEXT NOT NULL DEFAULT '',
    market_question TEXT NOT NULL,
    market_slug TEXT,
    outcome TEXT NOT NULL,
    outcome_index INTEGER NOT NULL,
    side TEXT NOT NULL DEFAULT 'buy',
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    total_cost REAL NOT NULL,
    potential_payout REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    end_date TEXT,
    resolved_at TEXT,
    pnl REAL,
    resolution_price REAL,
    last_checked_at TEXT,
    ai_reasoning TEXT,
    CONSTRAINT valid_status CHECK (status IN ('pending','filled','resolved','cancelled','won','lost'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    message TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'Info',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at);

  CREATE TABLE IF NOT EXISTS ai_cost_tracker (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0.0
  );

  CREATE TABLE IF NOT EXISTS ai_usage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    model TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    prompt TEXT,
    raw_response TEXT,
    response_time_ms INTEGER DEFAULT 0,
    summary TEXT,
    recommendations INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cycle_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    total_markets INTEGER NOT NULL DEFAULT 0,
    pool_breakdown TEXT,
    short_term_list TEXT,
    prompt TEXT,
    raw_response TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    response_time_ms INTEGER DEFAULT 0,
    summary TEXT,
    recommendations INTEGER DEFAULT 0,
    results TEXT,
    bets_placed INTEGER DEFAULT 0,
    next_scan_secs INTEGER DEFAULT 600,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS bot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_running INTEGER NOT NULL DEFAULT 0,
    start_time TEXT,
    cycle_count INTEGER NOT NULL DEFAULT 0,
    dynamic_interval INTEGER NOT NULL DEFAULT 600
  );

  -- Seed initial rows if empty
  INSERT OR IGNORE INTO portfolio (id, balance, initial_balance, total_pnl) VALUES (1, 100.0, 100.0, 0.0);
  INSERT OR IGNORE INTO ai_cost_tracker (id, total_calls, total_input_tokens, total_output_tokens, total_cost_usd) VALUES (1, 0, 0, 0, 0.0);
  INSERT OR IGNORE INTO bot_state (id, is_running, cycle_count, dynamic_interval) VALUES (1, 0, 0, 600);
`);

console.log("[DB] Schema initialized");

// ─── Migrations: add columns that may not exist yet ───
const aiHistoryCols = db.prepare("PRAGMA table_info(ai_usage_history)").all().map(c => c.name);
const migrationsAiHistory = [
  ["prompt", "ALTER TABLE ai_usage_history ADD COLUMN prompt TEXT"],
  ["raw_response", "ALTER TABLE ai_usage_history ADD COLUMN raw_response TEXT"],
  ["response_time_ms", "ALTER TABLE ai_usage_history ADD COLUMN response_time_ms INTEGER DEFAULT 0"],
  ["summary", "ALTER TABLE ai_usage_history ADD COLUMN summary TEXT"],
  ["recommendations", "ALTER TABLE ai_usage_history ADD COLUMN recommendations INTEGER DEFAULT 0"],
];
for (const [col, sql] of migrationsAiHistory) {
  if (!aiHistoryCols.includes(col)) {
    try { db.prepare(sql).run(); console.log(`[DB] Migration: added ai_usage_history.${col}`); } catch(e) { /* already exists */ }
  }
}

// ─── Express App ──────────────────────────────────────

const app = express();
app.use(express.json({ limit: "5mb" }));

// ─── PORTFOLIO ────────────────────────────────────────

app.get("/api/db/portfolio", (req, res) => {
  const portfolio = db.prepare("SELECT * FROM portfolio WHERE id = 1").get();
  const openOrders = db.prepare("SELECT * FROM orders WHERE status IN ('pending','filled') ORDER BY created_at DESC").all();
  const closedOrders = db.prepare("SELECT * FROM orders WHERE status IN ('won','lost','cancelled','resolved') ORDER BY resolved_at DESC LIMIT 200").all();

  res.json({
    balance: portfolio.balance,
    initialBalance: portfolio.initial_balance,
    totalPnl: portfolio.total_pnl,
    lastUpdated: portfolio.last_updated,
    openOrders: openOrders.map(deserializeOrder),
    closedOrders: closedOrders.map(deserializeOrder),
  });
});

app.put("/api/db/portfolio", (req, res) => {
  const { balance, initialBalance, totalPnl } = req.body;
  db.prepare(`
    UPDATE portfolio SET balance = ?, initial_balance = ?, total_pnl = ?, last_updated = datetime('now')
    WHERE id = 1
  `).run(balance, initialBalance, totalPnl);
  res.json({ ok: true });
});

app.post("/api/db/portfolio/reset", (req, res) => {
  const { initialBalance } = req.body;
  const bal = initialBalance || 100.0;

  const resetAll = db.transaction(() => {
    db.prepare("UPDATE portfolio SET balance = ?, initial_balance = ?, total_pnl = 0.0, last_updated = datetime('now') WHERE id = 1").run(bal, bal);
    db.prepare("DELETE FROM orders").run();
    db.prepare("DELETE FROM activities").run();
    db.prepare("DELETE FROM cycle_logs").run();
    db.prepare("DELETE FROM ai_usage_history").run();
    db.prepare("UPDATE ai_cost_tracker SET total_calls = 0, total_input_tokens = 0, total_output_tokens = 0, total_cost_usd = 0.0 WHERE id = 1").run();
    db.prepare("UPDATE bot_state SET is_running = 0, start_time = NULL, cycle_count = 0 WHERE id = 1").run();
  });
  resetAll();
  res.json({ ok: true });
});

// ─── ORDERS ───────────────────────────────────────────

app.post("/api/db/orders", (req, res) => {
  const o = req.body;
  db.prepare(`
    INSERT INTO orders (id, market_id, condition_id, market_question, market_slug, outcome, outcome_index, side, price, quantity, total_cost, potential_payout, status, created_at, end_date, ai_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.id, o.marketId, o.conditionId || "", o.marketQuestion, o.marketSlug || null,
    o.outcome, o.outcomeIndex, o.side, o.price, o.quantity, o.totalCost, o.potentialPayout,
    o.status, o.createdAt, o.endDate || null, o.aiReasoning ? JSON.stringify(o.aiReasoning) : null
  );

  // Deduct from balance
  db.prepare("UPDATE portfolio SET balance = balance - ?, last_updated = datetime('now') WHERE id = 1").run(o.totalCost);

  res.json({ ok: true });
});

app.put("/api/db/orders/:id", (req, res) => {
  const o = req.body;
  db.prepare(`
    UPDATE orders SET status = ?, resolved_at = ?, pnl = ?, resolution_price = ?, last_checked_at = ?, ai_reasoning = ?
    WHERE id = ?
  `).run(
    o.status, o.resolvedAt || null, o.pnl ?? null, o.resolutionPrice ?? null,
    o.lastCheckedAt || null, o.aiReasoning ? JSON.stringify(o.aiReasoning) : null,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete("/api/db/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (order && (order.status === "pending" || order.status === "filled")) {
    db.prepare("UPDATE portfolio SET balance = balance + ?, last_updated = datetime('now') WHERE id = 1").run(order.total_cost);
  }
  db.prepare("UPDATE orders SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── ACTIVITIES ───────────────────────────────────────

app.get("/api/db/activities", (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const rows = db.prepare("SELECT * FROM activities ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows.reverse());
});

app.post("/api/db/activities", (req, res) => {
  const { timestamp, message, entry_type } = req.body;
  db.prepare("INSERT INTO activities (timestamp, message, entry_type) VALUES (?, ?, ?)").run(
    timestamp, message, entry_type || "Info"
  );
  // Keep only last 500
  db.prepare("DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 500)").run();
  res.json({ ok: true });
});

app.post("/api/db/activities/batch", (req, res) => {
  const { items } = req.body;
  const insert = db.prepare("INSERT INTO activities (timestamp, message, entry_type) VALUES (?, ?, ?)");
  const batch = db.transaction((entries) => {
    for (const e of entries) {
      insert.run(e.timestamp, e.message, e.entry_type || "Info");
    }
  });
  batch(items || []);
  db.prepare("DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY id DESC LIMIT 500)").run();
  res.json({ ok: true });
});

// ─── AI COST TRACKER ──────────────────────────────────

app.get("/api/db/ai-costs", (req, res) => {
  const tracker = db.prepare("SELECT * FROM ai_cost_tracker WHERE id = 1").get();
  // Lightweight list: NO prompt/rawResponse (fetched on demand via /ai-costs/:id)
  const history = db.prepare("SELECT id, input_tokens, output_tokens, cost_usd, model, timestamp, response_time_ms, summary, recommendations FROM ai_usage_history ORDER BY id DESC LIMIT 50").all();
  res.json({
    totalCalls: tracker.total_calls,
    totalInputTokens: tracker.total_input_tokens,
    totalOutputTokens: tracker.total_output_tokens,
    totalCostUsd: tracker.total_cost_usd,
    history: history.reverse().map(h => ({
      id: h.id,
      inputTokens: h.input_tokens,
      outputTokens: h.output_tokens,
      costUsd: h.cost_usd,
      model: h.model,
      timestamp: h.timestamp,
      responseTimeMs: h.response_time_ms || undefined,
      summary: h.summary || undefined,
      recommendations: h.recommendations || undefined,
    })),
  });
});

// On-demand detail: returns full prompt + rawResponse for a single history entry
app.get("/api/db/ai-costs/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const row = db.prepare("SELECT prompt, raw_response FROM ai_usage_history WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({
    prompt: row.prompt || null,
    rawResponse: row.raw_response || null,
  });
});

app.post("/api/db/ai-costs/add", (req, res) => {
  const { inputTokens, outputTokens, costUsd, model, timestamp, prompt, rawResponse, responseTimeMs, summary, recommendations } = req.body;
  db.prepare(`
    UPDATE ai_cost_tracker SET
      total_calls = total_calls + 1,
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?
    WHERE id = 1
  `).run(inputTokens, outputTokens, costUsd);

  db.prepare(`INSERT INTO ai_usage_history
    (input_tokens, output_tokens, cost_usd, model, timestamp, prompt, raw_response, response_time_ms, summary, recommendations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    inputTokens, outputTokens, costUsd, model,
    timestamp || new Date().toISOString(),
    prompt || null, rawResponse || null, responseTimeMs || 0,
    summary || null, recommendations || 0
  );
  res.json({ ok: true });
});

app.post("/api/db/ai-costs/reset", (req, res) => {
  db.prepare("UPDATE ai_cost_tracker SET total_calls = 0, total_input_tokens = 0, total_output_tokens = 0, total_cost_usd = 0.0 WHERE id = 1").run();
  db.prepare("DELETE FROM ai_usage_history").run();
  res.json({ ok: true });
});

// ─── CYCLE LOGS ───────────────────────────────────────

app.get("/api/db/cycle-logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const rows = db.prepare("SELECT * FROM cycle_logs ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows.map(deserializeCycleLog));
});

app.post("/api/db/cycle-logs", (req, res) => {
  const l = req.body;
  db.prepare(`
    INSERT INTO cycle_logs (timestamp, total_markets, pool_breakdown, short_term_list, prompt, raw_response, model, input_tokens, output_tokens, cost_usd, response_time_ms, summary, recommendations, results, bets_placed, next_scan_secs, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    l.timestamp, l.totalMarkets,
    JSON.stringify(l.poolBreakdown), JSON.stringify(l.shortTermList),
    l.prompt, l.rawResponse, l.model,
    l.inputTokens, l.outputTokens, l.costUsd, l.responseTimeMs,
    l.summary, l.recommendations, JSON.stringify(l.results),
    l.betsPlaced, l.nextScanSecs, l.error || null
  );
  // Keep only last 50 cycle logs
  db.prepare("DELETE FROM cycle_logs WHERE id NOT IN (SELECT id FROM cycle_logs ORDER BY id DESC LIMIT 50)").run();
  res.json({ ok: true });
});

// ─── BOT STATE ────────────────────────────────────────

app.get("/api/db/bot-state", (req, res) => {
  const state = db.prepare("SELECT * FROM bot_state WHERE id = 1").get();
  res.json({
    isRunning: !!state.is_running,
    startTime: state.start_time,
    cycleCount: state.cycle_count,
    dynamicInterval: state.dynamic_interval,
  });
});

app.put("/api/db/bot-state", (req, res) => {
  const { isRunning, startTime, cycleCount, dynamicInterval } = req.body;
  const updates = [];
  const params = [];

  if (isRunning !== undefined) { updates.push("is_running = ?"); params.push(isRunning ? 1 : 0); }
  if (startTime !== undefined) { updates.push("start_time = ?"); params.push(startTime); }
  if (cycleCount !== undefined) { updates.push("cycle_count = ?"); params.push(cycleCount); }
  if (dynamicInterval !== undefined) { updates.push("dynamic_interval = ?"); params.push(dynamicInterval); }

  if (updates.length > 0) {
    db.prepare(`UPDATE bot_state SET ${updates.join(", ")} WHERE id = 1`).run(...params);
  }
  res.json({ ok: true });
});

// ─── STATS (computed) ─────────────────────────────────

app.get("/api/db/stats", (req, res) => {
  const portfolio = db.prepare("SELECT * FROM portfolio WHERE id = 1").get();
  const openCount = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','filled')").get().c;
  const pendingValue = db.prepare("SELECT COALESCE(SUM(potential_payout), 0) as v FROM orders WHERE status IN ('pending','filled')").get().v;
  const wins = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'won'").get().c;
  const losses = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'lost'").get().c;
  const wonPnl = db.prepare("SELECT COALESCE(SUM(pnl), 0) as v FROM orders WHERE status = 'won'").get().v;
  const lostPnl = db.prepare("SELECT COALESCE(SUM(pnl), 0) as v FROM orders WHERE status = 'lost'").get().v;
  const bestTrade = db.prepare("SELECT COALESCE(MAX(pnl), 0) as v FROM orders WHERE status IN ('won','lost')").get().v;
  const worstTrade = db.prepare("SELECT COALESCE(MIN(pnl), 0) as v FROM orders WHERE status IN ('won','lost')").get().v;
  const totalTrades = wins + losses;
  const avgBet = totalTrades > 0
    ? db.prepare("SELECT COALESCE(AVG(total_cost), 0) as v FROM orders WHERE status IN ('won','lost')").get().v
    : 0;

  res.json({
    balance: portfolio.balance,
    initialBalance: portfolio.initial_balance,
    totalPnl: wonPnl + lostPnl,
    openOrders: openCount,
    pendingValue,
    wins,
    losses,
    totalTrades,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    avgBet,
    bestTrade,
    worstTrade,
  });
});

// ─── Helpers ──────────────────────────────────────────

function deserializeOrder(row) {
  return {
    id: row.id,
    marketId: row.market_id,
    conditionId: row.condition_id,
    marketQuestion: row.market_question,
    marketSlug: row.market_slug,
    outcome: row.outcome,
    outcomeIndex: row.outcome_index,
    side: row.side,
    price: row.price,
    quantity: row.quantity,
    totalCost: row.total_cost,
    potentialPayout: row.potential_payout,
    status: row.status,
    createdAt: row.created_at,
    endDate: row.end_date,
    resolvedAt: row.resolved_at,
    pnl: row.pnl,
    resolutionPrice: row.resolution_price,
    lastCheckedAt: row.last_checked_at,
    aiReasoning: row.ai_reasoning ? JSON.parse(row.ai_reasoning) : undefined,
  };
}

function deserializeCycleLog(row) {
  return {
    timestamp: row.timestamp,
    totalMarkets: row.total_markets,
    poolBreakdown: row.pool_breakdown ? JSON.parse(row.pool_breakdown) : {},
    shortTermList: row.short_term_list ? JSON.parse(row.short_term_list) : [],
    prompt: row.prompt || "",
    rawResponse: row.raw_response || "",
    model: row.model || "",
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    responseTimeMs: row.response_time_ms,
    summary: row.summary || "",
    recommendations: row.recommendations,
    results: row.results ? JSON.parse(row.results) : [],
    betsPlaced: row.bets_placed,
    nextScanSecs: row.next_scan_secs,
    error: row.error,
  };
}

// ─── ORDER SYNC (bulk import from localStorage) ──────

app.post("/api/db/orders/sync", (req, res) => {
  const { orders } = req.body;
  if (!Array.isArray(orders)) return res.status(400).json({ error: "orders must be an array" });

  let imported = 0;
  let skipped = 0;

  const upsert = db.prepare(`
    INSERT OR IGNORE INTO orders (id, market_id, condition_id, market_question, market_slug, outcome, outcome_index, side, price, quantity, total_cost, potential_payout, status, created_at, end_date, resolved_at, pnl, resolution_price, last_checked_at, ai_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batch = db.transaction((orderList) => {
    for (const o of orderList) {
      const result = upsert.run(
        o.id, o.marketId, o.conditionId || "", o.marketQuestion, o.marketSlug || null,
        o.outcome, o.outcomeIndex, o.side || "buy", o.price, o.quantity, o.totalCost, o.potentialPayout,
        o.status, o.createdAt, o.endDate || null, o.resolvedAt || null,
        o.pnl ?? null, o.resolutionPrice ?? null, o.lastCheckedAt || null,
        o.aiReasoning ? JSON.stringify(o.aiReasoning) : null
      );
      if (result.changes > 0) imported++;
      else skipped++;
    }
  });

  batch(orders);
  console.log(`[Sync] Imported ${imported} orders, skipped ${skipped} already existing`);
  res.json({ ok: true, imported, skipped });
});

// ─── AUTO-RESOLVER: Background job ───────────────────
// Runs every 60 seconds. Checks open orders past their end_date,
// fetches Gamma API for resolution status, and resolves them.

const GAMMA_API = "https://gamma-api.polymarket.com";
const RESOLVE_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
const CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per order

async function fetchMarketByConditionId(conditionId) {
  try {
    const isCondition = conditionId.startsWith("0x");
    const url = isCondition
      ? `${GAMMA_API}/markets?condition_id=${conditionId}`
      : `${GAMMA_API}/markets/${conditionId}`;

    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();

    if (isCondition) {
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    }
    return data;
  } catch (e) {
    console.error(`[Resolver] Fetch error for ${conditionId}:`, e.message);
    return null;
  }
}

function isMarketOfficiallyResolved(market) {
  return market && market.resolved === true;
}

function getWinningOutcomeIndex(market) {
  if (!isMarketOfficiallyResolved(market)) return null;
  try {
    const prices = (market.outcomePrices || "[]");
    const parsed = typeof prices === "string" ? JSON.parse(prices) : prices;
    const nums = parsed.map(p => parseFloat(p));
    const winnerIdx = nums.findIndex(p => p >= 0.95);
    if (winnerIdx >= 0) return winnerIdx;
    const maxP = Math.max(...nums);
    return nums.indexOf(maxP);
  } catch {
    return null;
  }
}

async function runAutoResolver() {
  const now = new Date();
  const nowISO = now.toISOString();

  // Get open orders whose end_date has passed
  const openOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('pending', 'filled')
    AND end_date IS NOT NULL
    AND end_date < ?
  `).all(nowISO);

  if (openOrders.length === 0) return;

  let resolved = 0;
  let checked = 0;
  let skippedCooldown = 0;

  for (const order of openOrders) {
    // Cooldown: don't re-check if we checked < 5 min ago
    if (order.last_checked_at) {
      const lastCheck = new Date(order.last_checked_at).getTime();
      if (now.getTime() - lastCheck < CHECK_COOLDOWN_MS) {
        skippedCooldown++;
        continue;
      }
    }

    checked++;

    // Update last_checked_at
    db.prepare("UPDATE orders SET last_checked_at = ? WHERE id = ?").run(nowISO, order.id);

    // Fetch market from Gamma API
    const market = await fetchMarketByConditionId(order.condition_id);
    if (!market) {
      console.log(`[Resolver] Could not fetch market for order ${order.id} (${order.condition_id})`);
      continue;
    }

    if (!isMarketOfficiallyResolved(market)) {
      // Not resolved yet — UMA oracle may still be processing
      continue;
    }

    // Determine winner
    const winnerIdx = getWinningOutcomeIndex(market);
    const isWinner = winnerIdx === order.outcome_index;

    let pnl;
    let status;
    if (isWinner) {
      pnl = order.potential_payout - order.total_cost;
      status = "won";
    } else {
      pnl = -order.total_cost;
      status = "lost";
    }

    // Update order in DB
    db.prepare(`
      UPDATE orders SET status = ?, resolved_at = ?, pnl = ?, resolution_price = ?
      WHERE id = ?
    `).run(status, nowISO, pnl, winnerIdx !== null ? 1.0 : null, order.id);

    // Update portfolio balance if won
    if (isWinner) {
      db.prepare("UPDATE portfolio SET balance = balance + ?, total_pnl = total_pnl + ?, last_updated = datetime('now') WHERE id = 1").run(order.potential_payout, pnl);
    } else {
      db.prepare("UPDATE portfolio SET total_pnl = total_pnl + ?, last_updated = datetime('now') WHERE id = 1").run(pnl);
    }

    // Log activity
    db.prepare("INSERT INTO activities (timestamp, message, entry_type) VALUES (?, ?, ?)").run(
      nowISO,
      `AUTO-RESOLVED "${order.market_question.slice(0, 50)}" → ${status.toUpperCase()} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      isWinner ? "Resolved" : "Warning"
    );

    resolved++;
    console.log(`[Resolver] ${order.market_question.slice(0, 50)} → ${status.toUpperCase()} (P&L: $${pnl.toFixed(2)})`);
  }

  if (checked > 0 || resolved > 0) {
    console.log(`[Resolver] Checked ${checked} orders, resolved ${resolved}, cooldown-skipped ${skippedCooldown}`);
  }
}

// Endpoint to manually trigger a resolution check
app.post("/api/db/orders/resolve-check", async (req, res) => {
  try {
    await runAutoResolver();
    const portfolio = db.prepare("SELECT * FROM portfolio WHERE id = 1").get();
    const openCount = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','filled')").get().c;
    const recentResolved = db.prepare("SELECT * FROM orders WHERE status IN ('won','lost') AND resolved_at > datetime('now', '-1 minute') ORDER BY resolved_at DESC").all();
    res.json({
      ok: true,
      balance: portfolio.balance,
      openOrders: openCount,
      justResolved: recentResolved.map(deserializeOrder),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start the auto-resolver background job
let resolverInterval = null;

function startAutoResolver() {
  console.log(`[Resolver] Auto-resolver started — checking every ${RESOLVE_CHECK_INTERVAL_MS / 1000}s`);
  // Run once immediately
  runAutoResolver().catch(e => console.error("[Resolver] Error:", e));
  // Then every 60 seconds
  resolverInterval = setInterval(() => {
    runAutoResolver().catch(e => console.error("[Resolver] Error:", e));
  }, RESOLVE_CHECK_INTERVAL_MS);
}

// ─── Start ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[DB Server] Running on http://localhost:${PORT}`);
  console.log(`[DB Server] Database file: ${DB_PATH}`);
  // Start background jobs
  startAutoResolver();
});
