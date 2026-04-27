import type { ComponentType, ReactNode } from "react";

/**
 * The one true empty-state for list pages. Same icon framing, same vertical
 * rhythm, same dashed border across Tasks / Jobs / Reviews / Issues / Agents
 * / Sessions. Pass `action` to render a primary CTA below the description.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/80 bg-bg-card/30 px-8 py-14 text-center">
      <span
        className="inline-grid place-items-center w-11 h-11 rounded-full border border-border/70 bg-bg/60 text-text-muted/80 mb-4"
        aria-hidden
      >
        <Icon className="w-5 h-5" />
      </span>
      <h2 className="text-base font-medium text-text-heading">{title}</h2>
      {description ? (
        <p className="text-sm text-text-muted mt-1 max-w-md mx-auto">{description}</p>
      ) : null}
      {action ? <div className="mt-5 inline-flex">{action}</div> : null}
    </div>
  );
}
