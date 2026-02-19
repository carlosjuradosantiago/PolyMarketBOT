import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { BalancePoint } from "../types";
import { formatCurrency } from "../utils/format";
import { useTranslation } from "../i18n";

interface BalanceChartProps {
  history: BalancePoint[];
}

export default function BalanceChart({ history }: BalanceChartProps) {
  const { t } = useTranslation();

  const initialBalance = history[0]?.balance ?? 100;
  const currentBalance = history[history.length - 1]?.balance ?? 0;
  const isPositive = currentBalance >= initialBalance;
  const pnl = currentBalance - initialBalance;
  const pnlPct = initialBalance > 0 ? (pnl / initialBalance) * 100 : 0;

  // Color scheme based on performance
  const accentColor = isPositive ? "#22c55e" : "#ef4444";
  const accentColorDim = isPositive ? "#22c55e" : "#ef4444";

  const chartData = useMemo(() => {
    return history.map((point, i) => ({
      ...point,
      index: i,
      initial: initialBalance,
    }));
  }, [history, initialBalance]);

  // Dynamic Y domain with padding
  const yDomain = useMemo(() => {
    if (history.length === 0) return [0, 100];
    const values = history.map((h) => h.balance);
    values.push(initialBalance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 10;
    const padding = range * 0.15;
    return [Math.max(0, min - padding), max + padding];
  }, [history, initialBalance]);

  // Custom crosshair tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const data = payload[0].payload;
    const val = payload[0].value;
    const diff = val - initialBalance;
    const diffPct = initialBalance > 0 ? (diff / initialBalance) * 100 : 0;
    const up = diff >= 0;

    return (
      <div className="glass-card rounded-lg px-4 py-3 shadow-2xl">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-white font-display font-bold text-lg">
            {formatCurrency(val)}
          </span>
          <span className={`text-xs font-mono font-semibold ${up ? "text-bot-green" : "text-bot-red"}`}>
            {up ? "+" : ""}{formatCurrency(diff)} ({up ? "+" : ""}{diffPct.toFixed(2)}%)
          </span>
        </div>
        <div className="text-[10px] text-bot-muted/50 font-mono">
          {data.label}
          {data.timestamp && (
            <span className="ml-2 text-bot-muted/30">{data.timestamp}</span>
          )}
        </div>
      </div>
    );
  };

  // Custom cursor (crosshair line)
  const CustomCursor = ({ points, height }: any) => {
    if (!points?.length) return null;
    return (
      <line
        x1={points[0].x}
        y1={0}
        x2={points[0].x}
        y2={height}
        stroke="#666"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.5}
      />
    );
  };

  return (
    <div className="glass-card rounded-xl h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-bot-border/40">
        <div className="flex items-center gap-5">
          <div>
            <div className="text-[9px] font-display font-bold text-bot-muted/60 uppercase tracking-[0.2em] mb-1">
              {t("chart.equity")}
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-display font-extrabold text-white tracking-tight">
                {formatCurrency(currentBalance)}
              </span>
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono font-bold ${
                isPositive 
                  ? "bg-bot-green/10 text-bot-green border border-bot-green/20" 
                  : "bg-bot-red/10 text-bot-red border border-bot-red/20"
              }`}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                <span className="opacity-60 text-[10px]">
                  ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[8px] font-display text-bot-muted/40 uppercase tracking-widest">{t("chart.initial")}</div>
            <div className="text-xs text-bot-gray font-mono">{formatCurrency(initialBalance)}</div>
          </div>
          <div className="flex gap-0.5 bg-bot-surface/50 rounded-lg p-0.5 border border-bot-border/30">
            {["1D", "1W", "1M", "ALL"].map((tf, i) => (
              <span
                key={tf}
                className={`px-2.5 py-1 text-[9px] font-display font-bold rounded-md cursor-default transition-all ${
                  i === 3 ? "bg-white/8 text-white" : "text-bot-muted/40 hover:text-bot-muted"
                }`}
              >
                {tf}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 px-1 py-1 min-h-0 relative">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
            <defs>
              <linearGradient id="equityGradientGreen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00e87b" stopOpacity={0.2} />
                <stop offset="30%" stopColor="#00e87b" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#00e87b" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="equityGradientRed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff3b5c" stopOpacity={0.2} />
                <stop offset="30%" stopColor="#ff3b5c" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#ff3b5c" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="lineGradientGreen" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#00e87b" stopOpacity={0.6} />
                <stop offset="50%" stopColor="#06d6f0" stopOpacity={0.8} />
                <stop offset="100%" stopColor="#00e87b" stopOpacity={1} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="4 4"
              stroke="#1a1a2e"
              horizontal={true}
              vertical={false}
              opacity={0.4}
            />
            {/* Initial balance reference line */}
            <ReferenceLine
              y={initialBalance}
              stroke="#252540"
              strokeDasharray="8 4"
              strokeOpacity={0.6}
              label={{
                value: formatCurrency(initialBalance, 0),
                position: "right",
                fill: "#555570",
                fontSize: 9,
              }}
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "#555570", fontSize: 10, fontFamily: "JetBrains Mono" }}
              axisLine={{ stroke: "#1a1a2e" }}
              tickLine={false}
              interval="preserveStartEnd"
              dy={4}
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: "#555570", fontSize: 10, fontFamily: "JetBrains Mono" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(val) => `$${val.toFixed(0)}`}
              width={55}
              dx={-4}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={<CustomCursor />}
              animationDuration={150}
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke={isPositive ? "#00e87b" : "#ff3b5c"}
              strokeWidth={2}
              fill={isPositive ? "url(#equityGradientGreen)" : "url(#equityGradientRed)"}
              animationDuration={400}
              dot={false}
              activeDot={{
                r: 4,
                stroke: accentColor,
                strokeWidth: 2,
                fill: "#060609",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>

        {/* Current price tag */}
        <div
          className="absolute right-3 pointer-events-none flex items-center gap-1"
          style={{ top: "16px" }}
        >
          <div
            className={`px-2.5 py-1 rounded-md text-xs font-display font-bold shadow-lg border ${
              isPositive
                ? "bg-bot-green/90 text-black border-bot-green/50"
                : "bg-bot-red/90 text-white border-bot-red/50"
            }`}
          >
            {formatCurrency(currentBalance)}
          </div>
        </div>
      </div>
    </div>
  );
}
