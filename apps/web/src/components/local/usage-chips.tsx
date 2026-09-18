"use client";

import { useEffect, useState } from "react";
import { Coins, Gauge } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatTokens, formatUsd, type LocalTerminalUsage } from "@optio/shared";

/**
 * Two header chips:
 *  - AccountUsagePill: the Claude subscription's 5-hour / 7-day limit
 *    utilization (account-wide — the number that decides whether you can
 *    start another session). Polled; the server caches the upstream call.
 *  - SessionUsageChip: this terminal's own tokens + estimated spend, summed
 *    by the daemon from the agent's transcript.
 */

type Bucket = { utilization: number | null; resetsAt: string | null };
interface AccountUsage {
  available: boolean;
  fiveHour?: Bucket;
  sevenDay?: Bucket;
  error?: string;
}

const POLL_MS = 60_000;

let cached: AccountUsage | null = null;
const listeners = new Set<(u: AccountUsage | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function fetchUsage() {
  try {
    const res = await api.getUsage();
    cached = res.usage as AccountUsage;
  } catch {
    cached = { available: false, error: "unreachable" };
  }
  for (const l of listeners) l(cached);
}

/** One poller shared by every chip on screen. */
function useAccountUsage(): AccountUsage | null {
  const [usage, setUsage] = useState<AccountUsage | null>(cached);
  useEffect(() => {
    listeners.add(setUsage);
    if (listeners.size === 1) {
      fetchUsage();
      timer = setInterval(() => {
        if (document.visibilityState === "visible") fetchUsage();
      }, POLL_MS);
    }
    return () => {
      listeners.delete(setUsage);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return usage;
}

export function pctTone(pct: number): string {
  if (pct >= 95) return "text-error";
  if (pct >= 80) return "text-warning";
  return "text-text-muted";
}

export function resetsIn(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const diff = new Date(resetsAt).getTime() - now;
  if (!(diff > 0)) return null;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Meter({ label, bucket }: { label: string; bucket: Bucket }) {
  const pct = Math.max(0, Math.min(100, Math.round(bucket.utilization ?? 0)));
  return (
    <span className="inline-flex items-center gap-1" title={`${label} window`}>
      <span className="text-text-muted/70">{label}</span>
      <span className={cn("tabular-nums font-medium", pctTone(pct))}>{pct}%</span>
    </span>
  );
}

export function AccountUsagePill({ className }: { className?: string }) {
  const usage = useAccountUsage();
  if (!usage || !usage.available) return null;
  const buckets: Array<[string, Bucket]> = [];
  if (usage.fiveHour?.utilization != null) buckets.push(["5h", usage.fiveHour]);
  if (usage.sevenDay?.utilization != null) buckets.push(["7d", usage.sevenDay]);
  if (buckets.length === 0) return null;
  const worst = Math.max(...buckets.map(([, b]) => b.utilization ?? 0));
  const tip = buckets
    .map(([l, b]) => {
      const r = resetsIn(b.resetsAt);
      return `${l === "5h" ? "5-hour" : "7-day"} window: ${Math.round(b.utilization ?? 0)}% used${r ? `, resets in ${r}` : ""}`;
    })
    .join("\n");
  return (
    <span
      title={`Claude usage limits (account-wide)\n${tip}`}
      className={cn(
        "inline-flex items-center gap-2 h-6 px-2 rounded-md border text-[11px] font-mono",
        worst >= 95
          ? "border-error/40 bg-error/10"
          : worst >= 80
            ? "border-warning/40 bg-warning/10"
            : "border-border/70 bg-bg-card/60",
        className,
      )}
    >
      <Gauge className={cn("w-3 h-3 shrink-0", pctTone(worst))} />
      {buckets.map(([l, b]) => (
        <Meter key={l} label={l} bucket={b} />
      ))}
    </span>
  );
}

export function SessionUsageChip({
  usage,
  className,
}: {
  usage: LocalTerminalUsage | null | undefined;
  className?: string;
}) {
  if (!usage || usage.turns === 0) return null;
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const tip = [
    `This session (${usage.turns} turn${usage.turns === 1 ? "" : "s"}${usage.model ? `, ${usage.model}` : ""})`,
    `input ${formatTokens(usage.inputTokens)} · output ${formatTokens(usage.outputTokens)}`,
    `cache read ${formatTokens(usage.cacheReadTokens)} · cache write ${formatTokens(usage.cacheWriteTokens)}`,
    usage.costUsd != null
      ? `≈ ${formatUsd(usage.costUsd)} at list price`
      : "cost unknown for this model",
  ].join("\n");
  return (
    <span
      title={tip}
      className={cn(
        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-border/70 bg-bg-card/60 text-[11px] font-mono text-text-muted",
        className,
      )}
    >
      <Coins className="w-3 h-3 shrink-0 text-text-muted/70" />
      <span className="tabular-nums">{formatTokens(tokens)}</span>
      {usage.costUsd != null && (
        <span className="tabular-nums text-text">{formatUsd(usage.costUsd)}</span>
      )}
    </span>
  );
}
