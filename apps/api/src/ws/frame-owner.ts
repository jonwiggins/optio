import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgents, prReviews, workRuns } from "../db/schema.js";

/** Whose a piece of work is, and in which workspace: what /ws/events filters frames on. */
export interface WorkOwner {
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  createdBy: string | null;
}

/**
 * What a frame is about: a run (a Repo Task or a Job run — both rows of
 * `tasks`), an external PR review, or a persistent agent.
 */
export interface FrameSubject {
  kind: "run" | "pr-review" | "agent";
  id: string;
}

/**
 * Owners, remembered briefly. Every /ws/events connection filters the same
 * frames, so one lookup serves them all: the entry holds the lookup's
 * promise, and connections that ask while it runs share it. An owner rarely
 * changes, but a frame can name a row whose insert hasn't committed yet, so
 * "not found" is kept only for `MISS_TTL_MS` (long enough for one frame's
 * fan-out). A failed lookup isn't kept at all. The oldest entry goes once
 * there are `MAX_ENTRIES`.
 */
const TTL_MS = 10_000;
const MISS_TTL_MS = 1_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { until: number; owner: Promise<WorkOwner | null> }>();

/** The owner of a frame's subject; null when there is no such row. Rejects when the lookup fails. */
export function frameOwner(subject: FrameSubject): Promise<WorkOwner | null> {
  const key = `${subject.kind}:${subject.id}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.owner;
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const entry = { until: now + TTL_MS, owner: lookup(subject) };
  cache.set(key, entry);
  entry.owner.then(
    (owner) => {
      if (!owner) entry.until = Math.min(entry.until, Date.now() + MISS_TTL_MS);
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry.owner;
}

/** Forget every remembered owner (tests). */
export function forgetFrameOwners(): void {
  cache.clear();
}

async function lookup({ kind, id }: FrameSubject): Promise<WorkOwner | null> {
  if (kind === "pr-review") {
    const [row] = await db
      .select({ workspaceId: prReviews.workspaceId, createdBy: prReviews.createdBy })
      .from(prReviews)
      .where(eq(prReviews.id, id));
    // A review has no owner of its own: the organization's, made by whoever
    // asked for it (as routes/analytics.ts `costRows` reads it).
    return row ? { ...row, ownerUserId: null, ownerTeamId: null } : null;
  }
  if (kind === "agent") {
    const [row] = await db
      .select({
        workspaceId: persistentAgents.workspaceId,
        ownerUserId: persistentAgents.ownerUserId,
        ownerTeamId: persistentAgents.ownerTeamId,
        createdBy: persistentAgents.createdBy,
      })
      .from(persistentAgents)
      .where(eq(persistentAgents.id, id));
    return row ?? null;
  }
  const [row] = await db
    .select({
      workspaceId: workRuns.workspaceId,
      ownerUserId: workRuns.ownerUserId,
      ownerTeamId: workRuns.ownerTeamId,
      createdBy: workRuns.createdBy,
    })
    .from(workRuns)
    .where(eq(workRuns.id, id));
  return row ?? null;
}
