// Edge Function: run-cycle
// Ejecuta un ciclo de trading manual, actualiza bot_state.analyzing, logs, etc.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // TODO: Leer config de bot_kv, actualizar bot_state.analyzing=true
  // TODO: Ejecutar ciclo de trading (reutilizar lógica de smart-trader-cycle)
  // TODO: Guardar logs, actualizar bot_state.analyzing=false, last_cycle_at
  return new Response(JSON.stringify({ ok: true, message: "Ciclo ejecutado (borrador)" }), { status: 200 });
});
