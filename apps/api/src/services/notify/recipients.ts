import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { teamMembers, teams, users, workspaceMembers } from "../../db/schema.js";
import type { Actor } from "../ownership.js";
import { canSeeWork, getWorkVisibility } from "../work-visibility.js";
import { isEmailAddress } from "./mime.js";
import type { RecipientReason } from "./templates.js";

/**
 * Who hears about a piece of work, and the rule that keeps everyone else
 * out: a notification about work goes only to people who may see it
 * (services/work-visibility.ts `canSeeWork`, with the person's own teams,
 * role and the workspace's visibility mode — what the Work list would show
 * them), and who are still members of its workspace.
 *
 *   - the work's owner (`owner_user_id`; for a team's work, its creator),
 *     or for the organization's work the person who started it;
 *   - for a team's work, the team's admins.
 */

/** The owner columns of a piece of work (a `tasks` row of either kind). */
export interface WorkOwnership {
  workspaceId: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  createdBy?: string | null;
}

export interface Recipient {
  userId: string;
  /** Null when their sign-in gave no usable address: chat only (chat-hooks.ts). */
  email: string | null;
  displayName: string;
  reason: RecipientReason;
}

/** The Actor the auth plugin would build for `userId` in `workspaceId`; null when not a member. */
export async function actorFor(userId: string, workspaceId: string): Promise<Actor | null> {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!member) return null;
  const mine = await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.status, "active"),
        eq(teams.workspaceId, workspaceId),
      ),
    );
  return {
    userId,
    workspaceId,
    isAdmin: member.role === "admin",
    teamIds: mine.map((m) => m.teamId),
    adminTeamIds: mine.filter((m) => m.role === "admin").map((m) => m.teamId),
    workVisibility: await getWorkVisibility(workspaceId),
  };
}

/** The active admins of a team, with the team's name and workspace. */
export async function teamAdmins(
  teamId: string,
): Promise<{ teamName: string | null; workspaceId: string | null; userIds: string[] }> {
  const [team] = await db
    .select({ name: teams.name, workspaceId: teams.workspaceId })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!team) return { teamName: null, workspaceId: null, userIds: [] };
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.role, "admin"),
        eq(teamMembers.status, "active"),
      ),
    );
  return { teamName: team.name, workspaceId: team.workspaceId, userIds: rows.map((r) => r.userId) };
}

/** Name and address per person (null: no usable address); disabled accounts are left out. */
async function contacts(
  userIds: string[],
): Promise<Map<string, { email: string | null; displayName: string }>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    // A disabled account (services/offboarding.ts) gets nothing.
    .where(and(inArray(users.id, userIds), isNull(users.disabledAt)));
  return new Map(
    rows.map((r) => [
      r.id,
      { email: isEmailAddress(r.email) ? r.email : null, displayName: r.displayName },
    ]),
  );
}

export interface Candidate {
  userId: string;
  reason: RecipientReason;
}

/**
 * The rule, without the database: of `candidates` (in order, once each),
 * keep those Optio knows (and hasn't disabled), who are members of the workspace (an Actor
 * in `actors`) and — when the message is about `work` — may see it. Work
 * with no workspace (rows from before workspaces) goes to its owner only.
 */
export function selectRecipients(input: {
  candidates: Candidate[];
  contacts: Map<string, { email: string | null; displayName: string }>;
  actors: Map<string, Actor | null>;
  workspaceId: string | null;
  work?: WorkOwnership | null;
}): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const c of input.candidates) {
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    const contact = input.contacts.get(c.userId);
    if (!contact) continue;
    if (input.workspaceId) {
      const actor = input.actors.get(c.userId);
      if (!actor) continue;
      if (input.work && !canSeeWork(input.work, actor)) continue;
    } else if (input.work) {
      const owner = input.work.ownerUserId ?? input.work.createdBy ?? null;
      if (owner !== c.userId) continue;
    }
    out.push({ userId: c.userId, ...contact, reason: c.reason });
  }
  return out;
}

/** `selectRecipients` with the people's addresses, roles and teams read from the database. */
export async function filterVisible(
  candidates: Candidate[],
  scope: { workspaceId: string | null; work?: WorkOwnership | null },
): Promise<Recipient[]> {
  const ids = [...new Set(candidates.map((c) => c.userId))];
  const contactsById = await contacts(ids);
  const actors = new Map<string, Actor | null>();
  if (scope.workspaceId) {
    for (const id of ids) {
      if (contactsById.has(id)) actors.set(id, await actorFor(id, scope.workspaceId));
    }
  }
  return selectRecipients({
    candidates,
    contacts: contactsById,
    actors,
    workspaceId: scope.workspaceId,
    work: scope.work,
  });
}

/** The people a piece of work's events are for, before the visibility rule. */
export function workCandidates(
  work: WorkOwnership,
  admins: { teamName: string | null; userIds: string[] } | null,
): Candidate[] {
  const out: Candidate[] = [];
  if (work.ownerUserId) out.push({ userId: work.ownerUserId, reason: { why: "owner" } });
  else if (work.createdBy) out.push({ userId: work.createdBy, reason: { why: "creator" } });
  for (const userId of admins?.userIds ?? []) {
    out.push({ userId, reason: { why: "team-admin", teamName: admins?.teamName ?? null } });
  }
  return out;
}

/** Who hears about `work`: its owner (or starter) and, for a team's work, the team's admins. */
export async function workRecipients(work: WorkOwnership): Promise<Recipient[]> {
  const admins = work.ownerTeamId ? await teamAdmins(work.ownerTeamId) : null;
  return filterVisible(workCandidates(work, admins), { workspaceId: work.workspaceId, work });
}
