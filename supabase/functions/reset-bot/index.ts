// ═══════════════════════════════════════════════════════════════════
// Edge Function: reset-bot
// Resetea completamente el bot: portfolio, órdenes, logs, costes IA.
// Body opcional: { initialBalance?: number }
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
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  try {
    // Leer balance inicial configurable
    let initialBalance = 1500;
    try {
      const body = await req.json();
      if (body?.initialBalance && typeof body.initialBalance === "number" && body.initialBalance > 0) {
        initialBalance = body.initialBalance;
      }
    } catch { /* body vacío, usar default */ }

    // 1. Borrar datos en paralelo
    const deleteResults = await Promise.all([
      supabase.from("orders").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      supabase.from("activities").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      supabase.from("cycle_logs").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      supabase.from("ai_usage_history").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
    ]);

    // Verificar errores en borrado
    for (const r of deleteResults) {
      if (r.error) console.warn("[reset-bot] Error borrando tabla:", r.error.message);
    }

    // 2. Resetear portfolio
    const { error: portfolioErr } = await supabase.from("portfolio").upsert({
      id: 1,
      balance: initialBalance,
      initial_balance: initialBalance,
      total_invested: 0,
      total_won: 0,
      total_lost: 0,
      active_positions: 0,
      balance_history: JSON.stringify([{ t: new Date().toISOString(), b: initialBalance }]),
    }, { onConflict: "id" });
    if (portfolioErr) console.warn("[reset-bot] Error reseteando portfolio:", portfolioErr.message);

    // 3. Resetear ai_cost_tracker
    const { error: aiErr } = await supabase.from("ai_cost_tracker").upsert({
      id: 1,
      total_cost_usd: 0,
      total_tokens: 0,
      total_calls: 0,
      last_reset: new Date().toISOString(),
    }, { onConflict: "id" });
    if (aiErr) console.warn("[reset-bot] Error reseteando ai_cost_tracker:", aiErr.message);

    // 4. Resetear bot_state
    const { error: stateErr } = await supabase.from("bot_state").upsert({
      id: 1,
      is_running: false,
      analyzing: false,
      cycle_count: 0,
      dynamic_interval: 24,
      start_time: null,
      last_error: null,
      last_cycle_at: null,
    }, { onConflict: "id" });
    if (stateErr) console.warn("[reset-bot] Error reseteando bot_state:", stateErr.message);

    // 5. Limpiar claves de throttle en bot_kv
    const throttleKeys = ["last_claude_call_time", "cycle_lock", "last_cycle_timestamp"];
    for (const key of throttleKeys) {
      await supabase.from("bot_kv").upsert(
        { key, value: "0", updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    }

    // 6. Log de actividad (el único registro post-reset)
    await supabase.from("activities").insert({
      timestamp: new Date().toISOString(),
      message: `🔄 Bot reseteado completamente. Balance inicial: $${initialBalance.toFixed(2)}`,
      entry_type: "Info",
    });

    return jsonResponse({
      ok: true,
      message: `Bot reseteado. Balance: $${initialBalance.toFixed(2)}`,
      initialBalance,
    });

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[reset-bot]", errMsg);
    return jsonResponse({ ok: false, error: errMsg }, 500);
  }
});
