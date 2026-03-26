import { StateBadge } from "./state-badge";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

const STATE_DOT_COLORS: Record<string, string> = {
  running: "bg-primary",
  provisioning: "bg-info",
  queued: "bg-info",
  pending: "bg-text-muted",
  completed: "bg-success",
  pr_opened: "bg-success",
  failed: "bg-error",
  cancelled: "bg-text-muted",
  needs_attention: "bg-warning",
};

const ACTIVE_STATES = new Set(["running", "provisioning", "queued"]);

interface TimelineEvent {
  id: string;
  fromState?: string;
  toState: string;
  trigger: string;
  message?: string;
  createdAt: string;
}

export function EventTimeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="space-y-0">
      {events.map((event, i) => {
        const isLast = i === events.length - 1;
        const isFirst = i === 0;
        const dotColor = STATE_DOT_COLORS[event.toState] ?? "bg-text-muted";
        const isActive = isLast && ACTIVE_STATES.has(event.toState);
        return (
          <div
            key={event.id}
            className={cn("flex items-start gap-3", isFirst && "animate-fade-in")}
          >
            <div className="flex flex-col items-center">
              <div className="relative mt-2 shrink-0">
                {isActive && (
                  <div
                    className={cn(
                      "absolute -inset-1 rounded-full opacity-30 animate-ping",
                      dotColor,
                    )}
                  />
                )}
                <div
                  className={cn(
                    "w-2.5 h-2.5 rounded-full relative z-10 ring-2 ring-bg",
                    dotColor,
                    isActive && "glow-dot",
                  )}
                />
              </div>
              {!isLast && (
                <div
                  className={cn(
                    "w-px flex-1 mt-1",
                    isLast
                      ? "bg-gradient-to-b from-border to-transparent"
                      : "bg-gradient-to-b from-border/60 to-border/30",
                  )}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="flex items-center gap-2 flex-wrap">
                {event.fromState && (
                  <>
                    <StateBadge state={event.fromState} showDot={false} />
                    <span className="text-text-muted/40 text-xs">&rarr;</span>
                  </>
                )}
                <StateBadge
                  state={event.toState}
                  showDot={isLast || ACTIVE_STATES.has(event.toState)}
                />
              </div>
              <div className="text-xs text-text-muted/70 mt-1.5 font-medium">
                {event.trigger.replace(/_/g, " ")}
                {event.message && (
                  <span className="font-normal text-text-muted/50"> &mdash; {event.message}</span>
                )}
              </div>
              <div className="text-[10px] text-text-muted/40 mt-0.5 tabular-nums font-mono">
                {formatRelativeTime(event.createdAt)}
              </div>
            </div>
          </div>
        );
      })}
      {events.length === 0 && (
        <div className="text-center text-text-muted/40 text-sm py-6">No events yet</div>
      )}
    </div>
  );
}
