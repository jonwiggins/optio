import { cn } from "@/lib/utils";

/**
 * The one true status indicator. Color + animation map shared across
 * Tasks, Jobs, Reviews, Issues, Agents, Sessions, so the same hue means the
 * same thing everywhere in the app.
 *
 * Pass any state string; unknown values fall back to the muted "idle" look.
 */
export type StatusKind =
  | "idle"
  | "queued"
  | "provisioning"
  | "running"
  | "needs_attention"
  | "pr_opened"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "archived"
  | "ready"
  | "active"
  | "ended";

const DOT: Record<StatusKind, string> = {
  idle: "bg-text-muted/45",
  queued: "bg-warning",
  provisioning: "bg-warning animate-pulse",
  running: "bg-primary animate-pulse",
  needs_attention: "bg-warning animate-pulse",
  pr_opened: "bg-info",
  completed: "bg-success",
  failed: "bg-error",
  cancelled: "bg-text-muted/30",
  paused: "bg-text-muted/40",
  archived: "bg-text-muted/20",
  ready: "bg-success",
  active: "bg-success",
  ended: "bg-text-muted/30",
};

const LABEL: Record<StatusKind, string> = {
  idle: "Idle",
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  needs_attention: "Needs attention",
  pr_opened: "PR open",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
  archived: "Archived",
  ready: "Ready",
  active: "Active",
  ended: "Ended",
};

function resolve(state: string): StatusKind {
  return (state as StatusKind) in DOT ? (state as StatusKind) : "idle";
}

export function StatusDot({ state, className }: { state: string; className?: string }) {
  const kind = resolve(state);
  return (
    <span
      className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", DOT[kind], className)}
      aria-label={LABEL[kind]}
    />
  );
}

/**
 * Status pill — dot + label in a small chip. Used in list cards and headers
 * where you want both colour and explicit text.
 */
export function StatusPill({
  state,
  label,
  className,
}: {
  state: string;
  /** Override the default label (e.g. "Sticky" pod lifecycle, custom copy). */
  label?: string;
  className?: string;
}) {
  const kind = resolve(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded-md border border-border/60 bg-bg-card/60 text-text-muted whitespace-nowrap",
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", DOT[kind])} />
      {label ?? LABEL[kind]}
    </span>
  );
}
