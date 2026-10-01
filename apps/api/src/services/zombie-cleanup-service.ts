/**
 * Zombie run cleanup service.
 *
 * Detects workflow_runs stuck in "running" whose backing pod has terminated,
 * failed, or disappeared, and fails them; the reconciler retries them within
 * the workflow's maxRetries budget like any other failed run. Local runs are
 * not checked: they have no pod, and the Optio Local daemon is the authority
 * on whether their agent is alive.
 *
 * Also detects repo tasks stuck in "running"/"provisioning" whose pod record
 * has been cleaned up (no matching repoPod), failing them so they can retry
 * through the normal stale-task path.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns, tasks } from "../db/schema.js";
import { getPod } from "./agent-pod-pool.js";
import { WorkflowRunState, TaskState } from "@optio/shared";
import { getRuntime } from "./container-service.js";
import { transitionWorkflowRunCas } from "./workflow-service.js";
import * as taskService from "./task-service.js";
import { logger } from "../logger.js";

/** How long a run must be stale before we consider it a zombie (default 5 min). */
const ZOMBIE_THRESHOLD_MS = parseInt(process.env.OPTIO_ZOMBIE_RUN_THRESHOLD_MS ?? "300000", 10);

/**
 * Scan for zombie workflow_runs and transition them to failed.
 * Returns the number of runs cleaned up.
 */
export async function cleanupZombieWorkflowRuns(): Promise<number> {
  const cutoffMs = ZOMBIE_THRESHOLD_MS;
  const rt = getRuntime();

  // Find all running workflow_runs
  const runningRuns = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.state, WorkflowRunState.RUNNING));

  let cleaned = 0;

  for (const run of runningRuns) {
    try {
      // A local run's agent lives on its owner's machine (no pod to check).
      if (run.localTerminalId) continue;
      // Skip recently updated runs (might still be actively running)
      const age = Date.now() - new Date(run.updatedAt).getTime();
      if (age < cutoffMs) continue;

      let isZombie = false;
      let reason = "";

      if (run.podName) {
        // Check if the backing pod is still alive
        try {
          const status = await rt.status({ id: run.podName, name: run.podName });
          if (status.state === "running") {
            continue; // Pod alive — not a zombie
          }
          // Pod exists but in terminal/failed state
          isZombie = true;
          reason = `Pod ${status.state}: ${status.reason ?? "terminated"}`;
        } catch {
          // Pod not found in cluster at all
          isZombie = true;
          reason = "Backing pod no longer exists in cluster";
        }
      } else {
        // No pod name recorded — stuck in running without ever getting a pod
        isZombie = true;
        reason = "No backing pod assigned to running workflow run";
      }

      if (!isZombie) continue;

      if (await failZombieRun(run, reason)) cleaned++;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "Error during zombie workflow run check — continuing");
    }
  }

  return cleaned;
}

/**
 * Fail a zombie Job run and let go of its pod. The transition wakes the
 * reconciler, whose decideFailed retries the run within the Job's maxRetries.
 */
async function failZombieRun(
  run: typeof workflowRuns.$inferSelect,
  reason: string,
): Promise<boolean> {
  const failed = await transitionWorkflowRunCas(
    run.id,
    WorkflowRunState.RUNNING,
    WorkflowRunState.FAILED,
    { errorMessage: `Zombie run detected: ${reason}`, finishedAt: new Date() },
    // Only the attempt that was seen dead — not a retry that claimed the run since.
    { startedAt: run.startedAt ?? undefined },
  );
  if (!failed) return false; // someone else moved it first

  logger.info({ runId: run.id, workflowId: run.workflowId, reason }, "Zombie workflow run failed");

  // The run no longer holds its pod. Its slot is the worker's to give back
  // when the attempt ends; a dead worker's is repaired by the cleanup
  // sweep's count reconciliation, which counts only runs that hold a pod.
  if (run.podId) {
    await db
      .update(workflowRuns)
      .set({ podId: null, updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.podId, run.podId)))
      .catch((err) => logger.warn({ err, runId: run.id }, "Failed to clear zombie run's pod"));
  }
  return true;
}

/**
 * Detect repo tasks stuck in running/provisioning whose pod record has been
 * removed from agent_pods (pod was cleaned up but task was never transitioned).
 * Transitions them to FAILED so the existing stale-retry logic can re-queue.
 * Returns the number of orphaned tasks failed.
 */
export async function cleanupOrphanedRepoTasks(): Promise<number> {
  // Find running/provisioning tasks that reference a lastPodId
  const activeTasks = await db
    .select({
      id: tasks.id,
      state: tasks.state,
      lastPodId: tasks.lastPodId,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(
      sql`${tasks.state} IN ('running', 'provisioning')
          AND ${tasks.lastPodId} IS NOT NULL`,
    );

  let cleaned = 0;

  for (const task of activeTasks) {
    try {
      // Check if the referenced repoPod record still exists
      const pod = await getPod(task.lastPodId!);

      if (pod) continue; // Pod record exists — skip (health check handles live pod status)

      // Pod record gone — the task is orphaned. Fail it so stale-retry can pick it up.
      const age = Date.now() - new Date(task.updatedAt).getTime();
      if (age < ZOMBIE_THRESHOLD_MS) continue; // Give it time in case of race conditions

      await taskService.transitionTask(
        task.id,
        TaskState.FAILED,
        "zombie_pod_gone",
        "Task pod record no longer exists — pod was likely terminated or drained",
      );

      logger.info(
        { taskId: task.id, lastPodId: task.lastPodId },
        "Orphaned repo task failed (pod record gone)",
      );
      cleaned++;
    } catch (err) {
      logger.warn({ err, taskId: task.id }, "Error during orphaned repo task check — continuing");
    }
  }

  return cleaned;
}
