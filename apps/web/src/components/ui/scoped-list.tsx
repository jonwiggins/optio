import type { ReactNode } from "react";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import {
  OWNER_SCOPE_LABEL,
  inOwnerFilter,
  ownerScope,
  type Owned,
  type OwnerFilter,
  type OwnerScope,
} from "@/lib/owner";

/**
 * Rows grouped by scope. With `filter` = `all` (the default view) the rows
 * are **sectioned**: an Organization panel, a Private panel, and — for an
 * admin with any — an Other people's panel, so every scope is visible at a
 * glance without a chip on each row. Any other filter renders the matching
 * rows flat in the same bordered list.
 *
 *   <ScopedList rows={rows} filter={owner} viewerId={userId}
 *     render={(rows) => rows.map((r) => <Row key={r.id} row={r} />)}
 *     privateEmpty="Private secrets are yours alone: …" />
 */
export function ScopedList<T extends Owned>({
  rows,
  filter,
  viewerId,
  render,
  privateEmpty,
  organizationEmpty,
  sectionActions,
  className,
}: {
  rows: T[];
  filter: OwnerFilter;
  viewerId: string | null;
  /** Renders a scope's rows (already in order); rows divide themselves. */
  render: (rows: T[], scope: OwnerScope | null) => ReactNode;
  /** The one line an empty Private section shows (what private means here). */
  privateEmpty?: ReactNode;
  organizationEmpty?: ReactNode;
  /** Right-side actions for a section's header (e.g. "+ New" preset to that scope). */
  sectionActions?: (scope: OwnerScope) => ReactNode;
  className?: string;
}) {
  if (filter !== "all") {
    const visible = inOwnerFilter(rows, filter, viewerId);
    return (
      <div
        className={
          className ??
          "rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60"
        }
      >
        {render(visible, filter)}
      </div>
    );
  }
  const by: Record<OwnerScope, T[]> = { organization: [], private: [], others: [] };
  for (const r of rows) by[ownerScope(r, viewerId)].push(r);
  const sections: OwnerScope[] = ["organization", "private"];
  if (by.others.length > 0) sections.push("others");
  return (
    <div className={className ?? "space-y-4"}>
      {sections.map((scope) => (
        <Panel key={scope} title={OWNER_SCOPE_LABEL[scope]} actions={sectionActions?.(scope)}>
          {by[scope].length > 0 ? (
            <div className="divide-y divide-border/60">{render(by[scope], scope)}</div>
          ) : (
            <PanelEmpty>
              {scope === "private"
                ? (privateEmpty ?? "Nothing private yet.")
                : (organizationEmpty ?? "Nothing shared with the organization yet.")}
            </PanelEmpty>
          )}
        </Panel>
      ))}
    </div>
  );
}
