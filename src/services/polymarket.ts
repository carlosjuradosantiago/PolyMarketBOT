// ─── Polymarket API Service ─────────────────────────────────────────
// Connects to real Polymarket APIs for market data

import { PolymarketEvent, PolymarketMarket, MarketFilters, TimeframeFilter } from "../types";
import {
  JUNK_PATTERNS, JUNK_REGEXES, WEATHER_RE,
  MIN_LIQUIDITY, MIN_VOLUME, WEATHER_MIN_LIQUIDITY, WEATHER_MIN_VOLUME,
  PRICE_FLOOR, PRICE_CEILING,
} from "./marketConstants";

// Use Vite proxy to avoid CORS in browser
const GAMMA_API = "/api/gamma";
const CLOB_API = "/api/clob";

// Debug flag - enable for verbose logging
const DEBUG = true;

function log(...args: any[]) {
  if (DEBUG) console.log("[Polymarket]", ...args);
}

// ─── Helper Functions ─────────────────────────────────────────

function getTimeframeHours(tf: TimeframeFilter): number {
  switch (tf) {
    case "1h": return 1;
    case "4h": return 4;
    case "8h": return 8;
    case "1d": return 24;
    case "3d": return 72;
    case "7d": return 168;
    case "all": return 8760;
    default: return 24;
  }
}

/**
 * Categorize a market using the REAL data from the Polymarket API.
 *
 * The Gamma API returns several fields that reliably identify sports markets:
 *   - sportsMarketType ("totals", "spreads", "moneyline", etc.)
 *   - gameId, teamAID, teamBID  (only set for sports)
 *   - tags[] / categories[]     (labels like "Sports", "Esports", etc.)
 *
 * We check those first. Only if the API didn't provide structured metadata
 * do we fall back to lightweight keyword matching.
 */
function categorizeMarket(
  title: string,
  description: string,
  apiRaw?: any,          // pass the raw API object so we can read native fields
): string {
  // ── 1. Definitive API fields — highest priority ──
  if (apiRaw) {
    // sportsMarketType is ONLY set for sports/esports markets
    if (apiRaw.sportsMarketType) return "sports";
    // gameId / team IDs are sports-only
    if (apiRaw.gameId || apiRaw.teamAID || apiRaw.teamBID) return "sports";

    // tags[] / categories[] — check nested event data too
    const tagLabels: string[] = [];
    const catLabels: string[] = [];

    // Market-level tags & categories
    if (Array.isArray(apiRaw.tags)) {
      tagLabels.push(...apiRaw.tags.map((t: any) => (t.label || t.slug || "").toLowerCase()));
    }
    if (Array.isArray(apiRaw.categories)) {
      catLabels.push(...apiRaw.categories.map((c: any) => (c.label || c.slug || "").toLowerCase()));
    }

    // Event-level tags & categories (events[] is nested in market response)
    if (Array.isArray(apiRaw.events)) {
      for (const ev of apiRaw.events) {
        if (Array.isArray(ev.tags)) {
          tagLabels.push(...ev.tags.map((t: any) => (t.label || t.slug || "").toLowerCase()));
        }
        if (Array.isArray(ev.categories)) {
          catLabels.push(...ev.categories.map((c: any) => (c.label || c.slug || "").toLowerCase()));
        }
        // Series-level tags & categories
        if (Array.isArray(ev.series)) {
          for (const s of ev.series) {
            if (Array.isArray(s.tags)) {
              tagLabels.push(...s.tags.map((t: any) => (t.label || t.slug || "").toLowerCase()));
            }
            if (Array.isArray(s.categories)) {
              catLabels.push(...s.categories.map((c: any) => (c.label || c.slug || "").toLowerCase()));
            }
          }
        }
      }
    }

    const allLabels = [...tagLabels, ...catLabels];

    // Map API labels → our CategoryFilter values
    const sportsKeywords = ["sports", "sport", "esports", "e-sports", "football", "soccer", "basketball", "baseball", "hockey", "tennis", "mma", "boxing", "cricket", "golf", "motorsport", "racing"];
    if (allLabels.some(l => sportsKeywords.some(k => l.includes(k)))) return "sports";

    if (allLabels.some(l => l.includes("politic") || l.includes("election") || l.includes("government"))) return "politics";
    if (allLabels.some(l => l.includes("crypto") || l.includes("bitcoin") || l.includes("defi") || l.includes("blockchain"))) return "crypto";
    if (allLabels.some(l => l.includes("entertain") || l.includes("culture") || l.includes("pop culture") || l.includes("music") || l.includes("movie"))) return "entertainment";
    if (allLabels.some(l => l.includes("science") || l.includes("tech") || l.includes("space") || l.includes("climate"))) return "science";
    if (allLabels.some(l => l.includes("business") || l.includes("finance") || l.includes("economics") || l.includes("stocks"))) return "business";
  }

  // ── 2. Lightweight keyword fallback (only when API metadata absent) ──
  const text = (title + " " + description).toLowerCase();

  if (text.includes("trump") || text.includes("biden") || text.includes("election") ||
      text.includes("president") || text.includes("congress") || text.includes("senate") ||
      text.includes("vote") || text.includes("democrat") || text.includes("republican")) {
    return "politics";
  }
  if (text.includes("bitcoin") || text.includes("btc") || text.includes("ethereum") ||
      text.includes("eth") || text.includes("crypto") || text.includes("solana") ||
      text.includes("token") || text.includes("coin")) {
    return "crypto";
  }
  if (text.includes("movie") || text.includes("oscar") || text.includes("grammy") ||
      text.includes("album") || text.includes("celebrity") || text.includes("tv") ||
      text.includes("show") || text.includes("award")) {
    return "entertainment";
  }
  if (text.includes("stock") || text.includes("market") || text.includes("gdp") ||
      text.includes("fed") || text.includes("inflation") || text.includes("earnings") ||
      text.includes("company") || text.includes("revenue")) {
    return "business";
  }
  if (text.includes("spacex") || text.includes("nasa") || text.includes("ai") ||
      text.includes("research") || text.includes("study") || text.includes("science") ||
      text.includes("climate") || text.includes("weather")) {
    return "science";
  }
  return "other";
}

// ─── Parse Market from API Response ─────────────────────────────────────────

function parseMarket(m: any): PolymarketMarket | null {
  try {
    const question = m.question || m.title || "";
    if (!question) return null;
    
    const id = m.id || m.market_id || "";
    const conditionId = m.conditionId || m.condition_id || m.conditionID || id;
    
    // Parse outcomes - can be string array or JSON string
    let outcomes: string[] = ["Yes", "No"];
    if (m.outcomes) {
      if (typeof m.outcomes === "string") {
        try { outcomes = JSON.parse(m.outcomes); } 
        catch { outcomes = m.outcomes.split(",").map((s: string) => s.trim()); }
      } else if (Array.isArray(m.outcomes)) {
        outcomes = m.outcomes;
      }
    }
    
    // Parse outcome prices
    let outcomePrices: string[] = ["0.50", "0.50"];
    if (m.outcomePrices) {
      if (typeof m.outcomePrices === "string") {
        try { outcomePrices = JSON.parse(m.outcomePrices); } 
        catch { outcomePrices = m.outcomePrices.split(",").map((s: string) => s.trim()); }
      } else if (Array.isArray(m.outcomePrices)) {
        outcomePrices = m.outcomePrices.map((p: any) => String(p));
      }
    }
    
    // Parse clobTokenIds
    let clobTokenIds: string[] = [];
    if (m.clobTokenIds) {
      if (typeof m.clobTokenIds === "string") {
        try { clobTokenIds = JSON.parse(m.clobTokenIds); } 
        catch { clobTokenIds = m.clobTokenIds.split(",").map((s: string) => s.trim()); }
      } else if (Array.isArray(m.clobTokenIds)) {
        clobTokenIds = m.clobTokenIds;
      }
    }
    
    return {
      id,
      question,
      conditionId,
      slug: m.slug || "",
      outcomes,
      outcomePrices,
      clobTokenIds,
      volume: parseFloat(m.volume) || parseFloat(m.volumeNum) || 0,
      liquidity: parseFloat(m.liquidity) || parseFloat(m.liquidityNum) || 0,
      endDate: m.endDate || m.end_date || m.endDateIso || "",
      active: m.active !== false && m.closed !== true,
      closed: m.closed === true,
      resolved: m.resolved === true || m.resolved === "true" || m.closed === true,
      resolutionSource: m.resolutionSource,
      description: m.description || "",
      category: categorizeMarket(question, m.description || "", m),
      image: m.image || m.icon,
    };
  } catch (e) {
    log("Error parsing market:", e, m);
    return null;
  }
}

// ─── API Functions ─────────────────────────────────────────

export async function fetchEvents(
  limit: number = 50,
  active: boolean = true
): Promise<PolymarketEvent[]> {
  try {
    const url = `${GAMMA_API}/events?limit=${limit}&active=${active}&closed=false&order=volume&ascending=false`;
    log("Fetching events from:", url);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    log("Events response - count:", data?.length || 0);
    
    if (!Array.isArray(data)) {
      log("Events data is not an array:", typeof data);
      return [];
    }
    
    return data.map((event: any) => ({
      id: event.id || "",
      slug: event.slug || "",
      title: event.title || "",
      description: event.description || "",
      markets: (event.markets || []).map((m: any) => parseMarket(m)).filter(Boolean) as PolymarketMarket[],
      startDate: event.startDate || event.start_date || "",
      endDate: event.endDate || event.end_date || "",
      volume: parseFloat(event.volume) || 0,
      liquidity: parseFloat(event.liquidity) || 0,
      active: event.active !== false,
      closed: event.closed === true,
      category: categorizeMarket(event.title || "", event.description || "", event),
      image: event.image,
    }));
  } catch (error) {
    console.error("Error fetching events:", error);
    return [];
  }
}

export async function fetchMarkets(
  limit: number = 100,
  active: boolean = true
): Promise<PolymarketMarket[]> {
  try {
    const url = `${GAMMA_API}/markets?limit=${limit}&active=${active}&closed=false&order=volume&ascending=false&include_tag=true`;
    log("Fetching markets from:", url);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    log("Markets response - raw count:", data?.length || 0);
    
    if (!Array.isArray(data)) {
      log("Markets data is not an array:", typeof data);
      return [];
    }
    
    const markets = data.map((m: any) => parseMarket(m)).filter(Boolean) as PolymarketMarket[];
    log("Parsed markets count:", markets.length);
    
    return markets;
  } catch (error) {
    console.error("Error fetching markets:", error);
    return [];
  }
}

// ─── fetchAllMarkets cache (avoid N+1 re-fetches within the same window) ───
let _cachedMarkets: PolymarketMarket[] = [];
let _cacheTs = 0;
const FETCH_CACHE_TTL = 4 * 60 * 1000; // 4 min — re-use between cycle & panel

/**
 * Fetch ALL markets using pagination.
 * Results are cached for 4 minutes to prevent duplicate fetches
 * when both the trading cycle and MarketsPanel request markets.
 *
 * Resilience: retries up to 3 times on failure, never caches empty results,
 * and falls back to stale cache if a fresh fetch returns nothing.
 */
export async function fetchAllMarkets(
  active: boolean = true,
  maxTotal: number = 12000,
  onProgress?: (loaded: number) => void,
): Promise<PolymarketMarket[]> {
  // Return cache if still fresh AND has data
  if (_cachedMarkets.length > 0 && Date.now() - _cacheTs < FETCH_CACHE_TTL) {
    log(`[fetchAllMarkets] Using cache (${_cachedMarkets.length} markets, age ${Math.round((Date.now() - _cacheTs) / 1000)}s)`);
    onProgress?.(_cachedMarkets.length);
    return _cachedMarkets;
  }

  const result = await _fetchAllMarketsInner(active, maxTotal, onProgress);

  // ── RESILIENCE: Never cache empty results; fall back to stale cache ──
  if (result.length === 0) {
    console.warn(`[fetchAllMarkets] ⚠️ Fetch returned 0 markets — possible API issue`);
    if (_cachedMarkets.length > 0) {
      const staleSecs = Math.round((Date.now() - _cacheTs) / 1000);
      log(`[fetchAllMarkets] ♻️ Returning stale cache (${_cachedMarkets.length} markets, ${staleSecs}s old)`);
      onProgress?.(_cachedMarkets.length);
      return _cachedMarkets; // stale but non-empty
    }
    log(`[fetchAllMarkets] ❌ No cache available either — returning empty`);
    return [];
  }

  // Only update cache with non-empty results
  _cachedMarkets = result;
  _cacheTs = Date.now();
  return result;
}

/** Inner fetch with retry logic */
async function _fetchAllMarketsInner(
  active: boolean,
  maxTotal: number,
  onProgress?: (loaded: number) => void,
): Promise<PolymarketMarket[]> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const markets = await _fetchAllMarketsSingle(active, maxTotal, onProgress);
    if (markets.length > 0) return markets;

    if (attempt < MAX_RETRIES) {
      log(`[fetchAllMarkets] Attempt ${attempt}/${MAX_RETRIES} returned 0 markets — retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  console.error(`[fetchAllMarkets] ❌ All ${MAX_RETRIES} attempts returned 0 markets`);
  return [];
}

/** Single fetch attempt — paginate through Gamma API */
async function _fetchAllMarketsSingle(
  active: boolean,
  maxTotal: number,
  onProgress?: (loaded: number) => void,
): Promise<PolymarketMarket[]> {
  const PAGE_SIZE = 500; // Gamma API allows up to ~500 per request
  const allMarkets: PolymarketMarket[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let page = 0;
  const MAX_PAGES = Math.ceil(maxTotal / PAGE_SIZE);
  let consecutiveErrors = 0;

  log(`[fetchAllMarkets] Fetching markets (max=${maxTotal})...`);

  while (page < MAX_PAGES) {
    try {
      const url = `${GAMMA_API}/markets?limit=${PAGE_SIZE}&offset=${offset}&active=${active}&closed=false&order=volume&ascending=false&include_tag=true`;
      
      // Add timeout to prevent hanging requests (15s per page)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const bodySnippet = await response.text().catch(() => "");
        console.warn(`[fetchAllMarkets] HTTP ${response.status} on page ${page + 1}: ${bodySnippet.slice(0, 200)}`);
        consecutiveErrors++;
        // Allow up to 2 consecutive errors before giving up
        if (consecutiveErrors >= 2) {
          console.warn(`[fetchAllMarkets] ${consecutiveErrors} consecutive errors — stopping pagination`);
          break;
        }
        // Skip this page and try the next offset
        offset += PAGE_SIZE;
        page++;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      consecutiveErrors = 0; // reset on success
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        console.warn(`[fetchAllMarkets] Non-JSON response on page ${page + 1}: ${contentType}`);
        consecutiveErrors++;
        if (consecutiveErrors >= 2) break;
        offset += PAGE_SIZE;
        page++;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        // Empty page — we've reached the end
        break;
      }

      const parsed = data
        .map((m: any) => parseMarket(m))
        .filter(Boolean) as PolymarketMarket[];

      // Deduplicate
      for (const m of parsed) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          allMarkets.push(m);
        }
      }

      onProgress?.(allMarkets.length);

      // If this page returned fewer than PAGE_SIZE, there are no more
      if (data.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
      page++;

      // Small delay to stay well within rate limits (4000 req/10s for Gamma)
      if (page < MAX_PAGES) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (error: any) {
      const errMsg = error?.name === "AbortError" ? "timeout (15s)" : (error?.message || String(error));
      console.error(`[fetchAllMarkets] Error on page ${page + 1}: ${errMsg}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 2) {
        console.warn(`[fetchAllMarkets] ${consecutiveErrors} consecutive errors — stopping`);
        break;
      }
      offset += PAGE_SIZE;
      page++;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  log(`[fetchAllMarkets] ${allMarkets.length > 0 ? "✅" : "⚠️"} ${allMarkets.length} mercados en ${page + 1} páginas`);
  return allMarkets;
}

export async function fetchMarketById(idOrConditionId: string): Promise<PolymarketMarket | null> {
  try {
    // Always use /markets/{id} endpoint — the ?condition_id= query param is broken on Gamma
    // If given a 0x conditionId, try numeric lookup first, then fallback
    const url = `${GAMMA_API}/markets/${idOrConditionId}`;
    log("Fetching market by ID:", url);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      log("fetchMarketById failed:", response.status, response.statusText);
      return null;
    }
    
    const data = await response.json();
    return parseMarket(data);
  } catch (error) {
    console.error("Error fetching market:", error);
    return null;
  }
}

export async function fetchMarketPrice(tokenId: string): Promise<{ buy: number; sell: number } | null> {
  try {
    const url = `${CLOB_API}/price?token_id=${tokenId}&side=buy`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return {
      buy: parseFloat(data.price) || 0.5,
      sell: 1 - (parseFloat(data.price) || 0.5),
    };
  } catch (error) {
    console.error("Error fetching price:", error);
    return null;
  }
}

export async function fetchOrderbook(tokenId: string): Promise<any | null> {
  try {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error("Error fetching orderbook:", error);
    return null;
  }
}

// ─── Wallet Balance (Real) ─────────────────────────────────────────

export async function fetchWalletBalance(walletAddress: string): Promise<{
  usdc: number;
  matic: number;
} | null> {
  try {
    const POLYGON_RPC = "https://polygon-rpc.com";
    const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDCe on Polygon
    
    // Get MATIC balance
    const maticResponse = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBalance",
        params: [walletAddress, "latest"],
        id: 1,
      }),
    });
    
    const maticData = await maticResponse.json();
    const maticWei = parseInt(maticData.result || "0", 16);
    const matic = maticWei / 1e18;
    
    // Get USDC balance via balanceOf call
    const balanceOfSelector = "0x70a08231";
    const paddedAddress = walletAddress.slice(2).padStart(64, "0");
    
    const usdcResponse = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{
          to: USDC_ADDRESS,
          data: balanceOfSelector + paddedAddress,
        }, "latest"],
        id: 2,
      }),
    });
    
    const usdcData = await usdcResponse.json();
    const usdcRaw = parseInt(usdcData.result || "0", 16);
    const usdc = usdcRaw / 1e6; // USDC has 6 decimals
    
    log("Wallet balance:", { walletAddress, usdc, matic });
    
    return { usdc, matic };
  } catch (error) {
    console.error("Error fetching wallet balance:", error);
    return null;
  }
}

// ─── Filter Functions ─────────────────────────────────────────

export function filterMarketsByTimeframe(
  markets: PolymarketMarket[],
  timeframe: TimeframeFilter
): PolymarketMarket[] {
  if (timeframe === "all") return markets;
  
  const now = new Date();
  const maxHours = getTimeframeHours(timeframe);
  const cutoff = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
  
  return markets.filter(m => {
    if (!m.endDate) return true; // Include markets without end date
    const endDate = new Date(m.endDate);
    return endDate <= cutoff && endDate > now;
  });
}

export function filterMarketsByCategory(
  markets: PolymarketMarket[],
  category: string
): PolymarketMarket[] {
  if (category === "all") return markets;
  return markets.filter(m => m.category === category);
}

// Junk/weather/threshold constants imported from marketConstants.ts (single source of truth)

export function filterMarkets(
  markets: PolymarketMarket[],
  filters: MarketFilters,
  openOrderMarketIds?: Set<string>,
): PolymarketMarket[] {
  let filtered = markets;
  const now = Date.now();

  // ── Bot View: overrides individual toggles with bot's exact logic ──
  if (filters.botView) {
    const maxMs = (filters.maxExpiryHours || 72) * 60 * 60 * 1000;
    filtered = filtered.filter(m => {
      // 1. Must have endDate
      if (!m.endDate) return false;
      const endTime = new Date(m.endDate).getTime();
      const timeLeft = endTime - now;
      // 2. Not expired / not resolved
      if (timeLeft <= 0 || m.resolved || !m.active) return false;
      // 3. Within max expiry window
      if (timeLeft > maxMs) return false;
      // 4. Not near expiry (>10 min)
      if (timeLeft <= 10 * 60 * 1000) return false;
      // 5. Exclude sports
      if (m.category === 'sports') return false;
      // 6. Min liquidity/volume (weather exception)
      const q = m.question.toLowerCase();
      const isWeather = WEATHER_RE.test(q) && timeLeft > 12 * 60 * 60 * 1000;
      if (m.liquidity < (isWeather ? WEATHER_MIN_LIQUIDITY : MIN_LIQUIDITY)) return false;
      if (m.volume < (isWeather ? WEATHER_MIN_VOLUME : MIN_VOLUME)) return false;
      // 7. Price extremes
      const yp = parseFloat(m.outcomePrices[0] || '0.5');
      if (yp <= PRICE_FLOOR || yp >= PRICE_CEILING) return false;
      // 8. Junk patterns
      if (JUNK_PATTERNS.some(j => q.includes(j))) return false;
      if (JUNK_REGEXES.some(r => r.test(q))) return false;
      // 9. No duplicate open orders
      if (openOrderMarketIds && openOrderMarketIds.has(m.id)) return false;
      return true;
    });

    // Still apply search + category UI selects on top of bot view
    if (filters.category !== 'all') {
      filtered = filterMarketsByCategory(filtered, filters.category);
    }
    if (filters.searchQuery.trim()) {
      const query = filters.searchQuery.toLowerCase();
      filtered = filtered.filter(m =>
        m.question.toLowerCase().includes(query) ||
        (m.description || "").toLowerCase().includes(query)
      );
    }
    return filtered;
  }

  // ── Individual filters (non-bot-view mode) ──

  // Timeframe
  filtered = filterMarketsByTimeframe(filtered, filters.timeframe);

  // Category
  filtered = filterMarketsByCategory(filtered, filters.category);

  // Volume
  filtered = filtered.filter(m => m.volume >= filters.minVolume);

  // Liquidity
  filtered = filtered.filter(m => m.liquidity >= filters.minLiquidity);

  // Search query
  if (filters.searchQuery.trim()) {
    const query = filters.searchQuery.toLowerCase();
    filtered = filtered.filter(m =>
      m.question.toLowerCase().includes(query) ||
      (m.description || "").toLowerCase().includes(query)
    );
  }

  // Resolved
  if (!filters.showResolved) {
    filtered = filtered.filter(m => !m.resolved);
  }

  // Require end date
  if (filters.requireEndDate) {
    filtered = filtered.filter(m => !!m.endDate);
  }

  // Exclude expired
  if (filters.excludeExpired) {
    filtered = filtered.filter(m => {
      if (!m.endDate) return true; // no endDate = not expired
      return new Date(m.endDate).getTime() > now && m.active && !m.resolved;
    });
  }

  // Max expiry hours (0 = no limit)
  if (filters.maxExpiryHours > 0) {
    const maxMs = filters.maxExpiryHours * 60 * 60 * 1000;
    filtered = filtered.filter(m => {
      if (!m.endDate) return false;
      const timeLeft = new Date(m.endDate).getTime() - now;
      return timeLeft > 0 && timeLeft <= maxMs;
    });
  }

  // Exclude near expiry (≤10 min)
  if (filters.excludeNearExpiry) {
    filtered = filtered.filter(m => {
      if (!m.endDate) return true;
      return new Date(m.endDate).getTime() - now > 10 * 60 * 1000;
    });
  }

  // Exclude sports
  if (filters.excludeSports) {
    filtered = filtered.filter(m => m.category !== 'sports');
  }

  // Exclude price extremes (≤5¢ or ≥95¢)
  if (filters.excludeExtremes) {
    filtered = filtered.filter(m => {
      const yp = parseFloat(m.outcomePrices[0] || '0.5');
      return yp > 0.05 && yp < 0.95;
    });
  }

  // Exclude junk
  if (filters.excludeJunk) {
    filtered = filtered.filter(m => {
      const q = m.question.toLowerCase();
      if (JUNK_PATTERNS.some(j => q.includes(j))) return false;
      if (JUNK_REGEXES.some(r => r.test(q))) return false;
      return true;
    });
  }

  // Exclude markets with open orders
  if (filters.excludeOpenOrders && openOrderMarketIds) {
    filtered = filtered.filter(m => !openOrderMarketIds.has(m.id));
  }

  return filtered;
}

// ─── Resolution Checker ─────────────────────────────────────────

export function isMarketResolved(market: PolymarketMarket): boolean {
  // Gamma API uses 'closed' field for resolved markets.
  // Also check our parsed 'resolved' which now derives from closed.
  return market.resolved === true || market.closed === true;
}

export function getWinningOutcome(market: PolymarketMarket): number | null {
  if (!isMarketResolved(market)) return null;
  
  // For resolved markets, the winner's price goes to $1.00 (or very close)
  const prices = market.outcomePrices.map(p => parseFloat(p));
  const winnerIndex = prices.findIndex(p => p >= 0.95);
  
  if (winnerIndex >= 0) return winnerIndex;
  
  // Fallback: the outcome with the highest price is the winner
  const maxPrice = Math.max(...prices);
  return prices.indexOf(maxPrice);
}

// ─── Price Formatting ─────────────────────────────────────────

export function formatPrice(price: string | number): string {
  const p = typeof price === "string" ? parseFloat(price) : price;
  return `${(p * 100).toFixed(1)}¢`;
}

export function formatVolume(volume: number): string {
  if (volume >= 1000000) {
    return `$${(volume / 1000000).toFixed(2)}M`;
  }
  if (volume >= 1000) {
    return `$${(volume / 1000).toFixed(1)}K`;
  }
  return `$${volume.toFixed(0)}`;
}

export function formatTimeRemaining(endDate: string): string {
  if (!endDate) return "No deadline";
  
  const end = new Date(endDate);
  const now = new Date();
  const diff = end.getTime() - now.getTime();
  
  if (diff <= 0) return "Ended";
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  
  const minutes = Math.floor(diff / (1000 * 60));
  return `${minutes}m`;
}
