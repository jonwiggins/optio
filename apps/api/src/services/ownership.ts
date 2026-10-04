import type { FastifyRequest } from "fastify";
import { eq, inArray, isNull, or, type Column, type SQL } from "drizzle-orm";
import type { ResourceOwner } from "@optio/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { isAuthDisabled } from "./oauth/index.js";

/**
 * Organization and private scope — the one rule every scoped resource
 * follows (secrets, connections, model providers, MCP servers, skills,
 * prompts, and work of every kind):
 *
 *   A **private** resource (`owner_user_id` set) is visible to and usable by
 *   its owner alone. A workspace **admin** also sees it, read-only, named
 *   with its owner — so the organization's admins can see what exists and
 *   remove what someone left behind — but can never use, change or run it:
 *   it works with its owner's credentials. An **organization** resource
 *   (`owner_user_id` null) is visible to everyone in the workspace; who may
 *   change it is each resource's own role rule.
 *
 * `visibleOwner` is the SQL form of that rule, `canSee` the row form, and
 * `ownerForNew` / `canChange` the write side. See docs/plans/org-scoping-and-sso.md.
 */

/** Who is asking. The same shape `work-ownership.ts` uses for work. */
export interface Actor {
  userId: string | null;
  workspaceId: string | null;
  isAdmin: boolean;
}

export function actorOf(req: FastifyRequest): Actor {
  return {
    userId: req.user?.id ?? null,
    workspaceId: req.user?.workspaceId ?? null,
    isAdmin: isAuthDisabled() || req.user?.workspaceRole === "admin",
  };
}

/**
 * Rows `actor` may see, as a `WHERE` term on the table's `owner_user_id`
 * column: everything for an admin (undefined = no constraint), otherwise the
 * organization's rows and the actor's own.
 */
export function visibleOwner(column: Column, actor: Actor): SQL | undefined {
  if (actor.isAdmin) return undefined;
  if (!actor.userId) return isNull(column);
  return or(isNull(column), eq(column, actor.userId));
}

/**
 * Rows a piece of work owned by `ownerUserId` may use, as a `WHERE` term: the
 * organization's, plus the owner's own private rows. Organization work (null
 * owner) uses organization rows alone.
 */
export function usableBy(column: Column, ownerUserId: string | null | undefined): SQL {
  return ownerUserId ? or(isNull(column), eq(column, ownerUserId))! : isNull(column);
}

/** The row form of `usableBy`. */
export function canUse(
  rowOwner: string | null | undefined,
  workOwner: string | null | undefined,
): boolean {
  return !rowOwner || rowOwner === (workOwner ?? null);
}

/** Whether `actor` may see a row owned by `ownerUserId`. */
export function canSee(ownerUserId: string | null | undefined, actor: Actor): boolean {
  if (!ownerUserId) return true;
  return actor.isAdmin || ownerUserId === actor.userId;
}

/**
 * Whether `actor` may change (edit, use, run) a row owned by `ownerUserId`,
 * given `orgRule` — whether the actor may change the organization's rows of
 * this kind. A private row is its owner's alone; `delete` is also open to
 * admins (offboarding).
 */
export function canChange(
  ownerUserId: string | null | undefined,
  actor: Actor,
  orgRule: boolean,
  action: "edit" | "delete" = "edit",
): boolean {
  if (isAuthDisabled()) return true;
  if (!ownerUserId) return orgRule;
  if (ownerUserId === actor.userId) return true;
  return action === "delete" && actor.isAdmin;
}

/** The 403 message for a change `canChange` refused. */
export function changeRefusal(
  ownerUserId: string | null | undefined,
  what: string,
  orgNeeds: "admin" | "member" = "admin",
): string {
  return ownerUserId
    ? `Only its owner can change a private ${what}`
    : `Only an ${orgNeeds === "admin" ? "admin" : "member"} can change the organization's ${what}`;
}

/**
 * The owner a new row gets from the body's `owner` ("workspace" | "me"):
 * the actor for `me`; null (the organization's) otherwise. Without a
 * signed-in user everything is the organization's.
 */
export function ownerForNew(owner: ResourceOwner | undefined, actor: Actor): string | null {
  if (!actor.userId) return null;
  return owner === "me" ? actor.userId : null;
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

/** The `ownerName` a row carries for its viewer: set only for private rows. */
export function ownerNameFor(
  ownerUserId: string | null | undefined,
  names: Map<string, string>,
): string | null {
  return ownerUserId ? (names.get(ownerUserId) ?? "Someone") : null;
}

/** Decorate rows with `ownerName` (private rows only; null for the organization's). */
export async function withOwnerNames<T extends { ownerUserId?: string | null }>(
  rows: T[],
): Promise<Array<T & { ownerName: string | null }>> {
  const names = await ownerNames(rows.map((r) => r.ownerUserId));
  return rows.map((r) => ({ ...r, ownerName: ownerNameFor(r.ownerUserId, names) }));
}
