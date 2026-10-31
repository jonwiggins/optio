import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, workspaceMembers } from "../../db/schema.js";
import { canSee, type Actor } from "../ownership.js";
import { isEmailAddress } from "./mime.js";
import type { RecipientReason } from "./templates.js";

/** Email recipients are enabled workspace members who can see the work.
 * A work event addresses its owner, or the creator of organization work.
 */

/** The owner columns of a piece of work (a `tasks` row of either kind). */
export interface WorkOwnership {
  workspaceId: string | null;
  ownerUserId?: string | null;
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
  return {
    userId,
    workspaceId,
    isAdmin: member.role === "admin",
  };
}

/** Name and address per person (null: no usable address); disabled accounts are left out. */
async function contacts(
  userIds: string[],
): Promise<Map<string, { email: string | null; displayName: string }>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      displayName: users.displayName,
    })
    .from(users)
    // A disabled account (services/offboarding.ts) gets nothing.
    .where(and(inArray(users.id, userIds), isNull(users.disabledAt)));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        email: r.emailVerified && isEmailAddress(r.email) ? r.email : null,
        displayName: r.displayName,
      },
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
      if (input.work && !canSee(input.work.ownerUserId, actor)) continue;
    } else if (input.work) {
      const owner = input.work.ownerUserId ?? input.work.createdBy ?? null;
      if (owner !== c.userId) continue;
    }
    out.push({ userId: c.userId, ...contact, reason: c.reason });
  }
  return out;
}

/** `selectRecipients` with verified addresses and workspace roles read from the database. */
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
export function workCandidates(work: WorkOwnership): Candidate[] {
  const out: Candidate[] = [];
  if (work.ownerUserId) out.push({ userId: work.ownerUserId, reason: { why: "owner" } });
  else if (work.createdBy) out.push({ userId: work.createdBy, reason: { why: "creator" } });
  return out;
}

/** Who hears about `work`: its owner, or its starter for organization work. */
export async function workRecipients(work: WorkOwnership): Promise<Recipient[]> {
  return filterVisible(workCandidates(work), { workspaceId: work.workspaceId, work });
}
