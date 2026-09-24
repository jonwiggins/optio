"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";
import { HoverCard } from "./hover-card";
import { CONN_DOT, CONN_LABEL, type ConnState } from "./conn-state";
import { SESSION_DOT, sessionTone } from "./attention";
import {
  Bot,
  Briefcase,
  Clock,
  GitPullRequest,
  Github,
  Hash,
  Layers,
  Loader2,
  Play,
  Server,
  Ticket,
  Trash2,
  User,
  Webhook,
  XCircle,
  Zap,
} from "lucide-react";

/** Last two path segments of an absolute dir — enough to recognize a checkout. */
export function dirTail(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}

const STATE_STYLES: Record<string, { label: string; className: string; pulse?: boolean }> = {
  pending: { label: "Pending", className: "text-text-muted bg-bg" },
  launching: { label: "Launching", className: "text-primary bg-primary/10", pulse: true },
  running: { label: "Running", className: "text-primary bg-primary/10", pulse: true },
  exited: { label: "Exited", className: "text-text-muted bg-bg" },
  error: { label: "Error", className: "text-text-muted bg-bg" },
};

export function localStateLabel(terminal: any): string {
  const style = STATE_STYLES[terminal.state] ?? STATE_STYLES.pending;
  return terminal.state === "pending" && terminal.pendingReason === "host_offline"
    ? "Host offline"
    : terminal.state === "pending" && terminal.pendingReason === "hold"
      ? "Held"
      : style.label;
}

/**
 * The ONE status a terminal header shows. Folds lifecycle state and
 * attention into a single color so there's never a "Running" badge next to
 * a green dot next to a yellow dot:
 *   yellow pulse  needs you        green  working      grey  idle
 *   amber dim     pending/launching red    error        grey dim  exited
 */
/**
 * One dot for "what is this terminal doing". The header passes the stream's
 * `conn` too: while the process is live but the browser's stream to it is
 * not healthy, that is the more urgent fact, so the dot takes the stream's
 * color and the hover names it. A healthy stream never adds a second
 * indicator — "working" already implies the output is flowing.
 */
export function statusDescriptor(
  terminal: any,
  conn?: ConnState,
): {
  dot: string;
  label: string;
  detail: string | null;
} {
  const base = baseStatusDescriptor(terminal);
  const live = terminal.state === "running" || terminal.state === "launching";
  if (!conn || conn === "connected" || !live) return base;
  const streamDetail = `Stream ${CONN_LABEL[conn]}`;
  return {
    dot: cn(CONN_DOT[conn], conn !== "disconnected" && "animate-pulse"),
    label: base.label,
    detail: base.detail ? `${base.detail} · ${streamDetail}` : streamDetail,
  };
}

function baseStatusDescriptor(terminal: any): {
  dot: string;
  label: string;
  detail: string | null;
} {
  const tone = sessionTone(terminal);
  const dot = SESSION_DOT[tone];
  switch (terminal.state) {
    case "error":
      return { dot, label: "Error", detail: terminal.errorMessage ?? null };
    case "exited":
      if (tone === "needs_you")
        return { dot, label: "Finished", detail: attentionLabel(terminal.attentionReason) };
      if (tone === "completed") return { dot, label: "Completed", detail: "exit code 0" };
      return {
        dot,
        label: terminal.exitCode == null ? "Killed" : "Exited",
        detail:
          terminal.errorMessage ??
          (terminal.exitCode != null ? `exit code ${terminal.exitCode}` : null),
      };
    case "pending":
      return {
        dot,
        label:
          terminal.pendingReason === "host_offline"
            ? "Waiting for host"
            : terminal.pendingReason === "hold"
              ? "Held"
              : "Pending",
        detail: null,
      };
    case "launching":
      return { dot, label: "Launching", detail: null };
    default:
      if (tone === "needs_you")
        return { dot, label: "Needs you", detail: attentionLabel(terminal.attentionReason) };
      if (tone === "working") return { dot, label: "Working", detail: null };
      return { dot, label: "Idle", detail: "running, nothing happening" };
  }
}

/** Single status dot with the description on hover. */
export function StatusDot({
  terminal,
  conn,
  className,
}: {
  terminal: any;
  /** Stream health, when the caller has a live stream (the pane header). */
  conn?: ConnState;
  className?: string;
}) {
  const s = statusDescriptor(terminal, conn);
  return (
    <HoverCard
      align="left"
      className={cn("shrink-0", className)}
      content={
        <>
          <span className="block font-medium text-text">{s.label}</span>
          {s.detail && <span className="block">{s.detail}</span>}
        </>
      }
    >
      <span
        role="img"
        aria-label={s.detail ? `${s.label} — ${s.detail}` : s.label}
        className="inline-flex items-center justify-center w-5 h-5"
      >
        <span className={cn("w-2 h-2 rounded-full", s.dot)} />
      </span>
    </HoverCard>
  );
}

export function LocalStateBadge({
  terminal,
  compact,
}: {
  terminal: any;
  /** Just the dot (label on hover) — the header does this when the title needs the room. */
  compact?: boolean;
}) {
  const style = STATE_STYLES[terminal.state] ?? STATE_STYLES.pending;
  const label = localStateLabel(terminal);
  return (
    <span
      title={label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md text-[11px] font-medium tracking-wide uppercase shrink-0",
        compact ? "px-1.5 py-1" : "px-2 py-0.5",
        style.className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full bg-current", style.pulse && "animate-pulse")} />
      {!compact && <span>{label}</span>}
    </span>
  );
}

const SPAWN_SOURCE: Record<string, { label: string; icon: any }> = {
  manual: { label: "manual", icon: User },
  ticket: { label: "ticket", icon: Ticket },
  trigger: { label: "trigger", icon: Webhook },
  blueprint: { label: "blueprint", icon: Layers },
  api: { label: "api", icon: Bot },
  resume: { label: "resumed", icon: User },
  // Terminals that execute a Job run / Repo Task whose run location is this machine.
  job: { label: "job", icon: Briefcase },
  task: { label: "task", icon: GitPullRequest },
};

/** A trigger-started session names its source: GitHub, Slack, a schedule, … */
const TRIGGER_SOURCE: Record<string, { label: string; icon: any }> = {
  github: { label: "GitHub", icon: Github },
  slack: { label: "Slack", icon: Hash },
  linear: { label: "Linear", icon: Zap },
  schedule: { label: "schedule", icon: Clock },
  webhook: { label: "webhook", icon: Webhook },
  ticket: { label: "ticket", icon: Ticket },
};

export function SpawnSourceBadge({
  spawnedBy,
  triggerType,
}: {
  spawnedBy: string;
  triggerType?: string | null;
}) {
  const src =
    (spawnedBy === "trigger" && triggerType ? TRIGGER_SOURCE[triggerType] : undefined) ??
    SPAWN_SOURCE[spawnedBy] ??
    SPAWN_SOURCE.manual;
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
  quiet: "gone quiet — probably waiting on you",
  finished: "command finished",
  exit: "finished — review the result",
  done: "done — review the result",
  stale: "went quiet a while ago",
};

export function attentionLabel(reason: string | null): string {
  return (reason && ATTENTION_LABELS[reason]) || "needs you";
}

/** Attention-driven accent for the wall grid: left border color + optional ring. */
function cardAccent(terminal: any): string {
  switch (sessionTone(terminal)) {
    case "needs_you":
      return "border-l-warning ring-1 ring-warning/25";
    case "working":
      return "border-l-primary";
    case "completed":
      return "border-l-success opacity-80";
    case "dead":
      return "border-l-border-strong opacity-70";
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

  // A terminal parked on an offline host spawns itself when the daemon
  // reconnects — Start would only 409 with "Host is offline".
  const canStart = terminal.state === "pending" && terminal.pendingReason !== "host_offline";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canDelete =
    terminal.state === "exited" || terminal.state === "error" || terminal.state === "pending";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/local/${terminal.id}`)}
      onKeyDown={(e) => {
        // Only when the card itself is focused — keydown bubbles from the
        // inner Kill/Delete buttons, which must not also navigate away.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/local/${terminal.id}`);
        }
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
        <SpawnSourceBadge spawnedBy={terminal.spawnedBy} triggerType={terminal.triggerType} />
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
        {(terminal.state === "error" || terminal.state === "exited") && terminal.errorMessage && (
          <span
            className={cn(
              "text-[10px] truncate",
              terminal.state === "error" ? "text-error" : "text-text-muted",
            )}
            title={terminal.errorMessage}
          >
            {terminal.errorMessage}
          </span>
        )}
      </div>

      <WorkLinkBadges links={collectWorkLinks(terminal)} size="xs" max={4} />

      {terminal.preview && (
        <pre className="font-mono text-[10px] leading-4 max-h-24 overflow-hidden whitespace-pre-wrap break-all text-text-muted/70 bg-bg/60 rounded p-2 border border-border/50">
          {terminal.preview}
        </pre>
      )}

      {(canStart || canKill || canDelete) && (
        <div
          className="flex items-center gap-1.5 mt-auto"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {canStart && (
            <button
              onClick={() => run(onStart)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Start
            </button>
          )}
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
