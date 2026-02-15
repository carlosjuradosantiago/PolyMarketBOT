import { useState, useEffect, useMemo } from "react";
import {
  PolymarketMarket,
  MarketFilters,
  TimeframeFilter,
  CategoryFilter,
  defaultFilters,
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

  // Filter markets
  const filteredMarkets = useMemo(() => {
    return filterMarkets(markets, filters);
  }, [markets, filters]);

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

        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Timeframe */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t("markets.expiry")}</label>
            <select
              value={filters.timeframe}
              onChange={(e) =>
                setFilters({ ...filters, timeframe: e.target.value as TimeframeFilter })
              }
              className="w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none"
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
              value={filters.minVolume}
              onChange={(e) =>
                setFilters({ ...filters, minVolume: parseInt(e.target.value) })
              }
              className="w-full bg-bot-bg border border-bot-border rounded-lg px-3 py-2 
                       text-sm text-white focus:border-bot-green outline-none"
            >
              <option value={0}>{t("markets.vol.none")}</option>
              <option value={1000}>$1K+</option>
              <option value={5000}>$5K+</option>
              <option value={10000}>$10K+</option>
              <option value={50000}>$50K+</option>
              <option value={100000}>$100K+</option>
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
