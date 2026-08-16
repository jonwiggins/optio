import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskConfigs, workflowTriggers } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "./task-service.js";
import { getPromptTemplateById, renderTemplateString } from "./prompt-template-service.js";
import { logger } from "../logger.js";

export interface CreateTaskConfigInput {
  name: string;
  description?: string | null;
  title: string;
  prompt: string;
  promptTemplateId?: string | null;
  repoUrl: string;
  repoBranch?: string;
  agentType?: string | null;
  maxRetries?: number;
  priority?: number;
  enabled?: boolean;
  workspaceId?: string | null;
  createdBy?: string | null;
}

export interface UpdateTaskConfigInput {
  name?: string;
  description?: string | null;
  title?: string;
  prompt?: string;
  promptTemplateId?: string | null;
  repoUrl?: string;
  repoBranch?: string;
  agentType?: string | null;
  maxRetries?: number;
  priority?: number;
  enabled?: boolean;
}

export async function createTaskConfig(input: CreateTaskConfigInput) {
  const [row] = await db
    .insert(taskConfigs)
    .values({
      name: input.name,
      description: input.description ?? null,
      title: input.title,
      prompt: input.prompt,
      promptTemplateId: input.promptTemplateId ?? null,
      repoUrl: input.repoUrl,
      repoBranch: input.repoBranch ?? "main",
      agentType: input.agentType ?? null,
      maxRetries: input.maxRetries ?? 3,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      workspaceId: input.workspaceId ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row;
}

export async function getTaskConfig(id: string) {
  const [row] = await db.select().from(taskConfigs).where(eq(taskConfigs.id, id));
  return row ?? null;
}

export async function listTaskConfigs(opts?: { workspaceId?: string | null }) {
  const conditions = [];
  if (opts?.workspaceId) conditions.push(eq(taskConfigs.workspaceId, opts.workspaceId));

  let q = db.select().from(taskConfigs).orderBy(desc(taskConfigs.createdAt));
  if (conditions.length > 0) q = q.where(and(...conditions)) as typeof q;
  return q;
}

export async function listTaskConfigsWithTriggers(opts?: { workspaceId?: string | null }) {
  const configs = await listTaskConfigs(opts);
  if (configs.length === 0) return [];

  const ids = configs.map((c) => c.id);
  const triggers = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "task_config"),
        sql`${workflowTriggers.targetId} in ${ids}`,
      ),
    );

  const byConfig = new Map<string, typeof triggers>();
  for (const t of triggers) {
    const list = byConfig.get(t.targetId) ?? [];
    list.push(t);
    byConfig.set(t.targetId, list);
  }

  return configs.map((c) => ({ ...c, triggers: byConfig.get(c.id) ?? [] }));
}

export async function updateTaskConfig(id: string, input: UpdateTaskConfigInput) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.title !== undefined) updates.title = input.title;
  if (input.prompt !== undefined) updates.prompt = input.prompt;
  if (input.promptTemplateId !== undefined) updates.promptTemplateId = input.promptTemplateId;
  if (input.repoUrl !== undefined) updates.repoUrl = input.repoUrl;
  if (input.repoBranch !== undefined) updates.repoBranch = input.repoBranch;
  if (input.agentType !== undefined) updates.agentType = input.agentType;
  if (input.maxRetries !== undefined) updates.maxRetries = input.maxRetries;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  const [row] = await db.update(taskConfigs).set(updates).where(eq(taskConfigs.id, id)).returning();
  return row ?? null;
}

export async function deleteTaskConfig(id: string): Promise<boolean> {
  // Delete any triggers pointing at this task_config first.
  await db
    .delete(workflowTriggers)
    .where(and(eq(workflowTriggers.targetType, "task_config"), eq(workflowTriggers.targetId, id)));
  const deleted = await db.delete(taskConfigs).where(eq(taskConfigs.id, id)).returning();
  return deleted.length > 0;
}

/**
 * Create a concrete task from a task_config blueprint, transition it into
 * the queue, and enqueue the BullMQ job. Mirrors the flow used by the
 * ticket-sync worker and the POST /api/tasks route.
 */
export async function instantiateTask(
  taskConfigId: string,
  opts?: { triggerId?: string | null; params?: Record<string, unknown> | null },
) {
  const config = await getTaskConfig(taskConfigId);
  if (!config) throw new Error(`task_config ${taskConfigId} not found`);
  if (!config.enabled) throw new Error(`task_config ${taskConfigId} is disabled`);

  const params = opts?.params ?? {};

  // Resolve the effective prompt: if a template is linked, render it; else
  // treat the inline prompt as its own template so trigger params still
  // substitute.
  let effectivePrompt = config.prompt;
  let effectiveAgentType = config.agentType;
  if (config.promptTemplateId) {
    const template = await getPromptTemplateById(config.promptTemplateId);
    if (template) {
      effectivePrompt = renderTemplateString(template.template, params);
      if (!effectiveAgentType && template.defaultAgentType) {
        effectiveAgentType = template.defaultAgentType;
      }
    }
  } else {
    effectivePrompt = renderTemplateString(config.prompt, params);
  }
  const effectiveTitle = renderTemplateString(config.title, params);

  const agentType = effectiveAgentType ?? "claude-code";

  // Resolve the workspace: prefer the config's own workspace, falling back to
  // the repo's workspace so trigger-spawned tasks from legacy (NULL-workspace)
  // configs remain visible in the workspace-scoped UI — see issue #544.
  let workspaceId = config.workspaceId ?? null;
  if (!workspaceId) {
    // Dynamic import to avoid a cycle: repo-service → services graph.
    const { getRepoByUrl } = await import("./repo-service.js");
    const repo = await getRepoByUrl(config.repoUrl).catch(() => null);
    workspaceId = repo?.workspaceId ?? null;
  }

  const task = await taskService.createTask({
    title: effectiveTitle,
    prompt: effectivePrompt,
    repoUrl: config.repoUrl,
    repoBranch: config.repoBranch,
    agentType,
    maxRetries: config.maxRetries,
    priority: config.priority,
    createdBy: config.createdBy ?? undefined,
    workspaceId,
    metadata: {
      taskConfigId: config.id,
      taskConfigName: config.name,
      ...(opts?.triggerId ? { triggerId: opts.triggerId } : {}),
      ...(opts?.params ? { triggerParams: opts.params } : {}),
    },
  });

  await taskService.transitionTask(task.id, TaskState.QUEUED, "task_config");

  // Dynamic import to avoid a cycle: task-worker imports services, services
  // import task-config-service.
  const { taskQueue } = await import("../workers/task-worker.js");
  await taskQueue.add(
    "process-task",
    { taskId: task.id },
    {
      jobId: task.id,
      attempts: task.maxRetries + 1,
      backoff: { type: "exponential", delay: 5000 },
    },
  );

  logger.info(
    { taskId: task.id, taskConfigId: config.id, triggerId: opts?.triggerId ?? null },
    "Instantiated task from task_config",
  );

  return task;
}

export async function setEnabled(id: string, enabled: boolean) {
  return updateTaskConfig(id, { enabled });
}

// ── Trigger CRUD for task_config targets ─────────────────────────────────────

import { computeNextFire } from "../utils/cron.js";

export async function listTaskConfigTriggers(taskConfigId: string) {
  return db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "task_config"),
        eq(workflowTriggers.targetId, taskConfigId),
      ),
    )
    .orderBy(desc(workflowTriggers.createdAt));
}

export async function getTaskConfigTrigger(id: string) {
  const [row] = await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, id));
  return row ?? null;
}

export async function createTaskConfigTrigger(input: {
  taskConfigId: string;
  type: string;
  config?: Record<string, unknown>;
  paramMapping?: Record<string, unknown>;
  enabled?: boolean;
}) {
  const existingOfType = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "task_config"),
        eq(workflowTriggers.targetId, input.taskConfigId),
        eq(workflowTriggers.type, input.type),
      ),
    );
  if (existingOfType.length > 0) throw new Error("duplicate_type");

  if (input.type === "webhook" && input.config?.path) {
    const path = input.config.path as string;
    const webhookConflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    const conflict = webhookConflicts.find(
      (t) => (t.config as Record<string, unknown>)?.path === path,
    );
    if (conflict) throw new Error("duplicate_webhook_path");
  }

  const enabled = input.enabled ?? true;
  let nextFireAt: Date | null = null;
  if (input.type === "schedule" && enabled && input.config?.cronExpression) {
    nextFireAt = computeNextFire(input.config.cronExpression as string);
  }

  const [row] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: null,
      targetType: "task_config",
      targetId: input.taskConfigId,
      type: input.type,
      config: input.config ?? {},
      paramMapping: input.paramMapping ?? null,
      enabled,
      nextFireAt,
    })
    .returning();
  return row;
}

export async function updateTaskConfigTrigger(
  id: string,
  input: {
    config?: Record<string, unknown> | null;
    paramMapping?: Record<string, unknown> | null;
    enabled?: boolean;
  },
) {
  const existing = await getTaskConfigTrigger(id);
  if (!existing) return null;

  if (input.config && typeof input.config.path === "string") {
    const pathConflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    const conflict = pathConflicts.find(
      (t) => t.id !== id && (t.config as Record<string, unknown>)?.path === input.config!.path,
    );
    if (conflict) throw new Error("duplicate_webhook_path");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.config !== undefined) updates.config = input.config;
  if (input.paramMapping !== undefined) updates.paramMapping = input.paramMapping;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (existing.type === "schedule") {
    const newConfig =
      input.config !== undefined
        ? input.config
        : (existing.config as Record<string, unknown> | null);
    const newEnabled = input.enabled ?? existing.enabled;
    const cronExpression = newConfig?.cronExpression as string | undefined;
    updates.nextFireAt = newEnabled && cronExpression ? computeNextFire(cronExpression) : null;
  }

  const [row] = await db
    .update(workflowTriggers)
    .set(updates)
    .where(eq(workflowTriggers.id, id))
    .returning();
  return row ?? null;
}

export async function deleteTaskConfigTrigger(id: string): Promise<boolean> {
  const deleted = await db.delete(workflowTriggers).where(eq(workflowTriggers.id, id)).returning();
  return deleted.length > 0;
}

/**
 * Fire any enabled `ticket` triggers on task_configs whose config matches the
 * ticket's source (and optional label filter). Called by ticket-sync-service
 * when it discovers an actionable ticket. Returns the instantiated tasks.
 *
 * Trigger config shape:
 *   { source: "github" | "linear" | "notion" | "jira", labels?: string[] }
 *
 * When `labels` is set, the ticket must carry at least one matching label.
 */
export async function fireTicketTriggers(ticket: {
  source: string;
  externalId: string;
  title: string;
  body?: string;
  labels?: string[];
  url?: string;
}): Promise<Array<{ triggerId: string; taskId: string }>> {
  const candidates = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "task_config"),
        eq(workflowTriggers.type, "ticket"),
        eq(workflowTriggers.enabled, true),
      ),
    );

  const results: Array<{ triggerId: string; taskId: string }> = [];
  for (const trigger of candidates) {
    const config = (trigger.config ?? {}) as Record<string, unknown>;
    if (config.source && config.source !== ticket.source) continue;
    const requiredLabels = Array.isArray(config.labels) ? (config.labels as string[]) : null;
    if (requiredLabels && requiredLabels.length > 0) {
      const has = requiredLabels.some((l) => ticket.labels?.includes(l));
      if (!has) continue;
    }

    try {
      const task = await instantiateTask(trigger.targetId, {
        triggerId: trigger.id,
        params: {
          ticketSource: ticket.source,
          ticketExternalId: ticket.externalId,
          ticketTitle: ticket.title,
          ticketBody: ticket.body ?? "",
          ticketUrl: ticket.url ?? "",
          ticketLabels: (ticket.labels ?? []).join(","),
        },
      });
      results.push({ triggerId: trigger.id, taskId: task.id });
      logger.info(
        {
          triggerId: trigger.id,
          taskConfigId: trigger.targetId,
          taskId: task.id,
          ticketSource: ticket.source,
          ticketExternalId: ticket.externalId,
        },
        "Fired ticket trigger for task_config",
      );
    } catch (err) {
      logger.error(
        { err, triggerId: trigger.id, ticketExternalId: ticket.externalId },
        "Failed to fire ticket trigger",
      );
    }
  }
  return results;
}
