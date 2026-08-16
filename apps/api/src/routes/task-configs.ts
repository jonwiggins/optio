import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as taskConfigService from "../services/task-config-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";

const flexibleTimestamp = z.union([z.date(), z.string()]);

const TaskConfigSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    workspaceId: z.string().nullable(),
    title: z.string(),
    prompt: z.string(),
    promptTemplateId: z.string().nullable(),
    repoUrl: z.string(),
    repoBranch: z.string(),
    agentType: z.string().nullable(),
    maxRetries: z.number().int(),
    priority: z.number().int(),
    enabled: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: flexibleTimestamp,
    updatedAt: flexibleTimestamp,
  })
  .passthrough()
  .describe("Task config — reusable task blueprint instantiated by triggers");

const TaskConfigResponseSchema = z.object({ taskConfig: TaskConfigSchema });
const TaskConfigListResponseSchema = z.object({ taskConfigs: z.array(TaskConfigSchema) });

const createTaskConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  title: z.string().min(1).describe("Default task title (can reference {{params}})"),
  prompt: z.string().min(1).describe("Default prompt for the spawned task"),
  promptTemplateId: z.string().uuid().optional(),
  repoUrl: z.string().min(1),
  repoBranch: z.string().optional(),
  agentType: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const updateTaskConfigSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  promptTemplateId: z.string().uuid().nullable().optional(),
  repoUrl: z.string().min(1).optional(),
  repoBranch: z.string().optional(),
  agentType: z.string().nullable().optional(),
  maxRetries: z.number().int().min(0).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export async function taskConfigRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/task-configs",
    {
      schema: {
        operationId: "listTaskConfigs",
        summary: "List task configs",
        description: "Return all task configs visible to the current workspace.",
        tags: ["Task Configs"],
        response: { 200: TaskConfigListResponseSchema },
      },
    },
    async (req, reply) => {
      const taskConfigs = await taskConfigService.listTaskConfigs({
        workspaceId: req.user?.workspaceId ?? null,
      });
      reply.send({ taskConfigs });
    },
  );

  app.post(
    "/api/task-configs",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTaskConfig",
        summary: "Create a task config",
        description:
          "Create a reusable task blueprint. Triggers can fire this blueprint to create concrete tasks.",
        tags: ["Task Configs"],
        body: createTaskConfigSchema,
        response: {
          201: TaskConfigResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      try {
        const taskConfig = await taskConfigService.createTaskConfig({
          ...input,
          workspaceId: req.user?.workspaceId ?? null,
          createdBy: req.user?.id ?? null,
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "task_config.create",
          params: { name: input.name },
          result: { id: taskConfig.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ taskConfig });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/task-configs/:id",
    {
      schema: {
        operationId: "getTaskConfig",
        summary: "Get a task config",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        response: {
          200: TaskConfigResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const taskConfig = await taskConfigService.getTaskConfig(id);
      if (!taskConfig) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && taskConfig.workspaceId && taskConfig.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }
      reply.send({ taskConfig });
    },
  );

  app.patch(
    "/api/task-configs/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateTaskConfig",
        summary: "Update a task config",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        body: updateTaskConfigSchema,
        response: {
          200: TaskConfigResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      try {
        const taskConfig = await taskConfigService.updateTaskConfig(id, req.body);
        if (!taskConfig) return reply.status(404).send({ error: "Task config not found" });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action:
            req.body.enabled !== undefined
              ? req.body.enabled
                ? "task_config.enable"
                : "task_config.disable"
              : "task_config.update",
          params: { taskConfigId: id },
          result: { id },
          success: true,
        }).catch(() => {});
        reply.send({ taskConfig });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/task-configs/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteTaskConfig",
        summary: "Delete a task config",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        response: {
          204: z.null(),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      await taskConfigService.deleteTaskConfig(id);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "task_config.delete",
        params: { taskConfigId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  // ── Triggers nested under task configs ──────────────────────────────────

  const triggerParamsSchema = z.object({
    id: z.string(),
    triggerId: z.string(),
  });

  const createTriggerSchema = z.object({
    type: z.enum(["manual", "schedule", "webhook", "ticket"]),
    config: z.record(z.unknown()).default({}),
    paramMapping: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  });

  const updateTriggerSchema = z.object({
    config: z.record(z.unknown()).optional(),
    paramMapping: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  });

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

  function validateTriggerConfig(type: string, config: Record<string, unknown>): string | null {
    if (type === "schedule" && typeof config.cronExpression !== "string") {
      return "Schedule triggers require a cronExpression in config";
    }
    if (type === "webhook" && typeof config.path !== "string") {
      return "Webhook triggers require a path in config";
    }
    if (type === "ticket") {
      if (typeof config.source !== "string") {
        return "Ticket triggers require a `source` (github|linear|notion|jira) in config";
      }
      if (
        config.labels !== undefined &&
        (!Array.isArray(config.labels) || !config.labels.every((l) => typeof l === "string"))
      ) {
        return "Ticket trigger `labels` must be an array of strings";
      }
    }
    return null;
  }

  app.get(
    "/api/task-configs/:id/triggers",
    {
      schema: {
        operationId: "listTaskConfigTriggers",
        summary: "List triggers for a task config",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        response: {
          200: z.object({ triggers: z.array(TriggerSchema) }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }
      const triggers = await taskConfigService.listTaskConfigTriggers(id);
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/task-configs/:id/triggers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTaskConfigTrigger",
        summary: "Create a trigger for a task config",
        description:
          "Attach a schedule, webhook, or manual trigger to a task config. Schedule triggers require `cronExpression`; webhook triggers require `path`.",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        body: createTriggerSchema,
        response: {
          201: z.object({ trigger: TriggerSchema }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const input = req.body;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      const configError = validateTriggerConfig(input.type, input.config);
      if (configError) return reply.status(400).send({ error: configError });

      try {
        const trigger = await taskConfigService.createTaskConfigTrigger({
          taskConfigId: id,
          type: input.type,
          config: input.config,
          paramMapping: input.paramMapping,
          enabled: input.enabled,
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "task_config_trigger.create",
          params: { taskConfigId: id, type: input.type },
          result: { id: trigger.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ trigger });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "duplicate_type") {
          return reply.status(409).send({
            error: `A trigger of type "${input.type}" already exists for this task config`,
          });
        }
        if (msg === "duplicate_webhook_path") {
          return reply.status(409).send({ error: "Webhook path is already in use" });
        }
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.patch(
    "/api/task-configs/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateTaskConfigTrigger",
        summary: "Update a trigger on a task config",
        tags: ["Task Configs"],
        params: triggerParamsSchema,
        body: updateTriggerSchema,
        response: {
          200: z.object({ trigger: TriggerSchema }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      const trigger = await taskConfigService.getTaskConfigTrigger(triggerId);
      if (!trigger || trigger.targetType !== "task_config" || trigger.targetId !== id) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      if (req.body.config) {
        const err = validateTriggerConfig(trigger.type, req.body.config);
        if (err) return reply.status(400).send({ error: err });
      }

      try {
        const updated = await taskConfigService.updateTaskConfigTrigger(triggerId, req.body);
        if (!updated) return reply.status(404).send({ error: "Trigger not found" });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "task_config_trigger.update",
          params: { taskConfigId: id, triggerId },
          result: { id: triggerId },
          success: true,
        }).catch(() => {});
        reply.send({ trigger: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "duplicate_webhook_path") {
          return reply.status(409).send({ error: "Webhook path is already in use" });
        }
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.delete(
    "/api/task-configs/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteTaskConfigTrigger",
        summary: "Delete a trigger on a task config",
        tags: ["Task Configs"],
        params: triggerParamsSchema,
        response: {
          204: z.null(),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      const trigger = await taskConfigService.getTaskConfigTrigger(triggerId);
      if (!trigger || trigger.targetType !== "task_config" || trigger.targetId !== id) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      await taskConfigService.deleteTaskConfigTrigger(triggerId);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "task_config_trigger.delete",
        params: { taskConfigId: id, triggerId },
        result: { id: triggerId },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/task-configs/:id/run",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "runTaskConfig",
        summary: "Manually instantiate a task from a task config",
        description:
          "Immediately create a concrete task from this task config, bypassing triggers. Useful for manual runs.",
        tags: ["Task Configs"],
        params: IdParamsSchema,
        response: {
          202: z.object({ taskId: z.string() }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskConfigService.getTaskConfig(id);
      if (!existing) return reply.status(404).send({ error: "Task config not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task config not found" });
      }

      try {
        const task = await taskConfigService.instantiateTask(id);
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "task_config.run",
          params: { taskConfigId: id },
          result: { taskId: task.id },
          success: true,
        }).catch(() => {});
        reply.status(202).send({ taskId: task.id });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
