export function formatCurrency(value: number, decimals: number = 2): string {
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(2)}K`;
  }
  return `$${value.toFixed(decimals)}`;
}

export function formatPnl(value: number): string {
  const prefix = value >= 0 ? "+" : "";
  if (Math.abs(value) >= 1000) {
    return `${prefix}$${(value / 1000).toFixed(2)}K`;
  }
  return `${prefix}$${value.toFixed(2)}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatNumber(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toFixed(0);
}

export function getActivityColor(type: string): string {
  switch (type) {
    case "Edge":
      return "text-yellow-400";
    case "Order":
      return "text-blue-400";
    case "Resolved":
      return "text-green-400";
    case "Warning":
      return "text-red-400";
    case "Error":
      return "text-red-500";
    case "Inference":
      return "text-purple-400";
    default:
      return "text-gray-400";
  }
}
