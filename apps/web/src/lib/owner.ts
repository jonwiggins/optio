import type { ResourceOwner } from "@optio/shared";

/**
 * Organization and private scope, as the UI shows it. Every scoped resource
 * — secrets, connections, model providers, MCP servers, skills, prompts, work
 * — carries `ownerUserId`: null = the **organization's** (everyone in the
 * workspace sees it), set = someone's **private** one (visible to them alone,
 * read-only to admins, who see it under **Other people's**).
 *
 * One vocabulary everywhere: pickers say Organization / Private, lists are
 * sectioned Organization / Private / Other people's, chips say Private.
 */

export type OwnerScope = "organization" | "private" | "others";

/** The owner filter a list page offers (`?owner=`). */
export type OwnerFilter = "all" | OwnerScope;

export const OWNER_FILTERS: readonly OwnerFilter[] = ["all", "organization", "private", "others"];

export interface Owned {
  ownerUserId?: string | null;
  ownerName?: string | null;
}

/** Which scope a row falls in for the viewer. */
export function ownerScope(row: Owned, viewerId: string | null): OwnerScope {
  if (!row.ownerUserId) return "organization";
  // With auth disabled there is one person; everything private is theirs.
  if (viewerId === null || row.ownerUserId === viewerId) return "private";
  return "others";
}

export const OWNER_SCOPE_LABEL: Record<OwnerScope, string> = {
  organization: "Organization",
  private: "Private",
  others: "Other people's",
};

/** The `owner` a form sends for a picked scope. */
export function ownerOf(scope: "organization" | "private"): ResourceOwner {
  return scope === "private" ? "me" : "workspace";
}

/** The picked scope for an `owner` the API knows. */
export function scopeOf(owner: ResourceOwner | null | undefined): "organization" | "private" {
  return owner === "me" ? "private" : "organization";
}

/** Parse a `?owner=` value; anything else is `all`. */
export function parseOwnerFilter(raw: string | null | undefined): OwnerFilter {
  return raw && (OWNER_FILTERS as readonly string[]).includes(raw) ? (raw as OwnerFilter) : "all";
}

/** Rows in a scope (or every row for `all`). */
export function inOwnerFilter<T extends Owned>(
  rows: T[],
  filter: OwnerFilter,
  viewerId: string | null,
): T[] {
  if (filter === "all") return rows;
  return rows.filter((r) => ownerScope(r, viewerId) === filter);
}

/** How many rows fall in each scope. */
export function countByOwner<T extends Owned>(
  rows: T[],
  viewerId: string | null,
): Record<OwnerFilter, number> {
  const counts: Record<OwnerFilter, number> = {
    all: rows.length,
    organization: 0,
    private: 0,
    others: 0,
  };
  for (const r of rows) counts[ownerScope(r, viewerId)]++;
  return counts;
}

/** One sentence on what "Private" means for a kind of resource (the Private section's empty line). */
export function privateHint(what: string): string {
  return `Private ${what} are yours alone: only you see them and only your work can use them.`;
}
