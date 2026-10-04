/**
 * Unified Task service — the polymorphic /api/tasks HTTP layer routes through
 * here to dispatch to task-service, task-config-service, workflow-service,
 * or pr-review-service based on which backing table owns the given id.
 *
 * The user-facing concept is one "Task" with the following internal shapes:
 *   - `repo-task`       → rows in `tasks`          (ad-hoc one-time Repo Task run)
 *   - `repo-blueprint`  → `work_definitions` rows of that kind (reusable Repo Task blueprint)
 *   - `standalone`      → `work_definitions` rows of that kind (Standalone Task blueprint)
 *   - `pr-review`       → rows in `pr_reviews`     (external PR review)
 *
 * Runs underneath each:
 *   - `repo-task`       → has no sub-runs (the row itself IS a run)
 *   - `repo-blueprint`  → spawned repo tasks (linked via tasks.work_id)
 *   - `standalone`      → its Job runs (`tasks` rows of kind 'standalone')
 *   - `pr-review`       → rows in `pr_review_runs`
 */
import type { TriggerTargetType } from "@optio/shared";
import { canSee, type Actor } from "./ownership.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, workDefinitions, prReviews, prReviewRuns } from "../db/schema.js";
import * as taskService from "./task-service.js";
import * as taskConfigService from "./task-config-service.js";
import * as workflowService from "./workflow-service.js";
import * as prReviewService from "./pr-review-service.js";
import * as definitions from "./work-definition-service.js";

export type UnifiedTaskType = "repo-task" | "repo-blueprint" | "standalone" | "pr-review";

export interface ResolvedTask {
  type: UnifiedTaskType;
  /** The native row from the backing table. */
  data: Record<string, unknown>;
}

/**
 * Resolve an id across all three backing tables, in order of likelihood:
 * tasks (most common — ad-hoc runs) → scheduled Tasks → Jobs → PR reviews. Returns null
 * if no match. Optionally enforces workspace scoping.
 */
export async function resolveAnyTaskById(
  id: string,
  workspaceId?: string | null,
  /** With a viewer, someone else's private task or definition resolves to null (ownership.ts). */
  viewer?: Actor,
): Promise<ResolvedTask | null> {
  const task = await taskService.getTask(id);
  if (task) {
    if (workspaceId && task.workspaceId && task.workspaceId !== workspaceId) return null;
    if (viewer && !canSee(task.ownerUserId, viewer)) return null;
    return { type: "repo-task", data: task as unknown as Record<string, unknown> };
  }

  const definition = await definitions.getDefinition(id);
  if (definition && definition.kind !== "local-blueprint") {
    if (workspaceId && definition.workspaceId && definition.workspaceId !== workspaceId) {
      return null;
    }
    if (viewer && !canSee(definition.ownerUserId, viewer)) return null;
    return definition.kind === "repo-blueprint"
      ? { type: "repo-blueprint", data: taskConfigService.toTaskConfig(definition) }
      : { type: "standalone", data: workflowService.toWorkflow(definition) };
  }

  const review = await prReviewService.getPrReview(id);
  if (review) {
    if (workspaceId && review.workspaceId && review.workspaceId !== workspaceId) return null;
    return { type: "pr-review", data: review as unknown as Record<string, unknown> };
  }

  return null;
}

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
  const countRows = async (table: typeof tasks | typeof prReviews): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(wsId ? eq(table.workspaceId, wsId) : undefined);
    return row?.n ?? 0;
  };
  const countDefinitions = async (kind: "repo-blueprint" | "standalone"): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workDefinitions)
      .where(
        and(
          eq(workDefinitions.kind, kind),
          wsId ? eq(workDefinitions.workspaceId, wsId) : undefined,
        ),
      );
    return row?.n ?? 0;
  };
  let total = 0;
  if (!opts.type || opts.type === "repo-task") total += await countRows(tasks);
  if (!opts.type || opts.type === "repo-blueprint")
    total += await countDefinitions("repo-blueprint");
  if (!opts.type || opts.type === "standalone") total += await countDefinitions("standalone");
  if (!opts.type || opts.type === "pr-review") total += await countRows(prReviews);
  return total;
}

/**
 * List Tasks across backing tables.
 *
 * type="repo-task"       — tasks only
 * type="repo-blueprint"  — scheduled Tasks only
 * type="standalone"      — Jobs only
 * type="pr-review"       — PR reviews only
 * type=undefined         — all of them merged; individual rows tagged with `type`
 */
export async function listUnifiedTasks(opts: {
  type?: UnifiedTaskType;
  workspaceId?: string | null;
  limit?: number;
  /** Only rows this viewer may see (see ownership.ts). */
  viewer?: Actor;
}): Promise<Array<ResolvedTask>> {
  const wsId = opts.workspaceId ?? null;
  const limit = opts.limit ?? 50;
  const collected: ResolvedTask[] = [];

  if (!opts.type || opts.type === "repo-task") {
    const rows = await taskService.listTasks({ workspaceId: wsId, limit, visibleTo: opts.viewer });
    for (const r of rows) {
      collected.push({ type: "repo-task", data: r as unknown as Record<string, unknown> });
    }
  }

  if (!opts.type || opts.type === "repo-blueprint") {
    const rows = await taskConfigService.listTaskConfigs({
      workspaceId: wsId,
      viewer: opts.viewer,
    });
    for (const r of rows.slice(0, limit)) {
      collected.push({ type: "repo-blueprint", data: r as unknown as Record<string, unknown> });
    }
  }

  if (!opts.type || opts.type === "standalone") {
    const rows = await workflowService.listWorkflows(wsId ?? undefined, opts.viewer);
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
  const parentId = parent.data.id as string;
  switch (parent.type) {
    case "repo-task":
      return [];
    case "repo-blueprint":
      return taskService.listTasks({ workId: parentId, limit });
    case "standalone":
      return workflowService.listWorkflowRuns(parentId, limit);
    case "pr-review":
      return db
        .select()
        .from(prReviewRuns)
        .where(eq(prReviewRuns.prReviewId, parentId))
        .orderBy(desc(prReviewRuns.createdAt))
        .limit(limit);
  }
}

/** A single run by id, only if it is one of this parent Task's runs. */
export async function getUnifiedRun(
  parent: ResolvedTask,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const parentId = parent.data.id as string;
  switch (parent.type) {
    case "repo-task":
      return null;
    case "repo-blueprint": {
      const task = await taskService.getTask(runId);
      return task?.workId === parentId ? task : null;
    }
    case "standalone": {
      const run = await workflowService.getWorkflowRun(runId);
      return run?.workflowId === parentId ? run : null;
    }
    case "pr-review": {
      const [row] = await db
        .select()
        .from(prReviewRuns)
        .where(and(eq(prReviewRuns.id, runId), eq(prReviewRuns.prReviewId, parentId)));
      return row ?? null;
    }
  }
}

/** The `workflow_triggers.target_type` a resolved Task's triggers carry. */
export function targetTypeFor(parent: ResolvedTask): TriggerTargetType {
  if (parent.type === "pr-review") return "pr_review";
  return definitions.TRIGGER_TARGET[parent.type === "standalone" ? "standalone" : "repo-blueprint"];
}
