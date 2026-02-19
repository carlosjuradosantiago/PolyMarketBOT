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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activities]);

  return (
    <div className="glass-card rounded-xl h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-bot-border/40 flex-shrink-0 flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full bg-bot-cyan/60" />
        <span className="text-[10px] font-display font-bold tracking-[0.2em] text-bot-muted/70 uppercase">
          {t("activity.title")}
        </span>
        <span className="ml-auto text-[9px] font-mono text-bot-muted/30">{activities.length}</span>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed min-h-0 custom-scrollbar"
      >
        {activities.length === 0 ? (
          <div className="text-bot-muted/50 text-center py-8 font-display text-xs">
            {t("activity.waiting")}
          </div>
        ) : (
          activities.map((entry, idx) => (
            <div
              key={idx}
              className={`log-entry group flex gap-1.5 py-[3px] hover:bg-white/[0.015] rounded px-1.5 ${getActivityColor(
                entry.entry_type
              )}`}
            >
              {/* Type indicator dot */}
              <span className={`mt-[5px] flex-shrink-0 w-1 h-1 rounded-full ${getActivityDotColor(entry.entry_type)}`} />
              <span className="text-bot-muted/40 flex-shrink-0 w-[68px] text-[10px]">
                {entry.timestamp}
              </span>
              <span className="truncate text-[11px]">
                {renderMessage(entry)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function getActivityDotColor(type: string): string {
  switch (type) {
    case "Edge": return "bg-bot-yellow";
    case "Order": return "bg-bot-blue";
    case "Resolved": return "bg-bot-green";
    case "Warning": return "bg-bot-red/70";
    case "Error": return "bg-bot-red";
    case "Inference": return "bg-bot-purple";
    default: return "bg-bot-muted/30";
  }
}

function renderMessage(entry: ActivityEntry) {
  const { message, entry_type } = entry;

  switch (entry_type) {
    case "Edge":
      return (
        <span>
          <span className="text-bot-yellow font-semibold">Edge: </span>
          <span className="text-bot-yellow/60">{message.replace("Edge: ", "")}</span>
        </span>
      );
    case "Order":
      return (
        <span>
          <span className="text-bot-blue font-semibold">ORDER </span>
          <span className="text-bot-blue/60">{message.replace("ORDER ", "")}</span>
        </span>
      );
    case "Resolved":
      return (
        <span className="text-bot-green font-semibold">{message}</span>
      );
    case "Warning":
      return (
        <span className="text-bot-red/80">{message}</span>
      );
    case "Error":
      return (
        <span className="text-bot-red font-bold">{message}</span>
      );
    case "Inference":
      return (
        <span className="text-bot-purple/80">{message}</span>
      );
    default:
      return <span className="text-bot-muted/60">{message}</span>;
  }
}
