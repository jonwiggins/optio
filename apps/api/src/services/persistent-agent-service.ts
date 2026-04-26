// Persistent Agent service — CRUD, message inbox, turn lifecycle.
//
// A Persistent Agent is a long-lived, named, addressable agent process that
// halts after each turn and waits for the next wake event (user message,
// agent message, webhook, cron tick, ticket event). See docs/persistent-agents.md.

import { eq, and, desc, asc, sql, isNull, inArray, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import {
  persistentAgents,
  persistentAgentTurns,
  persistentAgentTurnLogs,
  persistentAgentMessages,
  persistentAgentPods,
} from "../db/schema.js";
import {
  PersistentAgentState,
  PersistentAgentPodLifecycle,
  type PersistentAgentControlIntent,
  type PersistentAgentMessageSenderType,
  type PersistentAgentTurnHaltReason,
  type PersistentAgentWakeSource,
  canTransitionPersistentAgent,
  buildSenderId,
} from "@optio/shared";
import { publishPersistentAgentEvent } from "./event-bus.js";
import { logger } from "../logger.js";

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listPersistentAgents(workspaceId?: string | null) {
  const baseQuery = db.select().from(persistentAgents).orderBy(desc(persistentAgents.updatedAt));
  if (workspaceId !== undefined) {
    return baseQuery.where(
      workspaceId === null
        ? isNull(persistentAgents.workspaceId)
        : eq(persistentAgents.workspaceId, workspaceId),
    );
  }
  return baseQuery;
}

export async function getPersistentAgent(id: string) {
  const [row] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, id));
  return row ?? null;
}

export async function getPersistentAgentBySlug(workspaceId: string | null, slug: string) {
  const conditions = [eq(persistentAgents.slug, slug)];
  if (workspaceId === null) {
    conditions.push(isNull(persistentAgents.workspaceId));
  } else {
    conditions.push(eq(persistentAgents.workspaceId, workspaceId));
  }
  const [row] = await db
    .select()
    .from(persistentAgents)
    .where(and(...conditions));
  return row ?? null;
}

export interface CreatePersistentAgentInput {
  slug: string;
  name: string;
  description?: string | null;
  workspaceId?: string | null;
  agentRuntime?: string;
  model?: string | null;
  systemPrompt?: string | null;
  agentsMd?: string | null;
  initialPrompt: string;
  promptTemplateId?: string | null;
  repoId?: string | null;
  branch?: string | null;
  podLifecycle?: PersistentAgentPodLifecycle;
  idlePodTimeoutMs?: number;
  maxTurnDurationMs?: number;
  maxTurns?: number;
  consecutiveFailureLimit?: number;
  enabled?: boolean;
  createdBy?: string | null;
}

export async function createPersistentAgent(input: CreatePersistentAgentInput) {
  const [row] = await db
    .insert(persistentAgents)
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      workspaceId: input.workspaceId ?? null,
      agentRuntime: input.agentRuntime ?? "claude-code",
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
      agentsMd: input.agentsMd ?? null,
      initialPrompt: input.initialPrompt,
      promptTemplateId: input.promptTemplateId ?? null,
      repoId: input.repoId ?? null,
      branch: input.branch ?? null,
      podLifecycle: input.podLifecycle ?? PersistentAgentPodLifecycle.STICKY,
      idlePodTimeoutMs: input.idlePodTimeoutMs ?? 300_000,
      maxTurnDurationMs: input.maxTurnDurationMs ?? 600_000,
      maxTurns: input.maxTurns ?? 50,
      consecutiveFailureLimit: input.consecutiveFailureLimit ?? 3,
      enabled: input.enabled ?? true,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row;
}

export interface UpdatePersistentAgentInput {
  name?: string;
  description?: string | null;
  agentRuntime?: string;
  model?: string | null;
  systemPrompt?: string | null;
  agentsMd?: string | null;
  initialPrompt?: string;
  promptTemplateId?: string | null;
  repoId?: string | null;
  branch?: string | null;
  podLifecycle?: PersistentAgentPodLifecycle;
  idlePodTimeoutMs?: number;
  maxTurnDurationMs?: number;
  maxTurns?: number;
  consecutiveFailureLimit?: number;
  enabled?: boolean;
}

export async function updatePersistentAgent(id: string, input: UpdatePersistentAgentInput) {
  const [row] = await db
    .update(persistentAgents)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(persistentAgents.id, id))
    .returning();
  return row ?? null;
}

export async function deletePersistentAgent(id: string): Promise<boolean> {
  const deleted = await db
    .delete(persistentAgents)
    .where(eq(persistentAgents.id, id))
    .returning({ id: persistentAgents.id });
  return deleted.length > 0;
}

// ── Control intent ──────────────────────────────────────────────────────────

export async function setControlIntent(id: string, intent: PersistentAgentControlIntent | null) {
  const [row] = await db
    .update(persistentAgents)
    .set({ controlIntent: intent, updatedAt: new Date() })
    .where(eq(persistentAgents.id, id))
    .returning();
  return row ?? null;
}

// ── State transitions (CAS) ────────────────────────────────────────────────

export interface TransitionExtras {
  errorMessage?: string | null;
  sessionId?: string | null;
  consecutiveFailures?: number;
  lastFailureAt?: Date | null;
  lastFailureReason?: string | null;
  lastTurnAt?: Date | null;
  totalCostUsd?: string;
  reconcileBackoffUntil?: Date | null;
  clearControlIntent?: boolean;
}

/**
 * Compare-and-swap transition. Returns true on success, false if the row's
 * updated_at moved between read and write (caller should rebuild snapshot
 * and retry).
 */
export async function transitionPersistentAgentState(
  agentId: string,
  toState: PersistentAgentState,
  expectedUpdatedAt: Date,
  extras: TransitionExtras = {},
  trigger: string = "service",
): Promise<boolean> {
  const [current] = await db
    .select()
    .from(persistentAgents)
    .where(eq(persistentAgents.id, agentId));
  if (!current) return false;

  const fromState = current.state as PersistentAgentState;
  if (!canTransitionPersistentAgent(fromState, toState)) {
    throw new Error(`Invalid persistent agent transition: ${fromState} → ${toState}`);
  }

  const updates: Record<string, unknown> = {
    state: toState,
    updatedAt: new Date(),
  };
  if (extras.errorMessage !== undefined) updates.lastFailureReason = extras.errorMessage;
  if (extras.sessionId !== undefined) updates.sessionId = extras.sessionId;
  if (extras.consecutiveFailures !== undefined) {
    updates.consecutiveFailures = extras.consecutiveFailures;
  }
  if (extras.lastFailureAt !== undefined) updates.lastFailureAt = extras.lastFailureAt;
  if (extras.lastFailureReason !== undefined) updates.lastFailureReason = extras.lastFailureReason;
  if (extras.lastTurnAt !== undefined) updates.lastTurnAt = extras.lastTurnAt;
  if (extras.totalCostUsd !== undefined) updates.totalCostUsd = extras.totalCostUsd;
  if (extras.reconcileBackoffUntil !== undefined) {
    updates.reconcileBackoffUntil = extras.reconcileBackoffUntil;
  }
  if (extras.clearControlIntent) updates.controlIntent = null;

  const result = await db
    .update(persistentAgents)
    .set(updates)
    .where(
      and(
        eq(persistentAgents.id, agentId),
        // Tolerate sub-millisecond DB precision on `updated_at` (PG stores
        // microseconds; JS Date is millisecond-precision). Same comparison
        // shape as reconcile-executor's casUpdate.
        sql`date_trunc('milliseconds', ${persistentAgents.updatedAt})
            = date_trunc('milliseconds', ${expectedUpdatedAt.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ id: persistentAgents.id });

  if (result.length === 0) {
    logger.debug({ agentId, fromState, toState }, "persistent agent CAS transition stale");
    return false;
  }

  await publishPersistentAgentEvent({
    type: "persistent_agent:state_changed",
    agentId,
    agentSlug: current.slug,
    fromState,
    toState,
    trigger,
    timestamp: new Date().toISOString(),
    errorMessage: extras.errorMessage ?? undefined,
  });
  return true;
}

// ── Inbox / messages ────────────────────────────────────────────────────────

export interface ReceiveMessageInput {
  agentId: string;
  senderType: PersistentAgentMessageSenderType;
  senderId?: string | null;
  senderName?: string | null;
  body: string;
  structuredPayload?: Record<string, unknown>;
  broadcasted?: boolean;
}

export async function receivePersistentAgentMessage(input: ReceiveMessageInput) {
  const agent = await getPersistentAgent(input.agentId);
  if (!agent) throw new Error(`Persistent agent ${input.agentId} not found`);

  const [msg] = await db
    .insert(persistentAgentMessages)
    .values({
      agentId: input.agentId,
      senderType: input.senderType,
      senderId: input.senderId ?? null,
      senderName: input.senderName ?? null,
      body: input.body,
      structuredPayload: input.structuredPayload ?? null,
      broadcasted: input.broadcasted ?? false,
    })
    .returning();

  await publishPersistentAgentEvent({
    type: "persistent_agent:message",
    agentId: input.agentId,
    agentSlug: agent.slug,
    messageId: msg.id,
    senderType: input.senderType,
    senderId: input.senderId ?? null,
    senderName: input.senderName ?? null,
    body: input.body,
    broadcasted: input.broadcasted ?? false,
    timestamp: msg.receivedAt.toISOString(),
  });

  return msg;
}

export async function listPendingMessages(agentId: string) {
  return db
    .select()
    .from(persistentAgentMessages)
    .where(
      and(
        eq(persistentAgentMessages.agentId, agentId),
        isNull(persistentAgentMessages.processedAt),
      ),
    )
    .orderBy(asc(persistentAgentMessages.receivedAt));
}

export async function listInboxSummary(agentId: string) {
  const [row] = await db
    .select({
      pending: count(persistentAgentMessages.id),
      oldest: sql<Date | null>`MIN(${persistentAgentMessages.receivedAt})`,
    })
    .from(persistentAgentMessages)
    .where(
      and(
        eq(persistentAgentMessages.agentId, agentId),
        isNull(persistentAgentMessages.processedAt),
      ),
    );
  return {
    pending: Number(row?.pending ?? 0),
    oldest: (row?.oldest as Date | null) ?? null,
  };
}

export async function listRecentMessages(agentId: string, limit = 100) {
  return db
    .select()
    .from(persistentAgentMessages)
    .where(eq(persistentAgentMessages.agentId, agentId))
    .orderBy(desc(persistentAgentMessages.receivedAt))
    .limit(limit);
}

/**
 * Mark a set of messages as drained into the given turn. Caller supplies the
 * turn id after the turn has been created so the messages and the turn link
 * up. Returns the count actually drained.
 */
export async function drainMessagesIntoTurn(
  agentId: string,
  turnId: string,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await db
    .update(persistentAgentMessages)
    .set({ processedAt: new Date(), turnId })
    .where(
      and(
        eq(persistentAgentMessages.agentId, agentId),
        inArray(persistentAgentMessages.id, messageIds),
      ),
    )
    .returning({ id: persistentAgentMessages.id });
  return result.length;
}

// ── Turns ───────────────────────────────────────────────────────────────────

export interface CreateTurnInput {
  agentId: string;
  wakeSource: PersistentAgentWakeSource;
  wakePayload?: Record<string, unknown>;
  promptUsed: string;
  podId?: string | null;
  podName?: string | null;
  sessionId?: string | null;
}

export async function createPersistentAgentTurn(input: CreateTurnInput) {
  const agent = await getPersistentAgent(input.agentId);
  if (!agent) throw new Error(`Persistent agent ${input.agentId} not found`);

  // Determine next turn number atomically (best-effort).
  const [last] = await db
    .select({ max: sql<number>`COALESCE(MAX(${persistentAgentTurns.turnNumber}), 0)` })
    .from(persistentAgentTurns)
    .where(eq(persistentAgentTurns.agentId, input.agentId));
  const nextNumber = Number(last?.max ?? 0) + 1;

  const [turn] = await db
    .insert(persistentAgentTurns)
    .values({
      agentId: input.agentId,
      turnNumber: nextNumber,
      wakeSource: input.wakeSource,
      wakePayload: input.wakePayload ?? null,
      promptUsed: input.promptUsed,
      podId: input.podId ?? null,
      podName: input.podName ?? null,
      sessionId: input.sessionId ?? null,
      startedAt: new Date(),
    })
    .returning();

  await publishPersistentAgentEvent({
    type: "persistent_agent:turn_started",
    agentId: input.agentId,
    agentSlug: agent.slug,
    turnId: turn.id,
    turnNumber: nextNumber,
    wakeSource: input.wakeSource,
    timestamp: new Date().toISOString(),
  });

  return turn;
}

export interface HaltTurnInput {
  turnId: string;
  haltReason: PersistentAgentTurnHaltReason;
  errorMessage?: string | null;
  costUsd?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  sessionId?: string | null;
  summary?: string | null;
}

export async function haltPersistentAgentTurn(input: HaltTurnInput) {
  const [turn] = await db
    .update(persistentAgentTurns)
    .set({
      haltReason: input.haltReason,
      errorMessage: input.errorMessage ?? null,
      costUsd: input.costUsd ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      sessionId: input.sessionId ?? undefined,
      summary: input.summary ?? null,
      finishedAt: new Date(),
    })
    .where(eq(persistentAgentTurns.id, input.turnId))
    .returning();

  if (turn) {
    const agent = await getPersistentAgent(turn.agentId);
    if (agent) {
      await publishPersistentAgentEvent({
        type: "persistent_agent:turn_halted",
        agentId: turn.agentId,
        agentSlug: agent.slug,
        turnId: turn.id,
        turnNumber: turn.turnNumber,
        haltReason: input.haltReason,
        costUsd: input.costUsd ?? undefined,
        inputTokens: input.inputTokens ?? undefined,
        outputTokens: input.outputTokens ?? undefined,
        errorMessage: input.errorMessage ?? undefined,
        summary: input.summary ?? undefined,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return turn;
}

export async function listPersistentAgentTurns(agentId: string, limit = 50) {
  return db
    .select()
    .from(persistentAgentTurns)
    .where(eq(persistentAgentTurns.agentId, agentId))
    .orderBy(desc(persistentAgentTurns.turnNumber))
    .limit(limit);
}

export async function getPersistentAgentTurn(turnId: string) {
  const [row] = await db
    .select()
    .from(persistentAgentTurns)
    .where(eq(persistentAgentTurns.id, turnId));
  return row ?? null;
}

// ── Logs ────────────────────────────────────────────────────────────────────

export interface AppendLogInput {
  turnId: string;
  agentId: string;
  stream?: string;
  content: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}

export async function appendPersistentAgentLog(input: AppendLogInput) {
  const [log] = await db
    .insert(persistentAgentTurnLogs)
    .values({
      turnId: input.turnId,
      agentId: input.agentId,
      stream: input.stream ?? "stdout",
      content: input.content,
      logType: input.logType ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();

  const agent = await getPersistentAgent(input.agentId);
  if (agent) {
    await publishPersistentAgentEvent({
      type: "persistent_agent:log",
      agentId: input.agentId,
      agentSlug: agent.slug,
      turnId: input.turnId,
      stream: (log.stream as "stdout" | "stderr") ?? "stdout",
      content: log.content,
      logType: log.logType ?? undefined,
      metadata: log.metadata ?? undefined,
      timestamp: log.timestamp?.toISOString() ?? new Date().toISOString(),
    });
  }
  return log;
}

export async function listTurnLogs(turnId: string, limit = 1000) {
  return db
    .select()
    .from(persistentAgentTurnLogs)
    .where(eq(persistentAgentTurnLogs.turnId, turnId))
    .orderBy(asc(persistentAgentTurnLogs.timestamp))
    .limit(limit);
}

// ── wakeAgent: canonical entry point ───────────────────────────────────────
//
// Called by HTTP routes (user message), the inter-agent MCP server (agent
// message), trigger-worker (webhook/schedule/ticket fire), and internal
// system events. Records a message in the inbox and enqueues a reconcile
// pass. The reconciler decides whether to start a turn now or wait.

export interface WakeAgentInput {
  agentId: string;
  source: PersistentAgentWakeSource;
  body: string;
  senderType?: PersistentAgentMessageSenderType;
  senderId?: string | null;
  senderName?: string | null;
  structuredPayload?: Record<string, unknown>;
  broadcasted?: boolean;
}

/**
 * Lazy import to avoid a circular dependency: reconcile-queue → reconcile-worker
 * → persistent-agent-service via snapshot builder.
 */
async function enqueueReconcileLazy(agentId: string, reason: string) {
  try {
    const mod = await import("./reconcile-queue.js");
    if (typeof mod.enqueueReconcile === "function") {
      await mod.enqueueReconcile({ kind: "persistent-agent", id: agentId }, { reason });
    }
  } catch (err) {
    logger.error({ err, agentId, reason }, "failed to enqueue persistent agent reconcile");
  }
}

export async function wakeAgent(input: WakeAgentInput) {
  const senderType = input.senderType ?? deriveSenderType(input.source);
  await receivePersistentAgentMessage({
    agentId: input.agentId,
    senderType,
    senderId: input.senderId ?? null,
    senderName: input.senderName ?? null,
    body: input.body,
    structuredPayload: input.structuredPayload,
    broadcasted: input.broadcasted ?? false,
  });
  await enqueueReconcileLazy(input.agentId, `wake_${input.source}`);
}

function deriveSenderType(source: PersistentAgentWakeSource): PersistentAgentMessageSenderType {
  switch (source) {
    case "user":
      return "user";
    case "agent":
      return "agent";
    case "webhook":
    case "schedule":
    case "ticket":
    case "system":
    case "initial":
      return "system";
  }
}

// ── Pods ────────────────────────────────────────────────────────────────────
//
// Persistent Agent pods are managed by persistent-agent-pool-service. This
// file exposes only read helpers for the snapshot builder.

export async function getActivePodForAgent(agentId: string) {
  const [row] = await db
    .select()
    .from(persistentAgentPods)
    .where(eq(persistentAgentPods.agentId, agentId))
    .orderBy(desc(persistentAgentPods.updatedAt))
    .limit(1);
  return row ?? null;
}

// ── Cost accumulation ──────────────────────────────────────────────────────

export async function addToTotalCost(agentId: string, addUsd: string) {
  const [agent] = await db
    .select({ totalCostUsd: persistentAgents.totalCostUsd })
    .from(persistentAgents)
    .where(eq(persistentAgents.id, agentId));
  if (!agent) return;
  const total = (Number(agent.totalCostUsd ?? "0") + Number(addUsd ?? "0")).toFixed(6);
  await db
    .update(persistentAgents)
    .set({ totalCostUsd: total, updatedAt: new Date() })
    .where(eq(persistentAgents.id, agentId));
}

// ── Cleanup helper for testing / restart ───────────────────────────────────

export async function purgeAllForAgent(agentId: string) {
  // Cascade deletes handle most of it; this is a no-op kept for symmetry.
  await db.delete(persistentAgents).where(eq(persistentAgents.id, agentId));
}

export { PersistentAgentState, PersistentAgentPodLifecycle, buildSenderId };
