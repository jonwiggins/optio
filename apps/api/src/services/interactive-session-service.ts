import { randomUUID } from "node:crypto";
import { eq, and, desc, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getPod } from "./agent-pod-pool.js";
import { interactiveSessions, sessionPrs, sessionChatEvents, repos } from "../db/schema.js";
import { publishEvent, publishSessionEvent } from "./event-bus.js";
import {
  InteractiveSessionState,
  normalizeRepoUrl,
  shellQuote,
  type PresetImageId,
} from "@optio/shared";
import { getOrCreateRepoPod } from "./repo-pool-service.js";
import { logger } from "../logger.js";

export async function createSession(input: {
  repoUrl: string;
  userId?: string;
  workspaceId?: string | null;
  /** The name the user gave the session (New session form). */
  title?: string | null;
}) {
  const repoUrl = normalizeRepoUrl(input.repoUrl);
  const sessionId = randomUUID();

  // Look up repo config for branch and image settings
  const [repoConfig] = await db
    .select()
    .from(repos)
    .where(
      and(
        eq(repos.repoUrl, repoUrl),
        input.workspaceId ? eq(repos.workspaceId, input.workspaceId) : isNull(repos.workspaceId),
      ),
    );
  const repoBranch = repoConfig?.defaultBranch ?? "main";

  // Get or create a repo pod for this session
  const env: Record<string, string> = {
    OPTIO_REPO_URL: repoUrl,
    OPTIO_REPO_BRANCH: repoBranch,
  };

  const { applyGitAccess } = await import("./git-access-env.js");
  await applyGitAccess(env, { workspaceId: input.workspaceId ?? null, ownerUserId: input.userId });

  const imageConfig = repoConfig
    ? { preset: (repoConfig.imagePreset ?? "base") as PresetImageId }
    : undefined;
  const pod = await getOrCreateRepoPod(repoUrl, repoBranch, env, imageConfig, {
    workspaceId: input.workspaceId,
    ownerUserId: input.userId,
    isolationPurpose: `session:${sessionId}`,
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
      id: sessionId,
      repoUrl,
      userId: input.userId ?? null,
      worktreePath,
      branch,
      title: input.title?.trim() || null,
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
    const pod = await getPod(session.podId);
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
  workspaceId?: string | null;
}) {
  const conditions = [];
  if (opts?.workspaceId !== undefined)
    conditions.push(
      opts.workspaceId === null
        ? isNull(interactiveSessions.workspaceId)
        : eq(interactiveSessions.workspaceId, opts.workspaceId),
    );
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

  const { closeSessionStreams } = await import("./session-sharing-service.js");
  const { interruptSessionChat } = await import("./session-turn-service.js");
  closeSessionStreams("pod", id);
  interruptSessionChat(id);
  if (session.podId) {
    try {
      const { getRuntime } = await import("./container-service.js");
      const { podHandle } = await import("./agent-pod-pool.js");
      const pod = await getPod(session.podId);
      if (pod?.podName) {
        const exec = await getRuntime().exec(podHandle(pod), [
          "bash",
          "-c",
          ["", "-terminal-1", "-terminal-2"]
            .map(
              (suffix) =>
                `tmux -L optio kill-session -t ${shellQuote(`session-${id}${suffix}`)} 2>/dev/null || true`,
            )
            .join("\n"),
        ]);
        exec.stdout.resume();
        exec.stderr.resume();
      }
    } catch (err) {
      logger.warn({ err, sessionId: id }, "Unable to stop ended session's shell");
    }
  }

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

/**
 * Store (or clear, with `null`) the Claude Code session id the chat resumes
 * from. Cleared when a `--resume` fails so the next turn starts fresh.
 */
export async function updateSessionAgentSessionId(id: string, agentSessionId: string | null) {
  await db
    .update(interactiveSessions)
    .set({ agentSessionId })
    .where(eq(interactiveSessions.id, id));
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

export async function getActiveSessionCount(
  repoUrl?: string,
  workspaceId?: string | null,
  userId?: string,
) {
  const conditions = [eq(interactiveSessions.state, "active")];
  if (workspaceId !== undefined)
    conditions.push(
      workspaceId === null
        ? isNull(interactiveSessions.workspaceId)
        : eq(interactiveSessions.workspaceId, workspaceId),
    );
  if (userId) conditions.push(eq(interactiveSessions.userId, userId));
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
      .orderBy(desc(sessionChatEvents.timestamp), desc(sessionChatEvents.seq))
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

/**
 * A session's chat history: the newest `limit` events (default 1000, at most
 * the retention cap), oldest first. A long session keeps up to
 * MAX_SESSION_CHAT_EVENTS; a shorter window must be its latest stretch, the
 * part a replay or a history view has to show.
 */
export async function listSessionChatEvents(sessionId: string, opts?: { limit?: number }) {
  const limit = Math.min(opts?.limit ?? 1000, MAX_SESSION_CHAT_EVENTS);
  const newestFirst = await db
    .select()
    .from(sessionChatEvents)
    .where(eq(sessionChatEvents.sessionId, sessionId))
    // seq breaks ties: several events share one millisecond.
    .orderBy(desc(sessionChatEvents.timestamp), desc(sessionChatEvents.seq))
    .limit(limit);
  return newestFirst.reverse();
}

/**
 * How recent an `ended` session is allowed to be to count toward the
 * Sessions stats bar. Past this window the session disappears from the
 * "what's been live recently" picture so the Done bucket reflects today's
 * activity, not historical noise.
 */
export const SESSION_RECENT_ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Per-state counts of interactive sessions in a workspace. Drives the
 * Sessions stats bar on the overview dashboard — shape mirrors
 * `getTaskStats()` / `getWorkflowRunStats()` so the frontend can treat all
 * four execution surfaces symmetrically.
 *
 * `ended` is windowed (last 24h) to keep the bar focused on recent
 * activity. `total` is the sum of `active` + `ended` (within the window),
 * not a lifetime count.
 */
export async function getSessionStats(workspaceId?: string | null) {
  const wsFilter =
    workspaceId === undefined
      ? undefined
      : workspaceId === null
        ? isNull(interactiveSessions.workspaceId)
        : eq(interactiveSessions.workspaceId, workspaceId);

  const recentSince = new Date(Date.now() - SESSION_RECENT_ENDED_WINDOW_MS);

  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(interactiveSessions)
    .where(
      wsFilter
        ? and(eq(interactiveSessions.state, "active"), wsFilter)
        : eq(interactiveSessions.state, "active"),
    );

  const [endedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(interactiveSessions)
    .where(
      and(
        eq(interactiveSessions.state, "ended"),
        gte(interactiveSessions.endedAt, recentSince),
        ...(wsFilter ? [wsFilter] : []),
      ),
    );

  const active = activeRow?.count ?? 0;
  const ended = endedRow?.count ?? 0;

  return { total: active + ended, active, ended };
}
