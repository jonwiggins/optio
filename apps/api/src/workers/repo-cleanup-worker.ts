import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods, podHealthEvents, tasks, taskEvents } from "../db/schema.js";
import { cleanupIdleRepoPods } from "../services/repo-pool-service.js";
import { getRuntime } from "../services/container-service.js";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { logger } from "../logger.js";

const connectionOpts = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

export const repoCleanupQueue = new Queue("repo-cleanup", { connection: connectionOpts });

async function recordHealthEvent(
  repoPodId: string,
  repoUrl: string,
  eventType: string,
  podName: string | null,
  message: string,
) {
  await db.insert(podHealthEvents).values({
    repoPodId,
    repoUrl,
    eventType,
    podName,
    message,
  });
  logger.info({ repoPodId, eventType, message }, "Pod health event");
}

export function startRepoCleanupWorker() {
  repoCleanupQueue.add(
    "health-check",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_HEALTH_CHECK_INTERVAL ?? "60000", 10),
      },
    },
  );

  const worker = new Worker(
    "repo-cleanup",
    async () => {
      const rt = getRuntime();
      const pods = await db.select().from(repoPods);

      for (const pod of pods) {
        if (!pod.podName || pod.state === "provisioning") continue;

        try {
          const status = await rt.status({
            id: pod.podId ?? pod.podName,
            name: pod.podName,
          });

          if (status.state === "failed" || status.state === "unknown") {
            const isOom = status.reason?.includes("OOMKilled") ?? false;
            const eventType = isOom ? "oom_killed" : "crashed";
            const message = isOom
              ? `Pod OOM killed: ${status.reason}`
              : `Pod ${status.state}: ${status.reason ?? "unknown reason"}`;

            await recordHealthEvent(pod.id, pod.repoUrl, eventType, pod.podName, message);

            // Mark the pod as errored
            await db
              .update(repoPods)
              .set({
                state: "error",
                errorMessage: message,
                updatedAt: new Date(),
              })
              .where(eq(repoPods.id, pod.id));

            // Fail any tasks that were running on this pod
            const activeTasks = await db
              .select({ id: tasks.id, state: tasks.state })
              .from(tasks)
              .where(
                sql`${tasks.repoUrl} = ${pod.repoUrl} AND ${tasks.state} IN ('running', 'provisioning')`,
              );

            for (const task of activeTasks) {
              try {
                await taskService.transitionTask(
                  task.id,
                  TaskState.FAILED,
                  `pod_${eventType}`,
                  message,
                );
                await taskService.updateTaskResult(task.id, undefined, message);
              } catch {}
            }

            // Auto-restart: delete the dead pod and clear the record so next task recreates it
            try {
              await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
            } catch {}
            await db.delete(repoPods).where(eq(repoPods.id, pod.id));
            await recordHealthEvent(
              pod.id,
              pod.repoUrl,
              "restarted",
              pod.podName,
              "Pod record cleared for auto-recreation",
            );

            logger.warn(
              { repoUrl: pod.repoUrl, podName: pod.podName, eventType },
              "Unhealthy pod cleaned up",
            );
          } else if (status.state === "running" && pod.state === "error") {
            // Pod recovered (shouldn't happen but handle it)
            await db
              .update(repoPods)
              .set({ state: "ready", errorMessage: null, updatedAt: new Date() })
              .where(eq(repoPods.id, pod.id));
            await recordHealthEvent(pod.id, pod.repoUrl, "healthy", pod.podName, "Pod recovered");
          }
        } catch (err) {
          // Pod not found in K8s — clean up the record
          await db.delete(repoPods).where(eq(repoPods.id, pod.id));
          await recordHealthEvent(
            pod.id,
            pod.repoUrl,
            "crashed",
            pod.podName,
            `Pod not found in cluster: ${String(err)}`,
          );
        }
      }

      // Clean up orphaned worktrees inside running pods
      for (const pod of pods) {
        if (!pod.podName || pod.state !== "ready") continue;

        try {
          // List worktrees in the pod
          const session = await rt.exec(
            { id: pod.podId ?? pod.podName, name: pod.podName },
            ["bash", "-c", "ls /workspace/tasks/ 2>/dev/null || echo ''"],
            { tty: false },
          );

          let output = "";
          for await (const chunk of session.stdout as AsyncIterable<Buffer>) {
            output += chunk.toString();
          }
          session.close();

          const worktreeIds = output.trim().split("\n").filter(Boolean);
          if (worktreeIds.length === 0) continue;

          // State-aware worktree cleanup
          const WORKTREE_GRACE_MS = 120_000; // 2 minutes after terminal state before cleanup
          for (const taskId of worktreeIds) {
            const [task] = await db
              .select({
                state: tasks.state,
                updatedAt: tasks.updatedAt,
                worktreeState: tasks.worktreeState,
                retryCount: tasks.retryCount,
                maxRetries: tasks.maxRetries,
              })
              .from(tasks)
              .where(eq(tasks.id, taskId));

            // Skip cleanup for preserved worktrees (pr_opened, needs_attention)
            if (task?.worktreeState === "preserved") continue;
            if (task && ["pr_opened", "needs_attention"].includes(task.state)) continue;

            // Skip cleanup for dirty worktrees that might be retried
            if (
              task?.worktreeState === "dirty" &&
              task.state === "failed" &&
              (task.retryCount ?? 0) < (task.maxRetries ?? 3)
            ) {
              continue;
            }

            const isTerminal = task && ["completed", "cancelled"].includes(task.state);
            const isFailedNoRetry =
              task?.state === "failed" && (task.retryCount ?? 0) >= (task.maxRetries ?? 3);
            const shouldClean = isTerminal || isFailedNoRetry || task?.worktreeState === "removed";
            const age = task?.updatedAt ? Date.now() - new Date(task.updatedAt).getTime() : 0;

            if (shouldClean && age > WORKTREE_GRACE_MS) {
              try {
                const cleanSession = await rt.exec(
                  { id: pod.podId ?? pod.podName, name: pod.podName },
                  [
                    "bash",
                    "-c",
                    `cd /workspace/repo && git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null; rm -rf /workspace/tasks/${taskId}`,
                  ],
                  { tty: false },
                );
                for await (const _ of cleanSession.stdout as AsyncIterable<Buffer>) {
                }
                cleanSession.close();

                // Update worktree state to removed
                if (task) {
                  await db
                    .update(tasks)
                    .set({ worktreeState: "removed" })
                    .where(eq(tasks.id, taskId));
                }

                await recordHealthEvent(
                  pod.id,
                  pod.repoUrl,
                  "orphan_cleaned",
                  pod.podName,
                  `Cleaned orphan worktree for task ${taskId}`,
                );
              } catch {}
            }

            // Also clean worktrees with no matching task (truly orphaned)
            if (!task && age === 0) {
              try {
                const cleanSession = await rt.exec(
                  { id: pod.podId ?? pod.podName, name: pod.podName },
                  [
                    "bash",
                    "-c",
                    `cd /workspace/repo && git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null; rm -rf /workspace/tasks/${taskId}`,
                  ],
                  { tty: false },
                );
                for await (const _ of cleanSession.stdout as AsyncIterable<Buffer>) {
                }
                cleanSession.close();

                await recordHealthEvent(
                  pod.id,
                  pod.repoUrl,
                  "orphan_cleaned",
                  pod.podName,
                  `Cleaned truly orphan worktree (no task) ${taskId}`,
                );
              } catch {}
            }
          }
        } catch {
          // Pod may not be accessible — skip
        }
      }

      // Detect stale running/provisioning tasks (agent exec died without updating state)
      const STALE_TASK_MS = parseInt(process.env.OPTIO_STALE_TASK_MS ?? "600000", 10); // 10 min
      const MAX_STALE_RETRIES = 3;
      const staleTasks = await db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.state} IN ('running', 'provisioning')
              AND ${tasks.updatedAt} < NOW() - INTERVAL '1 millisecond' * ${STALE_TASK_MS}`,
        );

      for (const task of staleTasks) {
        try {
          // Cap stale retries to prevent infinite cycling
          const [{ count: staleRetryCount }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(taskEvents)
            .where(
              sql`${taskEvents.taskId} = ${task.id} AND ${taskEvents.trigger} = 'auto_retry_stale'`,
            );
          if (Number(staleRetryCount) >= MAX_STALE_RETRIES) {
            logger.info(
              { taskId: task.id, staleRetryCount },
              "Stale retry limit reached — failing permanently",
            );
            await taskService.transitionTask(
              task.id,
              TaskState.FAILED,
              "stale_limit_reached",
              `Task stalled ${MAX_STALE_RETRIES} times — giving up`,
            );
            continue;
          }

          await taskService.transitionTask(
            task.id,
            TaskState.FAILED,
            "stale_detected",
            "Task stalled — no activity detected. The agent process may have died.",
          );
          await taskService.transitionTask(
            task.id,
            TaskState.QUEUED,
            "auto_retry_stale",
            "Re-queued after stale detection",
          );
          const { taskQueue } = await import("./task-worker.js");
          await taskQueue.add(
            "process-task",
            { taskId: task.id },
            { jobId: `${task.id}-stale-${Date.now()}`, priority: task.priority ?? 100 },
          );
          logger.info({ taskId: task.id, staleSince: task.updatedAt }, "Re-queued stale task");
        } catch (err) {
          logger.warn({ err, taskId: task.id }, "Failed to re-queue stale task");
        }
      }

      // Clean up idle pods (existing behavior)
      const cleaned = await cleanupIdleRepoPods();
      if (cleaned > 0) {
        logger.info({ cleaned }, "Cleaned up idle repo pods");
      }
    },
    {
      connection: connectionOpts,
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Health check failed");
  });

  return worker;
}
