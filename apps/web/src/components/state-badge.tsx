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
    color: "text-info",
    dotColor: "bg-info",
    glowClass: "badge-glow-info",
  },
  provisioning: {
    label: "Setup",
    color: "text-info",
    dotColor: "bg-info",
    glowClass: "badge-glow-info",
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
    color: "text-warning",
    dotColor: "bg-warning",
    glowClass: "badge-glow-warning",
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
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
  },
  failed: {
    label: "Failed",
    color: "text-error",
    dotColor: "bg-error",
    glowClass: "badge-glow-error",
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
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
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
          config.emphasis && "border border-warning/20",
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
