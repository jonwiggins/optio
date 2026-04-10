import { eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflows, workflowTriggers, workflowRuns, workflowPods } from "../db/schema.js";
import {
  WorkflowState,
  canTransitionWorkflow,
  InvalidWorkflowTransitionError,
} from "@optio/shared";
import { logger } from "../logger.js";

// ── Workflow CRUD ────────────────────────────────────────────────────────────

export async function listWorkflows(workspaceId?: string) {
  let query = db.select().from(workflows).orderBy(desc(workflows.createdAt));
  if (workspaceId) {
    query = query.where(eq(workflows.workspaceId, workspaceId)) as typeof query;
  }
  return query;
}

export async function getWorkflow(id: string) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id));
  return workflow ?? null;
}

export async function createWorkflow(input: {
  name: string;
  workspaceId?: string;
  environmentSpec?: Record<string, unknown>;
  promptTemplate: string;
  paramsSchema?: Record<string, unknown>;
  agentRuntime?: string;
  model?: string;
  maxTurns?: number;
  budgetUsd?: string;
  maxConcurrent?: number;
  maxRetries?: number;
  warmPoolSize?: number;
  enabled?: boolean;
}) {
  const [workflow] = await db
    .insert(workflows)
    .values({
      name: input.name,
      workspaceId: input.workspaceId,
      environmentSpec: input.environmentSpec,
      promptTemplate: input.promptTemplate,
      paramsSchema: input.paramsSchema,
      agentRuntime: input.agentRuntime ?? "claude-code",
      model: input.model,
      maxTurns: input.maxTurns,
      budgetUsd: input.budgetUsd,
      maxConcurrent: input.maxConcurrent ?? 1,
      maxRetries: input.maxRetries ?? 3,
      warmPoolSize: input.warmPoolSize ?? 0,
      enabled: input.enabled ?? true,
    })
    .returning();
  return workflow;
}

export async function updateWorkflow(
  id: string,
  input: {
    name?: string;
    environmentSpec?: Record<string, unknown>;
    promptTemplate?: string;
    paramsSchema?: Record<string, unknown>;
    agentRuntime?: string;
    model?: string;
    maxTurns?: number;
    budgetUsd?: string;
    maxConcurrent?: number;
    maxRetries?: number;
    warmPoolSize?: number;
    enabled?: boolean;
  },
) {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.environmentSpec !== undefined) updates.environmentSpec = input.environmentSpec;
  if (input.promptTemplate !== undefined) updates.promptTemplate = input.promptTemplate;
  if (input.paramsSchema !== undefined) updates.paramsSchema = input.paramsSchema;
  if (input.agentRuntime !== undefined) updates.agentRuntime = input.agentRuntime;
  if (input.model !== undefined) updates.model = input.model;
  if (input.maxTurns !== undefined) updates.maxTurns = input.maxTurns;
  if (input.budgetUsd !== undefined) updates.budgetUsd = input.budgetUsd;
  if (input.maxConcurrent !== undefined) updates.maxConcurrent = input.maxConcurrent;
  if (input.maxRetries !== undefined) updates.maxRetries = input.maxRetries;
  if (input.warmPoolSize !== undefined) updates.warmPoolSize = input.warmPoolSize;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  const [updated] = await db.update(workflows).set(updates).where(eq(workflows.id, id)).returning();
  return updated ?? null;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const deleted = await db.delete(workflows).where(eq(workflows.id, id)).returning();
  return deleted.length > 0;
}

// ── Workflow Triggers ────────────────────────────────────────────────────────

export async function listWorkflowTriggers(workflowId: string) {
  return db
    .select()
    .from(workflowTriggers)
    .where(eq(workflowTriggers.workflowId, workflowId))
    .orderBy(desc(workflowTriggers.createdAt));
}

export async function createWorkflowTrigger(input: {
  workflowId: string;
  type: "manual" | "schedule" | "webhook";
  config?: Record<string, unknown>;
  paramMapping?: Record<string, unknown>;
  enabled?: boolean;
}) {
  const [trigger] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: input.workflowId,
      type: input.type,
      config: input.config,
      paramMapping: input.paramMapping,
      enabled: input.enabled ?? true,
    })
    .returning();
  return trigger;
}

export async function deleteWorkflowTrigger(id: string): Promise<boolean> {
  const deleted = await db.delete(workflowTriggers).where(eq(workflowTriggers.id, id)).returning();
  return deleted.length > 0;
}

// ── Workflow Runs ────────────────────────────────────────────────────────────

export async function listWorkflowRuns(workflowId: string) {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt));
}

export async function getWorkflowRun(id: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return run ?? null;
}

export async function createWorkflowRun(input: {
  workflowId: string;
  triggerId?: string;
  params?: Record<string, unknown>;
}) {
  const workflow = await getWorkflow(input.workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (!workflow.enabled) throw new Error("Workflow is disabled");

  const [run] = await db
    .insert(workflowRuns)
    .values({
      workflowId: input.workflowId,
      triggerId: input.triggerId,
      params: input.params,
      state: "queued",
    })
    .returning();

  logger.info({ workflowRunId: run.id, workflowId: input.workflowId }, "Workflow run created");
  return run;
}

export async function transitionWorkflowRun(
  id: string,
  toState: WorkflowState,
  updates?: {
    output?: Record<string, unknown>;
    costUsd?: string;
    inputTokens?: number;
    outputTokens?: number;
    modelUsed?: string;
    errorMessage?: string;
    sessionId?: string;
    podName?: string;
  },
): Promise<void> {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const fromState = run.state as WorkflowState;
  if (!canTransitionWorkflow(fromState, toState)) {
    throw new InvalidWorkflowTransitionError(fromState, toState);
  }

  const setValues: Record<string, unknown> = {
    state: toState,
    updatedAt: new Date(),
  };
  if (updates?.output !== undefined) setValues.output = updates.output;
  if (updates?.costUsd !== undefined) setValues.costUsd = updates.costUsd;
  if (updates?.inputTokens !== undefined) setValues.inputTokens = updates.inputTokens;
  if (updates?.outputTokens !== undefined) setValues.outputTokens = updates.outputTokens;
  if (updates?.modelUsed !== undefined) setValues.modelUsed = updates.modelUsed;
  if (updates?.errorMessage !== undefined) setValues.errorMessage = updates.errorMessage;
  if (updates?.sessionId !== undefined) setValues.sessionId = updates.sessionId;
  if (updates?.podName !== undefined) setValues.podName = updates.podName;

  // Increment retryCount when re-queuing from failed
  if (fromState === WorkflowState.FAILED && toState === WorkflowState.QUEUED) {
    setValues.retryCount = run.retryCount + 1;
  }

  await db.update(workflowRuns).set(setValues).where(eq(workflowRuns.id, id));

  logger.info({ workflowRunId: id, from: fromState, to: toState }, "Workflow run transitioned");
}

// ── Workflow Pods ────────────────────────────────────────────────────────────

export async function listWorkflowPods(workflowId: string) {
  return db
    .select()
    .from(workflowPods)
    .where(eq(workflowPods.workflowId, workflowId))
    .orderBy(desc(workflowPods.createdAt));
}

export async function getWorkflowPod(id: string) {
  const [pod] = await db.select().from(workflowPods).where(eq(workflowPods.id, id));
  return pod ?? null;
}

export async function createWorkflowPod(input: { workflowId: string; podName?: string }) {
  const [pod] = await db
    .insert(workflowPods)
    .values({
      workflowId: input.workflowId,
      podName: input.podName,
      state: "provisioning",
    })
    .returning();
  return pod;
}

export async function deleteWorkflowPod(id: string): Promise<boolean> {
  const deleted = await db.delete(workflowPods).where(eq(workflowPods.id, id)).returning();
  return deleted.length > 0;
}
