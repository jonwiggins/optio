"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Gauge, RefreshCw } from "lucide-react";
import { api, type GatewayKeyInfo, type GatewayUsage } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Meter } from "./limits-panel";

/** One token's row: whose it is, the gateway's spend against its budget. */
export interface GatewayLimitRow {
  key: string;
  name: string;
  hasToken: boolean;
  keyInfo: GatewayKeyInfo | null;
}

/** The rows the panel shows, in order: you, then the organization (when it has one). */
export function collectGatewayLimits(usage: GatewayUsage | null): GatewayLimitRow[] {
  if (!usage) return [];
  const rows: GatewayLimitRow[] = [
    { key: "me", name: "You", hasToken: usage.personal.hasToken, keyInfo: usage.personal.keyInfo },
  ];
  if (usage.organization.hasToken) {
    rows.push({
      key: "org",
      name: "Organization",
      hasToken: true,
      keyInfo: usage.organization.keyInfo,
    });
  }
  return rows;
}

/** "$12.40 of $100" / "$12.40 spent · no budget", and the percent for the meter (null without a budget). */
export function budgetLine(info: GatewayKeyInfo | null): { text: string; percent: number | null } {
  if (!info) return { text: "Budget unknown — the gateway doesn't report one", percent: null };
  const spend = `$${info.spend.toFixed(2)}`;
  if (info.maxBudget == null || info.maxBudget <= 0) {
    return { text: `${spend} spent · no budget`, percent: null };
  }
  return {
    text: `${spend} of $${info.maxBudget.toFixed(2)}`,
    percent: Math.min(100, (info.spend / info.maxBudget) * 100),
  };
}

/**
 * The gateway-only deployment's "Usage limits": the gateway's own budget
 * for the viewer's token (spend, max budget, reset: LiteLLM `/key/info`; a
 * gateway that reports none shows the row only) and for the organization's
 * — in place of the Claude.ai
 * subscription windows, which no run here uses (docs/model-gateway.md).
 */
export function GatewayLimitsPanel({
  load = api.getMyGatewayUsage,
}: {
  load?: () => Promise<GatewayUsage>;
}) {
  const [usage, setUsage] = useState<GatewayUsage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      setError(null);
      try {
        setUsage(await load());
        if (manual) setRefreshedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't read the gateway's budgets");
      } finally {
        setLoaded(true);
        if (manual) setRefreshing(false);
      }
    },
    [load],
  );

  useEffect(() => {
    void fetch();
  }, [fetch]);

  if (!loaded) return null;
  // No gateway at all: nothing to meter (Settings → Model gateway says so).
  if (!usage?.gateway) return null;

  const rows = collectGatewayLimits(usage);
  const noToken = !usage.personal.hasToken;
  const updatedLabel =
    refreshedAt == null
      ? null
      : Date.now() - refreshedAt < 10_000
        ? "updated just now"
        : `updated ${formatRelativeTime(new Date(refreshedAt).toISOString())}`;

  return (
    <div className="rounded-xl border border-border/50 bg-bg-card p-4" data-testid="gateway-limits">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Gauge className="w-3.5 h-3.5 text-text-muted" />
          <span className="text-xs font-medium text-text-heading">Usage limits</span>
          <span className="text-[10px] text-text-muted/60 truncate">{usage.gateway.name}</span>
          {error ? (
            <span className="text-[10px] text-error">{error}</span>
          ) : refreshing ? (
            <span className="text-[10px] text-text-muted/70">asking the gateway…</span>
          ) : updatedLabel ? (
            <span className="text-[10px] text-success/80 flex items-center gap-1">
              <Check className="w-3 h-3" />
              {updatedLabel}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => fetch(true)}
          disabled={refreshing}
          aria-busy={refreshing}
          className={cn(
            "flex items-center gap-1 px-2 py-1 -my-1 -mr-2 rounded-md text-[11px] transition-colors",
            refreshing
              ? "text-text bg-bg-hover/60 cursor-wait"
              : "text-text-muted hover:text-text hover:bg-bg-hover/60",
          )}
          title="Re-read the budgets from the gateway now"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          {refreshing ? "refreshing" : "refresh"}
        </button>
      </div>

      {noToken && (
        <p className="text-xs text-text-muted mb-3" data-testid="gateway-no-token">
          No token yet — add one under{" "}
          <Link href="/settings#my-tokens" className="text-primary hover:underline">
            Settings → My tokens
          </Link>
          .
        </p>
      )}

      <div
        aria-live="polite"
        className={cn(
          "grid gap-6 transition-opacity duration-200",
          rows.length > 1 ? "md:grid-cols-2" : "",
          refreshing && "opacity-50",
        )}
      >
        {rows
          .filter((r) => r.hasToken)
          .map((r) => {
            const { text, percent } = budgetLine(r.keyInfo);
            return (
              <div key={r.key} className="min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold">{r.name}</span>
                  <span className="text-[10px] text-text-muted/60 ml-auto truncate">{text}</span>
                </div>
                {percent != null ? (
                  <Meter
                    label="budget"
                    window={{ usedPercent: percent, resetsAt: r.keyInfo?.budgetResetAt ?? null }}
                  />
                ) : (
                  <div className="h-1.5 rounded-full bg-border/30" />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
