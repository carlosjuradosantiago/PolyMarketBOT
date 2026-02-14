// ─── Polymarket CLOB API Authentication ──────────────────────
// L1 (EIP-712) for API key derivation
// L2 (HMAC-SHA256) for authenticated trading/balance requests

import { ethers } from "ethers";

const CHAIN_ID = 137;
const CLOB_PROXY = "/api/clob";

// ─── EIP-712 Domain & Types (L1 Auth) ──────────

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

// ─── Types ──────────────────────────────────────

export interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface PolymarketBalance {
  collateral: number;
  allowance: number;
}

// ─── L1 Auth Headers (EIP-712 Signature) ────────

async function createL1Headers(
  wallet: ethers.Wallet,
  nonce: number = 0
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const value = {
    address: wallet.address,
    timestamp,
    nonce,
    message: "This message attests that I control the given wallet",
  };

  const signature = await wallet.signTypedData(AUTH_DOMAIN, AUTH_TYPES, value);

  return {
    POLY_ADDRESS: wallet.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_NONCE: nonce.toString(),
  };
}

// ─── L2 Auth Headers (HMAC-SHA256) ──────────────

/**
 * Decode base64 (handles both standard AND url-safe) to bytes.
 * Matches the official Polymarket SDK: base64ToArrayBuffer in src/signing/hmac.ts
 */
function b64Decode(str: string): Uint8Array {
  // Convert URL-safe base64 to standard base64 (official SDK does this)
  const sanitized = str
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const raw = atob(sanitized);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Encode bytes to URL-safe base64 (keeping '=' suffix).
 * Matches the official Polymarket SDK: buildPolyHmacSignature output.
 */
function b64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const standard = btoa(binary);
  // Must be URL-safe base64 per SDK: convert + to -, / to _
  return standard.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build L2 HMAC auth headers.
 * Per the Polymarket SDK, the HMAC message is:
 *   timestamp + method + requestPath + body
 * where requestPath INCLUDES query params.
 */
async function createL2Headers(
  apiCreds: ApiCredentials,
  address: string,
  method: string,
  requestPath: string, // Full path WITH query params as the server sees it
  body: string = ""
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + requestPath + body;

  console.log("[CLOB L2] HMAC message:", message);

  const secretBytes = b64Decode(apiCreds.secret);

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  const signature = b64Encode(signatureBuffer);

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: apiCreds.apiKey,
    POLY_PASSPHRASE: apiCreds.passphrase,
  };
}

// ─── API Credential Management ──────────────────

const CREDS_STORAGE_KEY = "polymarket_api_creds";

function isValidCreds(creds: ApiCredentials): boolean {
  // apiKey should be UUID-ish, secret should be base64, passphrase non-empty
  return (
    typeof creds.apiKey === "string" && creds.apiKey.length > 10 &&
    typeof creds.secret === "string" && creds.secret.length > 10 &&
    typeof creds.passphrase === "string" && creds.passphrase.length > 3
  );
}

function loadCachedCreds(): ApiCredentials | null {
  try {
    const raw = localStorage.getItem(CREDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isValidCreds(parsed)) return parsed;
    // Invalid cached creds — purge them
    console.warn("[CLOB Auth] Purging invalid cached credentials");
    localStorage.removeItem(CREDS_STORAGE_KEY);
    return null;
  } catch {
    localStorage.removeItem(CREDS_STORAGE_KEY);
    return null;
  }
}

function cacheCreds(creds: ApiCredentials): void {
  localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify(creds));
}

export function clearCachedCreds(): void {
  localStorage.removeItem(CREDS_STORAGE_KEY);
}

/**
 * Get or derive API credentials for CLOB API.
 * Flow: cache → derive → create new.
 */
export async function getOrDeriveApiCredentials(
  privateKey: string
): Promise<ApiCredentials | null> {
  // 1. Check valid cache
  const cached = loadCachedCreds();
  if (cached) {
    console.log("[CLOB Auth] Using cached API credentials (apiKey:", cached.apiKey.slice(0, 8) + "...)");
    return cached;
  }

  try {
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(key);

    // 2. Try derive existing credentials
    console.log("[CLOB Auth] Deriving API credentials for", wallet.address);
    const deriveHeaders = await createL1Headers(wallet, 0);
    console.log("[CLOB Auth] L1 headers:", JSON.stringify(deriveHeaders));

    const deriveResp = await fetch(`${CLOB_PROXY}/auth/derive-api-key`, {
      method: "GET",
      headers: deriveHeaders,
    });

    console.log("[CLOB Auth] Derive response:", deriveResp.status, deriveResp.statusText);

    if (deriveResp.ok) {
      const data = await deriveResp.json();
      console.log("[CLOB Auth] Derive data:", JSON.stringify(data).slice(0, 200));
      const creds = extractCreds(data);
      if (creds) {
        cacheCreds(creds);
        console.log("[CLOB Auth] Derived & cached ✓");
        return creds;
      }
    }

    // 3. Try create new credentials
    console.log("[CLOB Auth] Creating new API key...");
    const createHeaders = await createL1Headers(wallet, 0);
    const createResp = await fetch(`${CLOB_PROXY}/auth/api-key`, {
      method: "POST",
      headers: {
        ...createHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    console.log("[CLOB Auth] Create response:", createResp.status, createResp.statusText);

    if (createResp.ok) {
      const data = await createResp.json();
      console.log("[CLOB Auth] Create data:", JSON.stringify(data).slice(0, 200));
      const creds = extractCreds(data);
      if (creds) {
        cacheCreds(creds);
        console.log("[CLOB Auth] Created & cached ✓");
        return creds;
      }
    }

    const errorText = await createResp.text().catch(() => "");
    console.error("[CLOB Auth] Both derive and create failed. Last response:", errorText);
    return null;
  } catch (error) {
    console.error("[CLOB Auth] Error:", (error as Error).message);
    return null;
  }
}

function extractCreds(data: Record<string, unknown>): ApiCredentials | null {
  const creds: ApiCredentials = {
    apiKey: String(data.apiKey || data.key || data.api_key || ""),
    secret: String(data.secret || data.api_secret || ""),
    passphrase: String(data.passphrase || data.api_passphrase || ""),
  };

  if (!isValidCreds(creds)) {
    console.error("[CLOB Auth] Response did not contain valid credentials:", JSON.stringify(data).slice(0, 200));
    return null;
  }

  return creds;
}

// ─── Balance Fetching ───────────────────────────

/**
 * Fetch the user's USDC balance deposited in Polymarket.
 * The signature_type param tells the server how to verify the funder.
 */
export async function fetchPolymarketBalance(
  privateKey: string,
  apiCreds: ApiCredentials
): Promise<PolymarketBalance | null> {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(key);

  // Try ALL signature types and return the one with the highest balance.
  // sig_type=0 may return $0 while the actual funds are under type 1 or 2.
  let best: PolymarketBalance | null = null;
  let anySuccess = false;

  for (const sigType of [0, 1, 2]) {
    const result = await tryFetchBalance(wallet.address, apiCreds, sigType);
    if (result) {
      anySuccess = true;
      if (!best || result.collateral > best.collateral) {
        best = result;
      }
    }
  }

  if (!anySuccess) {
    // If ALL fail (e.g., 401), credentials are probably invalid
    console.error("[CLOB] All balance attempts failed — clearing cached credentials");
    clearCachedCreds();
    return null;
  }

  return best;
}

async function tryFetchBalance(
  address: string,
  apiCreds: ApiCredentials,
  signatureType: number
): Promise<PolymarketBalance | null> {
  try {
    // Per the official Polymarket SDK, HMAC signs ONLY the endpoint path.
    // Query params are passed as separate HTTP params, NOT in the HMAC message.
    const endpoint = "/balance-allowance";
    const queryString = `?asset_type=COLLATERAL&signature_type=${signatureType}`;

    const headers = await createL2Headers(
      apiCreds,
      address,
      "GET",
      endpoint  // Only the path, no query params
    );

    const response = await fetch(`${CLOB_PROXY}${endpoint}${queryString}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      console.warn(`[CLOB] Balance sig_type=${signatureType}: ${response.status}`);
      return null;
    }

    return parseBalanceResponse(await response.json());
  } catch (error) {
    console.warn(`[CLOB] Balance sig_type=${signatureType} error:`, (error as Error).message);
    return null;
  }
}

function parseBalanceResponse(data: Record<string, unknown>): PolymarketBalance | null {
  console.log("[CLOB] Balance raw response:", JSON.stringify(data));

  const rawBalance = String(data.balance ?? data.collateral ?? "0");
  const rawAllowance = String(data.allowance ?? "0");

  const balNum = parseFloat(rawBalance);
  const allNum = parseFloat(rawAllowance);

  // USDC has 6 decimals — values > 1M are likely minor units
  const collateral = balNum > 1_000_000 ? balNum / 1e6 : balNum;
  const allowance = allNum > 1_000_000 ? allNum / 1e6 : allNum;

  console.log(`[CLOB] Polymarket balance: $${collateral.toFixed(2)} USDC, allowance: $${allowance.toFixed(2)}`);
  return { collateral, allowance };
}
