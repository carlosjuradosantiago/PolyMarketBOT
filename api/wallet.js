// Vercel Serverless Function — Secure wallet info proxy
// The private key lives server-side only (never exposed to browser)

import { ethers } from "ethers";
import crypto from "crypto";

const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-pokt.nodies.app",
  "https://1rpc.io/matic",
];
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CLOB_BASE = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// EIP-712 domain for Polymarket CLOB L1 auth
const AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: CHAIN_ID,
};

const AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
};

async function fetchBalance(address) {
  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
      const maticBalance = await provider.getBalance(address);
      const matic = parseFloat(ethers.formatEther(maticBalance));

      const usdcContract = new ethers.Contract(
        USDC_ADDRESS,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );
      const usdcBalance = await usdcContract.balanceOf(address);
      const usdc = parseFloat(ethers.formatUnits(usdcBalance, 6));

      return { usdc, matic };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── CLOB L1 Auth (EIP-712 signature) ───────────

async function createL1Headers(wallet) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const value = {
    address: wallet.address,
    timestamp,
    nonce: 0,
    message: "This message attests that I control the given wallet",
  };
  const signature = await wallet.signTypedData(AUTH_DOMAIN, AUTH_TYPES, value);
  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: "0",
  };
}

// ─── CLOB L2 Auth (HMAC-SHA256) ─────────────────

function b64Decode(str) {
  const sanitized = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(sanitized, "base64");
}

function b64Encode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createL2Headers(apiCreds, address, method, requestPath) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + requestPath;

  const secretBytes = b64Decode(apiCreds.secret);
  const hmac = crypto.createHmac("sha256", secretBytes);
  hmac.update(message);
  const signature = b64Encode(hmac.digest());

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: apiCreds.apiKey,
    POLY_PASSPHRASE: apiCreds.passphrase,
  };
}

// ─── Derive or Create API Credentials ───────────

let _cachedCreds = null;

async function getApiCredentials(wallet) {
  if (_cachedCreds) return _cachedCreds;

  try {
    // 1. Try derive existing credentials
    const deriveHeaders = await createL1Headers(wallet);
    const deriveResp = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
      method: "GET",
      headers: deriveHeaders,
    });

    if (deriveResp.ok) {
      const data = await deriveResp.json();
      const creds = extractCreds(data);
      if (creds) {
        _cachedCreds = creds;
        return creds;
      }
    }

    // 2. Try create new credentials
    const createHeaders = await createL1Headers(wallet);
    const createResp = await fetch(`${CLOB_BASE}/auth/api-key`, {
      method: "POST",
      headers: {
        ...createHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (createResp.ok) {
      const data = await createResp.json();
      const creds = extractCreds(data);
      if (creds) {
        _cachedCreds = creds;
        return creds;
      }
    }

    console.error("[Wallet API] Could not derive or create CLOB API credentials");
    return null;
  } catch (error) {
    console.error("[Wallet API] CLOB auth error:", error.message);
    return null;
  }
}

function extractCreds(data) {
  const creds = {
    apiKey: String(data.apiKey || data.key || data.api_key || ""),
    secret: String(data.secret || data.api_secret || ""),
    passphrase: String(data.passphrase || data.api_passphrase || ""),
  };
  if (creds.apiKey.length > 10 && creds.secret.length > 10 && creds.passphrase.length > 3) {
    return creds;
  }
  return null;
}

// ─── Fetch Polymarket CLOB Balance ──────────────

async function fetchPolymarketBalance(wallet, apiCreds) {
  // Try all signature types, collect debug data
  let best = null;
  const debug = [];

  for (const sigType of [0, 1, 2]) {
    try {
      const endpoint = "/balance-allowance";
      const queryString = `?asset_type=COLLATERAL&signature_type=${sigType}`;

      const headers = createL2Headers(apiCreds, wallet.address, "GET", endpoint);

      const response = await fetch(`${CLOB_BASE}${endpoint}${queryString}`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        debug.push({ sigType, status: response.status, error: "not ok" });
        continue;
      }

      const data = await response.json();
      const rawBalance = String(data.balance ?? data.collateral ?? "0");
      const balNum = parseFloat(rawBalance);
      // USDC has 6 decimals — CLOB API returns raw minor units (same as allowances)
      const collateral = balNum / 1e6;

      debug.push({ sigType, raw: data, parsed: collateral });

      if (!best || collateral > best) {
        best = collateral;
      }
    } catch (err) {
      debug.push({ sigType, error: err.message });
      continue;
    }
  }

  return { balance: best, debug };
}

// ─── Fetch Open Orders ───

// ─── Fetch all trades and compute positions ───

async function fetchAllTrades(apiCreds, address) {
  const allTrades = [];
  let nextCursor = "MA==";
  const END_CURSOR = "LTE=";
  const path = "/data/trades";

  while (nextCursor && nextCursor !== END_CURSOR) {
    const headers = createL2Headers(apiCreds, address, "GET", path);
    const resp = await fetch(`${CLOB_BASE}${path}?next_cursor=${encodeURIComponent(nextCursor)}`, {
      method: "GET", headers,
    });
    if (!resp.ok) break;
    const body = await resp.json();
    const trades = Array.isArray(body.data) ? body.data : [];
    allTrades.push(...trades);
    nextCursor = body.next_cursor;
    if (trades.length === 0) break;
  }
  return allTrades;
}

async function fetchOpenOrders(wallet, apiCreds) {
  try {
    const debug = [];

    // 1. Check open orders
    const ordersPath = "/data/orders";
    const ordersHeaders = createL2Headers(apiCreds, wallet.address, "GET", ordersPath);
    const ordersResp = await fetch(`${CLOB_BASE}${ordersPath}?state=OPEN&next_cursor=MA==`, {
      method: "GET", headers: ordersHeaders,
    });
    let openOrders = [];
    if (ordersResp.ok) {
      const body = await ordersResp.json();
      openOrders = Array.isArray(body.data) ? body.data : [];
      debug.push({ endpoint: "orders?state=OPEN", count: body.count ?? openOrders.length });
    }

    // 2. Fetch ALL trades to compute positions
    const allTrades = await fetchAllTrades(apiCreds, wallet.address);
    debug.push({ endpoint: "/data/trades", totalTrades: allTrades.length });

    // 3. Compute net positions from trades
    // Group by asset_id: BUY adds shares, SELL removes
    const posMap = {};
    for (const t of allTrades) {
      const aid = t.asset_id;
      if (!posMap[aid]) {
        posMap[aid] = {
          asset_id: aid,
          market: t.market,
          outcome: t.outcome,
          shares: 0,
          avgPrice: 0,
          totalCost: 0,
          trades: 0,
        };
      }
      const size = parseFloat(t.size || "0");
      const price = parseFloat(t.price || "0");
      if (t.side === "BUY") {
        posMap[aid].totalCost += size * price;
        posMap[aid].shares += size;
      } else {
        posMap[aid].totalCost -= size * price;
        posMap[aid].shares -= size;
      }
      posMap[aid].trades++;
    }

    // Build positions with current market prices
    const positions = [];
    for (const aid of Object.keys(posMap)) {
      const p = posMap[aid];
      if (p.shares <= 0.001) continue; // Skip closed positions
      p.avgPrice = p.shares > 0 ? p.totalCost / p.shares : 0;

      // Try to get current price from CLOB
      let currentPrice = null;
      try {
        const priceResp = await fetch(`${CLOB_BASE}/price?token_id=${aid}&side=sell`);
        if (priceResp.ok) {
          const priceData = await priceResp.json();
          currentPrice = parseFloat(priceData.price || "0");
        }
      } catch {}

      // Also try the market midpoint
      if (!currentPrice) {
        try {
          const midResp = await fetch(`${CLOB_BASE}/midpoint?token_id=${aid}`);
          if (midResp.ok) {
            const midData = await midResp.json();
            currentPrice = parseFloat(midData.mid || "0");
          }
        } catch {}
      }

      positions.push({
        asset_id: aid,
        market: p.market,
        outcome: p.outcome,
        shares: Math.round(p.shares * 10000) / 10000,
        avgPrice: Math.round(p.avgPrice * 10000) / 10000,
        currentPrice,
        totalCost: Math.round(p.totalCost * 100) / 100,
        currentValue: currentPrice ? Math.round(p.shares * currentPrice * 100) / 100 : null,
        pnl: currentPrice ? Math.round((p.shares * currentPrice - p.totalCost) * 100) / 100 : null,
      });
    }

    // 4. Open orders processing
    let totalLocked = 0;
    const ordersList = openOrders.map(o => {
      const price = parseFloat(o.price || "0");
      const origSize = parseFloat(o.original_size || o.size || "0");
      const matched = parseFloat(o.size_matched || "0");
      const remaining = origSize - matched;
      const cost = o.side === "BUY" ? price * remaining : 0;
      totalLocked += cost;
      return {
        id: o.id, market: o.market, asset_id: o.asset_id,
        side: o.side, price, remaining,
        cost: Math.round(cost * 100) / 100,
        outcome: o.outcome,
      };
    });

    // Total position value
    const totalPositionValue = positions.reduce((s, p) => s + (p.currentValue || p.totalCost), 0);
    const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);

    return {
      count: ordersList.length,
      totalLocked: Math.round(totalLocked * 100) / 100,
      orders: ordersList,
      positions,
      totalPositionValue: Math.round(totalPositionValue * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      _debug: debug,
    };
  } catch (err) {
    console.error("[Wallet] Open orders error:", err.message);
    return { count: 0, totalLocked: 0, orders: [], positions: [], error: err.message };
  }
}

// ─── Main Handler ───────────────────────────────

export default async function handler(req, res) {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    return res.status(200).json({
      address: "",
      balance: null,
      polymarketBalance: null,
      isValid: false,
    });
  }

  try {
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(key);
    const address = wallet.address;

    // Fetch on-chain balance and Polymarket CLOB balance in parallel
    const apiCreds = await getApiCredentials(wallet);
    const [balance, pmResult, ordersInfo] = await Promise.all([
      fetchBalance(address),
      (async () => {
        try {
          if (!apiCreds) return { balance: null, debug: [{ error: "no API credentials" }] };
          return await fetchPolymarketBalance(wallet, apiCreds);
        } catch (err) {
          console.error("[Wallet API] Polymarket balance error:", err.message);
          return { balance: null, debug: [{ error: err.message }] };
        }
      })(),
      (async () => {
        try {
          if (!apiCreds) return { count: 0, totalLocked: 0 };
          return await fetchOpenOrders(wallet, apiCreds);
        } catch (err) {
          return { count: 0, totalLocked: 0, error: err.message };
        }
      })(),
    ]);

    return res.status(200).json({
      address,
      balance,
      polymarketBalance: pmResult.balance,
      openOrders: ordersInfo,
      _debug: pmResult.debug,
      isValid: true,
    });
  } catch (err) {
    console.error("[Wallet] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
