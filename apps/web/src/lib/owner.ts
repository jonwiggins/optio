import { teamIdOf, teamOwner, type ResourceOwner } from "@optio/shared";

/**
 * Organization, team and private scope, as the UI shows it. Every scoped
 * resource — secrets, connections, model providers, MCP servers, skills,
 * prompts, work — carries `ownerUserId`: null = the **organization's**
 * (everyone in the workspace sees it), set = someone's **private** one
 * (visible to them alone, read-only to admins, who see it under **Other
 * people's**). The kinds whose API takes a team owner (prompts, secrets,
 * work) also carry `ownerTeamId`: set = a **team's** (its members see and
 * use it, its admins change it).
 *
 * One vocabulary everywhere: pickers say Organization / Team / Private,
 * lists are sectioned Organization / Team / Private / Other people's, chips
 * say Team · Name or Private.
 */

/** The scopes every scoped resource has. */
export type OwnerScope = "organization" | "private" | "others";

/** …plus a team's, for the kinds whose API takes a team owner. */
export type OwnerScopeWithTeam = OwnerScope | "team";

/** The owner filter a list page offers (`?owner=`). */
export type OwnerFilter = "all" | OwnerScopeWithTeam;

export const OWNER_FILTERS: readonly OwnerFilter[] = [
  "all",
  "organization",
  "team",
  "private",
  "others",
];

export interface Owned {
  ownerUserId?: string | null;
  ownerName?: string | null;
  /** Set when a team owns the row (the APIs that take a team owner). */
  ownerTeamId?: string | null;
  /** Display name of `ownerTeamId` (lists add it, `withOwnerNames` in the API). */
  ownerTeamName?: string | null;
}

/**
 * Which scope a row falls in for the viewer. `teamIds` (the viewer's teams,
 * possibly empty) opts a caller into the team scope: a team's row is then
 * "team" for everyone who receives it — a member, or an admin looking in
 * from outside. A caller that knows only the three scopes (a
 * `Record<OwnerScope, …>`) leaves it out and sees a team's row as a shared
 * one, the organization's.
 */
export function ownerScope(row: Owned, viewerId: string | null): OwnerScope;
export function ownerScope(
  row: Owned,
  viewerId: string | null,
  teamIds: readonly string[],
): OwnerScopeWithTeam;
export function ownerScope(
  row: Owned,
  viewerId: string | null,
  teamIds?: readonly string[],
): OwnerScopeWithTeam {
  if (row.ownerTeamId) return teamIds ? "team" : "organization";
  if (!row.ownerUserId) return "organization";
  // With auth disabled there is one person; everything private is theirs.
  if (viewerId === null || row.ownerUserId === viewerId) return "private";
  return "others";
}

/** The viewer's teams as the components pass them: unknown here, but teams count. */
const WITH_TEAMS: readonly string[] = [];

export const OWNER_SCOPE_LABEL: Record<OwnerScopeWithTeam, string> = {
  organization: "Organization",
  team: "Team",
  private: "Private",
  others: "Other people's",
};

/**
 * What an Owner picker holds: a scope word, or a team by id (`team:<id>`,
 * the same spelling as the `ResourceOwner` it becomes).
 */
export type PickedOwner = "organization" | "private" | `team:${string}`;

/** The `owner` a form sends for a picked scope. */
export function ownerOf(scope: "organization"): "workspace";
export function ownerOf(scope: "private"): "me";
export function ownerOf(scope: "organization" | "private"): "workspace" | "me";
export function ownerOf(scope: PickedOwner): ResourceOwner;
export function ownerOf(scope: PickedOwner): ResourceOwner {
  if (scope === "private") return "me";
  if (scope === "organization") return "workspace";
  return scope;
}

/** The picked scope for an `owner` the API knows. */
export function scopeOf(owner: "workspace" | "me" | null | undefined): "organization" | "private";
export function scopeOf(owner: ResourceOwner | null | undefined): PickedOwner;
export function scopeOf(owner: ResourceOwner | null | undefined): PickedOwner {
  if (owner === "me") return "private";
  const teamId = teamIdOf(owner);
  return teamId ? teamOwner(teamId) : "organization";
}

/** The team a picked owner names, or null. */
export function pickedTeamId(scope: PickedOwner | ResourceOwner | null | undefined): string | null {
  return teamIdOf(scope);
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
  return rows.filter((r) => ownerScope(r, viewerId, WITH_TEAMS) === filter);
}

/** How many rows fall in each scope. */
export function countByOwner<T extends Owned>(
  rows: T[],
  viewerId: string | null,
): Record<OwnerFilter, number> {
  const counts: Record<OwnerFilter, number> = {
    all: rows.length,
    organization: 0,
    team: 0,
    private: 0,
    others: 0,
  };
  for (const r of rows) counts[ownerScope(r, viewerId, WITH_TEAMS)]++;
  return counts;
}

/** Rows by scope, the team's apart (what `ScopedList` sections). */
export function groupByOwner<T extends Owned>(
  rows: T[],
  viewerId: string | null,
): Record<OwnerScopeWithTeam, T[]> {
  const by: Record<OwnerScopeWithTeam, T[]> = {
    organization: [],
    team: [],
    private: [],
    others: [],
  };
  for (const r of rows) by[ownerScope(r, viewerId, WITH_TEAMS)].push(r);
  return by;
}

/** One sentence on what "Private" means for a kind of resource (the Private section's empty line). */
export function privateHint(what: string): string {
  return `Private ${what} are yours alone: only you see them and only your work can use them.`;
}

/** One sentence on what "Team" means for a kind of resource (the Team section's empty line). */
export function teamHint(what: string): string {
  return `Team ${what} are shared with a team: its members see and use them, its admins change them.`;
}

/**
 * Who sees whose work in the workspace (`useCurrentUser().workVisibility`,
 * docs/teams.md): "organization" — the organization's work is everyone's;
 * "teams" — a member sees their own, their teams' and what they created.
 */
export type WorkVisibility = "organization" | "teams";

/**
 * The owner filters a work list offers. Under "teams" a member never
 * receives other people's work, so "Other people's" is an admin's alone.
 */
export function workOwnerFilters(
  workVisibility: WorkVisibility,
  isAdmin: boolean,
): readonly OwnerFilter[] {
  return workVisibility === "teams" && !isAdmin
    ? OWNER_FILTERS.filter((f) => f !== "others")
    : OWNER_FILTERS;
}

/** A work list's section label: under "teams", a member's organization rows are the ones they made. */
export function workOwnerLabel(
  scope: OwnerScopeWithTeam,
  workVisibility: WorkVisibility,
  isAdmin: boolean,
): string {
  if (workVisibility === "teams" && !isAdmin && scope === "organization") {
    return "Organization · made by you";
  }
  return OWNER_SCOPE_LABEL[scope];
}

/** One sentence on what a member sees of the workspace's work. */
export function workVisibilityHint(workVisibility: WorkVisibility): string {
  return workVisibility === "teams"
    ? "You see your own work, your teams' and what you started; admins see everything."
    : "Everyone sees the organization's work; private work is its owner's, a team's its members'.";
}
