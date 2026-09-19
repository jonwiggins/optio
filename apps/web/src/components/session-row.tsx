"use client";

import Link from "next/link";
import {
  Bot,
  Clock,
  ExternalLink,
  Laptop,
  LogOut,
  Play,
  Server,
  Terminal,
  Zap,
} from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { runtimeLabel } from "@/components/session-form/model";
import type { SessionRow, SessionStatus } from "@/lib/sessions-feed";

/**
 * One session as a row: status, name, its four attributes, recency. Shared
 * by the Sessions list and the overview.
 */

export const STATUS_DOT: Record<SessionStatus, string> = {
  needs_you: "bg-warning",
  running: "bg-primary animate-pulse",
  queued: "bg-warning/70",
  waiting: "bg-success",
  scheduled: "bg-text-muted/60",
  paused: "bg-text-muted/40",
  done: "bg-text-muted/40",
  failed: "bg-error",
};

const THEN_ICON = {
  exits: LogOut,
  "waits-for-me": Terminal,
  "waits-for-messages": Bot,
} as const;

export function SessionRowView({ row }: { row: SessionRow }) {
  const ThenIcon = THEN_ICON[row.then];
  const WhenIcon = row.when === "now" ? Play : row.when === "messages" ? Bot : Clock;
  const WhereIcon = row.where.target === "machine" ? Laptop : Server;
  return (
    <Link
      href={row.href}
      className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
    >
      <span
        className={cn("w-2 h-2 rounded-full", STATUS_DOT[row.status])}
        aria-label={row.statusLabel}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-heading truncate">{row.name}</div>
        <div className="text-[11px] text-text-muted truncate">
          {row.statusLabel}
          {row.note && <span className="text-text-muted/70"> · {row.note}</span>}
        </div>
      </div>
      <div className="col-span-3 sm:col-span-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-muted min-w-0">
        <Attr icon={WhenIcon} label={row.when} />
        <Attr
          icon={WhereIcon}
          label={row.where.detail ?? (row.where.target === "pod" ? "Optio pod" : "machine")}
          mono
        />
        <Attr
          icon={row.who === "terminal" ? Terminal : Zap}
          label={row.who === "terminal" ? "terminal" : runtimeLabel(row.who)}
        />
        <Attr
          icon={ThenIcon}
          label={
            row.then === "exits"
              ? "exits"
              : row.then === "waits-for-me"
                ? "waits for me"
                : "persistent"
          }
        />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-text-muted/70 whitespace-nowrap">
        {row.prUrl && (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-primary hover:underline inline-flex items-center gap-0.5"
          >
            PR <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {row.lastActivity && <span>{formatRelativeTime(row.lastActivity)}</span>}
      </div>
    </Link>
  );
}

function Attr({
  icon: Icon,
  label,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <Icon className="w-3 h-3 shrink-0 text-text-muted/60" />
      <span className={cn("truncate", mono && "font-mono")}>{label}</span>
    </span>
  );
}
