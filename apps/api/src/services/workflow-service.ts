import { eq, desc, sql, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflows, workflowRuns, workflowTriggers, taskLogs } from "../db/schema.js";
import { WorkflowRunState, canTransitionWorkflowRun, transitionWorkflowRun } from "@optio/shared";
import { logger } from "../logger.js";

// ── Workflow CRUD ────────────────────────────────────────────────────────────

export async function listWorkflows(workspaceId?: string) {
  const conditions = [];
  if (workspaceId) conditions.push(eq(workflows.workspaceId, workspaceId));

  const baseQuery = db.select().from(workflows).orderBy(desc(workflows.createdAt));
  if (conditions.length > 0) {
    return baseQuery.where(and(...conditions));
  }
  return baseQuery;
}

export async function getWorkflow(id: string) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id));
  return workflow ?? null;
}

export async function createWorkflow(input: {
  name: string;
  description?: string;
  promptTemplate: string;
  agentRuntime?: string;
  model?: string;
  maxTurns?: number;
  budgetUsd?: string;
  maxConcurrent?: number;
  maxRetries?: number;
  warmPoolSize?: number;
  enabled?: boolean;
  environmentSpec?: Record<string, unknown>;
  paramsSchema?: Record<string, unknown>;
  workspaceId?: string;
  createdBy?: string;
}) {
  const [workflow] = await db
    .insert(workflows)
    .values({
      name: input.name,
      description: input.description,
      promptTemplate: input.promptTemplate,
      agentRuntime: input.agentRuntime ?? "claude-code",
      model: input.model,
      maxTurns: input.maxTurns,
      budgetUsd: input.budgetUsd,
      maxConcurrent: input.maxConcurrent ?? 2,
      maxRetries: input.maxRetries ?? 1,
      warmPoolSize: input.warmPoolSize ?? 0,
      enabled: input.enabled ?? true,
      environmentSpec: input.environmentSpec,
      paramsSchema: input.paramsSchema,
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
    })
    .returning();
  return workflow;
}

export async function updateWorkflow(
  id: string,
  input: {
    name?: string;
    description?: string;
    promptTemplate?: string;
    agentRuntime?: string;
    model?: string | null;
    maxTurns?: number | null;
    budgetUsd?: string | null;
    maxConcurrent?: number;
    maxRetries?: number;
    warmPoolSize?: number;
    enabled?: boolean;
    environmentSpec?: Record<string, unknown> | null;
    paramsSchema?: Record<string, unknown> | null;
  },
) {
  const [workflow] = await db
    .update(workflows)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(workflows.id, id))
    .returning();
  return workflow ?? null;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const deleted = await db.delete(workflows).where(eq(workflows.id, id)).returning();
  return deleted.length > 0;
}

// ── Enriched list/get with aggregate run stats ───────────────────────────────

export async function listWorkflowsWithStats(workspaceId?: string) {
  const wsFilter = workspaceId ? sql`AND w.workspace_id = ${workspaceId}` : sql``;

  const rows = await db.execute<{
    id: string;
    name: string;
    description: string | null;
    workspace_id: string | null;
    prompt_template: string;
    params_schema: unknown;
    agent_runtime: string;
    model: string | null;
    max_turns: number | null;
    budget_usd: string | null;
    max_concurrent: number;
    max_retries: number;
    warm_pool_size: number;
    enabled: boolean;
    environment_spec: unknown;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    run_count: string;
    last_run_at: string | null;
    total_cost_usd: string;
  }>(sql`
    SELECT
      w.id,
      w.name,
      w.description,
      w.workspace_id,
      w.prompt_template,
      w.params_schema,
      w.agent_runtime,
      w.model,
      w.max_turns,
      w.budget_usd,
      w.max_concurrent,
      w.max_retries,
      w.warm_pool_size,
      w.enabled,
      w.environment_spec,
      w.created_by,
      w.created_at,
      w.updated_at,
      COUNT(DISTINCT wr.id)::text AS run_count,
      MAX(wr.created_at)::text AS last_run_at,
      COALESCE(SUM(CAST(wr.cost_usd AS NUMERIC)), 0)::text AS total_cost_usd
    FROM workflows w
    LEFT JOIN workflow_runs wr ON wr.workflow_id = w.id
    WHERE 1=1 ${wsFilter}
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `);

  // Fetch trigger types for all returned workflows
  const workflowIds = rows.map((r) => r.id);
  const triggerMap: Record<string, string[]> = {};

  if (workflowIds.length > 0) {
    const triggers = await db
      .select({
        workflowId: workflowTriggers.workflowId,
        type: workflowTriggers.type,
      })
      .from(workflowTriggers)
      .where(sql`${workflowTriggers.workflowId} in ${workflowIds}`);

    for (const t of triggers) {
      if (!triggerMap[t.workflowId]) triggerMap[t.workflowId] = [];
      if (!triggerMap[t.workflowId].includes(t.type)) {
        triggerMap[t.workflowId].push(t.type);
      }
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    workspaceId: r.workspace_id,
    promptTemplate: r.prompt_template,
    paramsSchema: r.params_schema,
    agentRuntime: r.agent_runtime,
    model: r.model,
    maxTurns: r.max_turns,
    budgetUsd: r.budget_usd,
    maxConcurrent: r.max_concurrent,
    maxRetries: r.max_retries,
    warmPoolSize: r.warm_pool_size,
    enabled: r.enabled,
    environmentSpec: r.environment_spec,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runCount: parseInt(r.run_count) || 0,
    lastRunAt: r.last_run_at || null,
    totalCostUsd: r.total_cost_usd,
    triggerTypes: triggerMap[r.id] ?? [],
  }));
}

export async function getWorkflowWithStats(id: string) {
  const workflow = await getWorkflow(id);
  if (!workflow) return null;

  const [stats] = await db.execute<{
    run_count: string;
    last_run_at: string | null;
    total_cost_usd: string;
  }>(sql`
    SELECT
      COUNT(DISTINCT wr.id)::text AS run_count,
      MAX(wr.created_at)::text AS last_run_at,
      COALESCE(SUM(CAST(wr.cost_usd AS NUMERIC)), 0)::text AS total_cost_usd
    FROM workflow_runs wr
    WHERE wr.workflow_id = ${id}
  `);

  return {
    ...workflow,
    runCount: parseInt(stats?.run_count) || 0,
    lastRunAt: stats?.last_run_at || null,
    totalCostUsd: stats?.total_cost_usd || "0",
  };
}

// ── Workflow Runs ────────────────────────────────────────────────────────────

export async function listWorkflowRuns(workflowId: string, limit = 50) {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);
}

export async function getWorkflowRun(id: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return run ?? null;
}

export async function createWorkflowRun(
  workflowId: string,
  opts?: { params?: Record<string, unknown>; triggerId?: string },
) {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (!workflow.enabled) throw new Error("Workflow is disabled");

  const [run] = await db
    .insert(workflowRuns)
    .values({
      workflowId,
      triggerId: opts?.triggerId,
      params: opts?.params,
      state: WorkflowRunState.QUEUED,
    })
    .returning();

  logger.info({ workflowRunId: run.id, workflowId }, "Workflow run created");
  return run;
}

// ── Workflow Run Operations ─────────────────────────────────────────────────

/**
 * Retry a failed workflow run by transitioning it back to queued.
 */
export async function retryWorkflowRun(id: string) {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const currentState = run.state as WorkflowRunState;
  if (!canTransitionWorkflowRun(currentState, WorkflowRunState.QUEUED)) {
    throw new Error(`Cannot retry workflow run in state "${run.state}"`);
  }

  transitionWorkflowRun(currentState, WorkflowRunState.QUEUED);

  const [updated] = await db
    .update(workflowRuns)
    .set({
      state: WorkflowRunState.QUEUED,
      retryCount: (run.retryCount ?? 0) + 1,
      errorMessage: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(workflowRuns.id, id))
    .returning();

  logger.info({ workflowRunId: id }, "Workflow run retried");
  return updated;
}

/**
 * Cancel a running workflow run by transitioning it to failed.
 */
export async function cancelWorkflowRun(id: string) {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const currentState = run.state as WorkflowRunState;
  if (!canTransitionWorkflowRun(currentState, WorkflowRunState.FAILED)) {
    throw new Error(`Cannot cancel workflow run in state "${run.state}"`);
  }

  transitionWorkflowRun(currentState, WorkflowRunState.FAILED);

  const [updated] = await db
    .update(workflowRuns)
    .set({
      state: WorkflowRunState.FAILED,
      errorMessage: "Cancelled by user",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowRuns.id, id))
    .returning();

  logger.info({ workflowRunId: id }, "Workflow run cancelled");
  return updated;
}

/**
 * Get aggregated logs for a workflow run by querying taskLogs with workflowRunId.
 */
export async function getWorkflowRunLogs(id: string, opts: { logType?: string; limit?: number }) {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const conditions = [eq(taskLogs.workflowRunId, id)];
  if (opts.logType) {
    conditions.push(eq(taskLogs.logType, opts.logType));
  }

  let query = db
    .select()
    .from(taskLogs)
    .where(and(...conditions))
    .orderBy(taskLogs.timestamp);

  if (opts.limit) {
    query = query.limit(opts.limit) as typeof query;
  }

  return query;
}

// ── Workflow Triggers ─────────────────────────────────────────────────────────

export async function listWorkflowTriggers(workflowId: string) {
  return db
    .select()
    .from(workflowTriggers)
    .where(eq(workflowTriggers.workflowId, workflowId))
    .orderBy(desc(workflowTriggers.createdAt));
}
