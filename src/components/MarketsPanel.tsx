import { useState, useEffect, useMemo } from "react";
import {
  PolymarketMarket,
  MarketFilters,
  TimeframeFilter,
  CategoryFilter,
  defaultFilters,
  defaultConfig,
  PaperOrder,
  Portfolio,
} from "../types";
import {
  fetchMarkets,
  fetchAllMarkets,
  filterMarkets,
  formatPrice,
  formatVolume,
  formatTimeRemaining,
} from "../services/polymarket";
import { computeClusterKey } from "../services/marketConstants";
import { createPaperOrder } from "../services/paperTrading";
import { useTranslation } from "../i18n";

interface MarketsProps {
  portfolio: Portfolio;
  onPortfolioUpdate: (portfolio: Portfolio) => void;
  onActivity: (message: string, type: string) => void;
}

const timeframeValues: TimeframeFilter[] = ["1h", "4h", "8h", "1d", "3d", "7d", "all"];

const categoryValues: { value: CategoryFilter; icon: string }[] = [
  { value: "all", icon: "🌐" },
  { value: "politics", icon: "🏛️" },
  { value: "sports", icon: "⚽" },
  { value: "crypto", icon: "₿" },
  { value: "entertainment", icon: "🎬" },
  { value: "science", icon: "🔬" },
  { value: "business", icon: "📈" },
  { value: "other", icon: "📦" },
];

export default function MarketsPanel({ portfolio, onPortfolioUpdate, onActivity }: MarketsProps) {
  const { t } = useTranslation();
  const [markets, setMarkets] = useState<PolymarketMarket[]>([]);
  const [filters, setFilters] = useState<MarketFilters>(defaultFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<PolymarketMarket | null>(null);
  const [betAmount, setBetAmount] = useState<string>("5");
  const [betOutcome, setBetOutcome] = useState<number>(0);
  const [loadProgress, setLoadProgress] = useState<string>("");
  const [displayCount, setDisplayCount] = useState(100); // Render in chunks for performance

  // Fetch ALL markets on mount (paginated)
  useEffect(() => {
    loadMarkets();
    // Refresh every 5 minutes (full reload is heavier now)
    const interval = setInterval(loadMarkets, 300000);
    return () => clearInterval(interval);
  }, []);

  const loadMarkets = async () => {
    try {
      setLoading(true);
      setLoadProgress(t("markets.starting"));
      onActivity(t("markets.loadingAll"), "System");
      const data = await fetchAllMarkets(true, 12000, (loaded: number) => {
        setLoadProgress(`${loaded.toLocaleString()} ${t("markets.marketsCount")}...`);
      });
      setMarkets(data);
      setDisplayCount(100); // Reset display on new load
      setError(null);
      setLoadProgress("");
      onActivity(`${data.length.toLocaleString()} ${t("markets.found")}`, data.length > 0 ? "Info" : "Warning");
    } catch (e) {
      setError(t("markets.errorLoading"));
      onActivity(`Error: ${e instanceof Error ? e.message : t("markets.unknownError")}`, "Error");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // Build set of market IDs with open orders (for duplicate filter)
  const openOrderMarketIds = useMemo(() => {
    return new Set(portfolio.openOrders.map(o => o.marketId));
  }, [portfolio.openOrders]);

  // Filter markets
  const filteredMarkets = useMemo(() => {
    return filterMarkets(markets, filters, openOrderMarketIds);
  }, [markets, filters, openOrderMarketIds]);

  // Count unique clusters (what Claude would actually see after dedup)
  const uniqueClusterCount = useMemo(() => {
    if (!filters.botView) return 0;
    const keys = new Set<string>();
    let uniqueIdx = 0;
    for (const m of filteredMarkets) {
      const key = computeClusterKey(m.question) || `__u_${uniqueIdx++}`;
      keys.add(key);
    }
    return keys.size;
  }, [filteredMarkets, filters.botView]);

  // Visible subset for performance (don't render 10K+ DOM nodes)
  const visibleMarkets = useMemo(() => {
    return filteredMarkets.slice(0, displayCount);
  }, [filteredMarkets, displayCount]);

  const hasMore = displayCount < filteredMarkets.length;

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(100);
  }, [filters]);

  // Handle placing a bet
  const handlePlaceBet = () => {
    if (!selectedMarket) return;

    const amount = parseFloat(betAmount);
    if (isNaN(amount) || amount <= 0) {
      onActivity(t("markets.invalidAmount"), "Warning");
      return;
    }

    // ═══ HARD CAP: max 10% of balance per bet ═══
    const maxBet = portfolio.balance * 0.10;
    if (amount > maxBet) {
      onActivity(`Max bet is $${maxBet.toFixed(2)} (10% of balance)`, "Warning");
      return;
    }

    const price = parseFloat(selectedMarket.outcomePrices[betOutcome]);
    const quantity = amount / price;

    const result = createPaperOrder(
      selectedMarket,
      betOutcome,
      "buy",
      quantity,
      portfolio
    );

    if (result.error) {
      onActivity(result.error, "Error");
      return;
    }

    if (result.order) {
      onPortfolioUpdate(result.portfolio);
      onActivity(
        `ORDER $${result.order.totalCost.toFixed(2)} → "${selectedMarket.outcomes[betOutcome]}" @ ${formatPrice(price)}`,
        "Order"
      );
      setSelectedMarket(null);
      setBetAmount("5");
    }
  };

  return (
    <div className="bg-bot-card rounded-xl border border-bot-border overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-bot-border bg-gradient-to-r from-bot-green/10 to-transparent">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-bot-green">📊</span> {t("markets.title")}
            <span className="text-xs text-gray-500 font-normal">
              ({filteredMarkets.length.toLocaleString()} {t("markets.marketsCount")}{markets.length !== filteredMarkets.length ? ` ${t("markets.of")} ${markets.length.toLocaleString()}` : ""})
              {filters.botView && uniqueClusterCount < filteredMarkets.length && (
                <span className="ml-1 text-cyan-400" title="After cluster dedup — what Claude actually sees">
                  → {uniqueClusterCount} unique
                </span>
              )}
            </span>
          </h2>
          <div className="flex items-center gap-3">
            {loading && loadProgress && (
              <span className="text-xs text-cyan-400 animate-pulse">
                📥 {loadProgress}
              </span>
            )}
            <button
              onClick={loadMarkets}
              disabled={loading}
              className="px-3 py-1 text-xs bg-bot-green/20 text-bot-green rounded-lg 
                       hover:bg-bot-green/30 transition-colors disabled:opacity-50"
            >
              {loading ? t("markets.loading") : t("markets.refresh")}
            </button>
          </div>
        </div>

        {/* Filters Row 1: Dropdowns */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Timeframe */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.expiry")}</label>
            <select
              value={filters.botView ? 'all' : filters.timeframe}
              disabled={filters.botView}
              onChange={(e) =>
                setFilters({ ...filters, timeframe: e.target.value as TimeframeFilter })
              }
              className={`w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none
                       ${filters.botView ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {timeframeValues.map((val) => (
                <option key={val} value={val}>
                  {t(`markets.tf.${val}` as any)}
                </option>
              ))}
            </select>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.category")}</label>
            <select
              value={filters.category}
              onChange={(e) =>
                setFilters({ ...filters, category: e.target.value as CategoryFilter })
              }
              className="w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none"
            >
              {categoryValues.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.icon} {t(`markets.cat.${opt.value}` as any)}
                </option>
              ))}
            </select>
          </div>

          {/* Min Volume */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.minVolume")}</label>
            <select
              value={filters.botView ? 1000 : filters.minVolume}
              disabled={filters.botView}
              onChange={(e) =>
                setFilters({ ...filters, minVolume: parseInt(e.target.value) })
              }
              className={`w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none
                       ${filters.botView ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <option value={0}>{t("markets.vol.none")}</option>
              <option value={500}>$500+</option>
              <option value={1000}>$1K+ ⭐</option>
              <option value={5000}>$5K+</option>
              <option value={10000}>$10K+</option>
              <option value={50000}>$50K+</option>
              <option value={100000}>$100K+</option>
            </select>
          </div>

          {/* Min Liquidity */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.minLiquidity" as any)}</label>
            <select
              value={filters.botView ? 2000 : filters.minLiquidity}
              disabled={filters.botView}
              onChange={(e) =>
                setFilters({ ...filters, minLiquidity: parseInt(e.target.value) })
              }
              className={`w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none
                       ${filters.botView ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <option value={0}>{t("markets.liq.none" as any)}</option>
              <option value={500}>$500+</option>
              <option value={1000}>$1K+</option>
              <option value={2000}>$2K+ ⭐</option>
              <option value={5000}>$5K+</option>
              <option value={10000}>$10K+</option>
            </select>
          </div>

          {/* Max Expiry (bot uses 72h) */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.maxExpiry" as any)}</label>
            <select
              value={filters.botView ? defaultConfig.max_expiry_hours : filters.maxExpiryHours}
              disabled={filters.botView}
              onChange={(e) =>
                setFilters({ ...filters, maxExpiryHours: parseInt(e.target.value) })
              }
              className={`w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none
                       ${filters.botView ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <option value={0}>{t("markets.maxExpiry.none" as any)}</option>
              <option value={1}>1h</option>
              <option value={4}>4h</option>
              <option value={8}>8h</option>
              <option value={24}>24h</option>
              <option value={72}>72h ⭐</option>
              <option value={168}>7d</option>
              <option value={720}>30d</option>
            </select>
          </div>

          {/* Search */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.search")}</label>
            <input
              type="text"
              value={filters.searchQuery}
              onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
              placeholder={t("markets.searchPlaceholder")}
              className="w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white placeholder-gray-600 focus:border-bot-green outline-none"
            />
          </div>
        </div>

        {/* Filters Row 2: Toggle filters */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {/* Bot View — master toggle */}
          <button
            onClick={() => setFilters({ ...filters, botView: !filters.botView })}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-all font-medium
                     ${filters.botView
                       ? 'bg-bot-green/20 border-bot-green text-bot-green shadow-[0_0_8px_rgba(0,255,136,0.3)]'
                       : 'bg-bot-bg border-bot-border text-gray-400 hover:border-gray-500'}`}
            title={t("markets.botViewDesc" as any)}
          >
            {t("markets.botView" as any)}
          </button>

          <div className="w-px h-5 bg-bot-border" />

          {/* Require End Date */}
          <button
            onClick={() => setFilters({ ...filters, requireEndDate: !filters.requireEndDate })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.requireEndDate || filters.botView
                       ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.requireEndDate" as any)}
          </button>

          {/* Exclude Expired */}
          <button
            onClick={() => setFilters({ ...filters, excludeExpired: !filters.excludeExpired })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeExpired || filters.botView
                       ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeExpired" as any)}
          </button>

          {/* Exclude Near Expiry */}
          <button
            onClick={() => setFilters({ ...filters, excludeNearExpiry: !filters.excludeNearExpiry })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeNearExpiry || filters.botView
                       ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeNearExpiry" as any)}
          </button>

          {/* Exclude Sports */}
          <button
            onClick={() => setFilters({ ...filters, excludeSports: !filters.excludeSports })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeSports || filters.botView
                       ? 'bg-red-500/15 border-red-500/40 text-red-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeSports" as any)}
          </button>

          {/* Exclude Junk */}
          <button
            onClick={() => setFilters({ ...filters, excludeJunk: !filters.excludeJunk })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeJunk || filters.botView
                       ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeJunk" as any)}
          </button>

          {/* Exclude Extremes */}
          <button
            onClick={() => setFilters({ ...filters, excludeExtremes: !filters.excludeExtremes })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeExtremes || filters.botView
                       ? 'bg-purple-500/15 border-purple-500/40 text-purple-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeExtremes" as any)}
          </button>

          {/* Exclude Open Orders */}
          <button
            onClick={() => setFilters({ ...filters, excludeOpenOrders: !filters.excludeOpenOrders })}
            className={`px-2 py-1 text-xs rounded-lg border transition-all
                     ${filters.excludeOpenOrders || filters.botView
                       ? 'bg-orange-500/15 border-orange-500/40 text-orange-400'
                       : 'bg-bot-bg border-bot-border text-gray-500 hover:border-gray-500'}`}
          >
            {t("markets.excludeOpenOrders" as any)}
            {openOrderMarketIds.size > 0 && (
              <span className="ml-1 text-[10px] opacity-70">({openOrderMarketIds.size})</span>
            )}
          </button>
        </div>
      </div>

      {/* Markets List */}
      <div className="max-h-[600px] overflow-y-auto custom-scrollbar">
        {error && (
          <div className="p-4 text-center text-red-400">
            {error}
          </div>
        )}

        {!error && filteredMarkets.length === 0 && !loading && (
          <div className="p-8 text-center text-gray-500">
            <div className="text-4xl mb-2">🔍</div>
            {t("markets.noResults")}
          </div>
        )}

        {visibleMarkets.map((market) => (
          <div
            key={market.id}
            className={`p-4 border-b border-bot-border hover:bg-bot-green/5 
                      transition-colors cursor-pointer group
                      ${selectedMarket?.id === market.id ? "bg-bot-green/10" : ""}`}
            onClick={() => setSelectedMarket(selectedMarket?.id === market.id ? null : market)}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-white truncate group-hover:text-bot-green transition-colors">
                  {market.question}
                </h3>
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <span className="text-yellow-500">⏱️</span>
                    {formatTimeRemaining(market.endDate)}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="text-green-500">📊</span>
                    {formatVolume(market.volume)}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="text-blue-500">💧</span>
                    {formatVolume(market.liquidity)}
                  </span>
                  <span className="px-2 py-0.5 bg-bot-border rounded text-gray-400">
                    {categoryValues.find((c) => c.value === market.category)?.icon}{" "}
                    {t(`markets.cat.${market.category}` as any)}
                  </span>
                </div>
              </div>

              {/* Prices */}
              <div className="flex gap-2 shrink-0">
                {market.outcomes.map((outcome, idx) => {
                  const price = parseFloat(market.outcomePrices[idx]);
                  const isYes = outcome.toLowerCase() === "yes" || outcome.toLowerCase() === "sí";
                  return (
                    <div
                      key={idx}
                      className={`px-3 py-2 rounded-lg text-center min-w-[80px]
                               ${isYes ? "bg-green-500/20 border border-green-500/30" : "bg-red-500/20 border border-red-500/30"}`}
                    >
                      <div className={`text-xs font-medium ${isYes ? "text-green-400" : "text-red-400"}`}>
                        {outcome}
                      </div>
                      <div className="text-lg font-bold text-white mt-0.5">
                        {(price * 100).toFixed(0)}¢
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Expanded betting panel */}
            {selectedMarket?.id === market.id && (
              <div className="mt-4 pt-4 border-t border-bot-border animate-fadeIn">
                <div className="flex flex-wrap items-end gap-4">
                  {/* Outcome Selection */}
                  <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs text-gray-500 mb-2">{t("markets.selectOutcome")}</label>
                    <div className="flex gap-2">
                      {market.outcomes.map((outcome, idx) => {
                        const price = parseFloat(market.outcomePrices[idx]);
                        const isSelected = betOutcome === idx;
                        return (
                          <button
                            key={idx}
                            onClick={(e) => {
                              e.stopPropagation();
                              setBetOutcome(idx);
                            }}
                            className={`flex-1 px-4 py-2 rounded-lg border transition-all
                                     ${isSelected
                                       ? "bg-bot-green border-bot-green text-black font-bold"
                                       : "bg-bot-bg border-bot-border text-white hover:border-bot-green"
                                     }`}
                          >
                            {outcome} @ {(price * 100).toFixed(0)}¢
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Amount Input */}
                  <div className="w-[120px]">
                    <label className="block text-xs text-gray-500 mb-2">{t("markets.amount")}</label>
                    <input
                      type="number"
                      value={betAmount}
                      onChange={(e) => setBetAmount(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      min="1"
                      step="1"
                      className="w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                               text-white focus:border-bot-green outline-none"
                    />
                  </div>

                  {/* Potential Payout */}
                  <div className="w-[140px]">
                    <label className="block text-xs text-gray-500 mb-2">{t("markets.potentialPayout")}</label>
                    <div className="bg-bot-bg border border-green-500/30 rounded-lg px-3 py-2 text-green-400 font-bold">
                      ${(parseFloat(betAmount || "0") / parseFloat(market.outcomePrices[betOutcome])).toFixed(2)}
                    </div>
                  </div>

                  {/* Place Bet Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlaceBet();
                    }}
                    disabled={portfolio.balance < parseFloat(betAmount || "0")}
                    className="px-6 py-2 bg-bot-green text-black font-bold rounded-lg 
                             hover:bg-bot-green/80 transition-colors disabled:opacity-50 
                             disabled:cursor-not-allowed"
                  >
                    {t("markets.placeBet")}
                  </button>
                </div>

                {/* Balance Warning */}
                {portfolio.balance < parseFloat(betAmount || "0") && (
                  <div className="mt-2 text-xs text-red-400">
                    {t("markets.insufficientBalance", portfolio.balance.toFixed(2))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {/* Load More button */}
        {hasMore && (
          <div className="p-4 text-center border-t border-bot-border">
            <button
              onClick={() => setDisplayCount(prev => prev + 200)}
              className="px-6 py-2.5 text-sm font-medium bg-bot-green/15 text-bot-green rounded-lg 
                       border border-bot-green/25 hover:bg-bot-green/25 transition-all"
            >
              {t("markets.loadMore", (filteredMarkets.length - displayCount).toLocaleString())}
            </button>
          </div>
        )}

        {/* Showing count */}
        {filteredMarkets.length > 100 && (
          <div className="px-4 py-2 text-center text-[10px] text-gray-600 border-t border-bot-border">
            {t("markets.showing", Math.min(displayCount, filteredMarkets.length).toLocaleString(), filteredMarkets.length.toLocaleString())}
          </div>
        )}      </div>
    </div>
  );
}
