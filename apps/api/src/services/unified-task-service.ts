/**
 * Unified Task service — the polymorphic /api/tasks HTTP layer routes through
 * here to dispatch to task-service, task-config-service, workflow-service,
 * or pr-review-service based on which backing table owns the given id.
 *
 * The user-facing concept is one "Task" with the following internal shapes:
 *   - `repo-task`       → rows in `tasks`          (ad-hoc one-time Repo Task run)
 *   - `repo-blueprint`  → rows in `task_configs`   (reusable Repo Task blueprint)
 *   - `standalone`      → rows in `workflows`      (Standalone Task blueprint)
 *   - `pr-review`       → rows in `pr_reviews`     (external PR review)
 *
 * Runs underneath each:
 *   - `repo-task`       → has no sub-runs (the row itself IS a run)
 *   - `repo-blueprint`  → spawned `tasks` rows (linked via metadata.taskConfigId)
 *   - `standalone`      → rows in `workflow_runs`
 *   - `pr-review`       → rows in `pr_review_runs`
 */
import type { TriggerTargetType } from "@optio/shared";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  tasks,
  taskConfigs,
  workflows,
  workflowRuns,
  workflowTriggers,
  prReviews,
  prReviewRuns,
} from "../db/schema.js";
import * as taskService from "./task-service.js";
import * as taskConfigService from "./task-config-service.js";
import * as workflowService from "./workflow-service.js";
import * as prReviewService from "./pr-review-service.js";

export type UnifiedTaskType = "repo-task" | "repo-blueprint" | "standalone" | "pr-review";

export interface ResolvedTask {
  type: UnifiedTaskType;
  /** The native row from the backing table. */
  data: Record<string, unknown>;
}

/**
 * Resolve an id across all three backing tables, in order of likelihood:
 * tasks (most common — ad-hoc runs) → task_configs → workflows. Returns null
 * if no match. Optionally enforces workspace scoping.
 */
export async function resolveAnyTaskById(
  id: string,
  workspaceId?: string | null,
): Promise<ResolvedTask | null> {
  const task = await taskService.getTask(id);
  if (task) {
    if (workspaceId && task.workspaceId && task.workspaceId !== workspaceId) return null;
    return { type: "repo-task", data: task as unknown as Record<string, unknown> };
  }

  const config = await taskConfigService.getTaskConfig(id);
  if (config) {
    if (workspaceId && config.workspaceId && config.workspaceId !== workspaceId) return null;
    return { type: "repo-blueprint", data: config as unknown as Record<string, unknown> };
  }

  const workflow = await workflowService.getWorkflow(id);
  if (workflow) {
    if (workspaceId && workflow.workspaceId && workflow.workspaceId !== workspaceId) return null;
    return { type: "standalone", data: workflow as unknown as Record<string, unknown> };
  }

  const review = await prReviewService.getPrReview(id);
  if (review) {
    if (workspaceId && review.workspaceId && review.workspaceId !== workspaceId) return null;
    return { type: "pr-review", data: review as unknown as Record<string, unknown> };
  }

  return null;
}

/**
 * List Tasks across backing tables.
 *
 * type="repo-task"       — tasks only
 * type="repo-blueprint"  — task_configs only
 * type="standalone"      — workflows only
 * type=undefined         — all three merged; individual rows tagged with `type`
 */
/**
 * How many rows the polymorphic list spans (the same tables
 * `listUnifiedTasks` reads, optionally one kind) in a workspace — the `total` for
 * `GET /api/tasks?type=…`, which the New session form uses to number
 * unnamed sessions.
 */
export async function countUnifiedTasks(opts: {
  type?: UnifiedTaskType;
  workspaceId?: string | null;
}): Promise<number> {
  const wsId = opts.workspaceId ?? null;
  const countRows = async (
    table: typeof tasks | typeof taskConfigs | typeof workflows | typeof prReviews,
  ): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(wsId ? eq(table.workspaceId, wsId) : undefined);
    return row?.n ?? 0;
  };
  let total = 0;
  if (!opts.type || opts.type === "repo-task") total += await countRows(tasks);
  if (!opts.type || opts.type === "repo-blueprint") total += await countRows(taskConfigs);
  if (!opts.type || opts.type === "standalone") total += await countRows(workflows);
  if (!opts.type || opts.type === "pr-review") total += await countRows(prReviews);
  return total;
}

export async function listUnifiedTasks(opts: {
  type?: UnifiedTaskType;
  workspaceId?: string | null;
  limit?: number;
}): Promise<Array<ResolvedTask>> {
  const wsId = opts.workspaceId ?? null;
  const limit = opts.limit ?? 50;
  const collected: ResolvedTask[] = [];

  if (!opts.type || opts.type === "repo-task") {
    const rows = await taskService.listTasks({ workspaceId: wsId, limit });
    for (const r of rows) {
      collected.push({ type: "repo-task", data: r as unknown as Record<string, unknown> });
    }
  }

  if (!opts.type || opts.type === "repo-blueprint") {
    const rows = await taskConfigService.listTaskConfigs({ workspaceId: wsId });
    for (const r of rows.slice(0, limit)) {
      collected.push({ type: "repo-blueprint", data: r as unknown as Record<string, unknown> });
    }
  }

  if (!opts.type || opts.type === "standalone") {
    const rows = await workflowService.listWorkflows(wsId ?? undefined);
    for (const r of rows.slice(0, limit)) {
      collected.push({ type: "standalone", data: r as unknown as Record<string, unknown> });
    }
  }

  if (!opts.type || opts.type === "pr-review") {
    const conditions = wsId ? [eq(prReviews.workspaceId, wsId)] : [];
    const rows = await db
      .select()
      .from(prReviews)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(prReviews.updatedAt))
      .limit(limit);
    for (const r of rows) {
      collected.push({ type: "pr-review", data: r as unknown as Record<string, unknown> });
    }
  }

  return collected;
}

/**
 * List runs under a Task. Returns [] for ad-hoc repo-task (it has no sub-runs).
 */
export async function listUnifiedRuns(
  parent: ResolvedTask,
  opts?: { limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const limit = opts?.limit ?? 50;
  if (parent.type === "repo-task") return [];

  if (parent.type === "repo-blueprint") {
    // Spawned tasks are normal tasks rows with metadata.taskConfigId set.
    const parentId = parent.data.id as string;
    const rows = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.metadata}->>'taskConfigId' = ${parentId}`)
      .orderBy(desc(tasks.createdAt))
      .limit(limit);
    return rows as unknown as Array<Record<string, unknown>>;
  }

  if (parent.type === "pr-review") {
    const parentId = parent.data.id as string;
    const rows = await db
      .select()
      .from(prReviewRuns)
      .where(eq(prReviewRuns.prReviewId, parentId))
      .orderBy(desc(prReviewRuns.createdAt))
      .limit(limit);
    return rows as unknown as Array<Record<string, unknown>>;
  }

  // standalone
  const parentId = parent.data.id as string;
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, parentId))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit);
  return rows as unknown as Array<Record<string, unknown>>;
}

/**
 * Resolve a single run by id across both "run" tables (tasks for repo,
 * workflow_runs for standalone), scoped to a parent Task.
 */
export async function getUnifiedRun(
  parent: ResolvedTask,
  runId: string,
): Promise<Record<string, unknown> | null> {
  if (parent.type === "repo-task") return null;

  if (parent.type === "repo-blueprint") {
    const parentId = parent.data.id as string;
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, runId), sql`${tasks.metadata}->>'taskConfigId' = ${parentId}`));
    return (row as unknown as Record<string, unknown>) ?? null;
  }

  if (parent.type === "pr-review") {
    const parentId = parent.data.id as string;
    const [row] = await db
      .select()
      .from(prReviewRuns)
      .where(and(eq(prReviewRuns.id, runId), eq(prReviewRuns.prReviewId, parentId)));
    return (row as unknown as Record<string, unknown>) ?? null;
  }

  const parentId = parent.data.id as string;
  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workflowId, parentId)));
  return (row as unknown as Record<string, unknown>) ?? null;
}

/** The `workflow_triggers.target_type` a resolved Task's triggers carry. */
export function targetTypeFor(parent: ResolvedTask): TriggerTargetType {
  switch (parent.type) {
    case "standalone":
      return "job";
    case "pr-review":
      return "pr_review";
    default:
      return "task_config";
  }
}

/**
 * Look up a trigger by id for the polymorphic trigger routes. Scoped to a
 * parent Task so that triggers only appear under their owning Task.
 */

export async function getTriggerForParent(parent: ResolvedTask, triggerId: string) {
  const targetType = targetTypeFor(parent);
  const parentId = parent.data.id as string;
  const [trigger] = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.id, triggerId),
        eq(workflowTriggers.targetType, targetType),
        eq(workflowTriggers.targetId, parentId),
      ),
    );
  return trigger ?? null;
}

export async function listTriggersForParent(parent: ResolvedTask) {
  const targetType = targetTypeFor(parent);
  const parentId = parent.data.id as string;
  return db
    .select()
    .from(workflowTriggers)
    .where(
      and(eq(workflowTriggers.targetType, targetType), eq(workflowTriggers.targetId, parentId)),
    )
    .orderBy(desc(workflowTriggers.createdAt));
}
