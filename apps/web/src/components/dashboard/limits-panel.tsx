"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Gauge, Clock, RefreshCw } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { UsageData } from "./types.js";

export interface LimitWindow {
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes?: number | null;
}

export interface ProviderLimits {
  key: "claude" | "codex";
  name: string;
  /** Where the number comes from, for the footnote. */
  source: string;
  /** null = live; otherwise the instant the snapshot was taken. */
  observedAt: string | null;
  planType?: string | null;
  windows: Array<{ label: string; window: LimitWindow }>;
}

/** Label a window by its length: 300 → "5h", 10080 → "7d". */
export function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Fold every host's Codex snapshot into one (the freshest), and Claude's
 * live account usage, into a uniform list for the panel.
 */
export function collectProviderLimits(usage: UsageData | null, hosts: any[]): ProviderLimits[] {
  const out: ProviderLimits[] = [];
  if (usage?.available) {
    const windows: ProviderLimits["windows"] = [];
    if (usage.fiveHour?.utilization != null)
      windows.push({
        label: "5h",
        window: { usedPercent: usage.fiveHour.utilization, resetsAt: usage.fiveHour.resetsAt },
      });
    if (usage.sevenDay?.utilization != null)
      windows.push({
        label: "7d",
        window: { usedPercent: usage.sevenDay.utilization, resetsAt: usage.sevenDay.resetsAt },
      });
    if (windows.length > 0)
      out.push({
        key: "claude",
        name: "Claude",
        source: "account, live",
        observedAt: null,
        windows,
      });
  }
  let codex: { observedAt: string; limits: any } | null = null;
  for (const h of hosts) {
    const c = h.agentLimits?.codex;
    if (c && (!codex || c.observedAt > codex.observedAt))
      codex = { observedAt: c.observedAt, limits: c };
  }
  if (codex) {
    const windows: ProviderLimits["windows"] = [];
    const now = Date.now();
    const asWindow = (w: any, fallback: string) => {
      if (!w) return;
      // A window that has since reset reads 0 — no point showing stale use.
      const reset = w.resetsAt && new Date(w.resetsAt).getTime() < now;
      windows.push({
        label: windowLabel(w.windowMinutes, fallback),
        window: {
          usedPercent: reset ? 0 : w.usedPercent,
          resetsAt: reset ? null : w.resetsAt,
          windowMinutes: w.windowMinutes,
        },
      });
    };
    asWindow(codex.limits.primary, "5h");
    asWindow(codex.limits.secondary, "7d");
    if (windows.length > 0)
      out.push({
        key: "codex",
        name: "Codex",
        source: "from its session log on your machine",
        observedAt: codex.observedAt,
        planType: codex.limits.planType,
        windows,
      });
  }
  return out;
}

function tone(pct: number) {
  if (pct >= 95) return { bar: "bg-error", text: "text-error" };
  if (pct >= 80) return { bar: "bg-warning", text: "text-warning" };
  if (pct >= 50) return { bar: "bg-primary", text: "text-text" };
  return { bar: "bg-success", text: "text-text" };
}

function resetsIn(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (!(diff > 0)) return null;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Meter({ label, window }: { label: string; window: LimitWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  const t = tone(pct);
  const reset = resetsIn(window.resetsAt);
  return (
    <div className="min-w-[7rem] flex-1">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-medium text-text-muted">{label}</span>
        <span className={cn("text-sm font-semibold tabular-nums font-mono", t.text)}>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", t.bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1 mt-1 h-3.5">
        {reset && (
          <>
            <Clock className="w-3 h-3 text-text-muted/50" />
            <span className="text-[10px] text-text-muted/60">resets in {reset}</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "How far along am I?" for every agent subscription Optio can see, side
 * by side. Claude is live from the account; Codex is the last snapshot the
 * daemon read from its session log (it only moves when Codex runs).
 */
export function LimitsPanel({
  providers,
  onRefresh,
  onRefreshHosts,
}: {
  providers: ProviderLimits[];
  /** Re-read Claude from Anthropic (bypassing the server cache). */
  onRefresh?: () => void | Promise<void>;
  /** Re-fetch hosts so a fresh Codex snapshot from the daemon shows up. */
  onRefreshHosts?: () => void | Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  // Keep "updated 12s ago" honest while it's on screen.
  useEffect(() => {
    if (refreshedAt == null) return;
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [refreshedAt]);

  if (providers.length === 0) return null;

  const doRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    setError(null);
    const started = Date.now();
    try {
      await Promise.all([onRefresh(), onRefreshHosts?.()]);
      // Anthropic answers fast; hold the spinner ≥400 ms so the click
      // visibly did something even when the numbers don't change.
      const wait = 400 - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      setRefreshedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const updatedLabel =
    refreshedAt == null
      ? null
      : Date.now() - refreshedAt < 10_000
        ? "updated just now"
        : `updated ${formatRelativeTime(new Date(refreshedAt).toISOString())}`;

  return (
    <div className="rounded-xl border border-border/50 bg-bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-3.5 h-3.5 text-text-muted" />
          <span className="text-xs font-medium text-text-heading">Usage limits</span>
          {error ? (
            <span className="text-[10px] text-error">{error}</span>
          ) : refreshing ? (
            <span className="text-[10px] text-text-muted/70">checking with Anthropic…</span>
          ) : updatedLabel ? (
            <span className="text-[10px] text-success/80 flex items-center gap-1">
              <Check className="w-3 h-3" />
              {updatedLabel}
            </span>
          ) : null}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            className={cn(
              "flex items-center gap-1 px-2 py-1 -my-1 -mr-2 rounded-md text-[11px] transition-colors",
              refreshing
                ? "text-text bg-bg-hover/60 cursor-wait"
                : "text-text-muted hover:text-text hover:bg-bg-hover/60",
            )}
            title="Re-read Claude usage from Anthropic now"
          >
            <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
            {refreshing ? "refreshing" : "refresh"}
          </button>
        )}
      </div>
      <div
        aria-live="polite"
        className={cn(
          "grid gap-6 transition-opacity duration-200",
          providers.length > 1 ? "md:grid-cols-2" : "",
          refreshing && "opacity-50",
        )}
      >
        {providers.map((p) => (
          <div key={p.key} className="min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold">{p.name}</span>
              {p.planType && (
                <span className="text-[10px] uppercase tracking-wide text-text-muted/60">
                  {p.planType}
                </span>
              )}
              <span className="text-[10px] text-text-muted/60 ml-auto truncate">
                {p.observedAt ? `as of ${formatRelativeTime(p.observedAt)}` : p.source}
              </span>
            </div>
            <div className="flex gap-4">
              {p.windows.map((w) => (
                <Meter key={w.label} label={w.label} window={w.window} />
              ))}
            </div>
            {p.observedAt && (
              <div className="text-[10px] text-text-muted/50 mt-1">
                {p.source} — updates when Codex runs;{" "}
                <Link href="/local" className="hover:text-text underline-offset-2 hover:underline">
                  daemon must be online
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
