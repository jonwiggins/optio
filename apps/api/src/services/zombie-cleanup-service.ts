/**
 * Zombie run cleanup service.
 *
 * Detects workflow_runs stuck in "running" whose backing pod has terminated,
 * failed, or disappeared. Transitions them to "failed" with a cleanup reason
 * and optionally retries within the workflow's maxRetries budget.
 *
 * Also detects repo tasks stuck in "running"/"provisioning" whose pod record
 * has been cleaned up (no matching repoPod), failing them so they can retry
 * through the normal stale-task path.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns, workflowPods, tasks, repoPods } from "../db/schema.js";
import { WorkflowRunState, TaskState } from "@optio/shared";
import { getRuntime } from "./container-service.js";
import { getWorkflow } from "./workflow-service.js";
import { releaseRun } from "./workflow-pool-service.js";
import { publishWorkflowRunEvent } from "./event-bus.js";
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

      await failZombieRun(run, reason);
      cleaned++;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "Error during zombie workflow run check — continuing");
    }
  }

  return cleaned;
}

/**
 * Transition a zombie workflow_run to failed, release its pod, and
 * optionally retry within the workflow's maxRetries budget.
 */
async function failZombieRun(run: typeof workflowRuns.$inferSelect, reason: string): Promise<void> {
  const errorMessage = `Zombie run detected: ${reason}`;

  // 1. Transition to FAILED
  await db
    .update(workflowRuns)
    .set({
      state: WorkflowRunState.FAILED,
      errorMessage,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowRuns.id, run.id));

  await publishWorkflowRunEvent({
    type: "workflow_run:state_changed",
    workflowRunId: run.id,
    workflowId: run.workflowId,
    fromState: WorkflowRunState.RUNNING,
    toState: WorkflowRunState.FAILED,
    timestamp: new Date().toISOString(),
  });

  logger.info({ runId: run.id, workflowId: run.workflowId, reason }, "Zombie workflow run failed");

  // 2. Release the workflow pod's activeRunCount
  try {
    const [pod] = await db
      .select()
      .from(workflowPods)
      .where(eq(workflowPods.workflowRunId, run.id));
    if (pod) {
      await releaseRun(pod.id);
    }
  } catch (err) {
    logger.warn({ err, runId: run.id }, "Failed to release workflow pod for zombie run");
  }

  // 3. Retry if within budget
  try {
    const workflow = await getWorkflow(run.workflowId);
    if (workflow && run.retryCount < workflow.maxRetries) {
      await db
        .update(workflowRuns)
        .set({
          state: WorkflowRunState.QUEUED,
          retryCount: run.retryCount + 1,
          errorMessage: null,
          finishedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));

      await publishWorkflowRunEvent({
        type: "workflow_run:state_changed",
        workflowRunId: run.id,
        workflowId: run.workflowId,
        fromState: WorkflowRunState.FAILED,
        toState: WorkflowRunState.QUEUED,
        timestamp: new Date().toISOString(),
      });

      const { workflowRunQueue } = await import("../workers/workflow-worker.js");
      await workflowRunQueue.add(
        "process-workflow-run",
        { workflowRunId: run.id },
        {
          jobId: `${run.id}-zombie-retry-${Date.now()}`,
          delay: 5000 * Math.pow(2, run.retryCount),
        },
      );

      logger.info(
        { runId: run.id, retryCount: run.retryCount + 1, maxRetries: workflow.maxRetries },
        "Zombie workflow run re-queued for retry",
      );
    }
  } catch (err) {
    logger.warn({ err, runId: run.id }, "Failed to retry zombie workflow run");
  }
}

/**
 * Detect repo tasks stuck in running/provisioning whose pod record has been
 * removed from repoPods (pod was cleaned up but task was never transitioned).
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
      const [pod] = await db
        .select({ id: repoPods.id })
        .from(repoPods)
        .where(eq(repoPods.id, task.lastPodId!));

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
