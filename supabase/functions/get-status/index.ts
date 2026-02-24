// Edge Function: get-status
// Devuelve el estado actual del bot (bot_state, último ciclo, etc.)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // TODO: Leer bot_state, último cycle_log, portfolio, etc.
  return new Response(JSON.stringify({ ok: true, status: "(borrador)" }), { status: 200 });
});
