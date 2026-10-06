import { isValidElement, type ComponentType, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

/** A primary "create" CTA: `{ label, href }` renders the standard + button. */
export type EmptyStateAction = { label: string; href: string };

/**
 * The one true empty-state. Same icon framing, same vertical rhythm, same
 * dashed border across Tasks / Jobs / Reviews / Issues / Agents / Work.
 *
 * - `size="page"` (default): list pages — round icon chip, text-base title.
 * - `size="panel"`: inside an Overview / dashboard panel — softer square
 *   icon tile, text-sm title, xs description.
 *
 * `action` is either a ready-made node (any button/link) or
 * `{ label, href }`, which renders the standard primary "+ label" link.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "page",
}: {
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode | EmptyStateAction;
  size?: "page" | "panel";
}) {
  const cta = isActionLink(action) ? (
    <ButtonLink href={action.href} size={size === "panel" ? "sm" : "md"}>
      <Plus />
      {action.label}
    </ButtonLink>
  ) : (
    (action as ReactNode)
  );

  if (size === "panel") {
    return (
      <div className="flex flex-col items-center justify-center py-14 px-6 rounded-xl border border-dashed border-border bg-bg-card/50">
        <div className="p-3.5 rounded-2xl bg-bg-hover/70 mb-4">
          <Icon className="w-7 h-7 text-text-muted/60" />
        </div>
        <span className="text-sm font-medium text-text-heading">{title}</span>
        {description ? (
          <p className="text-xs text-text-muted mt-1.5 text-center max-w-xs leading-relaxed">
            {description}
          </p>
        ) : null}
        {cta ? <div className="mt-5 inline-flex">{cta}</div> : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/70 bg-bg-card/30 px-6 py-14 text-center">
      <span
        className="inline-grid place-items-center w-12 h-12 rounded-2xl border border-primary/15 bg-primary/5 text-primary mb-4"
        aria-hidden
      >
        <Icon className="w-5 h-5" />
      </span>
      <h2 className="text-base font-medium text-text-heading">{title}</h2>
      {description ? (
        <p className="text-sm leading-relaxed text-text-muted mt-2 max-w-md mx-auto">
          {description}
        </p>
      ) : null}
      {cta ? <div className="mt-5 inline-flex">{cta}</div> : null}
    </div>
  );
}

function isActionLink(a: unknown): a is EmptyStateAction {
  return (
    !!a &&
    typeof a === "object" &&
    !isValidElement(a) &&
    typeof (a as EmptyStateAction).href === "string" &&
    typeof (a as EmptyStateAction).label === "string"
  );
}
