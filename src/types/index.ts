// ─── Trading Types ─────────────────────────────────────────────

export interface BotStats {
  current_balance: number;
  initial_balance: number;
  total_pnl: number;
  total_pnl_pct: string;
  api_costs: number;
  win_rate: number;
  wins: number;
  losses: number;
  total_trades: number;
  markets_scanned: number;
  avg_bet: number;
  best_trade: number;
  worst_trade: number;
  sharpe_ratio: number;
  avg_edge: number;
  daily_api_cost: number;
  runway_days: number;
  uptime: string;
  cycle: number;
  pid: number;
  open_orders: number;
  pending_value: number;
  invested_in_orders: number;
  signals_generated: number;
}

export interface ActivityEntry {
  timestamp: string;
  message: string;
  entry_type: ActivityType;
}

export type ActivityType =
  | "Info"
  | "Edge"
  | "Order"
  | "Resolved"
  | "Warning"
  | "Error"
  | "Inference"
  | "Market";

export interface BalancePoint {
  timestamp: string;
  balance: number;
  label: string;
}

// ─── Market Types ─────────────────────────────────────────────

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  markets: PolymarketMarket[];
  startDate: string;
  endDate: string;
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  category: string;
  image?: string;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  volume: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  resolutionSource?: string;
  description?: string;
  category?: string;
  image?: string;
}

export type TimeframeFilter = "1h" | "4h" | "8h" | "1d" | "3d" | "7d" | "all";
export type CategoryFilter = "all" | "politics" | "sports" | "crypto" | "entertainment" | "science" | "business" | "other";

export interface MarketFilters {
  timeframe: TimeframeFilter;
  category: CategoryFilter;
  minVolume: number;
  minLiquidity: number;
  searchQuery: string;
  showResolved: boolean;
  // ─── Bot-matching filters ───
  requireEndDate: boolean;     // only markets with expiry date
  excludeExpired: boolean;     // not expired & active
  excludeNearExpiry: boolean;  // >10 min remaining
  excludeSports: boolean;      // API-based sports detection
  excludeJunk: boolean;        // tweet/followers/trivia noise
  excludeExtremes: boolean;    // prices ≤2¢ or ≥98¢
  excludeOpenOrders: boolean;  // skip markets with existing bets
  maxExpiryHours: number;      // 0 = no limit, else max hours to expiry
  botView: boolean;            // apply ALL bot filters with bot defaults
}

export const defaultFilters: MarketFilters = {
  timeframe: "all",
  category: "all",
  minVolume: 0,
  minLiquidity: 0,
  searchQuery: "",
  showResolved: false,
  requireEndDate: false,
  excludeExpired: false,
  excludeNearExpiry: false,
  excludeSports: false,
  excludeJunk: false,
  excludeExtremes: false,
  excludeOpenOrders: false,
  maxExpiryHours: 0,
  botView: false,
};

// ─── Paper Trading Types ─────────────────────────────────────────────

export type OrderSide = "buy" | "sell";
export type OrderStatus = "pending" | "filled" | "resolved" | "cancelled" | "won" | "lost";

export interface PaperOrder {
  id: string;
  marketId: string;
  conditionId: string;
  marketQuestion: string;
  marketSlug?: string;
  outcome: string;
  outcomeIndex: number;
  side: OrderSide;
  price: number;
  quantity: number;
  totalCost: number;
  potentialPayout: number;
  status: OrderStatus;
  createdAt: string;
  endDate?: string;       // Market expiration date — resolution happens AFTER this
  resolvedAt?: string;
  pnl?: number;
  resolutionPrice?: number;
  lastCheckedAt?: string;  // Last time we checked resolution on the API
  aiReasoning?: {           // Full AI analysis + Kelly justification
    claudeAnalysis: {
      pMarket: number;
      pReal: number;
      pLow: number;
      pHigh: number;
      edge: number;
      confidence: number;
      recommendedSide: string;
      reasoning: string;
      sources: string[];
      // SCALP fields
      evNet?: number;
      maxEntryPrice?: number;
      sizeUsd?: number;
      orderType?: string;
      clusterId?: string | null;
      risks?: string;
      resolutionCriteria?: string;
    };
    kelly: {
      rawKelly: number;
      fractionalKelly: number;
      betAmount: number;
      expectedValue: number;
      aiCostPerBet: number;
    };
    model: string;
    costUsd: number;
    timestamp: string;
    fullPrompt?: string;      // The complete prompt sent to Claude
    fullResponse?: string;    // The complete raw response from Claude
  };
}

export interface Portfolio {
  balance: number;
  initialBalance: number;
  totalPnl: number;
  openOrders: PaperOrder[];
  closedOrders: PaperOrder[];
  lastUpdated: string;
}

export const defaultPortfolio: Portfolio = {
  balance: 100.0,
  initialBalance: 100.0,
  totalPnl: 0.0,
  openOrders: [],
  closedOrders: [],
  lastUpdated: new Date().toISOString(),
};

// ─── Config Types ─────────────────────────────────────────────

import type { AIProviderType } from "../services/aiProviders";

export interface BotConfig {
  polymarket_api_key: string;
  polymarket_secret: string;
  polymarket_passphrase: string;
  // AI multi-provider
  ai_provider: AIProviderType;
  ai_model: string;
  ai_api_keys: Partial<Record<AIProviderType, string>>;
  // Legacy (kept for backward compat migration)
  claude_api_key: string;
  claude_model: string;
  // Trading
  initial_balance: number;
  max_bet_size: number;
  min_edge_threshold: number;
  max_concurrent_orders: number;
  scan_interval_secs: number;
  max_expiry_hours: number;
  auto_trading: boolean;
  survival_mode: boolean;
  paper_trading: boolean;
}

export const defaultConfig: BotConfig = {
  polymarket_api_key: "",
  polymarket_secret: "",
  polymarket_passphrase: "",
  ai_provider: "anthropic",
  ai_model: "claude-sonnet-4-20250514",
  ai_api_keys: {},
  claude_api_key: "",
  claude_model: "claude-sonnet-4-20250514",
  initial_balance: 1500.0,
  max_bet_size: 150.0,
  min_edge_threshold: 0.10,
  max_concurrent_orders: 10,
  scan_interval_secs: 30,
  max_expiry_hours: 120,
  auto_trading: true,
  survival_mode: true,
  paper_trading: true,
};

/** Migrate old config format (claude-only) to multi-provider */
export function migrateBotConfig(config: any): BotConfig {
  const migrated = { ...defaultConfig, ...config };
  // If old claude_api_key exists but ai_api_keys doesn't have it
  if (migrated.claude_api_key && (!migrated.ai_api_keys || !migrated.ai_api_keys.anthropic)) {
    migrated.ai_api_keys = {
      ...migrated.ai_api_keys,
      anthropic: migrated.claude_api_key,
    };
  }
  // If no ai_provider set, default to anthropic
  if (!migrated.ai_provider) {
    migrated.ai_provider = "anthropic";
  }
  // If no ai_model set, use claude_model or default
  if (!migrated.ai_model) {
    migrated.ai_model = migrated.claude_model || "claude-sonnet-4-20250514";
  }
  return migrated;
}

export const defaultStats: BotStats = {
  current_balance: 1500.0,
  initial_balance: 1500.0,
  total_pnl: 0.0,
  total_pnl_pct: "+$0.00",
  api_costs: 0.0,
  win_rate: 0.0,
  wins: 0,
  losses: 0,
  total_trades: 0,
  markets_scanned: 0,
  avg_bet: 0.0,
  best_trade: 0.0,
  worst_trade: 0.0,
  sharpe_ratio: 0.0,
  avg_edge: 0.0,
  daily_api_cost: 0.0,
  runway_days: 999,
  uptime: "00:00:00",
  cycle: 0,
  pid: 0,
  open_orders: 0,
  pending_value: 0.0,
  invested_in_orders: 0,
  signals_generated: 0,
};

// ─── Utility Types ─────────────────────────────────────────────

export interface ChartDataPoint {
  time: string;
  value: number;
  label?: string;
}

export interface TradeHistory {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
}

// ─── AI Analysis Types ─────────────────────────────────────────

/** Result of Claude AI analyzing a single market */
export interface MarketAnalysis {
  marketId: string;
  question: string;
  pMarket: number;          // Current market implied probability
  pReal: number;            // AI estimated real probability
  pLow: number;             // Lower bound of estimate
  pHigh: number;            // Upper bound of estimate
  edge: number;             // pReal - pMarket (positive = underpriced)
  confidence: number;       // 0-100 confidence score
  recommendedSide: string;  // "YES" | "NO" | "SKIP"
  reasoning: string;        // Brief explanation
  sources: string[];        // Key information sources
  // SCALP fields
  evNet?: number;           // Expected value net of friction
  maxEntryPrice?: number;   // Max price to enter at
  sizeUsd?: number;         // Recommended position size in USD
  orderType?: string;       // "LIMIT" always in SCALP mode
  clusterId?: string | null; // Cluster of mutually exclusive markets
  risks?: string;           // Risk assessment
  resolutionCriteria?: string; // How the market resolves
  // Extended fields from improved prompt
  category?: string;        // Market category (politics, weather, sports, etc.)
  friction?: number;        // Dynamic friction estimate (spread + fee + slippage)
  expiresInMin?: number;    // Minutes until market expiry
  liqUsd?: number;          // Market liquidity in USD
  volUsd?: number;          // Market volume in USD
  dataFreshnessScore?: number; // 0-100 how fresh/reliable the data is
  executionNotes?: string;  // Spread/depth/timing notes
}

/** Token usage and cost tracking for a single AI call */
export interface AIUsage {
  id?: number;             // DB row id (set when loaded from DB)
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  timestamp: string;
  prompt?: string;        // Full prompt sent to Claude
  rawResponse?: string;   // Full raw response from Claude
  responseTimeMs?: number; // Response time in ms
  summary?: string;       // Parsed summary from response
  recommendations?: number; // Number of recommendations returned
  webSearches?: number;   // Number of web_search calls made by Claude
  searchQueries?: string[]; // The actual queries searched
}

/** Cumulative AI cost tracker */
export interface AICostTracker {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  history: AIUsage[];
}

/** Kelly Criterion calculation result */
export interface KellyResult {
  marketId: string;
  question: string;
  edge: number;              // Net edge after costs
  rawKelly: number;          // Raw Kelly fraction
  fractionalKelly: number;   // Conservative Kelly (0.25x)
  betAmount: number;         // Dollar amount to bet
  outcomeIndex: number;      // Which outcome to bet on
  outcomeName: string;       // "Yes" or "No"
  price: number;             // Entry price
  expectedValue: number;     // Expected profit per dollar
  aiCostPerBet: number;      // AI cost allocated to this bet
  confidence: number;        // AI confidence
  reasoning: string;         // Why this bet
}

/** Smart trader cycle result */
export interface SmartCycleResult {
  portfolio: Portfolio;
  betsPlaced: KellyResult[];
  marketsAnalyzed: number;
  marketsEligible: number;
  aiUsage: AIUsage | null;
  nextScanSeconds: number;
  activities: ActivityEntry[];
  skippedReason?: string;
}

export const defaultAICostTracker: AICostTracker = {
  totalCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  history: [],
};
