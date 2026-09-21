/**
 * Polymorphic sub-resources under /api/tasks/:id.
 *
 * The existing `tasks.ts` handles list/create/detail/action endpoints for the
 * Repo Task ad-hoc case (tasks table). This file adds the shared sub-resources
 * that make sense across all three kinds (repo-task / repo-blueprint / standalone):
 *   /api/tasks/:id/runs                list spawned runs
 *   POST /api/tasks/:id/runs           kick off a run
 *   /api/tasks/:id/runs/:runId         run detail
 *   /api/tasks/:id/triggers            list triggers (blueprint + standalone only)
 *   POST /api/tasks/:id/triggers       create trigger
 *   PATCH /api/tasks/:id/triggers/:tid update
 *   DELETE /api/tasks/:id/triggers/:tid
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as unifiedTaskService from "../services/unified-task-service.js";
import * as workflowService from "../services/workflow-service.js";
import * as taskConfigService from "../services/task-config-service.js";
import * as triggerService from "../services/trigger-service.js";
import { requireRole } from "../plugins/auth.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  CreateTriggerBodySchema,
  UpdateTriggerBodySchema,
  replyTriggerError,
} from "../schemas/trigger.js";

const flexibleTimestamp = z.union([z.date(), z.string()]);

const TaskRow = z
  .record(z.unknown())
  .describe("Row from tasks or workflow_runs tagged with the parent task kind");

const TriggerSchema = z
  .object({
    id: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    type: z.string(),
    config: z.record(z.unknown()).nullable(),
    paramMapping: z.record(z.unknown()).nullable(),
    enabled: z.boolean(),
    lastFiredAt: flexibleTimestamp.nullable().optional(),
    nextFireAt: flexibleTimestamp.nullable().optional(),
    createdAt: flexibleTimestamp,
    updatedAt: flexibleTimestamp,
  })
  .passthrough();

const triggerParamsSchema = z.object({
  id: z.string().describe("Parent Task id"),
  triggerId: z.string().describe("Trigger id"),
});

const runParamsSchema = z.object({
  id: z.string().describe("Parent Task id"),
  runId: z.string().describe("Run id"),
});

const createRunSchema = z
  .object({
    params: z.record(z.unknown()).optional().describe("Run params (for standalone)"),
  })
  .optional()
  .default({});

export async function tasksUnifiedRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ── Runs — list ─────────────────────────────────────────────────────────
  app.get(
    "/api/tasks/:id/runs",
    {
      schema: {
        operationId: "listTaskRuns",
        summary: "List runs under a Task",
        description:
          "Blueprint kinds (repo-blueprint, standalone) return their spawned runs. " +
          "Ad-hoc repo-task returns an empty array (the task IS a single run).",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: z.object({ runs: z.array(TaskRow) }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });
      const runs = await unifiedTaskService.listUnifiedRuns(parent);
      reply.send({ runs });
    },
  );

  // ── Runs — create (kick off a run now) ─────────────────────────────────
  app.post(
    "/api/tasks/:id/runs",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTaskRun",
        summary: "Kick off a run",
        description:
          "For repo-blueprint: instantiates a task via the blueprint. For standalone: " +
          "creates a workflow_run. For ad-hoc repo-task: 405.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: createRunSchema,
        response: {
          202: z.object({
            runId: z.string().describe("ID of the created run"),
            type: z.string(),
          }),
          404: ErrorResponseSchema,
          405: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });

      if (parent.type === "repo-task") {
        return reply.status(405).send({ error: "Ad-hoc Repo Tasks cannot spawn child runs" });
      }

      const body = req.body ?? { params: undefined };

      if (parent.type === "repo-blueprint") {
        const task = await taskConfigService.instantiateTask(parent.data.id as string, {
          params: body.params ?? undefined,
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "task.run",
          params: { type: parent.type, parentId: parent.data.id },
          result: { runId: task.id },
          success: true,
        }).catch(() => {});
        return reply.status(202).send({ runId: task.id, type: "repo-task" });
      }

      // standalone
      const run = await workflowService.createWorkflowRun(parent.data.id as string, {
        params: body.params ?? undefined,
      });
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "task.run",
        params: { type: parent.type, parentId: parent.data.id },
        result: { runId: run.id },
        success: true,
      }).catch(() => {});
      return reply.status(202).send({ runId: run.id, type: "workflow-run" });
    },
  );

  // ── Runs — detail ───────────────────────────────────────────────────────
  app.get(
    "/api/tasks/:id/runs/:runId",
    {
      schema: {
        operationId: "getTaskRun",
        summary: "Get a run by id",
        tags: ["Tasks"],
        params: runParamsSchema,
        response: {
          200: z.object({ run: TaskRow }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, runId } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });

      const run = await unifiedTaskService.getUnifiedRun(parent, runId);
      if (!run) return reply.status(404).send({ error: "Run not found" });
      reply.send({ run });
    },
  );

  // ── Triggers — list ─────────────────────────────────────────────────────
  app.get(
    "/api/tasks/:id/triggers",
    {
      schema: {
        operationId: "listTaskTriggers",
        summary: "List triggers under a Task",
        description:
          "Returns triggers for blueprint/standalone Tasks. Ad-hoc repo-task has no triggers.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: z.object({ triggers: z.array(TriggerSchema) }),
          404: ErrorResponseSchema,
          405: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });
      if (parent.type === "repo-task") {
        return reply.status(405).send({ error: "Ad-hoc Repo Tasks do not have triggers" });
      }
      const triggers = await unifiedTaskService.listTriggersForParent(parent);
      reply.send({ triggers });
    },
  );

  // ── Triggers — create ───────────────────────────────────────────────────
  app.post(
    "/api/tasks/:id/triggers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTaskTrigger",
        summary: "Attach a trigger to a Task",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: CreateTriggerBodySchema,
        response: {
          201: z.object({ trigger: TriggerSchema }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          405: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });
      if (parent.type === "repo-task") {
        return reply.status(405).send({ error: "Ad-hoc Repo Tasks do not have triggers" });
      }

      const input = req.body;
      const configError = triggerService.validateTriggerConfig(input.type, input.config);
      if (configError) return reply.status(400).send({ error: configError });

      try {
        const trigger = await triggerService.createTrigger({
          targetType: unifiedTaskService.targetTypeFor(parent),
          targetId: parent.data.id as string,
          type: input.type,
          config: input.config,
          paramMapping: input.paramMapping,
          enabled: input.enabled,
        });
        return reply.status(201).send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, input)) return;
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Triggers — update ───────────────────────────────────────────────────
  app.patch(
    "/api/tasks/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateTaskTrigger",
        summary: "Update a trigger",
        tags: ["Tasks"],
        params: triggerParamsSchema,
        body: UpdateTriggerBodySchema,
        response: {
          200: z.object({ trigger: TriggerSchema }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          405: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });
      if (parent.type === "repo-task") {
        return reply.status(405).send({ error: "Ad-hoc Repo Tasks do not have triggers" });
      }

      const existing = await unifiedTaskService.getTriggerForParent(parent, triggerId);
      if (!existing) return reply.status(404).send({ error: "Trigger not found" });

      if (req.body.config) {
        const err = triggerService.validateTriggerConfig(existing.type, req.body.config);
        if (err) return reply.status(400).send({ error: err });
      }

      try {
        const trigger = await triggerService.updateTrigger(triggerId, req.body);
        if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
        return reply.send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, req.body)) return;
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Triggers — delete ───────────────────────────────────────────────────
  app.delete(
    "/api/tasks/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteTaskTrigger",
        summary: "Delete a trigger",
        tags: ["Tasks"],
        params: triggerParamsSchema,
        response: {
          204: z.null(),
          404: ErrorResponseSchema,
          405: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const parent = await unifiedTaskService.resolveAnyTaskById(id, req.user?.workspaceId ?? null);
      if (!parent) return reply.status(404).send({ error: "Task not found" });
      if (parent.type === "repo-task") {
        return reply.status(405).send({ error: "Ad-hoc Repo Tasks do not have triggers" });
      }

      const existing = await unifiedTaskService.getTriggerForParent(parent, triggerId);
      if (!existing) return reply.status(404).send({ error: "Trigger not found" });

      await triggerService.deleteTrigger(triggerId);
      reply.status(204).send(null);
    },
  );
}
