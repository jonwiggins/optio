import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflows } from "../db/schema.js";
import * as triggerService from "../services/workflow-trigger-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { WorkflowTriggerSchema } from "../schemas/workflow.js";

const triggerTypeEnum = z
  .enum(["manual", "schedule", "webhook"])
  .describe("Trigger classification");

const configSchema = z.record(z.unknown()).default({}).describe("Trigger-specific config");

const createTriggerSchema = z
  .object({
    type: triggerTypeEnum,
    config: configSchema,
    paramMapping: z
      .record(z.unknown())
      .optional()
      .describe("How to map incoming data to workflow params"),
    enabled: z.boolean().optional(),
  })
  .describe("Body for creating a new workflow trigger");

const updateTriggerSchema = z
  .object({
    config: configSchema.optional(),
    paramMapping: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .describe("Partial update to a workflow trigger");

const workflowParamsSchema = z
  .object({
    id: z.string().describe("Workflow UUID"),
  })
  .describe("Path parameters: workflow id");

const triggerParamsSchema = z
  .object({
    id: z.string().describe("Workflow UUID"),
    triggerId: z.string().describe("Trigger UUID"),
  })
  .describe("Path parameters: workflow id + trigger id");

const TriggerListResponseSchema = z
  .object({
    triggers: z.array(WorkflowTriggerSchema),
  })
  .describe("All triggers for a workflow");

const TriggerResponseSchema = z
  .object({
    trigger: WorkflowTriggerSchema,
  })
  .describe("Single trigger envelope");

function validateConfigForType(type: string, config: Record<string, unknown>): string | null {
  if (type === "schedule") {
    if (!config.cronExpression || typeof config.cronExpression !== "string") {
      return "Schedule triggers require a cronExpression in config";
    }
  }
  if (type === "webhook") {
    if (!config.path || typeof config.path !== "string") {
      return "Webhook triggers require a path in config";
    }
  }
  return null;
}

async function getWorkflow(id: string) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id));
  return workflow ?? null;
}

export async function workflowTriggerRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/workflows/:id/triggers",
    {
      schema: {
        operationId: "listWorkflowTriggers",
        summary: "List triggers for a workflow",
        description: "Return all triggers configured for a workflow.",
        tags: ["Workflows"],
        params: workflowParamsSchema,
        response: {
          200: TriggerListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const workflow = await getWorkflow(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }

      const triggers = await triggerService.listTriggers(id);
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/workflows/:id/triggers",
    {
      schema: {
        operationId: "createWorkflowTrigger",
        summary: "Create a workflow trigger",
        description:
          "Create a manual, schedule, or webhook trigger for a workflow. " +
          "Schedule triggers must supply `cronExpression`; webhook triggers " +
          "must supply `path`. Fails with 409 if a duplicate trigger type or " +
          "webhook path already exists.",
        tags: ["Workflows"],
        params: workflowParamsSchema,
        body: createTriggerSchema,
        response: {
          201: TriggerResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const input = req.body;

      const workflow = await getWorkflow(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }

      const configError = validateConfigForType(input.type, input.config);
      if (configError) {
        return reply.status(400).send({ error: configError });
      }

      try {
        const trigger = await triggerService.createTrigger({
          workflowId: id,
          type: input.type,
          config: input.config,
          paramMapping: input.paramMapping,
          enabled: input.enabled,
        });
        logAction({
          userId: req.user?.id,
          action: "workflow_trigger.create",
          params: { workflowId: id, type: input.type },
          result: { id: trigger.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ trigger });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "duplicate_type") {
          return reply
            .status(409)
            .send({ error: `A trigger of type "${input.type}" already exists for this workflow` });
        }
        if (msg === "duplicate_webhook_path") {
          return reply
            .status(409)
            .send({ error: `Webhook path "${input.config.path}" is already in use` });
        }
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.patch(
    "/api/workflows/:id/triggers/:triggerId",
    {
      schema: {
        operationId: "updateWorkflowTrigger",
        summary: "Update a workflow trigger",
        description: "Partial update to a workflow trigger's config, params, or enabled flag.",
        tags: ["Workflows"],
        params: triggerParamsSchema,
        body: updateTriggerSchema,
        response: {
          200: TriggerResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const input = req.body;

      const workflow = await getWorkflow(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }

      const existing = await triggerService.getTrigger(triggerId);
      if (!existing || existing.workflowId !== id) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      if (input.config) {
        const configError = validateConfigForType(existing.type, input.config);
        if (configError) {
          return reply.status(400).send({ error: configError });
        }
      }

      try {
        const trigger = await triggerService.updateTrigger(triggerId, input);
        if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
        logAction({
          userId: req.user?.id,
          action: "workflow_trigger.update",
          params: { workflowId: id, triggerId },
          result: { id: triggerId },
          success: true,
        }).catch(() => {});
        reply.send({ trigger });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "duplicate_webhook_path") {
          return reply.status(409).send({ error: `Webhook path is already in use` });
        }
        reply.status(400).send({ error: msg });
      }
    },
  );

  app.delete(
    "/api/workflows/:id/triggers/:triggerId",
    {
      schema: {
        operationId: "deleteWorkflowTrigger",
        summary: "Delete a workflow trigger",
        description: "Delete a workflow trigger. Returns 204 on success.",
        tags: ["Workflows"],
        params: triggerParamsSchema,
        response: {
          204: z.null().describe("Trigger deleted"),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;

      const workflow = await getWorkflow(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }

      const existing = await triggerService.getTrigger(triggerId);
      if (!existing || existing.workflowId !== id) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      await triggerService.deleteTrigger(triggerId);
      logAction({
        userId: req.user?.id,
        action: "workflow_trigger.delete",
        params: { workflowId: id, triggerId },
        result: { id: triggerId },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );
}
