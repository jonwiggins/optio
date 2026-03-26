import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { taskDependencies, tasks } from "../db/schema.js";
import { TaskState, detectCycle, type DagEdge } from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

/**
 * Add dependencies for a task. Validates no cycles would be introduced.
 */
export async function addDependencies(taskId: string, dependsOnIds: string[]): Promise<void> {
  if (dependsOnIds.length === 0) return;

  // Validate no self-dependency
  if (dependsOnIds.includes(taskId)) {
    throw new Error("A task cannot depend on itself");
  }

  // Validate all dependency tasks exist
  const depTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.id, dependsOnIds));
  const foundIds = new Set(depTasks.map((t) => t.id));
  const missing = dependsOnIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Dependency tasks not found: ${missing.join(", ")}`);
  }

  // Load all existing edges to validate DAG
  const existingEdges = await getAllEdges();
  const newEdges: DagEdge[] = dependsOnIds.map((depId) => ({
    from: taskId,
    to: depId,
  }));

  // Check for cycles with all new edges added
  const allEdges = [...existingEdges, ...newEdges];
  const cycle = detectCycle(allEdges);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(" → ")}`);
  }

  // Insert dependency rows
  await db.insert(taskDependencies).values(
    dependsOnIds.map((depId) => ({
      taskId,
      dependsOnTaskId: depId,
    })),
  );
}

/**
 * Get all tasks that taskId depends on.
 */
export async function getDependencies(taskId: string) {
  const deps = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      state: tasks.state,
      dependencyId: taskDependencies.id,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));
  return deps;
}

/**
 * Get all tasks that depend on taskId (reverse lookup).
 */
export async function getDependents(taskId: string) {
  const deps = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      state: tasks.state,
      dependencyId: taskDependencies.id,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
    .where(eq(taskDependencies.dependsOnTaskId, taskId));
  return deps;
}

/**
 * Check if all dependencies of a task are in a "met" state
 * (completed or pr_opened, since pr_opened means the work is done).
 */
export async function areDependenciesMet(taskId: string): Promise<boolean> {
  const deps = await getDependencies(taskId);
  if (deps.length === 0) return true;
  return deps.every((d) => d.state === TaskState.COMPLETED || d.state === TaskState.PR_OPENED);
}

/**
 * Called when a task completes (or reaches pr_opened). Finds all dependents
 * in 'waiting_on_deps' state, checks if their dependencies are now all met,
 * and transitions them to 'queued'.
 */
export async function onDependencyComplete(completedTaskId: string): Promise<void> {
  const dependents = await getDependents(completedTaskId);

  for (const dep of dependents) {
    if (dep.state !== TaskState.WAITING_ON_DEPS) continue;

    const met = await areDependenciesMet(dep.id);
    if (!met) continue;

    try {
      await taskService.transitionTask(dep.id, TaskState.QUEUED, "dependencies_met");
      await taskQueue.add(
        "process-task",
        { taskId: dep.id },
        {
          jobId: `${dep.id}-deps-met-${Date.now()}`,
          priority: 100,
        },
      );
      logger.info({ taskId: dep.id }, "Dependencies met — task queued");
    } catch (err) {
      logger.warn({ err, taskId: dep.id }, "Failed to queue dependent task after deps met");
    }
  }
}

/**
 * Called when a task fails. Cascade-fails all dependents that are in
 * 'waiting_on_deps' state, recursively.
 */
export async function cascadeFailure(failedTaskId: string): Promise<void> {
  const dependents = await getDependents(failedTaskId);

  for (const dep of dependents) {
    if (dep.state !== TaskState.WAITING_ON_DEPS) continue;

    try {
      await taskService.transitionTask(
        dep.id,
        TaskState.FAILED,
        "dependency_failed",
        `Dependency ${failedTaskId} failed`,
      );
      logger.info(
        { taskId: dep.id, failedDep: failedTaskId },
        "Cascade failure — dependent failed",
      );

      // Recursively cascade to tasks depending on this one
      await cascadeFailure(dep.id);
    } catch (err) {
      logger.warn({ err, taskId: dep.id }, "Failed to cascade failure to dependent task");
    }
  }
}

/**
 * Remove a specific dependency.
 */
export async function removeDependency(taskId: string, dependsOnTaskId: string): Promise<boolean> {
  const deleted = await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
      ),
    )
    .returning();
  return deleted.length > 0;
}

/**
 * Compute a human-readable reason why a task is pending or not yet running.
 * Returns null if nothing is blocking the task.
 */
export async function computePendingReason(taskId: string): Promise<string | null> {
  const task = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((r) => r[0]);
  if (!task) return null;

  // Check for unsatisfied dependencies
  if (task.state === "waiting_on_deps" || task.state === "pending") {
    const deps = await getDependencies(taskId);
    if (deps.length > 0) {
      const incomplete = deps.filter(
        (d) => d.state !== TaskState.COMPLETED && d.state !== TaskState.PR_OPENED,
      );
      if (incomplete.length > 0) {
        const names = incomplete.map((d) => `${d.title} (${d.state})`);
        return `Blocked by: ${names.join(", ")}`;
      }
    }

    // Check if this is a pipeline step waiting for a previous step
    if (task.parentTaskId && task.taskType === "step") {
      const { getSubtasks } = await import("./subtask-service.js");
      const siblings = await getSubtasks(task.parentTaskId);
      const steps = siblings.filter((s) => s.taskType === "step");
      const myIndex = steps.findIndex((s) => s.id === taskId);
      if (myIndex > 0) {
        const prevStep = steps[myIndex - 1];
        if (prevStep.state !== "completed") {
          return `Waiting for step ${myIndex}: ${prevStep.title} (${prevStep.state})`;
        }
      }
    }
  }

  // Check concurrency limits for queued tasks
  if (task.state === "queued") {
    const globalMax = parseInt(process.env.OPTIO_MAX_CONCURRENT ?? "5", 10);
    const [{ count: activeCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(sql`${tasks.state} IN ('provisioning', 'running')`);
    if (Number(activeCount) >= globalMax) {
      return `Concurrency limit (${activeCount}/${globalMax} global)`;
    }

    const [{ count: repoCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        sql`${tasks.repoUrl} = ${task.repoUrl} AND ${tasks.state} IN ('provisioning', 'running')`,
      );
    // We can't easily get the repo config max here without importing repo-service,
    // so just report the count if there are running tasks
    if (Number(repoCount) > 0) {
      return `Waiting for repo slot (${repoCount} running in this repo)`;
    }
  }

  return null;
}

/**
 * Load all dependency edges from the database.
 */
async function getAllEdges(): Promise<DagEdge[]> {
  const rows = await db.select().from(taskDependencies);
  return rows.map((r) => ({ from: r.taskId, to: r.dependsOnTaskId }));
}
