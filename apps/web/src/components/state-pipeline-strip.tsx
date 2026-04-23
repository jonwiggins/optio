import { cn } from "@/lib/utils";

export interface PipelineStep {
  key: string;
  label: string;
}

/**
 * Compact horizontal pipeline strip — used in detail page headers to show
 * progression through a fixed sequence of states (e.g. Queued → CI →
 * Reviewing → Ready → Submitted for PR reviews).
 *
 * Visual language matches `<StateBadge>` so the strip feels native to the
 * rest of the app: completed steps in success, the active step in primary,
 * upcoming steps muted, and an explicit error/cancelled tail when the flow
 * has terminated abnormally.
 */
export function StatePipelineStrip({
  steps,
  current,
  /** When true, the current step is rendered as an error (e.g. "stale"). */
  errorAtCurrent = false,
  /** Trailing badge for terminal states that don't sit on the strip itself. */
  terminal,
}: {
  steps: PipelineStep[];
  /** Index of the active step. -1 means none of the steps are active. */
  current: number;
  errorAtCurrent?: boolean;
  terminal?: { label: string; tone: "error" | "muted" | "warning" };
}) {
  return (
    <div className="flex items-center gap-1 text-[11px]">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          <span
            className={cn(
              "px-2 py-0.5 rounded-md font-medium",
              i < current
                ? "bg-success/10 text-success"
                : i === current
                  ? errorAtCurrent
                    ? "bg-error/10 text-error"
                    : "bg-primary/10 text-primary"
                  : "bg-bg text-text-muted",
            )}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="text-text-muted/30">›</span>}
        </div>
      ))}
      {terminal && (
        <span
          className={cn(
            "ml-2 px-2 py-0.5 rounded-md font-medium",
            terminal.tone === "error"
              ? "bg-error/10 text-error"
              : terminal.tone === "warning"
                ? "bg-warning/10 text-warning"
                : "bg-bg text-text-muted",
          )}
        >
          {terminal.label}
        </span>
      )}
    </div>
  );
}
