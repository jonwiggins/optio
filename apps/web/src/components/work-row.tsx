"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  Clock,
  ExternalLink,
  Laptop,
  LogOut,
  Pencil,
  Play,
  Server,
  Terminal,
  Zap,
} from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { runtimeLabel } from "@/components/work-form/model";
import type { WorkRow, WorkStatus } from "@/lib/work-feed";

/**
 * One piece of work as a row: status, name, its four attributes, recency. Shared
 * by the Work list and the overview.
 */

export const STATUS_DOT: Record<WorkStatus, string> = {
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

export function WorkRowView({ row }: { row: WorkRow }) {
  const router = useRouter();
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
        {row.editHref && (
          // The row is a link to the page about it; Edit is a second target,
          // so it is a button (links don't nest) that navigates itself.
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              router.push(row.editHref!);
            }}
            className="p-1 -my-1 rounded-md text-text-muted/70 hover:text-text hover:bg-bg-hover transition-colors"
            title="Edit"
            aria-label={`Edit ${row.name}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
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
