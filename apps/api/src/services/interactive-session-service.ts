import { randomUUID } from "node:crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { interactiveSessions, sessionPrs, repos, repoPods } from "../db/schema.js";
import { publishEvent, publishSessionEvent } from "./event-bus.js";
import { InteractiveSessionState, normalizeRepoUrl, type PresetImageId } from "@optio/shared";
import { getOrCreateRepoPod } from "./repo-pool-service.js";
import { logger } from "../logger.js";

export async function createSession(input: { repoUrl: string; userId?: string }) {
  const repoUrl = normalizeRepoUrl(input.repoUrl);

  // Look up repo config for branch and image settings
  const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, repoUrl));
  const repoBranch = repoConfig?.defaultBranch ?? "main";

  // Get or create a repo pod for this session
  const env: Record<string, string> = {
    OPTIO_REPO_URL: repoUrl,
    OPTIO_REPO_BRANCH: repoBranch,
  };

  // Try to find a GITHUB_TOKEN secret for the pod
  try {
    const { retrieveSecret } = await import("./secret-service.js");
    const ghToken = await retrieveSecret("GITHUB_TOKEN");
    if (ghToken) env.GITHUB_TOKEN = ghToken;
  } catch {
    // No token, that's fine
  }

  const imageConfig = repoConfig
    ? { preset: (repoConfig.imagePreset ?? "base") as PresetImageId }
    : undefined;
  const pod = await getOrCreateRepoPod(repoUrl, repoBranch, env, imageConfig, {
    maxAgentsPerPod: repoConfig?.maxAgentsPerPod ?? 2,
    maxPodInstances: repoConfig?.maxPodInstances ?? 1,
  });

  // Generate a short ID for the branch name
  const shortId = randomUUID().slice(0, 8);
  const username = input.userId ? input.userId.slice(0, 8) : "anon";
  const branch = `session/${username}/${shortId}`;
  const worktreePath = `/workspace/sessions/${shortId}`;

  const [session] = await db
    .insert(interactiveSessions)
    .values({
      repoUrl,
      userId: input.userId ?? null,
      worktreePath,
      branch,
      state: "active",
      podId: pod.id,
    })
    .returning();

  await publishEvent({
    type: "session:created",
    sessionId: session.id,
    repoUrl,
    state: InteractiveSessionState.ACTIVE,
    timestamp: new Date().toISOString(),
  });

  await publishSessionEvent(session.id, {
    type: "session:created",
    sessionId: session.id,
    repoUrl,
    state: InteractiveSessionState.ACTIVE,
    timestamp: new Date().toISOString(),
  });

  return { ...session, podName: pod.podName };
}

export async function getSession(id: string) {
  const [session] = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, id));
  if (!session) return null;

  // Get pod info
  let podName: string | null = null;
  if (session.podId) {
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
    podName = pod?.podName ?? null;
  }

  return { ...session, podName };
}

export async function listSessions(opts?: {
  repoUrl?: string;
  state?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions = [];
  if (opts?.repoUrl) conditions.push(eq(interactiveSessions.repoUrl, opts.repoUrl));
  if (opts?.state) conditions.push(eq(interactiveSessions.state, opts.state as "active" | "ended"));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sessionList = await db
    .select()
    .from(interactiveSessions)
    .where(where)
    .orderBy(desc(interactiveSessions.createdAt))
    .limit(opts?.limit ?? 50)
    .offset(opts?.offset ?? 0);

  return sessionList;
}

export async function endSession(id: string) {
  const session = await getSession(id);
  if (!session) throw new Error("Session not found");
  if (session.state === "ended") throw new Error("Session already ended");

  const [updated] = await db
    .update(interactiveSessions)
    .set({
      state: "ended",
      endedAt: new Date(),
    })
    .where(eq(interactiveSessions.id, id))
    .returning();

  await publishEvent({
    type: "session:ended",
    sessionId: id,
    timestamp: new Date().toISOString(),
  });

  await publishSessionEvent(id, {
    type: "session:ended",
    sessionId: id,
    timestamp: new Date().toISOString(),
  });

  return updated;
}

export async function getSessionPrs(sessionId: string) {
  return db
    .select()
    .from(sessionPrs)
    .where(eq(sessionPrs.sessionId, sessionId))
    .orderBy(desc(sessionPrs.createdAt));
}

export async function addSessionPr(sessionId: string, prUrl: string, prNumber: number) {
  const [pr] = await db
    .insert(sessionPrs)
    .values({
      sessionId,
      prUrl,
      prNumber,
      prState: "open",
      prChecksStatus: "pending",
      prReviewStatus: "none",
    })
    .returning();
  return pr;
}

export async function updateSessionPr(
  prId: string,
  updates: {
    prState?: string;
    prChecksStatus?: string;
    prReviewStatus?: string;
  },
) {
  const [updated] = await db
    .update(sessionPrs)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(sessionPrs.id, prId))
    .returning();
  return updated;
}

export async function getActiveSessionCount(repoUrl?: string) {
  const conditions = [eq(interactiveSessions.state, "active")];
  if (repoUrl) conditions.push(eq(interactiveSessions.repoUrl, repoUrl));

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(interactiveSessions)
    .where(and(...conditions));

  return count;
}
