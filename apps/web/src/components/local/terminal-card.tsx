"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Bot,
  Layers,
  Loader2,
  Play,
  Server,
  Ticket,
  Trash2,
  User,
  Webhook,
  XCircle,
} from "lucide-react";

/** Last two path segments of an absolute dir — enough to recognize a checkout. */
export function dirTail(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}

const STATE_STYLES: Record<string, { label: string; className: string; pulse?: boolean }> = {
  pending: { label: "Pending", className: "text-warning bg-warning/10" },
  launching: { label: "Launching", className: "text-info bg-info/10", pulse: true },
  running: { label: "Running", className: "text-primary bg-primary/10", pulse: true },
  exited: { label: "Exited", className: "text-text-muted bg-bg" },
  error: { label: "Error", className: "text-error bg-error/10" },
};

export function LocalStateBadge({ terminal }: { terminal: any }) {
  const style = STATE_STYLES[terminal.state] ?? STATE_STYLES.pending;
  const label =
    terminal.state === "pending" && terminal.pendingReason === "host_offline"
      ? "Host offline"
      : terminal.state === "pending" && terminal.pendingReason === "hold"
        ? "Held"
        : style.label;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium tracking-wide uppercase",
        style.className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full bg-current", style.pulse && "animate-pulse")} />
      {label}
    </span>
  );
}

const SPAWN_SOURCE: Record<string, { label: string; icon: any }> = {
  manual: { label: "manual", icon: User },
  ticket: { label: "ticket", icon: Ticket },
  trigger: { label: "trigger", icon: Webhook },
  blueprint: { label: "blueprint", icon: Layers },
  api: { label: "api", icon: Bot },
};

export function SpawnSourceBadge({ spawnedBy }: { spawnedBy: string }) {
  const src = SPAWN_SOURCE[spawnedBy] ?? SPAWN_SOURCE.manual;
  const Icon = src.icon;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-bg text-[10px] text-text-muted uppercase tracking-wide">
      <Icon className="w-3 h-3" />
      {src.label}
    </span>
  );
}

const ATTENTION_LABELS: Record<string, string> = {
  stop: "waiting for you",
  notification: "wants your attention",
  bell: "rang the bell",
  exit: "finished — review the result",
};

export function attentionLabel(reason: string | null): string {
  return (reason && ATTENTION_LABELS[reason]) || "needs you";
}

/** Attention-driven accent for the wall grid: left border color + optional ring. */
function cardAccent(terminal: any): string {
  if (terminal.state === "error") return "border-l-error";
  if (terminal.state === "exited" && terminal.attentionState !== "needs_you")
    return "border-l-border-strong opacity-70";
  switch (terminal.attentionState) {
    case "needs_you":
      return "border-l-warning ring-1 ring-warning/25";
    case "working":
      return "border-l-primary";
    default:
      return "border-l-border-strong";
  }
}

export function TerminalCard({
  terminal,
  hostName,
  onStart,
  onKill,
  onDelete,
}: {
  terminal: any;
  hostName?: string;
  onStart: (t: any) => Promise<void>;
  onKill: (t: any) => Promise<void>;
  onDelete: (t: any) => Promise<void>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = async (fn: (t: any) => Promise<void>) => {
    setBusy(true);
    try {
      await fn(terminal);
    } finally {
      setBusy(false);
    }
  };

  const canStart = terminal.state === "pending";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canDelete =
    terminal.state === "exited" || terminal.state === "error" || terminal.state === "pending";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/local/${terminal.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(`/local/${terminal.id}`);
      }}
      className={cn(
        "card-hover cursor-pointer p-3 rounded-lg border border-border border-l-2 bg-bg-card hover:border-primary/30 text-left flex flex-col gap-2",
        cardAccent(terminal),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{terminal.title}</span>
            {terminal.attentionState === "needs_you" && (
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted flex-wrap">
            {hostName && (
              <span className="flex items-center gap-1">
                <Server className="w-3 h-3" />
                {hostName}
              </span>
            )}
            <span className="font-mono truncate">{dirTail(terminal.dir)}</span>
            {terminal.lastActivityAt && <span>{formatRelativeTime(terminal.lastActivityAt)}</span>}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <LocalStateBadge terminal={terminal} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <SpawnSourceBadge spawnedBy={terminal.spawnedBy} />
        {terminal.state === "exited" && terminal.exitCode != null && (
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded border",
              terminal.exitCode === 0
                ? "border-border text-text-muted"
                : "border-error/30 bg-error/10 text-error",
            )}
          >
            exit {terminal.exitCode}
          </span>
        )}
        {terminal.state === "error" && terminal.errorMessage && (
          <span className="text-[10px] text-error truncate" title={terminal.errorMessage}>
            {terminal.errorMessage}
          </span>
        )}
      </div>

      {terminal.preview && (
        <pre className="font-mono text-[10px] leading-4 max-h-24 overflow-hidden whitespace-pre-wrap break-all text-text-muted/70 bg-bg/60 rounded p-2 border border-border/50">
          {terminal.preview}
        </pre>
      )}

      {(canStart || canKill || canDelete) && (
        <div className="flex items-center gap-1.5 mt-auto" onClick={(e) => e.stopPropagation()}>
          {canStart && terminal.pendingReason === "hold" ? (
            <button
              onClick={() => run(onStart)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Start
            </button>
          ) : canStart ? (
            <button
              onClick={() => run(onStart)}
              disabled={busy}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-bg text-xs text-text-muted hover:text-text disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Start
            </button>
          ) : null}
          {canKill && (
            <button
              onClick={() => run(onKill)}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-bg text-[11px] text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
              title="Kill the process"
            >
              <XCircle className="w-3 h-3" />
              Kill
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => run(onDelete)}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-bg text-[11px] text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
              title="Delete this terminal record"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
