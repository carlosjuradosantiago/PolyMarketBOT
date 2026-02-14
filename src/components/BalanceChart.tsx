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
      <div className="bg-[#0d0d12] border border-gray-700/60 rounded-lg px-4 py-3 shadow-2xl backdrop-blur-sm">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-white font-bold text-lg font-mono">
            {formatCurrency(val)}
          </span>
          <span className={`text-xs font-semibold ${up ? "text-green-400" : "text-red-400"}`}>
            {up ? "+" : ""}{formatCurrency(diff)} ({up ? "+" : ""}{diffPct.toFixed(2)}%)
          </span>
        </div>
        <div className="text-[10px] text-gray-500 font-mono">
          {data.label}
          {data.timestamp && (
            <span className="ml-2 text-gray-600">{data.timestamp}</span>
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
    <div className="bg-[#0a0a0f] border border-gray-800/60 rounded-xl h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800/40">
        <div className="flex items-center gap-4">
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-0.5">
              {t("chart.equity")}
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold text-white font-mono tracking-tight">
                {formatCurrency(currentBalance)}
              </span>
              <span className={`text-sm font-semibold font-mono ${isPositive ? "text-green-400" : "text-red-400"}`}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                <span className="text-xs ml-1 opacity-70">
                  ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                </span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Initial balance reference */}
          <div className="text-right">
            <div className="text-[9px] text-gray-600 uppercase">{t("chart.initial")}</div>
            <div className="text-xs text-gray-400 font-mono">{formatCurrency(initialBalance)}</div>
          </div>
          {/* Timeframe badges */}
          <div className="flex gap-1">
            {["1D", "1W", "1M", "ALL"].map((tf, i) => (
              <span
                key={tf}
                className={`px-2 py-0.5 text-[9px] font-bold rounded cursor-default ${
                  i === 3 ? "bg-white/10 text-white" : "text-gray-600 hover:text-gray-400"
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
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                <stop offset="40%" stopColor="#22c55e" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="equityGradientRed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={0.25} />
                <stop offset="40%" stopColor="#ef4444" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="4 4"
              stroke="#1a1a2e"
              horizontal={true}
              vertical={true}
              opacity={0.5}
            />
            {/* Initial balance reference line */}
            <ReferenceLine
              y={initialBalance}
              stroke="#666"
              strokeDasharray="8 4"
              strokeOpacity={0.4}
              label={{
                value: formatCurrency(initialBalance, 0),
                position: "right",
                fill: "#555",
                fontSize: 9,
              }}
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "#4a4a6a", fontSize: 10, fontFamily: "monospace" }}
              axisLine={{ stroke: "#1a1a2e" }}
              tickLine={false}
              interval="preserveStartEnd"
              dy={4}
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: "#4a4a6a", fontSize: 10, fontFamily: "monospace" }}
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
              stroke={accentColor}
              strokeWidth={2.5}
              fill={isPositive ? "url(#equityGradientGreen)" : "url(#equityGradientRed)"}
              animationDuration={400}
              dot={false}
              activeDot={{
                r: 5,
                stroke: accentColor,
                strokeWidth: 2.5,
                fill: "#0a0a0f",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>

        {/* Current price tag on right edge */}
        <div
          className="absolute right-3 pointer-events-none flex items-center gap-1"
          style={{ top: "16px" }}
        >
          <div
            className={`px-2 py-1 rounded text-xs font-bold font-mono shadow-lg ${
              isPositive
                ? "bg-green-500 text-black"
                : "bg-red-500 text-white"
            }`}
          >
            {formatCurrency(currentBalance)}
          </div>
        </div>
      </div>
    </div>
  );
}
