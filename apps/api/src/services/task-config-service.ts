/**
 * Scheduled Tasks — `repo-blueprint` work definitions: a saved Repo Task that
 * each trigger firing spawns as a fresh task. Rows live in work_definitions
 * (work-definition-service); this module keeps the shape /api/task-configs
 * has always returned (`toTaskConfig`) and spawns the tasks.
 */
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { workDefinitions, workflowTriggers } from "../db/schema.js";
import { TaskState, type LocalAgentSessionMode, type RunTarget } from "@optio/shared";
import * as taskService from "./task-service.js";
import * as definitions from "./work-definition-service.js";
import type { WorkDefinition, WorkDefinitionValues } from "./work-definition-service.js";
import {
  getPromptTemplateById,
  renderRunTitle,
  renderTemplateString,
} from "./prompt-template-service.js";
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
  /** PR follow-through copied to every spawned task (null = the repo's setting). */
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
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
  /** PR follow-through copied to every spawned task (null = the repo's setting). */
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
}

/** A scheduled Task as /api/task-configs has always returned it. */
export function toTaskConfig(d: WorkDefinition) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    workspaceId: d.workspaceId,
    title: d.runTitle ?? d.name,
    prompt: d.prompt,
    promptTemplateId: d.promptTemplateId,
    repoUrl: d.repoUrl!,
    repoBranch: d.repoBranch ?? "main",
    agentType: d.agentType,
    maxRetries: d.maxRetries,
    priority: d.priority,
    agentOptions: d.agentOptions,
    runTarget: d.runTarget,
    localHostId: d.localHostId,
    localDir: d.localDir,
    localSessionMode: d.localSessionMode,
    autoResume: d.autoResume,
    autoMerge: d.autoMerge,
    enabled: d.enabled,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export type TaskConfig = ReturnType<typeof toTaskConfig>;

/** The work_definitions columns a create / update input sets (legacy names → one name each). */
function columns(input: UpdateTaskConfigInput): Partial<WorkDefinitionValues> {
  const { title, ...rest } = input;
  return { ...rest, ...(title !== undefined ? { runTitle: title } : {}) };
}

export async function createTaskConfig(input: CreateTaskConfigInput, tx?: definitions.Db) {
  const local = input.runTarget === "local";
  const row = await definitions.createDefinition(
    "repo-blueprint",
    {
      name: input.name,
      description: input.description ?? null,
      runTitle: input.title,
      prompt: input.prompt,
      promptTemplateId: input.promptTemplateId ?? null,
      repoUrl: input.repoUrl,
      repoBranch: input.repoBranch ?? "main",
      agentType: input.agentType ?? null,
      maxRetries: input.maxRetries ?? 3,
      priority: input.priority ?? 100,
      agentOptions: input.agentOptions ?? null,
      runTarget: input.runTarget ?? "cluster",
      localHostId: local ? (input.localHostId ?? null) : null,
      localDir: local ? (input.localDir ?? null) : null,
      localSessionMode: local ? (input.localSessionMode ?? "headless") : null,
      autoResume: input.autoResume ?? null,
      autoMerge: input.autoMerge ?? null,
      enabled: input.enabled ?? true,
      workspaceId: input.workspaceId ?? null,
      createdBy: input.createdBy ?? null,
    },
    tx,
  );
  return toTaskConfig(row);
}

export async function getTaskConfig(id: string) {
  const row = await definitions.getDefinition(id, "repo-blueprint");
  return row && toTaskConfig(row);
}

export async function listTaskConfigs(opts?: { workspaceId?: string | null }) {
  const rows = await definitions.listDefinitions(
    "repo-blueprint",
    opts?.workspaceId ? eq(workDefinitions.workspaceId, opts.workspaceId) : undefined,
  );
  return rows.map(toTaskConfig);
}

export async function listTaskConfigsWithTriggers(opts?: { workspaceId?: string | null }) {
  const configs = await listTaskConfigs(opts);
  if (configs.length === 0) return [];

  const triggers = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "task_config"),
        inArray(
          workflowTriggers.targetId,
          configs.map((c) => c.id),
        ),
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
  const row = await definitions.updateDefinition(id, "repo-blueprint", columns(input));
  return row && toTaskConfig(row);
}

/** Delete a scheduled Task and its triggers; the tasks it spawned stay. */
export async function deleteTaskConfig(id: string): Promise<boolean> {
  return definitions.deleteDefinition(id, "repo-blueprint");
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
  const effectiveTitle = renderRunTitle(config.title, params, config.name);

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
    autoResume: config.autoResume,
    autoMerge: config.autoMerge,
    ...(opts?.ticket
      ? { ticketSource: opts.ticket.source, ticketExternalId: opts.ticket.externalId }
      : {}),
    workId: config.id,
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
