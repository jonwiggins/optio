import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflows } from "../db/schema.js";
import * as triggerService from "../services/trigger-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { WorkflowTriggerSchema } from "../schemas/workflow.js";
import {
  CreateTriggerBodySchema,
  UpdateTriggerBodySchema,
  replyTriggerError,
} from "../schemas/trigger.js";
import { requireRole } from "../plugins/auth.js";

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

async function getWorkflow(id: string) {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, id));
  return workflow ?? null;
}

export async function workflowTriggerRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/jobs/:id/triggers",
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

      const triggers = await triggerService.listTriggers("job", id);
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/jobs/:id/triggers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createWorkflowTrigger",
        summary: "Create a workflow trigger",
        description:
          "Attach a trigger to a Job: manual, schedule (`cronExpression`), webhook " +
          "(`path`), ticket (`source`), or a GitHub / Slack / Linear event. " +
          "Fails with 409 if the webhook path is already in use.",
        tags: ["Workflows"],
        params: workflowParamsSchema,
        body: CreateTriggerBodySchema,
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

      const configError = triggerService.validateTriggerConfig(input.type, input.config);
      if (configError) {
        return reply.status(400).send({ error: configError });
      }

      try {
        const trigger = await triggerService.createTrigger({
          targetType: "job",
          targetId: id,
          type: input.type,
          config: input.config,
          paramMapping: input.paramMapping,
          enabled: input.enabled,
        });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "workflow_trigger.create",
          params: { workflowId: id, type: input.type },
          result: { id: trigger.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, input)) return;
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.patch(
    "/api/jobs/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateWorkflowTrigger",
        summary: "Update a workflow trigger",
        description: "Partial update to a workflow trigger's config, params, or enabled flag.",
        tags: ["Workflows"],
        params: triggerParamsSchema,
        body: UpdateTriggerBodySchema,
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

      const existing = await triggerService.getTriggerFor("job", id, triggerId);
      if (!existing) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      if (input.config) {
        const configError = triggerService.validateTriggerConfig(existing.type, input.config);
        if (configError) {
          return reply.status(400).send({ error: configError });
        }
      }

      try {
        const trigger = await triggerService.updateTrigger(triggerId, input);
        if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "workflow_trigger.update",
          params: { workflowId: id, triggerId },
          result: { id: triggerId },
          success: true,
        }).catch(() => {});
        reply.send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, input)) return;
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/jobs/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
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

      const existing = await triggerService.getTriggerFor("job", id, triggerId);
      if (!existing) {
        return reply.status(404).send({ error: "Trigger not found" });
      }

      await triggerService.deleteTrigger(triggerId);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
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
