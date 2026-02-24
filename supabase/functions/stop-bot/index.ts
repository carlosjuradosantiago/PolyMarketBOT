// ═══════════════════════════════════════════════════════════════════
// Edge Function: stop-bot
// Detiene el bot: is_running=false, analyzing=false, limpia cycle_lock
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
    // 1. Actualizar bot_state
    const { error: stateError } = await supabase.from("bot_state").update({
      is_running: false,
      analyzing: false,
      last_error: null,
    }).eq("id", 1);

    if (stateError) throw new Error(`Error actualizando bot_state: ${stateError.message}`);

    // 2. Limpiar cycle_lock para que no quede bloqueado
    await supabase.from("bot_kv").upsert(
      { key: "cycle_lock", value: "0", updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );

    // 3. Log de actividad
    await supabase.from("activities").insert({
      timestamp: new Date().toISOString(),
      message: "🛑 Bot detenido manualmente",
      entry_type: "Info",
    });

    return jsonResponse({ ok: true, message: "Bot detenido correctamente" });

  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[stop-bot]", errMsg);
    return jsonResponse({ ok: false, error: errMsg }, 500);
  }
});
