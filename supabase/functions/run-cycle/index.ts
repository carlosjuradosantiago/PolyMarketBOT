// ═══════════════════════════════════════════════════════════════════
// Edge Function: run-cycle
// Ejecuta un ciclo de trading MANUAL delegando a smart-trader-cycle.
// Actualiza bot_state.analyzing para que el dashboard lo refleje en tiempo real.
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
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método no permitido" }, 405);
  }

  const startMs = Date.now();

  // 1. Marcar analyzing = true en bot_state
  await supabase.from("bot_state").update({
    analyzing: true,
    last_error: null,
    last_cycle_at: new Date().toISOString(),
  }).eq("id", 1);

  // 2. Limpiar throttle para forzar ciclo inmediato
  await supabase.from("bot_kv").upsert(
    { key: "last_claude_call_time", value: "0", updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  // Limpiar cycle lock previo
  await supabase.from("bot_kv").upsert(
    { key: "cycle_lock", value: "0", updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );

  try {
    // 3. Delegar a smart-trader-cycle via HTTP (reutiliza toda la lógica de 1970 líneas)
    const cycleUrl = `${SUPABASE_URL}/functions/v1/smart-trader-cycle`;
    const response = await fetch(cycleUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ manual: true }),
    });

    const result = await response.json();
    const elapsed = Date.now() - startMs;

    // 4. Actualizar bot_state: analyzing=false, guardar resultado
    await supabase.from("bot_state").update({
      analyzing: false,
      last_error: result.ok ? null : (result.error || result.reason || "Error desconocido").slice(0, 500),
      last_cycle_at: new Date().toISOString(),
    }).eq("id", 1);

    // 5. Log de actividad
    await supabase.from("activities").insert({
      timestamp: new Date().toISOString(),
      message: result.ok
        ? `🔧 Ciclo manual completado: ${result.betsPlaced || 0} apuestas, ${result.recommendations || 0} recs (${(elapsed / 1000).toFixed(1)}s)`
        : `❌ Ciclo manual falló: ${(result.error || result.reason || "Error desconocido").slice(0, 100)}`,
      entry_type: result.ok ? "Info" : "Error",
    });

    return jsonResponse({
      ok: result.ok ?? false,
      betsPlaced: result.betsPlaced || 0,
      recommendations: result.recommendations || 0,
      poolSize: result.poolSize || 0,
      totalMarkets: result.totalMarkets || 0,
      costUsd: result.costUsd || 0,
      elapsedMs: elapsed,
      balance: result.balance || null,
      error: result.error || result.reason || null,
    }, result.ok ? 200 : 500);

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[run-cycle] FATAL:", errMsg);

    // Limpiar estado de analyzing en caso de error
    await supabase.from("bot_state").update({
      analyzing: false,
      last_error: errMsg.slice(0, 500),
    }).eq("id", 1);

    await supabase.from("activities").insert({
      timestamp: new Date().toISOString(),
      message: `❌ run-cycle FATAL: ${errMsg.slice(0, 150)}`,
      entry_type: "Error",
    });

    return jsonResponse({ ok: false, error: errMsg }, 500);
  }
});
