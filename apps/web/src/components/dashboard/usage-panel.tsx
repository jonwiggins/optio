import { cn } from "@/lib/utils";
import { Gauge, Clock, Moon } from "lucide-react";
import { getOffPeakInfo } from "@optio/shared";
import type { UsageData } from "./types.js";

function UsageMeter({
  label,
  utilization,
  resetsAt,
  sublabel,
}: {
  label: string;
  utilization: number;
  resetsAt: string | null;
  sublabel?: string;
}) {
  const pct = Math.min(utilization, 100);
  const color = pct >= 80 ? "bg-error" : pct >= 50 ? "bg-warning" : "bg-primary";
  const textColor = pct >= 80 ? "text-error" : pct >= 50 ? "text-warning" : "text-primary";

  let resetLabel: string | null = null;
  if (resetsAt) {
    const diff = new Date(resetsAt).getTime() - Date.now();
    if (diff > 0) {
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      resetLabel = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-medium text-text-muted">{label}</span>
        <span className={cn("text-sm font-medium tabular-nums", textColor)}>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {sublabel && (
        <div className="mt-1">
          <span className="text-xs text-text-muted/50">{sublabel}</span>
        </div>
      )}
      {resetLabel && (
        <div className="flex items-center gap-1 mt-1">
          <Clock className="w-3 h-3 text-text-muted/50" />
          <span className="text-xs text-text-muted/50">resets in {resetLabel}</span>
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ usage }: { usage: UsageData | null }) {
  if (!usage?.available) return null;

  return (
    <div className="rounded-xl border border-border/50 bg-bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="w-3.5 h-3.5 text-text-muted" />
        <span className="text-xs font-medium text-text-heading">Claude Max Usage</span>
        {(() => {
          const info = getOffPeakInfo();
          if (!info.promoActive) return null;
          if (info.isOffPeak) {
            return (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-success/10 text-success font-medium">
                <Moon className="w-3 h-3" />
                2x limits — off-peak
              </span>
            );
          }
          return (
            <span className="text-[10px] text-text-muted/60">2x limits resume at 2:00 PM ET</span>
          );
        })()}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {usage.fiveHour && usage.fiveHour.utilization != null && (
          <UsageMeter
            label="5-hour"
            utilization={usage.fiveHour.utilization}
            resetsAt={usage.fiveHour.resetsAt}
          />
        )}
        {usage.sevenDay && usage.sevenDay.utilization != null && (
          <UsageMeter
            label="7-day"
            utilization={usage.sevenDay.utilization}
            resetsAt={usage.sevenDay.resetsAt}
          />
        )}
        {usage.sevenDaySonnet && usage.sevenDaySonnet.utilization != null && (
          <UsageMeter
            label="7d Sonnet"
            utilization={usage.sevenDaySonnet.utilization}
            resetsAt={usage.sevenDaySonnet.resetsAt}
          />
        )}
        {usage.sevenDayOpus && usage.sevenDayOpus.utilization != null && (
          <UsageMeter
            label="7d Opus"
            utilization={usage.sevenDayOpus.utilization}
            resetsAt={usage.sevenDayOpus.resetsAt}
          />
        )}
        {usage.extraUsage?.isEnabled && usage.extraUsage.usedCredits != null && (
          <UsageMeter
            label="Extra Credits"
            utilization={usage.extraUsage.utilization ?? 0}
            resetsAt={null}
            sublabel={
              usage.extraUsage.monthlyLimit != null
                ? `$${(usage.extraUsage.usedCredits / 100).toFixed(2)} / $${(usage.extraUsage.monthlyLimit / 100).toFixed(2)} spent`
                : `$${(usage.extraUsage.usedCredits / 100).toFixed(2)} spent`
            }
          />
        )}
      </div>
    </div>
  );
}
