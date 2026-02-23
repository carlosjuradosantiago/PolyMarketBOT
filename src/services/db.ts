/**
 * Database Client — Direct Supabase (PostgreSQL)
 *
 * NO Express backend needed. Every function talks directly
 * to Supabase via the @supabase/supabase-js client.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  Portfolio,
  PaperOrder,
  AICostTracker,
  AIUsage,
  ActivityEntry,
  defaultPortfolio,
  defaultAICostTracker,
} from "../types";
import { CycleDebugLog } from "./smartTrader";

// ─── Supabase Client ─────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[DB] Missing VITE_SUPABASE_URL or VITE_SUPABASE_KEY in .env");
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Portfolio ────────────────────────────────────────

export async function dbLoadPortfolio(): Promise<Portfolio> {
  try {
    const { data: portfolio, error: pError } = await supabase
      .from("portfolio")
      .select("*")
      .eq("id", 1)
      .single();
    if (pError) throw pError;

    const { data: openOrders, error: oError } = await supabase
      .from("orders")
      .select("*")
      .in("status", ["pending", "filled"])
      .order("created_at", { ascending: false });
    if (oError) throw oError;

    const { data: closedOrders, error: cError } = await supabase
      .from("orders")
      .select("*")
      .in("status", ["won", "lost", "cancelled", "resolved"])
      .order("resolved_at", { ascending: false })
      .limit(200);
    if (cError) throw cError;

    const open = (openOrders || []).map(deserializeOrder);
    const closed = (closedOrders || []).map(deserializeOrder);
    const initialBal = portfolio.initial_balance || 100;
    const dbBalance = portfolio.balance;

    // ── Sanity check: validate DB balance against computed ──
    // DB balance is maintained by atomic RPCs (deduct_balance / add_balance)
    // Computed balance = initial - invested_in_open + realized_pnl
    const investedInOpen = open.reduce((s, o) => s + (o.totalCost || 0), 0);
    const resolvedOrders = closed.filter(o => o.status === "won" || o.status === "lost");
    const realizedPnl = resolvedOrders.reduce((s, o) => s + (o.pnl || 0), 0);
    const computedBalance = Math.round((initialBal - investedInOpen + realizedPnl) * 100) / 100;

    // If drift detected, fix DB to match computed (self-healing)
    let finalBalance = dbBalance;
    if (Math.abs(dbBalance - computedBalance) > 0.02) {
      console.warn(
        `[DB] Balance drift: DB=$${dbBalance.toFixed(2)} → computed=$${computedBalance.toFixed(2)}. Auto-fixing.`
      );
      finalBalance = computedBalance;
      supabase.from("portfolio").update({ balance: computedBalance }).eq("id", 1)
        .then(({ error: e }) => { if (e) console.error("[DB] Balance sync failed:", e); });
    }

    return {
      balance: finalBalance,
      initialBalance: initialBal,
      totalPnl: realizedPnl,
      lastUpdated: portfolio.last_updated,
      openOrders: open,
      closedOrders: closed,
    };
  } catch (e) {
    console.error("[DB] Failed to load portfolio:", e);
    // CRITICAL: Never return defaultPortfolio on DB failure!
    // That silently wipes all orders/balance when the network hiccups.
    throw new Error(`DB portfolio load failed: ${e}`);
  }
}

export async function dbSavePortfolio(p: Portfolio): Promise<void> {
  // Save balance, total_pnl, last_updated.
  // Safe for sequential operations (cancel, resolution).
  // For concurrent order creation, balance is handled by atomic deduct_balance RPC.
  const { error } = await supabase
    .from("portfolio")
    .update({
      balance: p.balance,
      total_pnl: p.totalPnl,
      last_updated: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw error;
}

export async function dbResetPortfolio(initialBalance = 100): Promise<void> {
  const bal = initialBalance;

  // Reset portfolio
  await supabase.from("portfolio").update({
    balance: bal,
    initial_balance: bal,
    total_pnl: 0.0,
    last_updated: new Date().toISOString(),
  }).eq("id", 1);

  // Clear all related tables
  await supabase.from("orders").delete().neq("id", "___none___");
  await supabase.from("activities").delete().gt("id", 0);
  await supabase.from("cycle_logs").delete().gt("id", 0);
  await supabase.from("ai_usage_history").delete().gt("id", 0);
  await supabase.from("ai_cost_tracker").update({
    total_calls: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0.0,
  }).eq("id", 1);
  await supabase.from("bot_state").update({
    is_running: false,
    start_time: null,
    cycle_count: 0,
  }).eq("id", 1);
}
/** Update initial_balance + reset balance/pnl in DB (full reset with new bankroll) */
export async function dbSetInitialBalance(amount: number): Promise<void> {
  const { error } = await supabase.from("portfolio").update({
    initial_balance: amount,
    balance: amount,
    total_pnl: 0.0,
    last_updated: new Date().toISOString(),
  }).eq("id", 1);
  if (error) console.error("[DB] dbSetInitialBalance failed:", error);
}

// ─── Bot Config (bot_kv) ─────────────────────────────

/** Guarda la configuración del bot en bot_kv (Supabase).
 *  - ai_provider y ai_model como filas individuales (Edge Function las lee)
 *  - bot_config como JSON blob (frontend las recarga)
 */
export async function dbSaveBotConfig(config: Record<string, any>): Promise<void> {
  try {
    const rows = [
      { key: "ai_provider", value: config.ai_provider || "anthropic" },
      { key: "ai_model", value: config.ai_model || "claude-sonnet-4-20250514" },
      { key: "bot_config", value: JSON.stringify(config) },
    ];
    const { error } = await supabase.from("bot_kv").upsert(rows, { onConflict: "key" });
    if (error) {
      console.error("[DB] dbSaveBotConfig failed:", error);
    } else {
      console.log("[DB] Bot config saved to bot_kv:", config.ai_provider, config.ai_model);
    }
  } catch (e) {
    console.error("[DB] dbSaveBotConfig exception:", e);
  }
}

/** Carga la configuración del bot desde bot_kv (Supabase).
 *  Retorna null si no hay config guardada.
 */
export async function dbLoadBotConfig(): Promise<Record<string, any> | null> {
  try {
    const { data, error } = await supabase
      .from("bot_kv")
      .select("key, value")
      .eq("key", "bot_config")
      .single();
    if (error || !data) return null;
    const parsed = JSON.parse(data.value);
    console.log("[DB] Bot config loaded from bot_kv:", parsed.ai_provider, parsed.ai_model);
    return parsed;
  } catch (e) {
    console.error("[DB] dbLoadBotConfig exception:", e);
    return null;
  }
}

// ─── Orders ───────────────────────────────────────────

export async function dbCreateOrder(order: PaperOrder): Promise<void> {
  const { error } = await supabase.from("orders").insert({
    id: order.id,
    market_id: order.marketId,
    condition_id: order.conditionId || "",
    market_question: order.marketQuestion,
    market_slug: order.marketSlug || null,
    outcome: order.outcome,
    outcome_index: order.outcomeIndex,
    side: order.side,
    price: order.price,
    quantity: order.quantity,
    total_cost: order.totalCost,
    potential_payout: order.potentialPayout,
    status: order.status,
    created_at: order.createdAt,
    end_date: order.endDate || null,
    ai_reasoning: order.aiReasoning || null,
  });
  if (error) throw error;

  // Atomically deduct balance: UPDATE portfolio SET balance = balance - amount
  // This is safe even with concurrent calls — atomic SQL operation
  const { error: rpcError } = await supabase.rpc("deduct_balance", { amount: order.totalCost });
  if (rpcError) console.error("[DB] deduct_balance RPC failed:", rpcError);
}

export async function dbUpdateOrder(order: Partial<PaperOrder> & { id: string }): Promise<void> {
  const update: Record<string, any> = {};
  if (order.status !== undefined) update.status = order.status;
  if (order.resolvedAt !== undefined) update.resolved_at = order.resolvedAt || null;
  if (order.pnl !== undefined) update.pnl = order.pnl ?? null;
  if (order.resolutionPrice !== undefined) update.resolution_price = order.resolutionPrice ?? null;
  if (order.lastCheckedAt !== undefined) update.last_checked_at = order.lastCheckedAt || null;
  if (order.aiReasoning !== undefined) update.ai_reasoning = order.aiReasoning || null;

  if (Object.keys(update).length === 0) return;
  const { error } = await supabase
    .from("orders")
    .update(update)
    .eq("id", order.id);
  if (error) throw error;
}

export async function dbCancelOrder(orderId: string, refundAmount: number): Promise<void> {
  await supabase
    .from("orders")
    .update({ status: "cancelled", resolved_at: new Date().toISOString() })
    .eq("id", orderId);

  // Atomically refund balance: UPDATE portfolio SET balance = balance + amount
  const { error } = await supabase.rpc("add_balance", { amount: refundAmount });
  if (error) console.error("[DB] add_balance (cancel) RPC failed:", error);
}

/** Atomically add to balance (used for resolution payouts) */
export async function dbAddBalance(amount: number): Promise<void> {
  const { error } = await supabase.rpc("add_balance", { amount });
  if (error) console.error("[DB] add_balance RPC failed:", error);
}

// ─── Activities ───────────────────────────────────────

export async function dbGetActivities(limit = 200): Promise<ActivityEntry[]> {
  try {
    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).reverse();
  } catch {
    return [];
  }
}

export async function dbAddActivity(entry: ActivityEntry): Promise<void> {
  await supabase.from("activities").insert({
    timestamp: entry.timestamp,
    message: entry.message,
    entry_type: entry.entry_type || "Info",
  });
  // Cleanup old activities (keep 500)
  await supabase.rpc("cleanup_old_activities");
}

export async function dbAddActivitiesBatch(entries: ActivityEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map(e => ({
    timestamp: e.timestamp,
    message: e.message,
    entry_type: e.entry_type || "Info",
  }));
  await supabase.from("activities").insert(rows);
  await supabase.rpc("cleanup_old_activities");
}

// ─── AI Costs ─────────────────────────────────────────

export async function dbLoadCostTracker(): Promise<AICostTracker> {
  try {
    const { data: tracker, error: tError } = await supabase
      .from("ai_cost_tracker")
      .select("*")
      .eq("id", 1)
      .single();
    if (tError) throw tError;

    // Lightweight list — no prompt/rawResponse
    const { data: history, error: hError } = await supabase
      .from("ai_usage_history")
      .select("id, input_tokens, output_tokens, cost_usd, model, timestamp, response_time_ms, summary, recommendations")
      .order("id", { ascending: false })
      .limit(50);
    if (hError) throw hError;

    return {
      totalCalls: tracker.total_calls,
      totalInputTokens: tracker.total_input_tokens,
      totalOutputTokens: tracker.total_output_tokens,
      totalCostUsd: tracker.total_cost_usd,
      history: (history || []).reverse().map(h => ({
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
    };
  } catch {
    return { ...defaultAICostTracker };
  }
}

export async function dbAddAICost(usage: AIUsage): Promise<void> {
  // Update aggregate tracker
  const { data: tracker } = await supabase
    .from("ai_cost_tracker")
    .select("total_calls, total_input_tokens, total_output_tokens, total_cost_usd")
    .eq("id", 1)
    .single();

  if (tracker) {
    await supabase.from("ai_cost_tracker").update({
      total_calls: tracker.total_calls + 1,
      total_input_tokens: tracker.total_input_tokens + usage.inputTokens,
      total_output_tokens: tracker.total_output_tokens + usage.outputTokens,
      total_cost_usd: tracker.total_cost_usd + usage.costUsd,
    }).eq("id", 1);
  }

  // Insert history row
  await supabase.from("ai_usage_history").insert({
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.costUsd,
    model: usage.model,
    timestamp: usage.timestamp || new Date().toISOString(),
    prompt: usage.prompt || null,
    raw_response: usage.rawResponse || null,
    response_time_ms: usage.responseTimeMs || 0,
    summary: usage.summary || null,
    recommendations: usage.recommendations || 0,
    web_searches: usage.webSearches || 0,
    search_queries: usage.searchQueries || [],
  });
}

export async function dbResetAICosts(): Promise<void> {
  await supabase.from("ai_cost_tracker").update({
    total_calls: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0.0,
  }).eq("id", 1);
  await supabase.from("ai_usage_history").delete().gt("id", 0);
}

/** Fetch prompt + rawResponse for a single AI history entry (on demand) */
export async function dbGetAICostDetail(id: number): Promise<{ prompt: string | null; rawResponse: string | null; skipped: { marketId: string; question: string; reason: string }[] }> {
  const { data, error } = await supabase
    .from("ai_usage_history")
    .select("prompt, raw_response")
    .eq("id", id)
    .single();
  if (error || !data) return { prompt: null, rawResponse: null, skipped: [] };

  // Extract skipped array from raw response JSON
  let skipped: { marketId: string; question: string; reason: string }[] = [];
  if (data.raw_response) {
    try {
      // Try extracting JSON from response (may have preamble text)
      const raw = data.raw_response as string;
      const firstBrace = raw.indexOf("{");
      if (firstBrace >= 0) {
        let depth = 0, lastBrace = -1;
        for (let i = firstBrace; i < raw.length; i++) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") { depth--; if (depth === 0) { lastBrace = i; break; } }
        }
        if (lastBrace > firstBrace) {
          const parsed = JSON.parse(raw.substring(firstBrace, lastBrace + 1));
          if (Array.isArray(parsed.skipped)) {
            skipped = parsed.skipped.map((s: any) => ({
              marketId: s.marketId || "",
              question: s.question || "",
              reason: s.reason || "Sin razón",
            }));
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return { prompt: data.prompt || null, rawResponse: data.raw_response || null, skipped };
}

// ─── Last Cycle Timestamp (anti-rapid-fire guard) ─────

/** Get the timestamp of the most recent cycle_log entry that actually called AI (cost > 0) */
export async function dbGetLastCycleTimestamp(): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from("cycle_logs")
      .select("timestamp")
      .gt("cost_usd", 0)  // Only count cycles that actually called AI
      .order("id", { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return null;
    return new Date(data.timestamp);
  } catch {
    return null;
  }
}

// ─── Cycle Logs ───────────────────────────────────────

export async function dbGetCycleLogs(limit = 20): Promise<CycleDebugLog[]> {
  try {
    const { data, error } = await supabase
      .from("cycle_logs")
      .select("*")
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(deserializeCycleLog);
  } catch {
    return [];
  }
}

export async function dbSaveCycleLog(log: CycleDebugLog): Promise<void> {
  await supabase.from("cycle_logs").insert({
    timestamp: log.timestamp,
    total_markets: log.totalMarkets,
    pool_breakdown: { ...log.poolBreakdown, skipped: log.skipped },
    short_term_list: log.shortTermList,
    prompt: log.prompt,
    raw_response: log.rawResponse,
    model: log.model,
    input_tokens: log.inputTokens,
    output_tokens: log.outputTokens,
    cost_usd: log.costUsd,
    response_time_ms: log.responseTimeMs,
    summary: log.summary,
    recommendations: log.recommendations,
    results: log.results,
    bets_placed: log.betsPlaced,
    next_scan_secs: log.nextScanSecs,
    error: log.error || null,
  });
  // Cleanup old logs
  await supabase.rpc("cleanup_old_cycle_logs");
}

// ─── Bot State ────────────────────────────────────────

export interface BotState {
  isRunning: boolean;
  startTime: string | null;
  cycleCount: number;
  dynamicInterval: number;
}

export async function dbGetBotState(): Promise<BotState> {
  try {
    const { data, error } = await supabase
      .from("bot_state")
      .select("*")
      .eq("id", 1)
      .single();
    if (error) throw error;
    return {
      isRunning: !!data.is_running,
      startTime: data.start_time,
      cycleCount: data.cycle_count,
      dynamicInterval: data.dynamic_interval,
    };
  } catch {
    return { isRunning: false, startTime: null, cycleCount: 0, dynamicInterval: 600 };
  }
}

export async function dbSetBotState(state: Partial<BotState>): Promise<void> {
  const updates: Record<string, any> = {};
  if (state.isRunning !== undefined) updates.is_running = state.isRunning;
  if (state.startTime !== undefined) updates.start_time = state.startTime;
  if (state.cycleCount !== undefined) updates.cycle_count = state.cycleCount;
  if (state.dynamicInterval !== undefined) updates.dynamic_interval = state.dynamicInterval;

  if (Object.keys(updates).length > 0) {
    await supabase.from("bot_state").update(updates).eq("id", 1);
  }
}

// ─── Stats (computed) ─────────────────────────────────

export interface DBStats {
  balance: number;
  initialBalance: number;
  totalPnl: number;
  openOrders: number;
  pendingValue: number;
  wins: number;
  losses: number;
  totalTrades: number;
  winRate: number;
  avgBet: number;
  bestTrade: number;
  worstTrade: number;
}

export async function dbGetStats(): Promise<DBStats> {
  const { data: portfolio } = await supabase.from("portfolio").select("*").eq("id", 1).single();

  const { count: openCount } = await supabase
    .from("orders").select("*", { count: "exact", head: true }).in("status", ["pending", "filled"]);

  const { data: pendingRows } = await supabase
    .from("orders").select("potential_payout").in("status", ["pending", "filled"]);
  const pendingValue = (pendingRows || []).reduce((s: number, r: any) => s + r.potential_payout, 0);

  const { count: winsCount } = await supabase.from("orders").select("*", { count: "exact", head: true }).eq("status", "won");
  const { count: lossesCount } = await supabase.from("orders").select("*", { count: "exact", head: true }).eq("status", "lost");

  const { data: pnlRows } = await supabase.from("orders").select("pnl, total_cost").in("status", ["won", "lost"]);
  const wins = winsCount || 0;
  const losses = lossesCount || 0;
  const totalTrades = wins + losses;
  const totalPnl = (pnlRows || []).reduce((s: number, r: any) => s + (r.pnl || 0), 0);
  const avgBet = totalTrades > 0 ? (pnlRows || []).reduce((s: number, r: any) => s + r.total_cost, 0) / totalTrades : 0;
  const bestTrade = (pnlRows || []).reduce((m: number, r: any) => Math.max(m, r.pnl || 0), 0);
  const worstTrade = (pnlRows || []).reduce((m: number, r: any) => Math.min(m, r.pnl || 0), 0);

  return {
    balance: portfolio?.balance || 100,
    initialBalance: portfolio?.initial_balance || 100,
    totalPnl,
    openOrders: openCount || 0,
    pendingValue,
    wins,
    losses,
    totalTrades,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    avgBet,
    bestTrade,
    worstTrade,
  };
}

// ─── Order Sync (bulk import) ─────────────────────────

export interface SyncResult {
  ok: boolean;
  imported: number;
  skipped: number;
}

export async function dbSyncOrders(orders: any[]): Promise<SyncResult> {
  let imported = 0;
  let skipped = 0;

  for (const o of orders) {
    const { error } = await supabase.from("orders").upsert({
      id: o.id,
      market_id: o.marketId,
      condition_id: o.conditionId || "",
      market_question: o.marketQuestion,
      market_slug: o.marketSlug || null,
      outcome: o.outcome,
      outcome_index: o.outcomeIndex,
      side: o.side || "buy",
      price: o.price,
      quantity: o.quantity,
      total_cost: o.totalCost,
      potential_payout: o.potentialPayout,
      status: o.status,
      created_at: o.createdAt,
      end_date: o.endDate || null,
      resolved_at: o.resolvedAt || null,
      pnl: o.pnl ?? null,
      resolution_price: o.resolutionPrice ?? null,
      last_checked_at: o.lastCheckedAt || null,
      ai_reasoning: o.aiReasoning || null,
    }, { onConflict: "id", ignoreDuplicates: true });
    if (!error) imported++; else skipped++;
  }

  return { ok: true, imported, skipped };
}

// ─── Auto-Resolver (runs client-side) ─────────────────

const GAMMA_API = "/api/gamma";
const CHECK_COOLDOWN_MS = 5 * 60 * 1000; // 5 min per order

export interface ResolveResult {
  ok: boolean;
  balance: number;
  openOrders: number;
  justResolved: any[];
}

export async function dbTriggerResolve(): Promise<ResolveResult> {
  const now = new Date();
  const nowISO = now.toISOString();

  // Get open orders past their end_date
  const { data: openOrders } = await supabase
    .from("orders")
    .select("*")
    .in("status", ["pending", "filled"])
    .not("end_date", "is", null)
    .lt("end_date", nowISO);

  const justResolved: any[] = [];

  for (const order of openOrders || []) {
    try {
      // Cooldown check
      if (order.last_checked_at) {
        const lastCheck = new Date(order.last_checked_at).getTime();
        if (now.getTime() - lastCheck < CHECK_COOLDOWN_MS) continue;
      }

      // Update last_checked_at
      await supabase.from("orders").update({ last_checked_at: nowISO }).eq("id", order.id);

      // Fetch market from Gamma API using numeric market_id (condition_id query param is broken)
      const market = await fetchMarketForResolution(order.market_id);
      if (!market) {
        console.warn(`[Resolve] Could not fetch market ${order.market_id} for "${(order.market_question || "").slice(0, 40)}"`);
        continue;
      }
      if (!isMarketOfficiallyResolved(market)) {
        console.log(`[Resolve] Market ${order.market_id} not yet resolved (closed=${market.closed}, accepting=${market.acceptingOrders}, prices=${JSON.stringify(market.outcomePrices)})`);
        continue;
      }

      // Determine winner
      const winnerIdx = getWinningOutcomeIndex(market);
      const isWinner = winnerIdx === order.outcome_index;

      const pnl = isWinner
        ? order.potential_payout - order.total_cost
        : -order.total_cost;
      const status = isWinner ? "won" : "lost";

      // Update order
      const { error: updateErr } = await supabase.from("orders").update({
        status,
        resolved_at: nowISO,
        pnl,
        resolution_price: winnerIdx !== null ? 1.0 : null,
      }).eq("id", order.id);
      if (updateErr) {
        console.error(`[Resolve] Failed to update order ${order.id}:`, updateErr);
        continue;
      }

      // Update portfolio balance
      if (isWinner) {
        const { error: rpcErr } = await supabase.rpc("add_balance", { amount: order.potential_payout });
        if (rpcErr) console.error(`[Resolve] add_balance RPC error:`, rpcErr);
      }
      // Update total_pnl
      const { data: pf } = await supabase.from("portfolio").select("total_pnl").eq("id", 1).single();
      if (pf) {
        await supabase.from("portfolio").update({
          total_pnl: pf.total_pnl + pnl,
          last_updated: nowISO,
        }).eq("id", 1);
      }

      // Log activity
      await supabase.from("activities").insert({
        timestamp: nowISO,
        message: `AUTO-RESOLVED "${(order.market_question || "").slice(0, 50)}" → ${status.toUpperCase()} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        entry_type: isWinner ? "Resolved" : "Warning",
      });

      console.log(`[Resolve] ✅ Order ${order.id} → ${status.toUpperCase()} (P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`);
      justResolved.push(deserializeOrder(order));
    } catch (err) {
      console.error(`[Resolve] Error processing order ${order.id}:`, err);
    }
  }

  // Get updated portfolio info
  const { data: portfolio } = await supabase.from("portfolio").select("balance").eq("id", 1).single();
  const { count: openCount } = await supabase
    .from("orders").select("*", { count: "exact", head: true }).in("status", ["pending", "filled"]);

  return {
    ok: true,
    balance: portfolio?.balance || 100,
    openOrders: openCount || 0,
    justResolved,
  };
}

// ─── Helpers ──────────────────────────────────────────

function deserializeOrder(row: any): PaperOrder {
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
    aiReasoning: row.ai_reasoning || undefined,
  };
}

function deserializeCycleLog(row: any): CycleDebugLog {
  const breakdown = row.pool_breakdown || {};
  // skipped is stored inside pool_breakdown JSONB to avoid schema migration
  const skipped = Array.isArray(breakdown.skipped) ? breakdown.skipped : [];
  return {
    timestamp: row.timestamp,
    totalMarkets: row.total_markets,
    poolBreakdown: breakdown,
    shortTermList: row.short_term_list || [],
    prompt: row.prompt || "",
    rawResponse: row.raw_response || "",
    model: row.model || "",
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    responseTimeMs: row.response_time_ms,
    summary: row.summary || "",
    recommendations: row.recommendations,
    skipped,
    results: row.results || [],
    betsPlaced: row.bets_placed,
    nextScanSecs: row.next_scan_secs,
    error: row.error,
  };
}

async function fetchMarketForResolution(marketId: string) {
  try {
    // Always use numeric market_id with /markets/{id}
    // The ?condition_id= query param is broken on Gamma API
    const url = `${GAMMA_API}/markets/${marketId}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function isMarketOfficiallyResolved(market: any): boolean {
  // Gamma API uses 'closed' field (not 'resolved' which doesn't exist)
  if (!market) return false;
  if (market.closed === true) return true;
  // Fallback: if acceptingOrders is false and one outcome price >= 0.95
  if (market.acceptingOrders === false) {
    try {
      const prices = market.outcomePrices || "[]";
      const parsed = typeof prices === "string" ? JSON.parse(prices) : prices;
      const nums = parsed.map((p: any) => parseFloat(p));
      return nums.some((p: number) => p >= 0.95);
    } catch { /* ignore */ }
  }
  return false;
}

function getWinningOutcomeIndex(market: any): number | null {
  if (!isMarketOfficiallyResolved(market)) return null;
  try {
    const prices = market.outcomePrices || "[]";
    const parsed = typeof prices === "string" ? JSON.parse(prices) : prices;
    const nums = parsed.map((p: any) => parseFloat(p));
    // For closed markets, look for outcome with price >= 0.95 ($1.00 winner)
    const winnerIdx = nums.findIndex((p: number) => p >= 0.95);
    if (winnerIdx >= 0) return winnerIdx;
    // Fallback: highest price outcome
    const maxP = Math.max(...nums);
    return nums.indexOf(maxP);
  } catch {
    return null;
  }
}


