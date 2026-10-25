import type { FastifyRequest } from "fastify";
import { eq, inArray, isNull, or, type Column, type SQL } from "drizzle-orm";
import { teamIdOf, type ResourceOwner } from "@optio/shared";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { isAuthDisabled } from "./oauth/index.js";

/**
 * Organization, team and private scope — the one rule every scoped resource
 * follows (secrets, connections, model providers, MCP servers, skills,
 * prompts, and work of every kind):
 *
 *   A **private** resource (`owner_user_id` set, `owner_team_id` null) is
 *   visible to and usable by its owner alone. A workspace **admin** also sees
 *   it, read-only, named with its owner — so the organization's admins can
 *   see what exists and remove what someone left behind — but can never use,
 *   change or run it: it works with its owner's credentials. A **team**
 *   resource (`owner_team_id` set; `owner_user_id` keeps its creator, so code
 *   that doesn't know teams treats it as the creator's — it fails closed) is
 *   visible to and usable by the team's members; its team admins change it
 *   where the organization's admins would change an organization resource,
 *   its members where the organization's members would. An **organization**
 *   resource (both null) is visible to everyone in the workspace; who may
 *   change it is each resource's own role rule.
 *
 * `visibleOwner` is the SQL form of that rule, `canSee` the row form, and
 * `ownerForNew` / `canChange` the write side. See docs/scope.md and docs/teams.md.
 */

/** Who is asking. The same shape `work-ownership.ts` uses for work. */
export interface Actor {
  userId: string | null;
  workspaceId: string | null;
  isAdmin: boolean;
  /** The teams (in this workspace) the actor is an active member of. */
  teamIds?: string[];
  /** The teams the actor administers. */
  adminTeamIds?: string[];
  /** The workspace's work-visibility mode (services/work-visibility.ts); absent = organization. */
  workVisibility?: "organization" | "teams";
}

export function actorOf(req: FastifyRequest): Actor {
  return {
    userId: req.user?.id ?? null,
    workspaceId: req.user?.workspaceId ?? null,
    isAdmin: isAuthDisabled() || req.user?.workspaceRole === "admin",
    teamIds: req.user?.teamIds ?? [],
    adminTeamIds: req.user?.adminTeamIds ?? [],
    workVisibility: req.user?.workVisibility,
  };
}

/** A row's owner columns, as the helpers read them. */
export interface Owned {
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
}

const inTeam = (actor: Actor, teamId: string | null | undefined) =>
  !!teamId && (actor.teamIds ?? []).includes(teamId);
const adminOfTeam = (actor: Actor, teamId: string | null | undefined) =>
  !!teamId && (actor.adminTeamIds ?? []).includes(teamId);

/**
 * Rows `actor` may see, as a `WHERE` term on the table's `owner_user_id`
 * column (and, when the table has one, its `owner_team_id` column):
 * everything for an admin (undefined = no constraint), otherwise the
 * organization's rows, the actor's own, and their teams'.
 */
export function visibleOwner(column: Column, actor: Actor, teamColumn?: Column): SQL | undefined {
  if (actor.isAdmin) return undefined;
  const teamIds = teamColumn ? (actor.teamIds ?? []) : [];
  if (!actor.userId) return isNull(column);
  return or(
    isNull(column),
    eq(column, actor.userId),
    ...(teamIds.length > 0 ? [inArray(teamColumn!, teamIds)] : []),
  );
}

/**
 * Rows a piece of work may use, as a `WHERE` term. Organization work (no
 * owner) uses organization rows alone; a person's work uses those plus their
 * own private rows; a team's work uses the organization's plus the team's.
 */
export function usableBy(
  column: Column,
  ownerUserId: string | null | undefined,
  teamColumn?: Column,
  ownerTeamId?: string | null,
): SQL {
  if (teamColumn && ownerTeamId) return or(isNull(column), eq(teamColumn, ownerTeamId))!;
  return ownerUserId ? or(isNull(column), eq(column, ownerUserId))! : isNull(column);
}

/** The row form of `usableBy`. */
export function canUse(
  rowOwner: string | null | undefined,
  workOwner: string | null | undefined,
  rowTeam?: string | null,
  workTeam?: string | null,
): boolean {
  if (workTeam) return !rowOwner || (!!rowTeam && rowTeam === workTeam);
  if (rowTeam) return false;
  return !rowOwner || rowOwner === (workOwner ?? null);
}

/** Whether `actor` may see a row owned by `ownerUserId` (and `ownerTeamId`). */
export function canSee(
  ownerUserId: string | null | undefined,
  actor: Actor,
  ownerTeamId?: string | null,
): boolean {
  if (!ownerUserId) return true;
  if (actor.isAdmin) return true;
  if (ownerTeamId) return inTeam(actor, ownerTeamId);
  return ownerUserId === actor.userId;
}

/**
 * Whether `actor` may change (edit, use, run) a row owned by `ownerUserId`,
 * given `orgRule` — whether the actor may change the organization's rows of
 * this kind. A private row is its owner's alone; `delete` is also open to
 * admins (offboarding). A team row is its team admins' (and, for a kind
 * whose organization rows every member may change — `orgNeeds: "member"` —
 * its members'); workspace admins may delete it.
 */
export function canChange(
  ownerUserId: string | null | undefined,
  actor: Actor,
  orgRule: boolean,
  action: "edit" | "delete" = "edit",
  team?: { ownerTeamId: string | null | undefined; orgNeeds?: "admin" | "member" },
): boolean {
  if (isAuthDisabled()) return true;
  if (!ownerUserId) return orgRule;
  if (team?.ownerTeamId) {
    if (adminOfTeam(actor, team.ownerTeamId)) return true;
    if (team.orgNeeds === "member" && inTeam(actor, team.ownerTeamId)) return true;
    return action === "delete" && actor.isAdmin;
  }
  if (ownerUserId === actor.userId) return true;
  return action === "delete" && actor.isAdmin;
}

/** The 403 message for a change `canChange` refused. */
export function changeRefusal(
  ownerUserId: string | null | undefined,
  what: string,
  orgNeeds: "admin" | "member" = "admin",
  ownerTeamId?: string | null,
): string {
  if (ownerTeamId) {
    return orgNeeds === "member"
      ? `Only the team's members can change a team ${what}`
      : `Only the team's admins can change a team ${what}`;
  }
  return ownerUserId
    ? `Only its owner can change a private ${what}`
    : `Only an ${orgNeeds === "admin" ? "admin" : "member"} can change the organization's ${what}`;
}

export class OwnerError extends Error {
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = "OwnerError";
  }
}

/**
 * The owner columns a new row gets from the body's `owner` ("workspace" |
 * "me" | "team:<id>"): the actor for `me`; the actor and their team for a
 * team (which they must be an active member of — else a 403); null (the
 * organization's) otherwise. Without a signed-in user everything is the
 * organization's.
 */
export function ownerColumnsForNew(
  owner: ResourceOwner | string | undefined,
  actor: Actor,
): { ownerUserId: string | null; ownerTeamId: string | null } {
  if (!actor.userId) return { ownerUserId: null, ownerTeamId: null };
  const teamId = teamIdOf(owner);
  if (teamId) {
    if (!inTeam(actor, teamId)) throw new OwnerError("You're not a member of that team");
    return { ownerUserId: actor.userId, ownerTeamId: teamId };
  }
  return { ownerUserId: owner === "me" ? actor.userId : null, ownerTeamId: null };
}

/** `ownerColumnsForNew` for callers that only store a user owner (no teams yet). */
export function ownerForNew(owner: ResourceOwner | undefined, actor: Actor): string | null {
  return ownerColumnsForNew(owner, actor).ownerUserId;
}

/** The viewer's own private row. */
export function isMine(ownerUserId: string | null | undefined, actor: Actor): boolean {
  return !!ownerUserId && ownerUserId === actor.userId;
}

/** Display names for a set of owner ids (display name, else email). */
export async function ownerNames(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(found.map((u) => [u.id, u.displayName || u.email]));
}

/** Team names for a set of team ids. */
export async function teamNames(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const found = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, unique));
  return new Map(found.map((t) => [t.id, t.name]));
}

/** The `ownerName` a row carries for its viewer: set only for private rows. */
export function ownerNameFor(
  ownerUserId: string | null | undefined,
  names: Map<string, string>,
): string | null {
  return ownerUserId ? (names.get(ownerUserId) ?? "Someone") : null;
}

/**
 * Decorate private rows with `ownerName` and team rows with `ownerTeamName`;
 * the organization's rows are returned as they are.
 */
export async function withOwnerNames<T extends Owned>(
  rows: T[],
): Promise<Array<T & { ownerName?: string | null; ownerTeamName?: string | null }>> {
  const names = await ownerNames(rows.map((r) => r.ownerUserId));
  const tNames = await teamNames(rows.map((r) => r.ownerTeamId));
  return rows.map((r) =>
    r.ownerTeamId
      ? {
          ...r,
          ownerName: ownerNameFor(r.ownerUserId, names),
          ownerTeamName: tNames.get(r.ownerTeamId) ?? "A team",
        }
      : r.ownerUserId
        ? { ...r, ownerName: ownerNameFor(r.ownerUserId, names) }
        : r,
  );
}
