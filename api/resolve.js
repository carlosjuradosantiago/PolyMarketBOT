// Vercel Serverless Function — Auto-resolver for paper trading orders
// Triggered by Vercel Cron every 5 minutes
// This replaces the client-side setInterval resolver

import { createClient } from "@supabase/supabase-js";

const GAMMA_API = "https://gamma-api.polymarket.com";

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Missing Supabase credentials");
  return createClient(url, key);
}

async function fetchMarket(marketId) {
  try {
    const resp = await fetch(`${GAMMA_API}/markets/${marketId}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function isMarketClosed(market) {
  if (!market) return false;
  if (market.closed === true) return true;
  // Fallback: not accepting orders and one outcome price >= 0.95
  if (market.acceptingOrders === false) {
    try {
      const prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices || [];
      return prices.map(Number).some((p) => p >= 0.95);
    } catch { /* ignore */ }
  }
  return false;
}

function getWinnerIndex(market) {
  try {
    const prices = typeof market.outcomePrices === "string"
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices || [];
    const nums = prices.map(Number);
    const idx = nums.findIndex((p) => p >= 0.95);
    if (idx >= 0) return idx;
    // Fallback: highest price
    const max = Math.max(...nums);
    return nums.indexOf(max);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // Verify cron secret (optional security)
  // const authHeader = req.headers['authorization'];
  // if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }

  try {
    const sb = getSupabase();
    const nowISO = new Date().toISOString();

    // Get expired open orders
    const { data: orders, error: qErr } = await sb
      .from("orders")
      .select("*")
      .in("status", ["pending", "filled"])
      .not("end_date", "is", null)
      .lt("end_date", nowISO);

    if (qErr) {
      console.error("[Resolve] Query error:", qErr);
      return res.status(500).json({ error: "Query failed", details: qErr.message });
    }

    const resolved = [];
    const errors = [];

    for (const order of orders || []) {
      try {
        // Update last_checked_at
        await sb.from("orders").update({ last_checked_at: nowISO }).eq("id", order.id);

        // Fetch market
        const market = await fetchMarket(order.market_id);
        if (!market) {
          console.warn(`[Resolve] Failed to fetch market ${order.market_id}`);
          continue;
        }

        if (!isMarketClosed(market)) continue;

        // Determine winner
        const winnerIdx = getWinnerIndex(market);
        const isWin = winnerIdx === order.outcome_index;
        const pnl = isWin
          ? order.potential_payout - order.total_cost
          : -order.total_cost;
        const status = isWin ? "won" : "lost";

        // Update order
        const { error: upErr } = await sb.from("orders").update({
          status,
          resolved_at: nowISO,
          pnl,
          resolution_price: winnerIdx !== null ? 1.0 : null,
        }).eq("id", order.id);

        if (upErr) {
          errors.push({ orderId: order.id, error: upErr.message });
          continue;
        }

        // Update balance (atomic RPC for wins)
        if (isWin) {
          const { error: rpcErr } = await sb.rpc("add_balance", { amount: order.potential_payout });
          if (rpcErr) console.error(`[Resolve] add_balance error:`, rpcErr);
        }

        // Update total_pnl
        const { data: pf } = await sb.from("portfolio").select("total_pnl").eq("id", 1).single();
        if (pf) {
          await sb.from("portfolio").update({
            total_pnl: pf.total_pnl + pnl,
            last_updated: nowISO,
          }).eq("id", 1);
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

        console.log(`[Resolve] ✅ Order ${order.id} → ${status.toUpperCase()} (P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`);
      } catch (err) {
        errors.push({ orderId: order.id, error: err.message });
        console.error(`[Resolve] Error on order ${order.id}:`, err);
      }
    }

    return res.status(200).json({
      ok: true,
      checked: (orders || []).length,
      resolved: resolved.length,
      details: resolved,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[Resolve] Fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
