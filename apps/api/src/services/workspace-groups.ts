import { qualifiedGroupParts } from "@optio/shared";
import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { WorkspaceRole } from "@optio/shared";
import { db } from "../db/client.js";
import { users, workspaceMembers, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";

/**
 * Workspaces people reach through their identity-provider groups
 * (`workspaces.access_groups`, docs/sign-in.md) — the group counterpart of
 * sign-in by email domain (`auto_join_domains`, workspace-service.ts).
 *
 * - A workspace lists the groups whose members may be in it, and the role
 *   they get (member or viewer; never admin). Names are compared
 *   case-insensitively and stored lower-cased.
 * - On every sign-in, `joinWorkspacesByGroups` adds the person to each
 *   workspace one of their groups opens (`completeSignIn` calls it after the
 *   organization step), and fills the teams those workspaces map to the
 *   same groups.
 * - When an admin adds groups to a workspace, `admitUsersByGroups` sweeps
 *   the people who already signed in (`users.sso_groups`), so nobody has to
 *   sign in again.
 * - A workspace whose groups a person is in but which they aren't a member
 *   of yet is **discoverable** to them (`listDiscoverableWorkspaces`), and
 *   `joinDiscoverableWorkspace` lets them join it — checked server-side
 *   against their own groups, never the client's word.
 * - A membership a group made is marked (`joined_via_groups`). The directory
 *   sync (services/directory-sync.ts) calls `leaveWorkspacesByGroups`: once
 *   none of the person's groups opens the workspace, they leave it — unless
 *   an admin made them its admin. Memberships made by hand stay.
 *
 * Nothing here creates a workspace: a group opens workspaces an admin made.
 */

/** At most this many groups per workspace. */
export const MAX_ACCESS_GROUPS = 50;
const MAX_GROUP_NAME = 256;

export class WorkspaceGroupError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 409 = 403,
  ) {
    super(message);
    this.name = "WorkspaceGroupError";
  }
}

/** Lower-cased, trimmed, de-duplicated group names; an error when one can't be stored. */
export function normalizeAccessGroups(groups: string[]): { groups: string[] } | { error: string } {
  const out = new Set<string>();
  for (const raw of groups) {
    const g = raw.trim().toLowerCase();
    if (!g) continue;
    if (g.length > MAX_GROUP_NAME)
      return { error: `"${raw.slice(0, 40)}…" is too long for a group name` };
    out.add(g);
  }
  if (out.size > MAX_ACCESS_GROUPS) return { error: `At most ${MAX_ACCESS_GROUPS} groups` };
  return { groups: [...out].sort() };
}

/** The role people joining by group get: never admin. */
export function joinRoleOf(role: WorkspaceRole | null | undefined): "member" | "viewer" {
  return role === "viewer" ? "viewer" : "member";
}

const lowered = (groups: string[]) => [
  ...new Set(
    groups
      .filter((g) => qualifiedGroupParts(g))
      .map((g) => g.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** `(<g1>, <g2>, …)` as bound parameters (a JS array in `sql` would expand to a row, not an array). */
const list = (groups: string[]) =>
  sql`(${sql.join(
    groups.map((g) => sql`${g}`),
    sql`, `,
  )})`;

/** `WHERE` term: the workspace's access groups intersect `mine` (lower-cased, non-empty). */
const opensTo = (mine: string[]) =>
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${workspaces.accessGroups}) g WHERE lower(g) IN ${list(mine)})`;

/** `WHERE` term: the person's remembered groups intersect `groups` (lower-cased, non-empty). */
const userInGroups = (groups: string[]) =>
  sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${users.ssoGroups}) g WHERE lower(g) IN ${list(groups)})`;

/**
 * Add a person to a workspace with the workspace's group role; an existing
 * membership is kept as it is. Returns whether a row was inserted.
 */
async function admit(workspaceId: string, userId: string, role: WorkspaceRole): Promise<boolean> {
  const inserted = await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role: joinRoleOf(role), joinedViaGroups: true })
    .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
    .returning({ id: workspaceMembers.id });
  return inserted.length > 0;
}

/** A first-time user's default workspace becomes the first one joined. */
async function defaultTo(userId: string, workspaceId: string): Promise<void> {
  await db
    .update(users)
    .set({ defaultWorkspaceId: workspaceId })
    .where(and(eq(users.id, userId), isNull(users.defaultWorkspaceId)));
}

/**
 * After a sign-in: join every workspace one of `groups` opens, with its
 * group role. `completeSignIn` then fills the group-mapped teams of every
 * workspace the person is in (team-service.ts `syncTeamsAfterSignIn`).
 * Returns the ids joined.
 */
export async function joinWorkspacesByGroups(userId: string, groups: string[]): Promise<string[]> {
  const mine = lowered(groups);
  if (mine.length === 0) return [];
  const matching = await db
    .select({ id: workspaces.id, role: workspaces.accessGroupsRole })
    .from(workspaces)
    .where(opensTo(mine));
  const joined: string[] = [];
  for (const ws of matching) {
    if (await admit(ws.id, userId, ws.role)) joined.push(ws.id);
  }
  if (joined.length > 0) await defaultTo(userId, joined[0]);
  return joined;
}

/**
 * The directory sync's counterpart of `joinWorkspacesByGroups`: leave each
 * workspace a group put the person in (`joined_via_groups`) whose groups —
 * it still has some — none of `groups` is any more. Their group-mapped
 * teams there go too. Not a membership made by hand, nor one an admin made
 * the workspace's admin, nor a workspace whose groups were all removed (an
 * admin who stops using groups keeps its people). Returns the ids left.
 */
export async function leaveWorkspacesByGroups(userId: string, groups: string[]): Promise<string[]> {
  const mine = lowered(groups);
  const lost = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.joinedViaGroups, true),
        ne(workspaceMembers.role, "admin"),
        sql`jsonb_array_length(${workspaces.accessGroups}) > 0`,
        mine.length > 0 ? sql`NOT ${opensTo(mine)}` : undefined,
      ),
    );
  const left: string[] = [];
  for (const ws of lost) {
    const removed = await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws.id),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.joinedViaGroups, true),
          ne(workspaceMembers.role, "admin"),
        ),
      )
      .returning({ id: workspaceMembers.id });
    if (removed.length === 0) continue;
    left.push(ws.id);
    // A default workspace they left: the next request picks another (plugins/auth.ts).
    await db
      .update(users)
      .set({ defaultWorkspaceId: null })
      .where(and(eq(users.id, userId), eq(users.defaultWorkspaceId, ws.id)));
  }
  if (left.length > 0) logger.info({ userId, workspaceIds: left }, "Left workspaces by groups");
  return left;
}

/**
 * When a workspace's groups change: admit everyone who already signed in
 * with one of them (`users.sso_groups`), so a group added today works
 * without another sign-in. Returns how many people were added.
 */
export async function admitUsersByGroups(
  workspaceId: string,
  groups: string[],
  role: WorkspaceRole,
): Promise<number> {
  const mine = lowered(groups);
  if (mine.length === 0) return 0;
  const people = await db
    .select({ id: users.id, groups: users.ssoGroups })
    .from(users)
    .where(userInGroups(mine));
  let added = 0;
  for (const person of people) {
    if (await admit(workspaceId, person.id, role)) {
      added++;
      await defaultTo(person.id, workspaceId);
    }
  }
  return added;
}

export interface DiscoverableWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** The role joining gives. */
  role: "member" | "viewer";
}

/** The person's remembered groups, lower-cased. */
async function groupsOf(userId: string): Promise<string[]> {
  const [row] = await db
    .select({ groups: users.ssoGroups })
    .from(users)
    .where(eq(users.id, userId));
  return lowered(row?.groups ?? []);
}

/** Workspaces one of the person's groups opens that they aren't in yet. */
export async function listDiscoverableWorkspaces(userId: string): Promise<DiscoverableWorkspace[]> {
  const mine = await groupsOf(userId);
  if (mine.length === 0) return [];
  const memberOf = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      description: workspaces.description,
      role: workspaces.accessGroupsRole,
    })
    .from(workspaces)
    .where(and(opensTo(mine), notInArray(workspaces.id, memberOf)))
    .orderBy(workspaces.name);
  return rows.map((r) => ({ ...r, role: joinRoleOf(r.role) }));
}

/**
 * Join a discoverable workspace. The match is re-done here against the
 * person's own groups (403 when none opens it; 409 when already a member).
 */
export async function joinDiscoverableWorkspace(
  userId: string,
  workspaceId: string,
): Promise<{ role: "member" | "viewer" }> {
  const mine = await groupsOf(userId);
  const [ws] = mine.length
    ? await db
        .select({ id: workspaces.id, role: workspaces.accessGroupsRole })
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), opensTo(mine)))
    : [];
  if (!ws) throw new WorkspaceGroupError("Your groups don't give access to this workspace", 403);
  if (!(await admit(ws.id, userId, ws.role))) {
    throw new WorkspaceGroupError("You're already a member of this workspace", 409);
  }
  await defaultTo(userId, ws.id);
  return { role: joinRoleOf(ws.role) };
}
