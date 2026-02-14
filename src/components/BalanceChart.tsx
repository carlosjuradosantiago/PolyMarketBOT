import { useMemo, useRef, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { BalancePoint } from "../types";
import { formatCurrency } from "../utils/format";

interface BalanceChartProps {
  history: BalancePoint[];
}

export default function BalanceChart({ history }: BalanceChartProps) {
  const chartData = useMemo(() => {
    return history.map((point, i) => ({
      ...point,
      index: i,
    }));
  }, [history]);

  const currentBalance = history[history.length - 1]?.balance ?? 0;

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-bot-card border border-bot-border rounded px-3 py-2 shadow-lg">
          <p className="text-white font-semibold">
            {formatCurrency(payload[0].value)}
          </p>
          <p className="text-bot-muted text-xs">{payload[0].payload.label}</p>
        </div>
      );
    }
    return null;
  };

  // Dynamic domain for Y axis
  const yDomain = useMemo(() => {
    if (history.length === 0) return [0, 100];
    const values = history.map((h) => h.balance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.1 || 10;
    return [Math.max(0, min - padding), max + padding];
  }, [history]);

  return (
    <div className="bg-bot-card border border-bot-border rounded-lg h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-bot-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-wider text-bot-muted uppercase">
            Balance History
          </span>
          <span className="text-[10px] text-bot-muted">(LOG SCALE)</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-bot-muted">48.0H / 48H</span>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 px-2 py-2 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 40, left: 10, bottom: 0 }}>
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00ff88" stopOpacity={0.3} />
                <stop offset="50%" stopColor="#00ff88" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#1e1e2e"
              horizontal={true}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "#666680", fontSize: 10 }}
              axisLine={{ stroke: "#1e1e2e" }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={yDomain}
              tick={{ fill: "#666680", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(val) => formatCurrency(val, 0)}
              width={60}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="#00ff88"
              strokeWidth={2}
              fill="url(#balanceGradient)"
              animationDuration={300}
              dot={false}
              activeDot={{
                r: 4,
                stroke: "#00ff88",
                strokeWidth: 2,
                fill: "#0a0a0f",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Current balance label */}
      <div className="absolute top-12 right-12 pointer-events-none">
        <span className="text-bot-green font-bold text-sm">
          {formatCurrency(currentBalance)}
        </span>
      </div>
    </div>
  );
}
