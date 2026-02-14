import { useEffect, useRef } from "react";
import { ActivityEntry } from "../types";
import { getActivityColor } from "../utils/format";
import { useTranslation } from "../i18n";

interface ActivityLogProps {
  activities: ActivityEntry[];
}

export default function ActivityLog({ activities }: ActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activities]);

  return (
    <div className="bg-bot-card border border-bot-border rounded-lg h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-2 border-b border-bot-border flex-shrink-0">
        <span className="text-xs font-semibold tracking-wider text-bot-muted uppercase">
          {t("activity.title")}
        </span>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed min-h-0"
      >
        {activities.length === 0 ? (
          <div className="text-bot-muted text-center py-8">
            {t("activity.waiting")}
          </div>
        ) : (
          activities.map((entry, idx) => (
            <div
              key={idx}
              className={`log-entry flex gap-2 py-0.5 hover:bg-white/[0.02] rounded px-1 ${getActivityColor(
                entry.entry_type
              )}`}
            >
              <span className="text-bot-muted flex-shrink-0 w-[76px]">
                {entry.timestamp}
              </span>
              <span className="truncate">
                {renderMessage(entry)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function renderMessage(entry: ActivityEntry) {
  const { message, entry_type } = entry;

  switch (entry_type) {
    case "Edge":
      return (
        <span>
          <span className="text-yellow-400">Edge: </span>
          <span className="text-yellow-300/80">{message.replace("Edge: ", "")}</span>
        </span>
      );
    case "Order":
      return (
        <span>
          <span className="text-blue-400">ORDER </span>
          <span className="text-blue-300/80">{message.replace("ORDER ", "")}</span>
        </span>
      );
    case "Resolved":
      return (
        <span className="text-green-400 font-semibold">{message}</span>
      );
    case "Warning":
      return (
        <span className="text-red-400 font-semibold">{message}</span>
      );
    case "Error":
      return (
        <span className="text-red-500 font-bold">{message}</span>
      );
    case "Inference":
      return (
        <span className="text-purple-400">{message}</span>
      );
    default:
      return <span className="text-gray-400">{message}</span>;
  }
}
