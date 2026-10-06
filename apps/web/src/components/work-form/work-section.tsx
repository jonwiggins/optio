import type { ReactNode } from "react";

/** A question in the work form; the live answers are collected in its review panel. */
export function WorkSection({
  step,
  label,
  hint,
  id,
  children,
}: {
  step: number;
  label: string;
  hint?: ReactNode;
  id: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-6 rounded-xl border border-border/80 bg-bg-card/50"
    >
      <header className="flex items-start gap-3 p-4 sm:p-5">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border bg-bg-subtle text-xs font-medium tabular-nums text-text-muted"
        >
          {step}
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-sm font-semibold text-text-heading">
            {label}
          </h2>
          {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
        </div>
      </header>
      <div className="px-4 pb-4 sm:px-5 sm:pb-5">{children}</div>
    </section>
  );
}
