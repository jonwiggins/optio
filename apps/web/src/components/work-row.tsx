"use client";

import Link from "next/link";
import {
  Bot,
  Clock,
  ExternalLink,
  GitMerge,
  Laptop,
  LogOut,
  Pencil,
  Play,
  Server,
  Terminal,
} from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { runtimeLabel } from "@/components/work-form/model";
import { PrIcon, TriggerIcon, agentRuntimeIcon, triggerLabel } from "@/components/brand-icon";
import { OwnerChip } from "@/components/ui/owner-chip";
import { ManagedChip } from "@/components/ui/managed-chip";
import type { WorkRow, WorkStatus, WorkTrigger } from "@/lib/work-feed";

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
  "until-merged": GitMerge,
  "waits-for-me": Terminal,
  "waits-for-messages": Bot,
} as const;

/**
 * `whereLabel` replaces the Where chip's text where the place is already
 * said around the row (the Machines page lists a machine's work under it,
 * so its rows name only the directory).
 */
export function WorkRowView({ row, whereLabel }: { row: WorkRow; whereLabel?: string }) {
  // Private work carries the Private chip (Private · Name for someone else's,
  // which only an admin sees); the organization's is the norm and carries none.
  const { userId } = useCurrentUser();
  const ThenIcon = THEN_ICON[row.then];
  const WhenIcon = row.when === "now" ? Play : row.when === "messages" ? Bot : Clock;
  const WhereIcon = row.where.target === "machine" ? Laptop : Server;
  return (
    <article
      className={cn(
        "group relative flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 sm:px-5 bg-bg-card/40 hover:bg-bg-card transition-colors",
        row.status === "needs_you" && "bg-warning/[0.035]",
      )}
    >
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href={row.href}
            className="min-w-0 truncate text-sm font-medium text-text-heading after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-primary focus-visible:after:-outline-offset-2"
          >
            {row.name}
          </Link>
          <OwnerChip row={row} viewerId={userId} className="shrink-0" />
          <ManagedChip managedBy={row.managedBy} className="shrink-0" />
        </div>
        {row.note && (
          <p className="mt-1 truncate text-xs text-text-muted" title={row.note}>
            {row.note}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-muted min-w-0">
          {row.triggers && row.triggers.length > 0 ? (
            <WhenTriggers triggers={row.triggers} />
          ) : (
            <Attr icon={WhenIcon} label={row.when} />
          )}
          <Attr
            icon={WhereIcon}
            label={
              whereLabel ??
              row.where.detail ??
              (row.where.target === "pod" ? "Optio pod" : "machine")
            }
            mono
          />
          <Attr
            icon={agentRuntimeIcon(row.who)}
            label={row.who === "terminal" ? "terminal" : runtimeLabel(row.who)}
          />
          <Attr
            icon={ThenIcon}
            label={
              row.then === "exits"
                ? "exits"
                : row.then === "until-merged"
                  ? "until merged"
                  : row.then === "waits-for-me"
                    ? "waits for me"
                    : "persistent"
            }
          />
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 text-xs text-text-muted sm:w-auto sm:shrink-0 sm:flex-col sm:items-end">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium",
            row.status === "needs_you"
              ? "bg-warning/10 text-warning"
              : row.status === "failed"
                ? "bg-error/10 text-error"
                : "bg-bg-hover/50 text-text",
          )}
        >
          <span aria-hidden className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[row.status])} />
          {row.statusLabel}
        </span>
        <div className="flex items-center gap-2">
          {row.prUrl && (
            <a
              href={row.prUrl}
              target="_blank"
              rel="noreferrer"
              className="relative z-10 inline-flex min-h-7 items-center gap-1 text-text underline decoration-border-strong underline-offset-4 hover:text-text-heading"
              title={`Pull request${row.prState ? ` (${row.prState})` : ""} · ${row.prUrl}`}
            >
              <PrIcon state={row.prState} className="w-3 h-3" />
              PR <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {row.lastActivity && (
            <time dateTime={row.lastActivity} title={new Date(row.lastActivity).toLocaleString()}>
              {formatRelativeTime(row.lastActivity)}
            </time>
          )}
          {row.editHref && (
            <Link
              href={row.editHref}
              className="relative z-10 grid h-8 w-8 place-items-center rounded-md text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
              title={`Edit ${row.name}`}
              aria-label={`Edit ${row.name}`}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>
    </article>
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
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full" title={label}>
      <Icon className="w-3 h-3 shrink-0 text-text-muted" />
      <span className={cn("truncate", mono && "font-mono")}>{label}</span>
    </span>
  );
}

/**
 * The When attribute for work whose triggers are known: each source's mark
 * (GitHub, Slack, Linear, a ticket tracker, or the schedule / webhook icon)
 * and their names, so a row reads "GitHub" rather than "on a trigger".
 */
function WhenTriggers({ triggers }: { triggers: WorkTrigger[] }) {
  const labels = triggers.map((t) => triggerLabel(t.type, t.source));
  const shown = triggers.slice(0, 3);
  return (
    <span
      className="inline-flex items-center gap-1 min-w-0"
      title={`Starts on: ${labels.join(", ")}`}
    >
      <span className="inline-flex items-center gap-0.5 shrink-0">
        {shown.map((t) => (
          <TriggerIcon
            key={`${t.type}:${t.source ?? ""}`}
            type={t.type}
            source={t.source}
            className="w-3 h-3 text-text-muted/80"
          />
        ))}
      </span>
      <span className="truncate">
        {labels.length > 2 ? `${labels[0]} +${labels.length - 1}` : labels.join(" · ")}
      </span>
    </span>
  );
}
