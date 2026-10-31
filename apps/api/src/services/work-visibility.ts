import { eq, inArray, or, type Column, type SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { canSee, visibleOwner, type Actor } from "./ownership.js";

/**
 * Who sees whose work — the one rule for Tasks, scheduled Tasks, Jobs, Job
 * runs and persistent agents, on top of the scope rule in ownership.ts.
 *
 * A workspace's `work_visibility` picks the mode:
 *
 * - **organization** (upstream's rule, `visibleOwner`): the organization's
 *   work is everyone's to see, a person's their own, a team's its members'.
 * - **teams**: a member sees their own work, their teams' work and what they
 *   created (organization work included, when they made it) — nothing else.
 *   The organization's other work stays an admin's to see.
 *
 * `NULL` on the workspace means the deployment's default,
 * `OPTIO_WORK_VISIBILITY_DEFAULT` (`organization` when unset: upstream's
 * behaviour). The mode is a teams feature: while teams are off the auth
 * plugin never puts `teams` on the Actor, so the organization rule holds.
 * Admins see everything in both modes. Secrets, connections and the other
 * resources keep the scope rule alone.
 *
 * `visibleWork` is the SQL form, `canSeeWork` the row form; the auth plugin
 * puts the mode on the Actor once per request (`getWorkVisibility`).
 */

export type WorkVisibility = "organization" | "teams";

/** The deployment's default mode when a workspace sets none. */
export function defaultWorkVisibility(): WorkVisibility {
  return process.env.OPTIO_WORK_VISIBILITY_DEFAULT === "teams" ? "teams" : "organization";
}

/** A workspace row's mode, with the deployment's default filled in. */
export function workVisibilityOf(
  row: { workVisibility?: string | null } | null | undefined,
): WorkVisibility {
  return row?.workVisibility === "teams"
    ? "teams"
    : row?.workVisibility === "organization"
      ? "organization"
      : defaultWorkVisibility();
}

/** Per-workspace mode, remembered briefly: every request would read it otherwise. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: WorkVisibility; until: number }>();

/** The mode of a workspace (the deployment's default without one, or on a miss). */
export async function getWorkVisibility(
  workspaceId: string | null | undefined,
): Promise<WorkVisibility> {
  if (!workspaceId) return defaultWorkVisibility();
  const hit = cache.get(workspaceId);
  const now = Date.now();
  if (hit && hit.until > now) return hit.value;
  // A failed read throws: the request fails rather than widening what it shows.
  const [row] = await db
    .select({ workVisibility: workspaces.workVisibility })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const value = workVisibilityOf(row);
  cache.set(workspaceId, { value, until: now + CACHE_TTL_MS });
  return value;
}

/** Forget a workspace's cached mode (after PATCH /api/workspaces/:id). */
export function forgetWorkVisibility(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** The mode an actor sees work under (`organization` when the request carries none). */
export function actorWorkVisibility(actor: Actor): WorkVisibility {
  return actor.workVisibility === "teams" ? "teams" : "organization";
}

/**
 * The work `actor` may see, as a `WHERE` term on a work table's owner
 * columns: everything for an admin (undefined = no constraint); in
 * `organization` mode the scope rule (`visibleOwner`); in `teams` mode
 * the actor's own rows, their teams' and — when the table records it —
 * those they created. Nothing for someone who isn't signed in.
 */
export function visibleWork(
  ownerCol: Column,
  teamCol: Column | undefined,
  createdByCol: Column | undefined,
  actor: Actor,
): SQL | undefined {
  if (actor.executionTeamId) return teamCol ? eq(teamCol, actor.executionTeamId) : sql`false`;
  if (actor.isAdmin) return undefined;
  if (actorWorkVisibility(actor) === "organization") return visibleOwner(ownerCol, actor, teamCol);
  if (!actor.userId) return sql`false`;
  const teamIds = teamCol ? (actor.teamIds ?? []) : [];
  return or(
    eq(ownerCol, actor.userId),
    ...(teamIds.length > 0 ? [inArray(teamCol!, teamIds)] : []),
    ...(createdByCol ? [eq(createdByCol, actor.userId)] : []),
  );
}

/**
 * `visibleWork` over owner columns named in SQL rather than drizzle Columns
 * — a UNION's or a subquery's (routes/analytics.ts `costRows`). drizzle's
 * `eq` / `inArray` / `isNull` take any SQL on their left, so the terms are
 * the same.
 */
export function visibleWorkSql(
  ownerCol: SQL,
  teamCol: SQL | undefined,
  createdByCol: SQL | undefined,
  actor: Actor,
): SQL | undefined {
  const col = (c: SQL | undefined) => c as unknown as Column | undefined;
  return visibleWork(col(ownerCol)!, col(teamCol), col(createdByCol), actor);
}

/** The row form of `visibleWork`. */
export function canSeeWork(
  row: { ownerUserId?: string | null; ownerTeamId?: string | null; createdBy?: string | null },
  actor: Actor,
): boolean {
  if (actor.executionTeamId) return row.ownerTeamId === actor.executionTeamId;
  if (actor.isAdmin) return true;
  if (actorWorkVisibility(actor) === "organization") {
    return canSee(row.ownerUserId, actor, row.ownerTeamId);
  }
  if (!actor.userId) return false;
  // The same three terms as the SQL: own, a team's, or created by me.
  return (
    row.ownerUserId === actor.userId ||
    (!!row.ownerTeamId && (actor.teamIds ?? []).includes(row.ownerTeamId)) ||
    (!!row.createdBy && row.createdBy === actor.userId)
  );
}
