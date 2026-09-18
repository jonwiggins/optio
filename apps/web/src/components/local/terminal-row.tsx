"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Loader2, Play, Server, Trash2, XCircle } from "lucide-react";
import { LocalStateBadge, SpawnSourceBadge, attentionLabel, dirTail } from "./terminal-card";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";

/** Accent dot for the row: attention while live, muted once finished. */
function rowDot(t: any): string {
  if (t.attentionState === "needs_you") return "bg-warning animate-pulse";
  if (t.state === "error") return "bg-error";
  if (t.state === "exited") return "bg-text-muted/30";
  if (t.state === "pending" || t.state === "launching") return "bg-warning/60";
  if (t.attentionState === "working") return "bg-success";
  return "bg-text-muted/40";
}

/**
 * One terminal as a horizontal row for the list view — title + attention,
 * where it runs, what it's working on (PR / ticket badges), and actions.
 * Wraps to two lines below the `md` breakpoint so it stays usable on a phone.
 */
export function TerminalRow({
  terminal,
  hostName,
  showHost,
  onStart,
  onKill,
  onDelete,
}: {
  terminal: any;
  hostName?: string;
  showHost: boolean;
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

  const canStart = terminal.state === "pending" && terminal.pendingReason !== "host_offline";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canDelete =
    terminal.state === "exited" || terminal.state === "error" || terminal.state === "pending";
  const links = collectWorkLinks(terminal);
  const needsYou = terminal.attentionState === "needs_you";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/local/${terminal.id}`)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/local/${terminal.id}`);
        }
      }}
      className={cn(
        "group cursor-pointer px-3 py-2.5 md:py-2 border-b border-border/60 last:border-b-0 transition-colors hover:bg-bg-hover/50",
        "flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1.5",
        needsYou && "bg-warning/[0.04]",
      )}
    >
      {/* Title + attention */}
      <div className="flex items-center gap-2 min-w-0 flex-1 md:min-w-[14rem]">
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", rowDot(terminal))} />
        <span className="text-sm font-medium truncate">{terminal.title}</span>
        {needsYou && (
          <span className="hidden sm:inline text-[11px] text-warning truncate shrink">
            {attentionLabel(terminal.attentionReason)}
          </span>
        )}
      </div>

      {/* Phone: actions sit on the title line; everything else wraps below. */}
      <div
        className="flex items-center gap-1.5 shrink-0 md:hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <RowActions
          busy={busy}
          canStart={canStart}
          canKill={canKill}
          canDelete={canDelete}
          onStart={() => run(onStart)}
          onKill={() => run(onKill)}
          onDelete={() => run(onDelete)}
        />
      </div>
      <div className="basis-full h-0 md:hidden" aria-hidden />

      {/* State */}
      <div className="shrink-0 flex items-center gap-1.5">
        <LocalStateBadge terminal={terminal} />
        {terminal.state === "exited" && terminal.exitCode != null && terminal.exitCode !== 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-error/30 bg-error/10 text-error">
            exit {terminal.exitCode}
          </span>
        )}
      </div>

      {/* Where */}
      <div className="flex items-center gap-2 min-w-0 text-[11px] text-text-muted md:w-56 md:shrink-0">
        {showHost && hostName && (
          <span className="flex items-center gap-1 shrink-0">
            <Server className="w-3 h-3" />
            {hostName}
          </span>
        )}
        <span className="font-mono truncate" title={terminal.dir}>
          {dirTail(terminal.dir)}
        </span>
      </div>

      {/* What it's working on */}
      <div className="min-w-0 md:flex-1">
        <WorkLinkBadges links={links} size="xs" max={3} />
      </div>

      {/* When */}
      <div className="hidden lg:block w-20 shrink-0 text-right text-[11px] text-text-muted tabular-nums">
        {terminal.lastActivityAt ? formatRelativeTime(terminal.lastActivityAt) : ""}
      </div>

      {/* Source + actions (desktop) */}
      <div
        className="hidden md:flex items-center gap-1.5 shrink-0 ml-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <SpawnSourceBadge spawnedBy={terminal.spawnedBy} />
        <RowActions
          busy={busy}
          canStart={canStart}
          canKill={canKill}
          canDelete={canDelete}
          onStart={() => run(onStart)}
          onKill={() => run(onKill)}
          onDelete={() => run(onDelete)}
        />
      </div>
    </div>
  );
}

function RowActions({
  busy,
  canStart,
  canKill,
  canDelete,
  onStart,
  onKill,
  onDelete,
}: {
  busy: boolean;
  canStart: boolean;
  canKill: boolean;
  canDelete: boolean;
  onStart: () => void;
  onKill: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      {canStart && (
        <button
          onClick={onStart}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          Start
        </button>
      )}
      {canKill && (
        <button
          onClick={onKill}
          disabled={busy}
          title="Kill the process"
          aria-label="Kill"
          className="p-1.5 rounded-md border border-border bg-bg text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
        >
          <XCircle className="w-3.5 h-3.5" />
        </button>
      )}
      {canDelete && (
        <button
          onClick={onDelete}
          disabled={busy}
          title="Delete this terminal record"
          aria-label="Delete"
          className="p-1.5 rounded-md border border-border bg-bg text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  );
}
