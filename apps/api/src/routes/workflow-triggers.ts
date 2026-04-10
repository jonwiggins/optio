import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflows } from "../db/schema.js";
import * as triggerService from "../services/workflow-trigger-service.js";

const triggerTypeEnum = z.enum(["manual", "schedule", "webhook"]);

const configSchema = z.record(z.unknown()).default({});

const createTriggerSchema = z.object({
  type: triggerTypeEnum,
  config: configSchema,
  paramMapping: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const updateTriggerSchema = z.object({
  config: configSchema.optional(),
  paramMapping: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const workflowParamsSchema = z.object({ id: z.string() });
const triggerParamsSchema = z.object({ id: z.string(), triggerId: z.string() });

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

export async function workflowTriggerRoutes(app: FastifyInstance) {
  // List triggers for a workflow
  app.get("/api/workflows/:id/triggers", async (req, reply) => {
    const { id } = workflowParamsSchema.parse(req.params);
    const workflow = await getWorkflow(id);
    if (!workflow || workflow.workspaceId !== (req.user?.workspaceId ?? undefined)) {
      return reply.status(404).send({ error: "Workflow not found" });
    }

    const triggers = await triggerService.listTriggers(id);
    reply.send({ triggers });
  });

  // Create a trigger for a workflow
  app.post("/api/workflows/:id/triggers", async (req, reply) => {
    const { id } = workflowParamsSchema.parse(req.params);

    const parsed = createTriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const input = parsed.data;

    const workflow = await getWorkflow(id);
    if (!workflow || workflow.workspaceId !== (req.user?.workspaceId ?? undefined)) {
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
  });

  // Update a trigger
  app.patch("/api/workflows/:id/triggers/:triggerId", async (req, reply) => {
    const { id, triggerId } = triggerParamsSchema.parse(req.params);

    const parsed = updateTriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const input = parsed.data;

    const workflow = await getWorkflow(id);
    if (!workflow || workflow.workspaceId !== (req.user?.workspaceId ?? undefined)) {
      return reply.status(404).send({ error: "Workflow not found" });
    }

    const existing = await triggerService.getTrigger(triggerId);
    if (!existing || existing.workflowId !== id) {
      return reply.status(404).send({ error: "Trigger not found" });
    }

    // Validate config if being updated — use the existing trigger type
    if (input.config) {
      const configError = validateConfigForType(existing.type, input.config);
      if (configError) {
        return reply.status(400).send({ error: configError });
      }
    }

    try {
      const trigger = await triggerService.updateTrigger(triggerId, input);
      if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
      reply.send({ trigger });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "duplicate_webhook_path") {
        return reply.status(409).send({ error: `Webhook path is already in use` });
      }
      reply.status(400).send({ error: msg });
    }
  });

  // Delete a trigger
  app.delete("/api/workflows/:id/triggers/:triggerId", async (req, reply) => {
    const { id, triggerId } = triggerParamsSchema.parse(req.params);

    const workflow = await getWorkflow(id);
    if (!workflow || workflow.workspaceId !== (req.user?.workspaceId ?? undefined)) {
      return reply.status(404).send({ error: "Workflow not found" });
    }

    const existing = await triggerService.getTrigger(triggerId);
    if (!existing || existing.workflowId !== id) {
      return reply.status(404).send({ error: "Trigger not found" });
    }

    await triggerService.deleteTrigger(triggerId);
    reply.status(204).send();
  });
}
