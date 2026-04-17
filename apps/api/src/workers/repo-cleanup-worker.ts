import { Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods, podHealthEvents, tasks, taskEvents, repos } from "../db/schema.js";
import {
  cleanupIdleRepoPods,
  updateWorktreeState,
  reconcileActiveTaskCounts,
  deleteNetworkPolicy,
  killOrphanedAgentInPod,
} from "../services/repo-pool-service.js";
import { cleanupIdleWorkflowPods } from "../services/workflow-pool-service.js";
import {
  cleanupZombieWorkflowRuns,
  cleanupOrphanedRepoTasks,
} from "../services/zombie-cleanup-service.js";
import { getRuntime } from "../services/container-service.js";
import { isStatefulSetEnabled, getWorkloadManager } from "../services/k8s-workload-service.js";
import { TaskState, DEFAULT_STALL_THRESHOLD_MS } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { cleanupExpiredSessions } from "../services/session-service.js";
import { publishEvent } from "../services/event-bus.js";
import { logger } from "../logger.js";
import { recordPodHealthEvent } from "../telemetry/metrics.js";
import { emitPodHealthEventLog } from "../telemetry/logs.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

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

  // Telemetry: record pod health event metric and log
  recordPodHealthEvent(eventType, repoUrl);
  emitPodHealthEventLog(eventType, podName ?? "unknown", repoUrl, message);
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

  // Dedicated stall-check cadence (30s) — more responsive than the 60s health-check
  repoCleanupQueue.add(
    "stall-check",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_STALL_CHECK_INTERVAL ?? "30000", 10),
      },
    },
  );

  const worker = new Worker(
    "repo-cleanup",
    instrumentWorkerProcessor("repo-cleanup", async () => {
      const rt = getRuntime();
      const pods = await db.select().from(repoPods);

      for (const pod of pods) {
        // Skip pods without a K8s name. For bare pods, also skip "provisioning"
        // (still being created). For StatefulSet pods, "provisioning" means
        // recovering from a crash — we need to check if they've come back.
        if (!pod.podName) continue;
        if (pod.state === "provisioning" && pod.managedBy !== "statefulset") continue;

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

            // Fail any tasks that were running on this pod
            const activeTasks = await db
              .select({ id: tasks.id, state: tasks.state })
              .from(tasks)
              .where(
                sql`${tasks.repoUrl} = ${pod.repoUrl} AND ${tasks.state} IN ('running', 'provisioning')`,
              );

            for (const task of activeTasks) {
              try {
                await updateWorktreeState(task.id, "dirty");
                await taskService.transitionTask(
                  task.id,
                  TaskState.FAILED,
                  `pod_${eventType}`,
                  message,
                );
                await taskService.updateTaskResult(task.id, undefined, message);
              } catch {}
            }

            if (pod.managedBy === "statefulset") {
              // StatefulSet pods auto-restart (restartPolicy: Always).
              // Mark as provisioning and wait for recovery rather than deleting.
              await db
                .update(repoPods)
                .set({
                  state: "provisioning",
                  activeTaskCount: 0,
                  errorMessage: message,
                  updatedAt: new Date(),
                })
                .where(eq(repoPods.id, pod.id));

              logger.warn(
                { repoUrl: pod.repoUrl, podName: pod.podName, eventType },
                "StatefulSet pod crashed — waiting for auto-restart",
              );
            } else {
              // Bare pod: delete and clear record for auto-recreation
              await db
                .update(repoPods)
                .set({
                  state: "error",
                  errorMessage: message,
                  updatedAt: new Date(),
                })
                .where(eq(repoPods.id, pod.id));

              try {
                await deleteNetworkPolicy(pod.podName).catch(() => {});
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
            }
          } else if (
            status.state === "running" &&
            (pod.state === "error" || pod.state === "provisioning")
          ) {
            // Pod recovered (StatefulSet auto-restart, or unexpected recovery)
            await db
              .update(repoPods)
              .set({ state: "ready", errorMessage: null, updatedAt: new Date() })
              .where(eq(repoPods.id, pod.id));
            await recordHealthEvent(pod.id, pod.repoUrl, "healthy", pod.podName, "Pod recovered");
          }
        } catch (err) {
          if (pod.managedBy === "statefulset") {
            // StatefulSet pod not found — it may be restarting. Mark as provisioning.
            await db
              .update(repoPods)
              .set({
                state: "provisioning",
                activeTaskCount: 0,
                errorMessage: `Pod not found, may be restarting: ${String(err)}`,
                updatedAt: new Date(),
              })
              .where(eq(repoPods.id, pod.id));
          } else {
            // Bare pod not found — clean up the record
            if (pod.podName) {
              await deleteNetworkPolicy(pod.podName).catch(() => {});
            }
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

          // State-aware worktree cleanup:
          // - "active" / "preserved" worktrees: leave alone
          // - "dirty" worktrees for failed tasks WITH retries remaining: leave for same-pod retry
          // - "dirty" worktrees for failed tasks WITHOUT retries: remove after grace period
          // - completed/cancelled tasks: remove after grace period
          // - No task found: orphan, remove immediately
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

            if (!task) {
              // No task found — orphan worktree, clean it up
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
                  `Cleaned orphan worktree for task ${taskId}`,
                );
              } catch {}
              continue;
            }

            // Preserve worktrees for active tasks and tasks awaiting resume
            if (task.worktreeState === "active" || task.worktreeState === "preserved") continue;
            if (["running", "provisioning", "pr_opened", "needs_attention"].includes(task.state)) {
              continue;
            }

            // For failed tasks with retries remaining, keep worktree for same-pod retry
            if (
              task.state === "failed" &&
              task.worktreeState === "dirty" &&
              task.retryCount < task.maxRetries
            ) {
              continue;
            }

            // Terminal state or failed with no retries — clean up after grace period
            const age = task.updatedAt ? Date.now() - new Date(task.updatedAt).getTime() : 0;
            if (age > WORKTREE_GRACE_MS) {
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

                await updateWorktreeState(taskId, "removed");
                await recordHealthEvent(
                  pod.id,
                  pod.repoUrl,
                  "orphan_cleaned",
                  pod.podName,
                  `Cleaned worktree for task ${taskId} (state: ${task.state})`,
                );
              } catch {}
            }
          }
        } catch {
          // Pod may not be accessible — skip
        }
      }

      // ── Soft stall detection ──────────────────────────────────────────────
      // Flag running tasks that have been silent beyond their threshold.
      // This does NOT fail/retry the task — it's an observable warning only.
      try {
        const globalThreshold = parseInt(
          process.env.OPTIO_STALL_THRESHOLD_MS ?? String(DEFAULT_STALL_THRESHOLD_MS),
          10,
        );

        // Fetch all running tasks with lastActivityAt set
        const runningTasks = await db
          .select({
            id: tasks.id,
            repoUrl: tasks.repoUrl,
            workspaceId: tasks.workspaceId,
            lastActivityAt: tasks.lastActivityAt,
            activitySubstate: tasks.activitySubstate,
          })
          .from(tasks)
          .where(sql`${tasks.state} = 'running' AND ${tasks.lastActivityAt} IS NOT NULL`);

        // Cache repo configs to avoid repeated queries
        const repoConfigCache = new Map<string, typeof repos.$inferSelect | null>();

        for (const task of runningTasks) {
          const now = Date.now();
          const lastActivity = new Date(task.lastActivityAt!).getTime();
          const silentForMs = now - lastActivity;

          // Get per-repo threshold
          let repoConfig = repoConfigCache.get(task.repoUrl);
          if (repoConfig === undefined) {
            const [rc] = await db.select().from(repos).where(eq(repos.repoUrl, task.repoUrl));
            repoConfig = rc ?? null;
            repoConfigCache.set(task.repoUrl, repoConfig);
          }
          const threshold = taskService.getStallThresholdForRepo(repoConfig);

          if (silentForMs >= threshold && task.activitySubstate !== "stalled") {
            // Mark as stalled
            await db
              .update(tasks)
              .set({ activitySubstate: "stalled" })
              .where(eq(tasks.id, task.id));

            // Get last log summary for the stall event
            const lastLogSummary = await taskService.getLastLogSummary(task.id);

            await publishEvent({
              type: "task:stalled",
              taskId: task.id,
              lastActivityAt: task.lastActivityAt!.toISOString(),
              silentForMs,
              lastLogSummary,
              timestamp: new Date().toISOString(),
            });

            logger.info(
              { taskId: task.id, silentForMs, threshold },
              "Task flagged as stalled (soft)",
            );
          } else if (silentForMs < threshold && task.activitySubstate === "stalled") {
            // Recovered — activity flush in task-worker already handles this,
            // but catch edge cases here too
            await db
              .update(tasks)
              .set({ activitySubstate: "recovered" })
              .where(eq(tasks.id, task.id));

            await publishEvent({
              type: "task:recovered",
              taskId: task.id,
              silentWasMs: silentForMs,
              timestamp: new Date().toISOString(),
            });

            logger.info({ taskId: task.id }, "Task recovered from stall");
          }
        }
      } catch (err) {
        logger.warn({ err }, "Soft stall detection pass failed");
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

          // ── Kill orphaned agent before re-queue ──────────────────────
          // The previous agent process may still be alive inside the pod
          // (orphaned after an API restart). Launching a new agent in the
          // same worktree would deadlock on git index lock / state files.
          let cleanupSucceeded = false;
          if (task.lastPodId) {
            try {
              await killOrphanedAgentInPod(task.lastPodId, task.id);
              cleanupSucceeded = true;
            } catch (err) {
              logger.warn(
                { err, taskId: task.id, podId: task.lastPodId },
                "Failed to kill orphaned agent in pod",
              );
            }
          } else {
            cleanupSucceeded = true; // No pod to clean up
          }

          // If this is a repeated stale recovery (retried before but went
          // stale again) AND cleanup failed, escalate to needs_attention
          // rather than re-queueing — prevents infinite retry loops.
          if (!cleanupSucceeded && Number(staleRetryCount) >= 1) {
            logger.warn(
              { taskId: task.id, staleRetryCount },
              "Stale recovery cleanup failed on repeated attempt — escalating to needs_attention",
            );
            await updateWorktreeState(task.id, "dirty");
            await taskService.transitionTask(
              task.id,
              TaskState.NEEDS_ATTENTION,
              "stale_recovery_failed",
              "Stale task recovery failed — orphaned processes could not be killed. Manual intervention required.",
            );
            continue;
          }

          // Mark worktree as removed (cleanup ran above) so the new agent creates a fresh one
          await updateWorktreeState(task.id, "removed");

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

      // Reconcile activeTaskCount on all repo pods to catch any drift
      const reconciled = await reconcileActiveTaskCounts();
      if (reconciled > 0) {
        logger.info({ reconciled }, "Reconciled repo pod activeTaskCounts");
      }

      // Clean up idle pods (existing behavior)
      const cleaned = await cleanupIdleRepoPods();
      if (cleaned > 0) {
        logger.info({ cleaned }, "Cleaned up idle repo pods");
      }

      // Clean up idle workflow pods
      try {
        const workflowCleaned = await cleanupIdleWorkflowPods();
        if (workflowCleaned > 0) {
          logger.info({ workflowCleaned }, "Cleaned up idle workflow pods");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to clean up idle workflow pods");
      }

      // Detect zombie workflow_runs (running but pod terminated/gone)
      try {
        const zombieRuns = await cleanupZombieWorkflowRuns();
        if (zombieRuns > 0) {
          logger.info({ zombieRuns }, "Cleaned up zombie workflow runs");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to clean up zombie workflow runs");
      }

      // Detect orphaned repo tasks (running but pod record gone)
      try {
        const orphanedTasks = await cleanupOrphanedRepoTasks();
        if (orphanedTasks > 0) {
          logger.info({ orphanedTasks }, "Cleaned up orphaned repo tasks");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to clean up orphaned repo tasks");
      }

      // Clean up expired auth sessions
      try {
        const expiredSessions = await cleanupExpiredSessions();
        if (expiredSessions > 0) {
          logger.info({ expiredSessions }, "Cleaned up expired sessions");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to clean up expired sessions");
      }
    }),
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
