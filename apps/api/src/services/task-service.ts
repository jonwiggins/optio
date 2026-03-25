import { eq, desc, and, or, ilike, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, taskEvents, taskLogs, users } from "../db/schema.js";
import { TaskState, transition, normalizeRepoUrl, type CreateTaskInput } from "@optio/shared";
import { publishEvent } from "./event-bus.js";
import { logger } from "../logger.js";
import { enqueueWebhookEvent } from "../workers/webhook-worker.js";
import type { WebhookEvent } from "./webhook-service.js";

/**
 * Thrown when a state transition fails because another worker changed the
 * state between our read and write (atomic conditional update returned 0 rows).
 */
export class StateRaceError extends Error {
  constructor(
    public readonly attemptedFrom: TaskState,
    public readonly attemptedTo: TaskState,
    public readonly actualState: TaskState | undefined,
  ) {
    super(
      `State race: expected ${attemptedFrom} → ${attemptedTo}, but state is now ${actualState ?? "unknown"}`,
    );
    this.name = "StateRaceError";
  }
}

export async function createTask(input: CreateTaskInput) {
  const [task] = await db
    .insert(tasks)
    .values({
      title: input.title,
      prompt: input.prompt,
      repoUrl: normalizeRepoUrl(input.repoUrl),
      repoBranch: input.repoBranch ?? "main",
      agentType: input.agentType,
      ticketSource: input.ticketSource,
      ticketExternalId: input.ticketExternalId,
      metadata: input.metadata,
      maxRetries: input.maxRetries ?? 3,
      priority: input.priority ?? 100,
    })
    .returning();

  await publishEvent({
    type: "task:created",
    taskId: task.id,
    title: task.title,
    timestamp: new Date().toISOString(),
  });

  return task;
}

export async function getTask(id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  return task ?? null;
}

export async function listTasks(opts?: { state?: string; limit?: number; offset?: number }) {
  let query = db.select().from(tasks).orderBy(desc(tasks.createdAt));
  if (opts?.state) {
    query = query.where(eq(tasks.state, opts.state as any)) as typeof query;
  }
  if (opts?.limit) {
    query = query.limit(opts.limit) as typeof query;
  }
  if (opts?.offset) {
    query = query.offset(opts.offset) as typeof query;
  }
  return query;
}

export interface SearchTasksOpts {
  q?: string;
  state?: string;
  repoUrl?: string;
  agentType?: string;
  taskType?: string;
  costMin?: string;
  costMax?: string;
  createdAfter?: string;
  createdBefore?: string;
  author?: string;
  cursor?: string;
  limit?: number;
}

export async function searchTasks(opts: SearchTasksOpts) {
  const limit = opts.limit ?? 50;
  const conditions = [];

  // Full-text search on title and prompt
  if (opts.q) {
    const pattern = `%${opts.q}%`;
    conditions.push(or(ilike(tasks.title, pattern), ilike(tasks.prompt, pattern))!);
  }

  // Exact field filters
  if (opts.state) {
    conditions.push(eq(tasks.state, opts.state as any));
  }
  if (opts.repoUrl) {
    conditions.push(eq(tasks.repoUrl, normalizeRepoUrl(opts.repoUrl)));
  }
  if (opts.agentType) {
    conditions.push(eq(tasks.agentType, opts.agentType));
  }
  if (opts.taskType) {
    conditions.push(eq(tasks.taskType, opts.taskType));
  }
  if (opts.author) {
    conditions.push(eq(tasks.createdBy, opts.author));
  }

  // Cost range (costUsd is stored as text, cast to numeric for comparison)
  if (opts.costMin) {
    conditions.push(sql`CAST(${tasks.costUsd} AS numeric) >= ${Number(opts.costMin)}`);
  }
  if (opts.costMax) {
    conditions.push(sql`CAST(${tasks.costUsd} AS numeric) <= ${Number(opts.costMax)}`);
  }

  // Date range
  if (opts.createdAfter) {
    conditions.push(gte(tasks.createdAt, new Date(opts.createdAfter)));
  }
  if (opts.createdBefore) {
    conditions.push(lte(tasks.createdAt, new Date(opts.createdBefore)));
  }

  // Cursor-based pagination: cursor is base64 of "createdAt|id"
  if (opts.cursor) {
    const decoded = Buffer.from(opts.cursor, "base64").toString();
    const sepIdx = decoded.indexOf("|");
    if (sepIdx !== -1) {
      const cursorDate = decoded.slice(0, sepIdx);
      const cursorId = decoded.slice(sepIdx + 1);
      conditions.push(
        or(
          sql`${tasks.createdAt} < ${new Date(cursorDate)}`,
          and(eq(tasks.createdAt, new Date(cursorDate) as any), sql`${tasks.id} < ${cursorId}`),
        )!,
      );
    }
  }

  let query = db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit + 1);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  const results = await query;
  const hasMore = results.length > limit;
  const items = hasMore ? results.slice(0, limit) : results;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64");
  }

  return { tasks: items, nextCursor, hasMore };
}

export async function transitionTask(
  id: string,
  toState: TaskState,
  trigger: string,
  message?: string,
  userId?: string,
) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  const currentState = task.state as TaskState;
  transition(currentState, toState); // throws if invalid

  const updateFields: Record<string, unknown> = {
    state: toState,
    updatedAt: new Date(),
  };

  if (toState === TaskState.RUNNING && !task.startedAt) {
    updateFields.startedAt = new Date();
  }
  if (
    toState === TaskState.COMPLETED ||
    toState === TaskState.FAILED ||
    toState === TaskState.CANCELLED
  ) {
    updateFields.completedAt = new Date();
  }
  // Clear error fields on successful completion (PR merged after prior errors)
  if (toState === TaskState.COMPLETED) {
    updateFields.errorMessage = null;
    updateFields.resultSummary = null;
  }
  // Reset fields when retrying/re-queuing
  if (toState === TaskState.QUEUED) {
    updateFields.errorMessage = null;
    updateFields.resultSummary = null;
    updateFields.completedAt = null;
    updateFields.startedAt = null;
    updateFields.containerId = null;
  }

  // Atomic conditional update — only succeeds if state hasn't changed since we read it
  const updated = await db
    .update(tasks)
    .set(updateFields)
    .where(and(eq(tasks.id, id), eq(tasks.state, currentState as any)))
    .returning();

  if (updated.length === 0) {
    // Another worker changed the state between our read and write
    const fresh = await getTask(id);
    throw new StateRaceError(currentState, toState, fresh?.state as TaskState);
  }

  await db.insert(taskEvents).values({
    taskId: id,
    fromState: currentState,
    toState,
    trigger,
    message,
    userId,
  });

  await publishEvent({
    type: "task:state_changed",
    taskId: id,
    fromState: currentState,
    toState,
    timestamp: new Date().toISOString(),
  });

  // Close linked GitHub issue when task completes
  if (toState === TaskState.COMPLETED && task.ticketSource === "github" && task.ticketExternalId) {
    closeGitHubIssue(task.repoUrl, task.ticketExternalId, task.prUrl).catch((err) =>
      logger.warn({ err, taskId: id }, "Failed to close linked GitHub issue"),
    );
  }

  // Dispatch webhook notifications for relevant state changes
  const webhookEventMap: Partial<Record<TaskState, WebhookEvent>> = {
    [TaskState.COMPLETED]: task.taskType === "review" ? "review.completed" : "task.completed",
    [TaskState.FAILED]: "task.failed",
    [TaskState.NEEDS_ATTENTION]: "task.needs_attention",
    [TaskState.PR_OPENED]: "task.pr_opened",
  };
  const webhookEvent = webhookEventMap[toState];
  if (webhookEvent) {
    enqueueWebhookEvent(webhookEvent, {
      taskId: id,
      taskTitle: task.title,
      repoUrl: task.repoUrl,
      repoBranch: task.repoBranch,
      fromState: currentState,
      toState,
      prUrl: updated[0].prUrl ?? undefined,
      errorMessage: updated[0].errorMessage ?? undefined,
      taskType: task.taskType,
    }).catch((err) => logger.warn({ err, taskId: id }, "Failed to enqueue webhook event"));
  }

  return updated[0];
}

async function closeGitHubIssue(repoUrl: string, issueNumber: string, prUrl?: string | null) {
  const { retrieveSecret } = await import("./secret-service.js");
  const token = await retrieveSecret("GITHUB_TOKEN");
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return;
  const [, owner, repo] = match;

  // Post completion comment
  const comment = prUrl
    ? `✅ **Optio** completed this issue. Changes merged in ${prUrl}.`
    : `✅ **Optio** completed this issue.`;

  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Optio",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: comment }),
  });

  // Close the issue
  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Optio",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });

  logger.info({ owner, repo, issueNumber }, "Closed linked GitHub issue");
}

/**
 * Like transitionTask, but returns null instead of throwing when another
 * worker wins the race. Used by the task worker at the critical
 * queued → provisioning claim point.
 */
export async function tryTransitionTask(
  id: string,
  toState: TaskState,
  trigger: string,
  message?: string,
  userId?: string,
) {
  try {
    return await transitionTask(id, toState, trigger, message, userId);
  } catch (err) {
    if (err instanceof StateRaceError) {
      return null;
    }
    throw err;
  }
}

/**
 * Bump tasks.updatedAt without a state transition or event.
 * Called periodically during log streaming so the stale detector
 * knows the task is still active.
 */
export async function touchTaskHeartbeat(id: string) {
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));
}

export async function updateTaskContainer(id: string, containerId: string) {
  await db.update(tasks).set({ containerId, updatedAt: new Date() }).where(eq(tasks.id, id));
}

export async function updateTaskPr(id: string, prUrl: string) {
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;
  await db
    .update(tasks)
    .set({ prUrl, ...(prNumber != null && { prNumber }), updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

export async function updateTaskSession(id: string, sessionId: string) {
  await db.update(tasks).set({ sessionId, updatedAt: new Date() }).where(eq(tasks.id, id));
}

export async function updateTaskResult(id: string, resultSummary?: string, errorMessage?: string) {
  await db
    .update(tasks)
    .set({ resultSummary, errorMessage, updatedAt: new Date() })
    .where(eq(tasks.id, id));
}

export async function appendTaskLog(
  taskId: string,
  content: string,
  stream = "stdout",
  logType?: string,
  metadata?: Record<string, unknown>,
) {
  await db.insert(taskLogs).values({ taskId, content, stream, logType, metadata });

  await publishEvent({
    type: "task:log",
    taskId,
    stream: stream as "stdout" | "stderr",
    content,
    timestamp: new Date().toISOString(),
  });
}

export async function getTaskLogs(
  taskId: string,
  opts?: { limit?: number; offset?: number; search?: string; logType?: string },
) {
  const conditions = [eq(taskLogs.taskId, taskId)];
  if (opts?.logType) {
    conditions.push(eq(taskLogs.logType, opts.logType));
  }
  if (opts?.search) {
    conditions.push(ilike(taskLogs.content, `%${opts.search}%`));
  }
  let query = db
    .select()
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(taskLogs.timestamp);
  if (opts?.limit) query = query.limit(opts.limit) as typeof query;
  if (opts?.offset) query = query.offset(opts.offset) as typeof query;
  return query;
}

export async function getAllTaskLogs(taskId: string, opts?: { search?: string; logType?: string }) {
  const conditions = [eq(taskLogs.taskId, taskId)];
  if (opts?.logType) {
    conditions.push(eq(taskLogs.logType, opts.logType));
  }
  if (opts?.search) {
    conditions.push(ilike(taskLogs.content, `%${opts.search}%`));
  }
  return db
    .select()
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(taskLogs.timestamp);
}

export async function forceRedoTask(id: string) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  // Clear all execution data and reset to queued
  await db
    .update(tasks)
    .set({
      state: TaskState.QUEUED,
      sessionId: null,
      containerId: null,
      prUrl: null,
      prNumber: null,
      prState: null,
      prChecksStatus: null,
      prReviewStatus: null,
      prReviewComments: null,
      resultSummary: null,
      costUsd: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));

  // Delete all logs
  await db.delete(taskLogs).where(eq(taskLogs.taskId, id));

  // Record the force-redo event (keep event history for audit)
  const fromState = task.state as TaskState;
  await db.insert(taskEvents).values({
    taskId: id,
    fromState,
    toState: TaskState.QUEUED,
    trigger: "force_redo",
    message: `Force redo from ${fromState}`,
  });

  await publishEvent({
    type: "task:state_changed",
    taskId: id,
    fromState,
    toState: TaskState.QUEUED,
    timestamp: new Date().toISOString(),
  });

  return await getTask(id);
}

export async function getTaskEvents(taskId: string) {
  const rows = await db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      fromState: taskEvents.fromState,
      toState: taskEvents.toState,
      trigger: taskEvents.trigger,
      message: taskEvents.message,
      userId: taskEvents.userId,
      createdAt: taskEvents.createdAt,
      userName: users.displayName,
      userAvatar: users.avatarUrl,
    })
    .from(taskEvents)
    .leftJoin(users, eq(taskEvents.userId, users.id))
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(taskEvents.createdAt);

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    fromState: row.fromState,
    toState: row.toState,
    trigger: row.trigger,
    message: row.message,
    userId: row.userId,
    createdAt: row.createdAt,
    user: row.userId
      ? { id: row.userId, displayName: row.userName!, avatarUrl: row.userAvatar }
      : undefined,
  }));
}
