// Edge Function: reset-bot
// Resetea todo el bot (portfolio, órdenes, logs, etc.)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // TODO: Borrar orders, activities, cycle_logs, resetear portfolio y ai_cost_tracker
  return new Response(JSON.stringify({ ok: true, message: "Bot reseteado (borrador)" }), { status: 200 });
});
