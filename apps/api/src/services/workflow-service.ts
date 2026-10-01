/**
 * Jobs — `standalone` work definitions (rows in work_definitions, CRUD in
 * work-definition-service) and their runs (`workflow_runs`). The Job half
 * keeps the shape /api/jobs has always returned (`toWorkflow`).
 */
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  parseIntEnv,
  SHELL_RUNTIME,
  type LocalAgentSessionMode,
  type RunTarget,
} from "@optio/shared";
import { db } from "../db/client.js";
import { workDefinitions, workflowRuns, workflowTriggers } from "../db/schema.js";
import * as runLogs from "./run-log-service.js";
import { WorkflowRunState, canTransitionWorkflowRun } from "@optio/shared";
import { publishWorkflowRunEvent } from "./event-bus.js";
import { logger } from "../logger.js";
import * as triggerService from "./trigger-service.js";
import * as definitions from "./work-definition-service.js";
import type { WorkDefinition, WorkDefinitionValues } from "./work-definition-service.js";
import { renderRunTitle } from "./prompt-template-service.js";
import { pgDate, updatedAtMatches } from "../utils/pg-timestamp.js";

// ── Workflow CRUD ────────────────────────────────────────────────────────────

/** A Job as /api/jobs has always returned it. */
export function toWorkflow(d: WorkDefinition) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    workspaceId: d.workspaceId,
    environmentSpec: d.environmentSpec,
    promptTemplate: d.prompt,
    paramsSchema: d.paramsSchema,
    runTitle: d.runTitle,
    // No agent: a Job that runs a shell command.
    agentRuntime: d.agentType ?? SHELL_RUNTIME,
    model: d.model,
    agentOptions: d.agentOptions,
    maxTurns: d.maxTurns,
    budgetUsd: d.budgetUsd,
    maxConcurrent: d.maxConcurrent,
    maxRetries: d.maxRetries,
    warmPoolSize: d.warmPoolSize,
    maxPodInstances: d.maxPodInstances,
    maxAgentsPerPod: d.maxAgentsPerPod,
    runTarget: d.runTarget,
    localHostId: d.localHostId,
    localDir: d.localDir,
    localSessionMode: d.localSessionMode ?? "headless",
    enabled: d.enabled,
    ownerUserId: d.ownerUserId,
    podSecrets: d.podSecrets,
    settings: d.settings,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export type Workflow = ReturnType<typeof toWorkflow>;

/** The stored agent for a runtime name: none for a shell command. */
export const agentTypeOf = (runtime: string): string | null =>
  runtime === SHELL_RUNTIME ? null : runtime;

/** A Job that runs a shell command (its params shell-quoted) instead of an agent. */
export const isCommandJob = (w: Pick<Workflow, "agentRuntime">): boolean =>
  w.agentRuntime === SHELL_RUNTIME;

export async function listWorkflows(workspaceId?: string) {
  const rows = await definitions.listDefinitions(
    "standalone",
    workspaceId ? eq(workDefinitions.workspaceId, workspaceId) : undefined,
  );
  return rows.map(toWorkflow);
}

export async function getWorkflow(id: string) {
  const row = await definitions.getDefinition(id, "standalone");
  return row && toWorkflow(row);
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  promptTemplate: string;
  /** `{{param}}` template each run is named from; null = the workflow's name. */
  runTitle?: string | null;
  agentRuntime?: string;
  model?: string;
  /** Per-run agent parameters keyed like the provider catalog; null = defaults. */
  agentOptions?: Record<string, string | boolean> | null;
  maxTurns?: number;
  budgetUsd?: string;
  maxConcurrent?: number;
  maxRetries?: number;
  warmPoolSize?: number;
  maxPodInstances?: number;
  maxAgentsPerPod?: number;
  enabled?: boolean;
  environmentSpec?: Record<string, unknown>;
  paramsSchema?: Record<string, unknown>;
  workspaceId?: string;
  createdBy?: string;
  /** Null = the organization's; see services/work-ownership.ts. */
  ownerUserId?: string | null;
  /** Secrets (by name) the pod gets; null = the workspace's legacy behavior. */
  podSecrets?: string[] | null;
  // Run location — validate with local-run-service.validateRunLocation first.
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
}

export async function createWorkflow(input: CreateWorkflowInput) {
  const local = input.runTarget === "local";
  const row = await definitions.createDefinition("standalone", {
    name: input.name,
    description: input.description,
    prompt: input.promptTemplate,
    runTitle: input.runTitle?.trim() || null,
    agentType: agentTypeOf(input.agentRuntime ?? "claude-code"),
    model: input.model,
    agentOptions: input.agentOptions ?? null,
    maxTurns: input.maxTurns,
    budgetUsd: input.budgetUsd,
    maxConcurrent: input.maxConcurrent ?? 2,
    maxRetries: input.maxRetries ?? 1,
    warmPoolSize: input.warmPoolSize ?? 0,
    maxPodInstances: input.maxPodInstances ?? 1,
    maxAgentsPerPod: input.maxAgentsPerPod ?? 2,
    runTarget: input.runTarget ?? "cluster",
    localHostId: local ? (input.localHostId ?? null) : null,
    localDir: local ? (input.localDir ?? null) : null,
    localSessionMode: input.localSessionMode ?? "headless",
    enabled: input.enabled ?? true,
    environmentSpec: input.environmentSpec,
    paramsSchema: input.paramsSchema,
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    ownerUserId: input.ownerUserId ?? null,
    podSecrets: input.podSecrets ?? null,
  });
  return toWorkflow(row);
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  promptTemplate?: string;
  runTitle?: string | null;
  agentRuntime?: string;
  model?: string | null;
  agentOptions?: Record<string, string | boolean> | null;
  maxTurns?: number | null;
  budgetUsd?: string | null;
  maxConcurrent?: number;
  maxRetries?: number;
  warmPoolSize?: number;
  maxPodInstances?: number;
  maxAgentsPerPod?: number;
  enabled?: boolean;
  environmentSpec?: Record<string, unknown> | null;
  paramsSchema?: Record<string, unknown> | null;
  runTarget?: RunTarget;
  localHostId?: string | null;
  localDir?: string | null;
  localSessionMode?: LocalAgentSessionMode | null;
  ownerUserId?: string | null;
  podSecrets?: string[] | null;
}

export async function updateWorkflow(id: string, input: UpdateWorkflowInput) {
  const { promptTemplate, agentRuntime, localSessionMode, runTitle, ...rest } = input;
  const patch: Partial<WorkDefinitionValues> = {
    ...rest,
    ...(promptTemplate !== undefined ? { prompt: promptTemplate } : {}),
    ...(agentRuntime !== undefined ? { agentType: agentTypeOf(agentRuntime) } : {}),
    ...(runTitle !== undefined ? { runTitle: runTitle?.trim() || null } : {}),
    // A null from a "cluster" location means "back to the default".
    ...(localSessionMode !== undefined ? { localSessionMode: localSessionMode ?? "headless" } : {}),
  };
  const row = await definitions.updateDefinition(id, "standalone", patch);
  return row && toWorkflow(row);
}

/** Delete a Job, its triggers, and its runs. */
export async function deleteWorkflow(id: string): Promise<boolean> {
  return definitions.deleteDefinition(id, "standalone");
}

export async function cloneWorkflow(
  id: string,
  opts?: { workspaceId?: string; createdBy?: string },
) {
  const source = await getWorkflow(id);
  if (!source) return null;

  const cloned = await createWorkflow({
    name: `${source.name} (copy)`,
    description: source.description ?? undefined,
    promptTemplate: source.promptTemplate,
    runTitle: source.runTitle,
    agentRuntime: source.agentRuntime ?? undefined,
    model: source.model ?? undefined,
    agentOptions: source.agentOptions ?? undefined,
    maxTurns: source.maxTurns ?? undefined,
    budgetUsd: source.budgetUsd ?? undefined,
    maxConcurrent: source.maxConcurrent ?? undefined,
    maxRetries: source.maxRetries ?? undefined,
    warmPoolSize: source.warmPoolSize ?? undefined,
    maxPodInstances: source.maxPodInstances ?? undefined,
    maxAgentsPerPod: source.maxAgentsPerPod ?? undefined,
    runTarget: source.runTarget,
    localHostId: source.localHostId,
    localDir: source.localDir,
    localSessionMode: source.localSessionMode,
    enabled: false, // clones start disabled
    environmentSpec: (source.environmentSpec as Record<string, unknown>) ?? undefined,
    paramsSchema: (source.paramsSchema as Record<string, unknown>) ?? undefined,
    workspaceId: opts?.workspaceId ?? source.workspaceId ?? undefined,
    createdBy: opts?.createdBy,
    // A copy of someone's personal work is the organization's: their
    // provider / secrets stay theirs (the copy's runs say so until changed).
    ownerUserId:
      source.ownerUserId && source.ownerUserId === opts?.createdBy ? source.ownerUserId : null,
    podSecrets: source.podSecrets,
  });

  // Clone triggers (except webhook — paths must be unique)
  const sourceTriggers = await triggerService.listTriggers("job", id);
  for (const trigger of sourceTriggers) {
    if (trigger.type === "webhook") continue; // skip — webhook paths must be globally unique
    await triggerService.createTrigger({
      targetType: "job",
      targetId: cloned.id,
      type: trigger.type,
      config: (trigger.config as Record<string, unknown>) ?? undefined,
      paramMapping: (trigger.paramMapping as Record<string, unknown>) ?? undefined,
      enabled: trigger.enabled,
    });
  }

  return cloned;
}

// ── Enriched list/get with aggregate run stats ───────────────────────────────

/**
 * Global per-state counts across all workflow runs for a workspace. Drives
 * the Standalone stats bar on the overview dashboard — shape mirrors
 * `getTaskStats()` so the frontend can treat it symmetrically.
 */
export async function getWorkflowRunStats(workspaceId?: string | null) {
  const wsFilter = workspaceId ? sql`AND w.workspace_id = ${workspaceId}` : sql``;

  const rows = await db.execute<{ state: string; count: string }>(sql`
    SELECT wr.state, COUNT(*)::text AS count
    FROM workflow_runs wr
    JOIN work_definitions w ON w.id = wr.workflow_id
    WHERE 1=1 ${wsFilter}
    GROUP BY wr.state
  `);

  let total = 0;
  let queued = 0;
  let running = 0;
  let failed = 0;
  let completed = 0;

  for (const row of rows) {
    const count = parseInt(row.count, 10) || 0;
    total += count;
    switch (row.state) {
      case "queued":
        queued += count;
        break;
      case "running":
        running += count;
        break;
      case "failed":
        failed += count;
        break;
      case "completed":
        completed += count;
        break;
    }
  }

  return { total, queued, running, failed, completed };
}

type RunStatsRow = {
  workflow_id: string;
  run_count: string;
  last_run_at: string | null;
  total_cost_usd: string;
  recent_queued: string;
  recent_running: string;
  recent_failed: string;
  recent_completed: string;
};

/** Run counts, last run, spend, and the last 7 days by state — per Job. */
async function runStats(workflowIds: string[]): Promise<Map<string, RunStatsRow>> {
  if (workflowIds.length === 0) return new Map();
  const rows = await db.execute<RunStatsRow>(sql`
    SELECT
      wr.workflow_id,
      COUNT(*)::text AS run_count,
      MAX(wr.created_at)::text AS last_run_at,
      COALESCE(SUM(CAST(NULLIF(wr.cost_usd, '') AS NUMERIC)), 0)::text AS total_cost_usd,
      COUNT(*) FILTER (
        WHERE wr.state = 'queued' AND wr.created_at > NOW() - INTERVAL '7 days'
      )::text AS recent_queued,
      COUNT(*) FILTER (
        WHERE wr.state = 'running' AND wr.created_at > NOW() - INTERVAL '7 days'
      )::text AS recent_running,
      COUNT(*) FILTER (
        WHERE wr.state = 'failed' AND wr.created_at > NOW() - INTERVAL '7 days'
      )::text AS recent_failed,
      COUNT(*) FILTER (
        WHERE wr.state = 'completed' AND wr.created_at > NOW() - INTERVAL '7 days'
      )::text AS recent_completed
    FROM workflow_runs wr
    WHERE wr.workflow_id IN ${workflowIds}
    GROUP BY wr.workflow_id
  `);
  return new Map(rows.map((r) => [r.workflow_id, r]));
}

export async function listWorkflowsWithStats(workspaceId?: string) {
  const workflows = await listWorkflows(workspaceId);
  const ids = workflows.map((w) => w.id);
  const stats = await runStats(ids);

  // Trigger types per Job
  const triggerMap: Record<string, string[]> = {};
  if (ids.length > 0) {
    const triggers = await db
      .select({ targetId: workflowTriggers.targetId, type: workflowTriggers.type })
      .from(workflowTriggers)
      .where(and(eq(workflowTriggers.targetType, "job"), inArray(workflowTriggers.targetId, ids)));
    for (const t of triggers) {
      const types = (triggerMap[t.targetId] ??= []);
      if (!types.includes(t.type)) types.push(t.type);
    }
  }

  return workflows.map((w) => {
    const r = stats.get(w.id);
    return {
      ...w,
      runCount: parseInt(r?.run_count ?? "0") || 0,
      lastRunAt: pgDate(r?.last_run_at ?? null),
      totalCostUsd: r?.total_cost_usd ?? "0",
      recentStats: {
        queued: parseInt(r?.recent_queued ?? "0") || 0,
        running: parseInt(r?.recent_running ?? "0") || 0,
        failed: parseInt(r?.recent_failed ?? "0") || 0,
        completed: parseInt(r?.recent_completed ?? "0") || 0,
      },
      triggerTypes: triggerMap[w.id] ?? [],
    };
  });
}

export async function getWorkflowWithStats(id: string) {
  const workflow = await getWorkflow(id);
  if (!workflow) return null;

  const r = (await runStats([id])).get(id);
  return {
    ...workflow,
    runCount: parseInt(r?.run_count ?? "0") || 0,
    lastRunAt: pgDate(r?.last_run_at ?? null),
    totalCostUsd: r?.total_cost_usd || "0",
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

/**
 * The Job concurrency rule's two limits and how full each is: running Job
 * runs across every Job (cluster runs only — a local run holds no pod) under
 * OPTIO_MAX_WORKFLOW_CONCURRENT, and this Job's running runs under its
 * `maxConcurrent`. A run starts only while both are below their max.
 */
export async function jobRunCapacity(workflowId: string, maxConcurrent: number) {
  const [row] = await db
    .select({
      global: sql<number>`count(*) FILTER (WHERE ${workDefinitions.runTarget} <> 'local')::int`,
      job: sql<number>`count(*) FILTER (WHERE ${workflowRuns.workflowId} = ${workflowId})::int`,
    })
    .from(workflowRuns)
    .innerJoin(workDefinitions, eq(workDefinitions.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.state, WorkflowRunState.RUNNING));
  return {
    global: {
      running: Number(row?.global ?? 0),
      max: parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5),
    },
    job: { running: Number(row?.job ?? 0), max: maxConcurrent },
  };
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
      title: workflow.runTitle
        ? renderRunTitle(workflow.runTitle, opts?.params, workflow.name)
        : null,
      state: WorkflowRunState.QUEUED,
      // A run is its Job's: seen in the Job's workspace, run as its owner.
      workspaceId: workflow.workspaceId,
      ownerUserId: workflow.ownerUserId,
      runTarget: workflow.runTarget,
      maxRetries: workflow.maxRetries,
    })
    .returning();

  logger.info({ workflowRunId: run.id, workflowId }, "Workflow run created");

  // Enqueue for the workflow-worker to pick up. Dynamic import avoids a cycle
  // between services/workflow-service and workers/workflow-worker. This is
  // the ONE place every run-creation path hits — keeping the enqueue here
  // means trigger firings, webhook ingress, and the unified /api/tasks
  // endpoints all get processed without each caller remembering to enqueue.
  import("../workers/workflow-worker.js")
    .then(({ workflowRunQueue }) =>
      workflowRunQueue.add("process-workflow-run", { workflowRunId: run.id }, { jobId: run.id }),
    )
    .catch((err) =>
      logger.error({ err, runId: run.id }, "Failed to enqueue workflow run for processing"),
    );

  // Fire outbound webhook (fire-and-forget). Dynamic import to avoid a cycle
  // with workers/webhook-worker -> services/workflow-service.
  import("../workers/webhook-worker.js")
    .then(({ enqueueWebhookEvent }) =>
      enqueueWebhookEvent("workflow_run.queued", {
        runId: run.id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        state: run.state,
        params: run.params ?? null,
        retryCount: run.retryCount,
      }),
    )
    .catch((err) =>
      logger.warn({ err, runId: run.id }, "Failed to enqueue workflow_run.queued webhook"),
    );

  return run;
}

// ── Workflow Run Operations ─────────────────────────────────────────────────

/**
 * Retry a failed workflow run by transitioning it back to queued. The
 * transition wakes the reconciler, which enqueues the run.
 */
export async function retryWorkflowRun(id: string) {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const updated = await transitionWorkflowRunCas(
    id,
    run.state as WorkflowRunState,
    WorkflowRunState.QUEUED,
    { retryCount: (run.retryCount ?? 0) + 1, errorMessage: null, finishedAt: null },
  );
  if (!updated) throw new Error(`Cannot retry workflow run in state "${run.state}"`);

  logger.info({ workflowRunId: id }, "Workflow run retried");
  return updated;
}

/**
 * Cancel a running workflow run by transitioning it to failed (which also
 * stops a local run's terminal).
 *
 * Also exhausts the run's retry budget (retryCount = workflow.maxRetries):
 * the reconciler's decideFailed auto-retries any FAILED run with budget left
 * and cannot tell a user cancellation from an agent failure — without this a
 * cancelled run silently reruns. An explicit user retry via retryWorkflowRun
 * still works (it does not consult maxRetries). The reconciler's
 * control_intent=cancel path stamps the same shape.
 */
export async function cancelWorkflowRun(id: string) {
  const run = await getWorkflowRun(id);
  if (!run) throw new Error("Workflow run not found");

  const workflow = await getWorkflow(run.workflowId);
  const updated = await transitionWorkflowRunCas(
    id,
    run.state as WorkflowRunState,
    WorkflowRunState.FAILED,
    {
      errorMessage: "Cancelled by user",
      finishedAt: new Date(),
      retryCount: Math.max(run.retryCount ?? 0, workflow?.maxRetries ?? 0),
    },
  );
  if (!updated) throw new Error(`Cannot cancel workflow run in state "${run.state}"`);

  logger.info({ workflowRunId: id }, "Workflow run cancelled");
  return updated;
}

/**
 * The one way a Job run changes state. Compare-and-swap: it lands only while
 * the row is still in `from` (and, for the reconciler, still at `version`),
 * so concurrent writers — the worker, daemon frames for local runs, the
 * reconciler, zombie detection, user actions — can't clobber each other.
 * A worker passes the `startedAt` of the attempt it claimed, so an attempt
 * that outlived its claim (failed as stalled and retried, cancelled and
 * retried) can't finish the attempt that replaced it.
 * One fan-out for every caller: the WS state-change event, the outbound
 * webhook, stopping a local run's terminal when the run fails, and (unless
 * the reconciler itself is the caller) a reconcile wake. Returns the updated
 * row, or null when the transition is invalid or someone else moved the run.
 */
export async function transitionWorkflowRunCas(
  runId: string,
  from: WorkflowRunState,
  to: WorkflowRunState,
  fields: PgUpdateSetSource<typeof workflowRuns> = {},
  opts: {
    /** The reconciler's CAS version (`updated_at`). */
    version?: Date;
    /** A worker's attempt: lands only while the attempt that started then still owns the run. */
    startedAt?: Date;
    wakeReconciler?: boolean;
  } = {},
) {
  if (!canTransitionWorkflowRun(from, to)) {
    logger.warn({ runId, from, to }, "Invalid workflow run state transition");
    return null;
  }
  const [row] = await db
    .update(workflowRuns)
    .set({ ...fields, state: to, updatedAt: new Date() })
    .where(
      and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.state, from),
        opts.version ? updatedAtMatches(workflowRuns.updatedAt, opts.version) : undefined,
        opts.startedAt ? updatedAtMatches(workflowRuns.startedAt, opts.startedAt) : undefined,
      ),
    )
    .returning();
  if (!row) return null;

  await publishWorkflowRunEvent({
    type: "workflow_run:state_changed",
    workflowRunId: runId,
    workflowId: row.workflowId,
    fromState: from,
    toState: to,
    timestamp: new Date().toISOString(),
    costUsd: row.costUsd ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    modelUsed: row.modelUsed ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
  }).catch((err) => logger.warn({ err, runId }, "Failed to publish workflow run event"));

  const webhookEvent = (
    {
      [WorkflowRunState.RUNNING]: "workflow_run.started",
      [WorkflowRunState.COMPLETED]: "workflow_run.completed",
      [WorkflowRunState.FAILED]: "workflow_run.failed",
    } as Partial<Record<WorkflowRunState, string>>
  )[to];
  if (webhookEvent) {
    const workflow = await getWorkflow(row.workflowId).catch(() => null);
    if (workflow) {
      const durationMs = row.startedAt
        ? (row.finishedAt ?? new Date()).getTime() - row.startedAt.getTime()
        : undefined;
      import("../workers/webhook-worker.js")
        .then(({ enqueueWebhookEvent }) =>
          enqueueWebhookEvent(webhookEvent as never, {
            runId: row.id,
            workflowId: workflow.id,
            workflowName: workflow.name,
            state: row.state,
            fromState: from,
            params: row.params ?? null,
            output: row.output ?? null,
            costUsd: row.costUsd ?? undefined,
            inputTokens: row.inputTokens ?? undefined,
            outputTokens: row.outputTokens ?? undefined,
            modelUsed: row.modelUsed ?? undefined,
            errorMessage: row.errorMessage ?? undefined,
            retryCount: row.retryCount,
            durationMs,
            startedAt: row.startedAt?.toISOString() ?? null,
            finishedAt: row.finishedAt?.toISOString() ?? null,
          }),
        )
        .catch((err) => logger.warn({ err, runId }, "Failed to enqueue workflow run webhook"));
    }
  }

  // A local run failed from the server side (a cancel, a disabled Job, the
  // reconciler): its agent may still be alive in a terminal on the owner's
  // machine — stop it. A no-op when the terminal already exited. Dynamic
  // import — local-run-service imports this module.
  if (to === WorkflowRunState.FAILED && row.localTerminalId) {
    const terminalId = row.localTerminalId;
    import("./local-run-service.js")
      .then(({ killLinkedTerminal }) => killLinkedTerminal(terminalId, `run_failed:${from}`))
      .catch((err) => logger.warn({ err, runId }, "Failed to kill local terminal for run"));
  }

  if (opts.wakeReconciler !== false) {
    import("./reconcile-queue.js")
      .then(({ enqueueReconcile }) =>
        enqueueReconcile(
          { kind: "standalone", id: runId },
          { reason: `transition:${from}->${to}` },
        ),
      )
      .catch((err) => logger.warn({ err, runId }, "Failed to enqueue reconcile"));
  }

  return row;
}

// ── Workflow Run Logs ────────────────────────────────────────────────────────

// A Job run's lines live in task_logs with every other run's, keyed by the
// run (it is a row of the runs table); this keeps the shape the Job-run log
// endpoints and frames have always carried.

/** A stored line, as the Job-run endpoints return it. */
function asWorkflowRunLog(row: runLogs.LogRow) {
  return {
    id: row.id,
    workflowRunId: row.taskId!,
    stream: row.stream,
    content: row.content,
    logType: row.logType,
    metadata: row.metadata,
    timestamp: row.timestamp,
  };
}

export async function getWorkflowRunLogs(
  workflowRunId: string,
  opts?: { logType?: string; limit?: number },
) {
  const rows = await runLogs.listLogs({ taskId: workflowRunId }, opts);
  return rows.map(asWorkflowRunLog);
}

export async function insertWorkflowRunLog(input: {
  workflowRunId: string;
  stream?: string;
  content: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}) {
  const row = await runLogs.insertLog({ taskId: input.workflowRunId }, input);
  return asWorkflowRunLog(row);
}

export async function appendWorkflowRunLog(input: {
  workflowRunId: string;
  stream?: string;
  content: string;
  logType?: string;
  metadata?: Record<string, unknown>;
}) {
  const log = await insertWorkflowRunLog(input);

  await publishWorkflowRunEvent({
    type: "workflow_run:log",
    workflowRunId: input.workflowRunId,
    stream: (log.stream as "stdout" | "stderr") ?? "stdout",
    content: log.content,
    timestamp: log.timestamp?.toISOString() ?? new Date().toISOString(),
    logType: log.logType ?? undefined,
    metadata: log.metadata ?? undefined,
  });

  return log;
}
