"use client";

import { useEffect, useState } from "react";
import { Coins, Gauge, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  formatTokens,
  formatUsd,
  type AgentLimitWindow,
  type LocalHostAgentLimits,
  type LocalTerminalUsage,
} from "@optio/shared";
import { windowLabel } from "@/components/dashboard/limits-panel";
import { HoverCard, HoverRow } from "./hover-card";

/**
 * Header chips:
 *  - AccountUsagePill: the Claude subscription's 5-hour / 7-day limit
 *    utilization (account-wide — the number that decides whether you can
 *    start another session). Polled; the server caches the upstream call.
 *  - CodexLimitsPill: the same for Codex, from the snapshot the machine's
 *    daemon read out of Codex's session log (it moves after each turn).
 *    SessionLimitsPills picks which of the two a session shows.
 *  - SessionUsageChip: this terminal's own tokens + estimated spend, summed
 *    by the daemon from the agent's transcript.
 */

type Bucket = { utilization: number | null; resetsAt: string | null };
interface AccountUsage {
  available: boolean;
  fiveHour?: Bucket;
  sevenDay?: Bucket;
  /** Per-model 7-day limits (Fable, …): separate caps from the account-wide 7-day. */
  sevenDayModels?: Array<Bucket & { model: string }>;
  error?: string;
  /** Last good numbers, served because the latest upstream read failed. */
  stale?: boolean;
  asOf?: string;
}

const POLL_MS = 60_000;

let cached: AccountUsage | null = null;
const listeners = new Set<(u: AccountUsage | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let lastFreshAt = 0;
/** Manual refreshes bypass the server cache — and hit Anthropic — so pace them. */
const FRESH_MIN_GAP_MS = 15_000;

async function fetchUsage(fresh = false): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await api.getUsage(fresh ? { fresh: true } : undefined);
      cached = res.usage as AccountUsage;
    } catch {
      cached = { available: false, error: "unreachable" };
    } finally {
      inFlight = null;
    }
    for (const l of listeners) l(cached);
  })();
  return inFlight;
}

/** Force a re-read from Anthropic (rate-paced). Returns false when paced out. */
export async function refreshAccountUsage(): Promise<boolean> {
  const now = Date.now();
  if (now - lastFreshAt < FRESH_MIN_GAP_MS) return false;
  lastFreshAt = now;
  await fetchUsage(true);
  return true;
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

/** Coarse "how old are these numbers" for the stale note. */
export function staleAge(asOf: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(asOf)) / 60_000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
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

/**
 * The limits worth a header slot, labelled: 5h, 7d, then one "7d <Model>"
 * per model-scoped weekly cap (Fable) — those are the ones that lock a
 * model while the account-wide numbers still look fine.
 */
export function accountBuckets(usage: AccountUsage): Array<[string, Bucket]> {
  const buckets: Array<[string, Bucket]> = [];
  if (usage.fiveHour?.utilization != null) buckets.push(["5h", usage.fiveHour]);
  if (usage.sevenDay?.utilization != null) buckets.push(["7d", usage.sevenDay]);
  for (const m of usage.sevenDayModels ?? []) {
    if (m.utilization != null) buckets.push([`7d ${m.model}`, m]);
  }
  return buckets;
}

/**
 * Why the account pill has nothing to show, or null when it should simply
 * not exist: an API-key / Vertex deployment has no subscription limits to
 * read, but a failed read (expired token, upstream 429, API unreachable)
 * must stay on screen so the pill can't silently vanish.
 */
export function usageUnavailableReason(usage: AccountUsage): string | null {
  if (usage.available && accountBuckets(usage).length > 0) return null;
  const err = usage.error ?? "";
  if (/no (claude subscription|oauth token)/i.test(err)) return null;
  if (usage.available) return "no usage limits reported";
  return err || "usage unavailable";
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

/**
 * `collapsible` (inside an `@container`): below @2xl the pill is just the
 * gauge icon plus the worse of the two percentages; hover for the rest.
 */
export function AccountUsagePill({
  className,
  collapsible,
}: {
  className?: string;
  collapsible?: boolean;
}) {
  const usage = useAccountUsage();
  const [refreshing, setRefreshing] = useState(false);
  if (!usage) return null;
  const buckets = accountBuckets(usage);
  const ready = usage.available && buckets.length > 0;
  const unavailable = ready ? null : usageUnavailableReason(usage);
  // Nothing to read on this deployment (API key / Vertex): no pill at all.
  if (!ready && unavailable === null) return null;
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const ok = await refreshAccountUsage();
      if (!ok) toast.message("Usage was refreshed a moment ago — try again in a few seconds");
    } finally {
      setRefreshing(false);
    }
  };
  const refreshButton = (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      title="Re-read from Anthropic now"
      aria-label="Refresh usage"
      className="inline-flex items-center gap-1 -mr-1 px-1.5 py-0.5 rounded text-[10px] text-text-muted hover:text-text hover:bg-bg-hover/70 disabled:opacity-50 transition-colors"
    >
      <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
      refresh
    </button>
  );
  if (unavailable !== null) {
    return (
      <HoverCard
        content={
          <>
            <span className="flex items-center justify-between gap-4 mb-1">
              <span className="font-medium text-text">Claude usage limits</span>
              {refreshButton}
            </span>
            <span className="block text-[10px] text-warning/90">
              Couldn&apos;t read usage — {unavailable}; retrying automatically
            </span>
          </>
        }
        className={className}
        interactive
      >
        <span
          title={`Claude usage unavailable — ${unavailable}`}
          data-usage-provider="claude"
          data-usage-state="unavailable"
          className="inline-flex items-center gap-1.5 h-6 px-1.5 @2xl:px-2 rounded-md border border-dashed border-border/70 bg-bg-card/60 text-[11px] font-mono text-text-muted/70 shrink-0"
        >
          <Gauge className="w-3 h-3 shrink-0" />
          <span>—</span>
        </span>
      </HoverCard>
    );
  }
  const worst = Math.max(...buckets.map(([, b]) => b.utilization ?? 0));
  const card = (
    <>
      <span className="flex items-center justify-between gap-4 mb-1">
        <span className="font-medium text-text">Claude usage limits</span>
        {refreshButton}
      </span>
      {buckets.map(([l, b]) => {
        const pct = Math.round(b.utilization ?? 0);
        const r = resetsIn(b.resetsAt);
        return (
          <span key={l} className="block">
            <HoverRow
              label={
                l === "5h"
                  ? "5-hour window"
                  : l === "7d"
                    ? "7-day window"
                    : `7-day ${l.slice(3)} window`
              }
              value={<span className={pctTone(pct)}>{pct}%</span>}
            />
            {r && (
              <span className="block text-[10px] text-text-muted/70 -mt-0.5">resets in {r}</span>
            )}
          </span>
        );
      })}
      {usage.stale ? (
        <span className="block mt-1 text-[10px] text-warning/90">
          Last known values{usage.asOf ? ` from ${staleAge(usage.asOf)} ago` : ""} — the latest read
          failed ({usage.error ?? "unavailable"}); retrying automatically
        </span>
      ) : (
        <span className="block mt-1 text-[10px] text-text-muted/70">
          Account-wide, refreshed every few minutes
        </span>
      )}
    </>
  );
  return (
    <HoverCard content={card} className={className} interactive>
      <span
        title={usage.stale ? "Showing last known usage — the latest read failed" : undefined}
        data-usage-provider="claude"
        className={cn(
          "inline-flex items-center gap-1.5 @2xl:gap-2 h-6 px-1.5 @2xl:px-2 rounded-md border text-[11px] font-mono shrink-0",
          usage.stale && "opacity-60 border-dashed",
          worst >= 95
            ? "border-error/40 bg-error/10"
            : worst >= 80
              ? "border-warning/40 bg-warning/10"
              : "border-border/70 bg-bg-card/60",
        )}
      >
        <Gauge className={cn("w-3 h-3 shrink-0", pctTone(worst))} />
        {collapsible && (
          <span className={cn("@2xl:hidden tabular-nums font-medium", pctTone(worst))}>
            {Math.round(worst)}%
          </span>
        )}
        <span
          className={cn("inline-flex items-center gap-2", collapsible && "hidden @2xl:inline-flex")}
        >
          {buckets.map(([l, b]) => (
            <Meter key={l} label={l} bucket={b} />
          ))}
        </span>
      </span>
    </HoverCard>
  );
}

type CodexLimits = NonNullable<LocalHostAgentLimits["codex"]>;

/**
 * Codex's windows as the pill shows them, labelled by length ("5h", "7d"). A
 * window that has reset since the snapshot reads 0%: the log only moves
 * when Codex runs.
 */
export function codexBuckets(limits: CodexLimits, now = Date.now()): Array<[string, Bucket]> {
  const out: Array<[string, Bucket]> = [];
  const add = (w: AgentLimitWindow | null, fallback: string) => {
    if (!w) return;
    const reset = !!w.resetsAt && Date.parse(w.resetsAt) <= now;
    out.push([
      windowLabel(w.windowMinutes, fallback),
      { utilization: reset ? 0 : w.usedPercent, resetsAt: reset ? null : w.resetsAt },
    ]);
  };
  add(limits.primary, "5h");
  add(limits.secondary, "7d");
  return out;
}

/** Codex ran on the machine inside its current short window, so its limits are live. */
export function codexRecentlyUsed(limits: CodexLimits, now = Date.now()): boolean {
  const minutes = limits.primary?.windowMinutes ?? 300;
  return now - Date.parse(limits.observedAt) < minutes * 60_000;
}

function windowName(label: string): string {
  const unit = label.at(-1);
  const n = label.slice(0, -1);
  if (unit === "h") return `${n}-hour window`;
  if (unit === "d") return `${n}-day window`;
  return `${label} window`;
}

/**
 * Codex's plan limits for the machine a session runs on. `collapsible` (in
 * an `@container`): below @2xl just the gauge and the worse percentage.
 */
export function CodexLimitsPill({
  limits,
  hostName,
  className,
  collapsible,
}: {
  limits: CodexLimits;
  hostName?: string;
  className?: string;
  collapsible?: boolean;
}) {
  const buckets = codexBuckets(limits);
  if (buckets.length === 0) return null;
  const worst = Math.max(...buckets.map(([, b]) => b.utilization ?? 0));
  const plan = limits.planType
    ? limits.planType.charAt(0).toUpperCase() + limits.planType.slice(1)
    : null;
  const card = (
    <>
      <span className="block font-medium text-text mb-1">Codex usage limits</span>
      {buckets.map(([l, b]) => {
        const pct = Math.round(b.utilization ?? 0);
        const r = resetsIn(b.resetsAt);
        return (
          <span key={l} className="block">
            <HoverRow label={windowName(l)} value={<span className={pctTone(pct)}>{pct}%</span>} />
            {r && (
              <span className="block text-[10px] text-text-muted/70 -mt-0.5">resets in {r}</span>
            )}
          </span>
        );
      })}
      <span className="block mt-1 text-[10px] text-text-muted/70">
        {plan ? `${plan} plan · ` : ""}as of {staleAge(limits.observedAt)} ago — Codex logs these
        after each turn{hostName ? ` on ${hostName}` : ""}
      </span>
    </>
  );
  return (
    <HoverCard content={card} className={className}>
      <span
        data-usage-provider="codex"
        className={cn(
          "inline-flex items-center gap-1.5 @2xl:gap-2 h-6 px-1.5 @2xl:px-2 rounded-md border text-[11px] font-mono shrink-0",
          worst >= 95
            ? "border-error/40 bg-error/10"
            : worst >= 80
              ? "border-warning/40 bg-warning/10"
              : "border-border/70 bg-bg-card/60",
        )}
      >
        <Gauge className={cn("w-3 h-3 shrink-0", pctTone(worst))} />
        <span className="font-sans text-text-muted/80">Codex</span>
        {collapsible && (
          <span className={cn("@2xl:hidden tabular-nums font-medium", pctTone(worst))}>
            {Math.round(worst)}%
          </span>
        )}
        <span
          className={cn("inline-flex items-center gap-2", collapsible && "hidden @2xl:inline-flex")}
        >
          {buckets.map(([l, b]) => (
            <Meter key={l} label={l} bucket={b} />
          ))}
        </span>
      </span>
    </HoverCard>
  );
}

/**
 * The limits a session header shows: Codex's in a Codex session; Claude's
 * everywhere else, plus Codex's in a plain terminal on a machine where Codex
 * ran inside its current window (the numbers are live, so it may be running
 * there now).
 */
export function SessionLimitsPills({
  terminal,
  host,
  className,
  collapsible,
}: {
  terminal: { spec?: { kind?: string; agent?: string } | null } | null | undefined;
  host: { name?: string; agentLimits?: LocalHostAgentLimits | null } | null | undefined;
  className?: string;
  collapsible?: boolean;
}) {
  const agent = terminal?.spec?.kind === "agent" ? terminal.spec.agent : null;
  const codex = host?.agentLimits?.codex ?? null;
  const showCodex = !!codex && (agent === "codex" || (agent == null && codexRecentlyUsed(codex)));
  return (
    <>
      {agent !== "codex" && <AccountUsagePill collapsible={collapsible} className={className} />}
      {showCodex && (
        <CodexLimitsPill
          limits={codex}
          hostName={host?.name}
          collapsible={collapsible}
          className={className}
        />
      )}
    </>
  );
}

/** `collapsible`: below @xl only the coin icon shows (numbers on hover). */
export function SessionUsageChip({
  usage,
  className,
  collapsible,
}: {
  usage: LocalTerminalUsage | null | undefined;
  className?: string;
  collapsible?: boolean;
}) {
  if (!usage || usage.turns === 0) return null;
  const tokens =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const card = (
    <>
      <span className="block font-medium text-text mb-1">
        This session · {usage.turns} turn{usage.turns === 1 ? "" : "s"}
      </span>
      <HoverRow label="Input" value={formatTokens(usage.inputTokens)} />
      <HoverRow label="Output" value={formatTokens(usage.outputTokens)} />
      <HoverRow label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
      <HoverRow label="Cache write" value={formatTokens(usage.cacheWriteTokens)} />
      <span className="block border-t border-border/60 mt-1.5 pt-1.5">
        <HoverRow
          label="Est. cost"
          value={usage.costUsd != null ? formatUsd(usage.costUsd) : "unknown model"}
        />
      </span>
      {usage.model && (
        <span className="block mt-1 text-[10px] text-text-muted/70">
          {usage.model} · list price
        </span>
      )}
    </>
  );
  return (
    <HoverCard content={card} className={className}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 h-6 px-1.5 @xl:px-2 rounded-md border border-border/70 bg-bg-card/60 text-[11px] font-mono text-text-muted shrink-0",
        )}
      >
        <Coins className="w-3 h-3 shrink-0 text-text-muted/70" />
        <span className={cn("tabular-nums", collapsible && "hidden @xl:inline")}>
          {formatTokens(tokens)}
        </span>
        {usage.costUsd != null && (
          <span className={cn("tabular-nums text-text", collapsible && "hidden @xl:inline")}>
            {formatUsd(usage.costUsd)}
          </span>
        )}
      </span>
    </HoverCard>
  );
}
