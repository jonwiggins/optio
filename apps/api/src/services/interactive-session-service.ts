import { randomUUID } from "node:crypto";
import { eq, and, desc, asc, sql, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  sessionPrs,
  sessionChatEvents,
  repos,
  repoPods,
} from "../db/schema.js";
import { publishEvent, publishSessionEvent } from "./event-bus.js";
import { InteractiveSessionState, normalizeRepoUrl, type PresetImageId } from "@optio/shared";
import { getOrCreateRepoPod } from "./repo-pool-service.js";
import { logger } from "../logger.js";

export async function createSession(input: {
  repoUrl: string;
  userId?: string;
  workspaceId?: string | null;
}) {
  const repoUrl = normalizeRepoUrl(input.repoUrl);

  // Look up repo config for branch and image settings
  const [repoConfig] = await db.select().from(repos).where(eq(repos.repoUrl, repoUrl));
  const repoBranch = repoConfig?.defaultBranch ?? "main";

  // Get or create a repo pod for this session
  const env: Record<string, string> = {
    OPTIO_REPO_URL: repoUrl,
    OPTIO_REPO_BRANCH: repoBranch,
  };

  // Add git credential helper URLs
  const apiInternalUrl =
    process.env.OPTIO_API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? "4000"}`;
  env.OPTIO_GIT_CREDENTIAL_URL = `${apiInternalUrl}/api/internal/git-credentials`;

  // Add credential secret for authentication
  const { getCredentialSecret } = await import("../routes/github-app.js");
  env.OPTIO_CREDENTIAL_SECRET = getCredentialSecret();

  // Try to find a GitHub token for the pod (fallback for old images without credential helper)
  try {
    const { getGitHubToken } = await import("./github-token-service.js");
    const ghToken = input.userId
      ? await getGitHubToken({ userId: input.userId })
      : await getGitHubToken({ server: true });
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
    networkPolicy: repoConfig?.networkPolicy ?? "unrestricted",
    cpuRequest: repoConfig?.cpuRequest,
    cpuLimit: repoConfig?.cpuLimit,
    memoryRequest: repoConfig?.memoryRequest,
    memoryLimit: repoConfig?.memoryLimit,
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
      workspaceId: input.workspaceId ?? null,
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
  userId?: string;
}) {
  const conditions = [];
  if (opts?.repoUrl) conditions.push(eq(interactiveSessions.repoUrl, opts.repoUrl));
  if (opts?.state) conditions.push(eq(interactiveSessions.state, opts.state as "active" | "ended"));
  if (opts?.userId) conditions.push(eq(interactiveSessions.userId, opts.userId));

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

// ── Session Chat Events ─────────────────────────────────────────────────────

/**
 * Per-session retention cap. Sessions can run for hours/days, and a busy
 * agent may emit thousands of events per turn. Keeping the most recent N
 * events keeps the chat usable on reconnect without unbounded table growth.
 * Older events are pruned synchronously as new ones are inserted.
 */
export const MAX_SESSION_CHAT_EVENTS = 5000;

export interface AppendSessionChatEventInput {
  sessionId: string;
  content: string;
  stream?: string;
  logType?: string;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

/**
 * Persist a single chat event for a session. Trims older events past the
 * retention cap so a long-running session doesn't grow unboundedly.
 */
export async function appendSessionChatEvent(input: AppendSessionChatEventInput) {
  const [event] = await db
    .insert(sessionChatEvents)
    .values({
      sessionId: input.sessionId,
      stream: input.stream ?? "stdout",
      content: input.content,
      logType: input.logType ?? null,
      metadata: input.metadata ?? null,
      timestamp: input.timestamp ?? new Date(),
    })
    .returning();

  // Best-effort retention prune. A bulk DELETE keyed on the cutoff timestamp
  // avoids a per-row lookup on the hot streaming path.
  try {
    const [cutoff] = await db
      .select({ ts: sessionChatEvents.timestamp })
      .from(sessionChatEvents)
      .where(eq(sessionChatEvents.sessionId, input.sessionId))
      .orderBy(desc(sessionChatEvents.timestamp))
      .limit(1)
      .offset(MAX_SESSION_CHAT_EVENTS);
    if (cutoff?.ts) {
      await db
        .delete(sessionChatEvents)
        .where(
          and(
            eq(sessionChatEvents.sessionId, input.sessionId),
            lte(sessionChatEvents.timestamp, cutoff.ts),
          ),
        );
    }
  } catch (err) {
    logger.warn({ err, sessionId: input.sessionId }, "Failed to prune session chat events");
  }

  return event;
}

export async function listSessionChatEvents(sessionId: string, opts?: { limit?: number }) {
  const limit = Math.min(opts?.limit ?? 1000, MAX_SESSION_CHAT_EVENTS);
  return db
    .select()
    .from(sessionChatEvents)
    .where(eq(sessionChatEvents.sessionId, sessionId))
    .orderBy(asc(sessionChatEvents.timestamp))
    .limit(limit);
}
