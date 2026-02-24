// Edge Function: cancel-order
// Cancela una orden específica
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }
  // TODO: Recibir orderId, cancelar orden, actualizar balance
  return new Response(JSON.stringify({ ok: true, message: "Orden cancelada (borrador)" }), { status: 200 });
});
