import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

const STATE_CONFIG: Record<
  string,
  {
    label: string;
    color: string;
    dotColor: string;
    glowClass: string;
    pulse?: boolean;
    emphasis?: boolean;
  }
> = {
  pending: {
    label: "Queued",
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  },
  waiting_on_deps: {
    label: "Waiting",
    color: "text-warning",
    dotColor: "bg-warning",
    glowClass: "badge-glow-warning",
  },
  queued: {
    label: "Queued",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
  },
  provisioning: {
    label: "Setup",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
    pulse: true,
  },
  running: {
    label: "Running",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
    pulse: true,
  },
  needs_attention: {
    label: "Attention",
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
    emphasis: true,
  },
  pr_opened: {
    label: "PR",
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
  },
  completed: {
    label: "Done",
    color: "text-text-muted",
    dotColor: "bg-text-muted/40",
    glowClass: "badge-glow-muted",
  },
  failed: {
    label: "Failed",
    color: "text-warning",
    dotColor: "bg-warning",
    glowClass: "badge-glow-warning",
  },
  cancelled: {
    label: "Cancelled",
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  },
  // PR review-specific states
  waiting_ci: {
    label: "Waiting CI",
    color: "text-warning",
    dotColor: "bg-warning",
    glowClass: "badge-glow-warning",
    pulse: true,
  },
  reviewing: {
    label: "Reviewing",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
    pulse: true,
  },
  ready: {
    label: "Ready",
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
  },
  stale: {
    label: "Stale",
    color: "text-warning",
    dotColor: "bg-warning",
    glowClass: "badge-glow-warning",
    emphasis: true,
  },
  submitted: {
    label: "Submitted",
    color: "text-text-muted",
    dotColor: "bg-text-muted/40",
    glowClass: "badge-glow-muted",
  },
  // Persistent agent states (queued / provisioning / running / failed shared above)
  idle: {
    label: "Idle",
    color: "text-text-muted",
    dotColor: "bg-text-muted/50",
    glowClass: "badge-glow-muted",
  },
  paused: {
    label: "Paused",
    color: "text-text-muted",
    dotColor: "bg-text-muted/30",
    glowClass: "badge-glow-muted",
  },
  archived: {
    label: "Archived",
    color: "text-text-muted",
    dotColor: "bg-text-muted/20",
    glowClass: "badge-glow-muted",
  },
  // Interactive pod session states
  active: {
    label: "Active",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
    pulse: true,
  },
  ended: {
    label: "Ended",
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  },
  // Workflow blueprint enablement states
  enabled: {
    label: "Enabled",
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
  },
  disabled: {
    label: "Disabled",
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  },
};

export function StateBadge({
  state,
  showDot = true,
  isStalled,
}: {
  state: string;
  showDot?: boolean;
  isStalled?: boolean;
}) {
  const config = STATE_CONFIG[state] ?? {
    label: state,
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  };
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium tracking-wide uppercase transition-all duration-200",
          config.color,
          config.glowClass,
          config.emphasis && "border border-current/20",
        )}
      >
        {showDot && (
          <span
            className={cn("w-1.5 h-1.5 rounded-full", config.dotColor, config.pulse && "glow-dot")}
          />
        )}
        {config.label}
      </span>
      {isStalled && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium tracking-wide uppercase text-warning bg-warning/10 border border-warning/20">
          <AlertTriangle className="w-3 h-3" />
          Stuck
        </span>
      )}
    </span>
  );
}
