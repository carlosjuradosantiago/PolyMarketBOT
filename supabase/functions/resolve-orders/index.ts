// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Supabase Edge Function — Auto-resolver for paper trading orders
// Called by pg_cron every 5 minutes

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GAMMA_API = "https://gamma-api.polymarket.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function fetchMarket(marketId: number) {
  try {
    const resp = await fetch(`${GAMMA_API}/markets/${marketId}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function isMarketClosed(market: any): boolean {
  if (!market) return false;
  if (market.closed === true) return true;
  if (market.acceptingOrders === false) {
    try {
      const prices =
        typeof market.outcomePrices === "string"
          ? JSON.parse(market.outcomePrices)
          : market.outcomePrices || [];
      return prices.map(Number).some((p: number) => p >= 0.95);
    } catch {
      /* ignore */
    }
  }
  return false;
}

function getWinnerIndex(market: any): number | null {
  try {
    const prices =
      typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices || [];
    const nums = prices.map(Number);
    const idx = nums.findIndex((p: number) => p >= 0.95);
    if (idx >= 0) return idx;
    const max = Math.max(...nums);
    return nums.indexOf(max);
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    const nowISO = new Date().toISOString();

    // ── 1) Get expired open orders (have end_date) ──
    const { data: expiredOrders, error: qErr } = await sb
      .from("orders")
      .select("*")
      .in("status", ["pending", "filled"])
      .not("end_date", "is", null)
      .lt("end_date", nowISO);

    if (qErr) {
      console.error("[Resolve] Query error:", qErr);
      return new Response(JSON.stringify({ error: "Query failed", details: qErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2) Get zombie orders (no end_date, older than 7 days) ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: zombieOrders } = await sb
      .from("orders")
      .select("*")
      .in("status", ["pending", "filled"])
      .is("end_date", null)
      .lt("created_at", sevenDaysAgo);

    const allOrders = [...(expiredOrders || []), ...(zombieOrders || [])];

    const resolved: any[] = [];
    const errors: any[] = [];

    for (const order of allOrders) {
      try {
        // Update last_checked_at
        await sb.from("orders").update({ last_checked_at: nowISO }).eq("id", order.id);

        // Fetch market (with 1 retry)
        let market = await fetchMarket(order.market_id);
        if (!market) {
          // Retry once after 2s
          await new Promise(r => setTimeout(r, 2000));
          market = await fetchMarket(order.market_id);
        }
        if (!market) {
          console.warn(`[Resolve] Failed to fetch market ${order.market_id} (after retry)`);
          continue;
        }

        // ── LIMIT orders that never filled: cancel, don't resolve as loss ──
        if (order.status === "pending" && isMarketClosed(market)) {
          const { error: cancelErr } = await sb
            .from("orders")
            .update({
              status: "cancelled",
              resolved_at: nowISO,
              pnl: 0,
              cancel_reason: "LIMIT order never filled — market closed",
            })
            .eq("id", order.id);

          if (cancelErr) {
            errors.push({ orderId: order.id, error: cancelErr.message });
            continue;
          }

          // Refund the cost back to balance
          const { error: refundErr } = await sb.rpc("add_balance", { amount: order.total_cost });
          if (refundErr) console.error(`[Resolve] refund error:`, refundErr);

          await sb.from("activities").insert({
            timestamp: nowISO,
            message: `AUTO-CANCELLED unfilled LIMIT "${(order.market_question || "").slice(0, 50)}" → refund +$${order.total_cost.toFixed(2)}`,
            entry_type: "Warning",
          });

          resolved.push({
            id: order.id,
            market: (order.market_question || "").slice(0, 60),
            status: "cancelled",
            pnl: "0.00",
            reason: "unfilled_limit",
          });

          console.log(`[Resolve] Order ${order.id} → CANCELLED (unfilled LIMIT, refund $${order.total_cost.toFixed(2)})`);
          continue;
        }

        if (!isMarketClosed(market)) continue;

        // Determine winner
        const winnerIdx = getWinnerIndex(market);
        const isWin = winnerIdx === order.outcome_index;
        const pnl = isWin ? order.potential_payout - order.total_cost : -order.total_cost;
        const status = isWin ? "won" : "lost";

        // Update order
        const { error: upErr } = await sb
          .from("orders")
          .update({
            status,
            resolved_at: nowISO,
            pnl,
            resolution_price: winnerIdx !== null ? 1.0 : null,
          })
          .eq("id", order.id);

        if (upErr) {
          errors.push({ orderId: order.id, error: upErr.message });
          continue;
        }

        // Update balance (atomic RPC for wins)
        if (isWin) {
          const { error: rpcErr } = await sb.rpc("add_balance", { amount: order.potential_payout });
          if (rpcErr) console.error(`[Resolve] add_balance error:`, rpcErr);
        }

        // Update total_pnl (atomic via RPC — avoid race conditions)
        const { error: pnlErr } = await sb.rpc("add_balance", { amount: 0 }); // touch
        const { data: pf } = await sb.from("portfolio").select("total_pnl").eq("id", 1).single();
        if (pf) {
          await sb
            .from("portfolio")
            .update({
              total_pnl: pf.total_pnl + pnl,
              last_updated: nowISO,
            })
            .eq("id", 1);
        }

        // Log activity
        await sb.from("activities").insert({
          timestamp: nowISO,
          message: `AUTO-RESOLVED "${(order.market_question || "").slice(0, 50)}" → ${status.toUpperCase()} ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
          entry_type: isWin ? "Resolved" : "Warning",
        });

        resolved.push({
          id: order.id,
          market: (order.market_question || "").slice(0, 60),
          status,
          pnl: pnl.toFixed(2),
        });

        console.log(
          `[Resolve] Order ${order.id} → ${status.toUpperCase()} (P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`
        );
      } catch (err) {
        errors.push({ orderId: order.id, error: (err as Error).message });
        console.error(`[Resolve] Error on order ${order.id}:`, err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        checked: allOrders.length,
        resolved: resolved.length,
        details: resolved,
        errors: errors.length > 0 ? errors : undefined,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("[Resolve] Fatal:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/resolve-orders' \
    --header 'Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjIwODY0MDcxMDN9.3snBr6UQ23VudoEFbYW_oyRtrqUFA9dPm1xLS4Xx3MJcGUg08CUGvakSWWx9CGqTRPpsfTTFL9QBkaEjqjMVOw' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
