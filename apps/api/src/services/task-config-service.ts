import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskConfigs, workflowTriggers } from "../db/schema.js";
import { TaskState, type LocalAgentSessionMode, type RunTarget } from "@optio/shared";
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
  agentOptions?: Record<string, string | boolean> | null;
  enabled?: boolean;
  workspaceId?: string | null;
  createdBy?: string | null;
  // Run location inherited by spawned tasks (validate with validateRunLocation first).
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
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
  agentOptions?: Record<string, string | boolean> | null;
  enabled?: boolean;
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
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
      agentOptions: input.agentOptions ?? null,
      runTarget: input.runTarget ?? "cluster",
      localHostId: input.runTarget === "local" ? (input.localHostId ?? null) : null,
      localDir: input.runTarget === "local" ? (input.localDir ?? null) : null,
      localSessionMode: input.runTarget === "local" ? (input.localSessionMode ?? "headless") : null,
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
  if (input.agentOptions !== undefined) updates.agentOptions = input.agentOptions;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.runTarget !== undefined) updates.runTarget = input.runTarget;
  if (input.localHostId !== undefined) updates.localHostId = input.localHostId;
  if (input.localDir !== undefined) updates.localDir = input.localDir;
  if (input.localSessionMode !== undefined) updates.localSessionMode = input.localSessionMode;

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
  opts?: {
    triggerId?: string | null;
    params?: Record<string, unknown> | null;
    /** The ticket / PR / issue the firing was about, so the task links back to it. */
    ticket?: { source: string; externalId: string; url?: string } | null;
  },
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
    runTarget: config.runTarget,
    localHostId: config.localHostId,
    localDir: config.localDir,
    localSessionMode: config.localSessionMode,
    ...(opts?.ticket
      ? { ticketSource: opts.ticket.source, ticketExternalId: opts.ticket.externalId }
      : {}),
    metadata: {
      taskConfigId: config.id,
      taskConfigName: config.name,
      ...(config.agentOptions ? { agentOptions: config.agentOptions } : {}),
      ...(opts?.triggerId ? { triggerId: opts.triggerId } : {}),
      ...(opts?.params ? { triggerParams: opts.params } : {}),
      ...(opts?.ticket?.url ? { ticketUrl: opts.ticket.url } : {}),
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
