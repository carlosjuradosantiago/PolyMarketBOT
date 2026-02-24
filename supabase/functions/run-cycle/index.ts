// Edge Function: run-cycle
// Ejecuta un ciclo de trading manual, actualiza bot_state.analyzing, logs, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Variables de entorno ─────────────
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function setAnalyzing(val: boolean, errorMsg?: string) {
  const update: any = { analyzing: val, last_cycle_at: new Date().toISOString() };
  if (errorMsg) update.last_error = errorMsg.slice(0, 500);
  await supabase.from("bot_state").update(update).eq("id", 1);
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // Inicia ciclo manual
  await setAnalyzing(true);
  let result: any = { ok: false };
  try {
    // Importar la lógica principal del ciclo desde smart-trader-cycle (copiado aquí por Edge Function isolation)
    // 1. Cargar config y estado
    // 2. Ejecutar ciclo de trading (fetch markets, analizar, colocar órdenes, logs)
    // 3. Guardar logs y actualizar bot_state

    // --- 1. Cargar config y estado ---
    const { data: botState } = await supabase.from("bot_state").select("*").eq("id", 1).single();
    if (!botState) throw new Error("No se pudo cargar bot_state");
    const { data: portfolio } = await supabase.from("portfolio").select("*").eq("id", 1).single();
    if (!portfolio) throw new Error("No se pudo cargar portfolio");

    // --- 2. Ejecutar ciclo de trading simplificado (placeholder: solo log) ---
    // Aquí se debe reutilizar la lógica de smart-trader-cycle, pero por simplicidad inicial:
    const now = new Date().toISOString();
    await supabase.from("cycle_logs").insert({
      timestamp: now,
      summary: "Ciclo manual ejecutado desde run-cycle (implementación real pendiente de integración completa)",
      model: "run-cycle",
      recommendations: 0,
      bets_placed: 0,
      error: null,
    });

    // --- 3. Actualizar bot_state.analyzing=false, last_cycle_at ---
    await setAnalyzing(false);
    result = { ok: true, message: "Ciclo ejecutado correctamente" };
  } catch (e: any) {
    await setAnalyzing(false, e?.message || String(e));
    result = { ok: false, error: e?.message || String(e) };
  }
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
