import type { ReactNode } from "react";

/**
 * The New work form's card: a header strip that names the question (with an
 * optional numbered step circle and an inline hint) and echoes the current
 * answer on the right, then one padded body. Controls inside separate with
 * dividers, never with boxes of their own.
 */
export function SectionCard({
  step,
  label,
  hint,
  summary,
  summaryIcon,
  actions,
  id,
  bodyClassName = "p-4",
  children,
}: {
  /** Number shown in the step circle; no circle when absent. */
  step?: number;
  label: ReactNode;
  hint?: ReactNode;
  /** Right-aligned echo of the current answer. */
  summary?: string;
  summaryIcon?: ReactNode;
  /** Right-aligned header controls (after the summary). */
  actions?: ReactNode;
  id?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="rounded-xl border border-border bg-bg-card overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-border bg-bg-subtle/70">
        {step !== undefined && (
          <span className="flex items-center justify-center w-5 h-5 shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-semibold tabular-nums">
            {step}
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-text-heading">{label}</h2>
          {hint && <span className="text-xs text-text-muted">{hint}</span>}
        </div>
        {summary && (
          <span className="ml-auto pl-3 text-xs text-text-muted max-w-[45%] min-w-0 inline-flex items-center justify-end gap-1.5">
            {summaryIcon}
            <span className="truncate">{summary}</span>
          </span>
        )}
        {actions && (
          <div
            className={
              summary
                ? "flex items-center gap-2 shrink-0"
                : "ml-auto flex items-center gap-2 shrink-0"
            }
          >
            {actions}
          </div>
        )}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
