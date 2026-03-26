import { cn } from "@/lib/utils";

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
};

export function StateBadge({ state, showDot = true }: { state: string; showDot?: boolean }) {
  const config = STATE_CONFIG[state] ?? {
    label: state,
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  };
  return (
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
  );
}
