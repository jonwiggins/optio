import type { ReactNode } from "react";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import {
  OWNER_SCOPE_LABEL,
  groupByOwner,
  inOwnerFilter,
  type Owned,
  type OwnerFilter,
  type OwnerScope,
  type OwnerScopeWithTeam,
} from "@/lib/owner";

/**
 * Rows grouped by scope. With `filter` = `all` (the default view) the rows
 * are **sectioned**: an Organization panel, a Team panel when any row is a
 * team's, a Private panel, and — for an admin with any — an Other people's
 * panel, so every scope is visible at a glance without a chip on each row.
 * The Team section is rendered with `scope` null, the way a flat list is,
 * so each row names its team with its chip (several teams may share it).
 * Any other filter renders the matching rows flat in the same bordered list.
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
  teamActions,
  className,
}: {
  rows: T[];
  filter: OwnerFilter;
  viewerId: string | null;
  /**
   * Renders a scope's rows (already in order); rows divide themselves.
   * `scope` is null in a flat list and in the Team section, where the row
   * says its own scope.
   */
  render: (rows: T[], scope: OwnerScope | null) => ReactNode;
  /** The one line an empty Private section shows (what private means here). */
  privateEmpty?: ReactNode;
  organizationEmpty?: ReactNode;
  /** Right-side actions for a section's header (e.g. "+ New" preset to that scope). */
  sectionActions?: (scope: OwnerScope) => ReactNode;
  /** The Team section's header actions (e.g. "+ New" preset to the viewer's team). */
  teamActions?: ReactNode;
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
        {render(visible, filter === "team" ? null : filter)}
      </div>
    );
  }
  const by = groupByOwner(rows, viewerId);
  const sections: OwnerScopeWithTeam[] = ["organization"];
  if (by.team.length > 0) sections.push("team");
  sections.push("private");
  if (by.others.length > 0) sections.push("others");
  return (
    <div className={className ?? "space-y-4"}>
      {sections.map((scope) => (
        <Panel
          key={scope}
          title={OWNER_SCOPE_LABEL[scope]}
          actions={scope === "team" ? teamActions : sectionActions?.(scope)}
        >
          {by[scope].length > 0 ? (
            <div className="divide-y divide-border/60">
              {render(by[scope], scope === "team" ? null : scope)}
            </div>
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
