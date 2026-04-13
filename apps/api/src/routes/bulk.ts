import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { requireRole } from "../plugins/auth.js";
import { logAction } from "../services/optio-action-service.js";

const RetriedResponseSchema = z
  .object({
    retried: z.number().int().describe("Number of tasks actually re-queued"),
    total: z.number().int().describe("Total number of failed tasks found"),
  })
  .describe("Bulk retry result");

const CancelledResponseSchema = z
  .object({
    cancelled: z.number().int().describe("Number of tasks actually cancelled"),
    total: z.number().int().describe("Total number of active (running or queued) tasks found"),
  })
  .describe("Bulk cancel result");

export async function bulkRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/tasks/bulk/retry-failed",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "bulkRetryFailedTasks",
        summary: "Retry every failed task in the workspace",
        description:
          "Transition every task currently in the `failed` state back to " +
          "`queued` and re-enqueue it. Tasks that can't transition (e.g. " +
          "not allowed by the state machine) are skipped. Requires `member` role.",
        tags: ["Tasks"],
        response: {
          200: RetriedResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId;
      const conditions = [eq(tasks.state, "failed")];
      if (workspaceId) conditions.push(eq(tasks.workspaceId, workspaceId));
      const failedTasks = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(...conditions));

      let retried = 0;
      for (const task of failedTasks) {
        try {
          await taskService.transitionTask(task.id, TaskState.QUEUED, "bulk_retry");
          await taskQueue.add(
            "process-task",
            { taskId: task.id },
            {
              jobId: `${task.id}-retry-${Date.now()}`,
              attempts: 1,
            },
          );
          retried++;
        } catch {
          // Skip tasks that can't transition
        }
      }
      logAction({
        userId: req.user?.id,
        action: "task.bulk_retry",
        params: {},
        result: { retried, total: failedTasks.length },
        success: true,
      }).catch(() => {});
      reply.send({ retried, total: failedTasks.length });
    },
  );

  app.post(
    "/api/tasks/bulk/cancel-active",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "bulkCancelActiveTasks",
        summary: "Cancel every active task in the workspace",
        description:
          "Transition every running or queued task to the `cancelled` state. " +
          "Tasks that can't transition are skipped. Requires `member` role.",
        tags: ["Tasks"],
        response: {
          200: CancelledResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId;
      const runningConds = [eq(tasks.state, "running")];
      const queuedConds = [eq(tasks.state, "queued")];
      if (workspaceId) {
        runningConds.push(eq(tasks.workspaceId, workspaceId));
        queuedConds.push(eq(tasks.workspaceId, workspaceId));
      }
      const activeTasks = await db
        .select({ id: tasks.id, state: tasks.state })
        .from(tasks)
        .where(and(...runningConds));

      const queuedTasks = await db
        .select({ id: tasks.id, state: tasks.state })
        .from(tasks)
        .where(and(...queuedConds));

      const allActive = [...activeTasks, ...queuedTasks];
      let cancelled = 0;
      for (const task of allActive) {
        try {
          await taskService.transitionTask(task.id, TaskState.CANCELLED, "bulk_cancel");
          cancelled++;
        } catch {
          // Skip tasks that can't transition
        }
      }
      logAction({
        userId: req.user?.id,
        action: "task.bulk_cancel",
        params: {},
        result: { cancelled, total: allActive.length },
        success: true,
      }).catch(() => {});
      reply.send({ cancelled, total: allActive.length });
    },
  );
}
