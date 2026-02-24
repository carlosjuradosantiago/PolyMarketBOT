// ═══════════════════════════════════════════════════════════════════
// Edge Function: get-status
// Devuelve el estado completo del bot para el dashboard.
// Incluye: bot_state, portfolio, últimos ciclos, órdenes abiertas, costes IA
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  try {
    // Lanzar todas las consultas en paralelo
    const [
      botStateRes,
      portfolioRes,
      lastCycleRes,
      openOrdersRes,
      aiCostRes,
      recentActivitiesRes,
      statsRes,
    ] = await Promise.all([
      // bot_state
      supabase.from("bot_state").select("*").eq("id", 1).single(),
      // portfolio
      supabase.from("portfolio").select("*").eq("id", 1).single(),
      // último ciclo
      supabase.from("cycle_logs").select("*").order("timestamp", { ascending: false }).limit(1).single(),
      // órdenes abiertas (pending o filled)
      supabase.from("orders").select("id", { count: "exact" }).in("status", ["pending", "filled"]),
      // costes IA
      supabase.from("ai_cost_tracker").select("*").eq("id", 1).single(),
      // actividades recientes
      supabase.from("activities").select("*").order("timestamp", { ascending: false }).limit(30),
      // estadísticas calculadas: órdenes ganadas/perdidas/totales
      supabase.from("orders").select("status, profit"),
    ]);

    const botState = botStateRes.data;
    const portfolio = portfolioRes.data;
    const lastCycle = lastCycleRes.data;
    const openOrdersCount = openOrdersRes.count || 0;
    const aiCost = aiCostRes.data;
    const activities = recentActivitiesRes.data || [];

    // Calcular stats desde órdenes
    const allOrders = statsRes.data || [];
    const totalOrders = allOrders.length;
    const wonOrders = allOrders.filter((o: { status: string; profit: number }) => o.status === "won");
    const lostOrders = allOrders.filter((o: { status: string; profit: number }) => o.status === "lost");
    const pendingOrders = allOrders.filter((o: { status: string }) => ["pending", "filled"].includes(o.status));
    const totalProfit = allOrders.reduce((sum: number, o: { profit: number }) => sum + (o.profit || 0), 0);
    const winRate = totalOrders > 0 ? (wonOrders.length / (wonOrders.length + lostOrders.length)) * 100 : 0;

    // Calcular PnL
    const balance = portfolio?.balance ?? 0;
    const initialBalance = portfolio?.initial_balance ?? 1500;
    const pnl = balance - initialBalance;
    const pnlPercent = initialBalance > 0 ? (pnl / initialBalance) * 100 : 0;

    return jsonResponse({
      ok: true,
      botState: {
        isRunning: botState?.is_running ?? false,
        analyzing: botState?.analyzing ?? false,
        cycleCount: botState?.cycle_count ?? 0,
        dynamicInterval: botState?.dynamic_interval ?? 24,
        startTime: botState?.start_time ?? null,
        lastError: botState?.last_error ?? null,
        lastCycleAt: botState?.last_cycle_at ?? null,
      },
      portfolio: {
        balance,
        initialBalance,
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
      },
      stats: {
        totalOrders,
        won: wonOrders.length,
        lost: lostOrders.length,
        pending: pendingOrders.length,
        openOrders: openOrdersCount,
        totalProfit: Math.round(totalProfit * 100) / 100,
        winRate: Math.round(winRate * 10) / 10,
      },
      lastCycle: lastCycle ? {
        timestamp: lastCycle.timestamp,
        summary: lastCycle.summary,
        model: lastCycle.model,
        recommendations: lastCycle.recommendations,
        betsPlaced: lastCycle.bets_placed,
        error: lastCycle.error,
      } : null,
      aiCost: aiCost ? {
        totalCost: aiCost.total_cost_usd ?? 0,
        totalTokens: aiCost.total_tokens ?? 0,
        totalCalls: aiCost.total_calls ?? 0,
      } : { totalCost: 0, totalTokens: 0, totalCalls: 0 },
      activities,
    });

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[get-status]", errMsg);
    return jsonResponse({ ok: false, error: errMsg }, 500);
  }
});
