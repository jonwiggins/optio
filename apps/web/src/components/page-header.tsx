import type { ComponentType, ReactNode } from "react";

/**
 * Shared header for list / index pages — pairs with `DetailHeader` for detail
 * pages. Establishes the visual rhythm that ties /tasks, /jobs, /reviews,
 * /issues, /agents, /work together: same title scale, the page's sidebar
 * icon repeated as a glyph next to the title, a one-line muted description,
 * and a gradient-divider hairline anchoring the page.
 */
export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  meta,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  /** Right-side action cluster (buttons, links). */
  actions?: ReactNode;
  /** Optional inline meta below the description (e.g. counts, filters). */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            {Icon ? (
              <span
                className="grid place-items-center w-9 h-9 rounded-xl border border-border/70 bg-bg-card text-primary shrink-0"
                aria-hidden
              >
                <Icon className="w-4 h-4" />
              </span>
            ) : null}
            <h1 className="text-2xl font-semibold tracking-tight text-text-heading">{title}</h1>
          </div>
          {description ? (
            <p className="text-sm leading-relaxed text-text-muted mt-2 max-w-2xl">{description}</p>
          ) : null}
          {meta ? (
            <div className="text-xs text-text-muted mt-2 flex items-center gap-3 flex-wrap">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>
        ) : null}
      </div>
      <div className="gradient-divider mt-5" />
    </header>
  );
}
