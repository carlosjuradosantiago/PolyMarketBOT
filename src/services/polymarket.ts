// ─── Polymarket API Service ─────────────────────────────────────────
// Connects to real Polymarket APIs for market data

import { PolymarketEvent, PolymarketMarket, TimeframeFilter } from "../types";

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

function categorizeMarket(title: string, description: string): string {
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
  if (text.includes("nfl") || text.includes("nba") || text.includes("ufc") || 
      text.includes("soccer") || text.includes("football") || text.includes("basketball") ||
      text.includes("tennis") || text.includes("match") || text.includes("game") ||
      text.includes("team") || text.includes("vs") || text.includes("championship")) {
    return "sports";
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
      category: categorizeMarket(question, m.description || ""),
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
      category: categorizeMarket(event.title || "", event.description || ""),
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
    const url = `${GAMMA_API}/markets?limit=${limit}&active=${active}&closed=false&order=volume&ascending=false`;
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
 */
export async function fetchAllMarkets(
  active: boolean = true,
  maxTotal: number = 12000,
  onProgress?: (loaded: number) => void,
): Promise<PolymarketMarket[]> {
  // Return cache if still fresh
  if (_cachedMarkets.length > 0 && Date.now() - _cacheTs < FETCH_CACHE_TTL) {
    log(`[fetchAllMarkets] Using cache (${_cachedMarkets.length} markets, age ${Math.round((Date.now() - _cacheTs) / 1000)}s)`);
    onProgress?.(_cachedMarkets.length);
    return _cachedMarkets;
  }

  const PAGE_SIZE = 500; // Gamma API allows up to ~500 per request
  const allMarkets: PolymarketMarket[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let page = 0;
  const MAX_PAGES = Math.ceil(maxTotal / PAGE_SIZE);

  log(`[fetchAllMarkets] Fetching markets (max=${maxTotal})...`);

  while (page < MAX_PAGES) {
    try {
      const url = `${GAMMA_API}/markets?limit=${PAGE_SIZE}&offset=${offset}&active=${active}&closed=false&order=volume&ascending=false`;
      
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[fetchAllMarkets] HTTP ${response.status} on page ${page + 1}, stopping`);
        break;
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        // Empty page, done
        break;
      }

      const parsed = data
        .map((m: any) => parseMarket(m))
        .filter(Boolean) as PolymarketMarket[];

      // Deduplicate
      let newCount = 0;
      for (const m of parsed) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          allMarkets.push(m);
          newCount++;
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
    } catch (error) {
      console.error(`[fetchAllMarkets] Error on page ${page + 1}:`, error);
      break;
    }
  }

  log(`[fetchAllMarkets] ✅ ${allMarkets.length} mercados en ${page + 1} páginas`);
  // Update cache
  _cachedMarkets = allMarkets;
  _cacheTs = Date.now();
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

export function filterMarkets(
  markets: PolymarketMarket[],
  filters: {
    timeframe: TimeframeFilter;
    category: string;
    minVolume: number;
    minLiquidity: number;
    searchQuery: string;
    showResolved: boolean;
  }
): PolymarketMarket[] {
  let filtered = markets;
  
  // Filter by timeframe
  filtered = filterMarketsByTimeframe(filtered, filters.timeframe);
  
  // Filter by category
  filtered = filterMarketsByCategory(filtered, filters.category);
  
  // Filter by volume
  filtered = filtered.filter(m => m.volume >= filters.minVolume);
  
  // Filter by liquidity
  filtered = filtered.filter(m => m.liquidity >= filters.minLiquidity);
  
  // Filter by search query
  if (filters.searchQuery.trim()) {
    const query = filters.searchQuery.toLowerCase();
    filtered = filtered.filter(m => 
      m.question.toLowerCase().includes(query) ||
      (m.description || "").toLowerCase().includes(query)
    );
  }
  
  // Filter resolved markets
  if (!filters.showResolved) {
    filtered = filtered.filter(m => !m.resolved);
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
