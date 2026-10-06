import type { ReactNode } from "react";
import { StateBadge } from "@/components/state-badge";
import { PAGE_COLUMN } from "@/components/ui/page";
import { cn } from "@/lib/utils";

/**
 * Shared header for task and PR-review detail pages.
 *
 * Layout: a full-bleed band holding the page column (`PAGE_COLUMN`, the same
 * one every page's content uses) with two stacked rows. The top row holds
 * the title block (subtitle + title + state badge + meta) and an inline action
 * cluster on the right. The optional `actions` slot below holds the primary
 * action button row.
 */
export function DetailHeader({
  title,
  subtitle,
  state,
  isStalled,
  metaItems,
  rightSlot,
  actions,
  compact = false,
  extraBadges,
}: {
  compact?: boolean;
  title: ReactNode;
  /** Optional subtitle line shown above the title (e.g. "owner/repo · #123"). */
  subtitle?: ReactNode;
  /** Task or review state — rendered as a `<StateBadge>`. Omit for pages without one. */
  state?: string;
  isStalled?: boolean;
  /** Small chips below the title (repo, agent, age, …). */
  metaItems?: ReactNode[];
  /** Inline content rendered next to the state badge (e.g. origin chip, "Updated 2m ago"). */
  extraBadges?: ReactNode;
  /** Action cluster rendered top-right (refresh, etc.). */
  rightSlot?: ReactNode;
  /** Primary action button row, rendered below the title block. */
  actions?: ReactNode;
}) {
  return (
    <header
      className={cn("shrink-0 border-b border-border/70 bg-bg-card/50", compact ? "py-3" : "py-5")}
    >
      <div className={cn(PAGE_COLUMN, "flex flex-col gap-3", compact && "max-w-none")}>
        <div className="flex flex-col items-start justify-between gap-3 xl:flex-row xl:gap-6">
          <div className="min-w-0 flex-1">
            {subtitle && (
              <div className="flex flex-wrap items-center gap-2 mb-2 text-xs text-text-muted">
                {subtitle}
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight text-text-heading break-words [overflow-wrap:anywhere]">
                {title}
              </h1>
              {state && <StateBadge state={state} isStalled={isStalled} />}
              {extraBadges}
            </div>
            {metaItems && metaItems.length > 0 && (
              <div className="flex items-center gap-x-4 gap-y-2 mt-2 text-xs text-text-muted flex-wrap">
                {metaItems.map((item, i) => (
                  <span key={i} className="flex min-w-0 items-center gap-1.5 break-all">
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
          {rightSlot && (
            <div className="flex max-w-full shrink-0 items-center gap-2 flex-wrap">{rightSlot}</div>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    </header>
  );
}
