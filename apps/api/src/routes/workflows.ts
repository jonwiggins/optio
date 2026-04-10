import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workflowService from "../services/workflow-service.js";

const idParamsSchema = z.object({ id: z.string() });

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  environmentSpec: z.record(z.unknown()).optional(),
  promptTemplate: z.string().min(1),
  paramsSchema: z.record(z.unknown()).optional(),
  agentRuntime: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  budgetUsd: z.string().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  warmPoolSize: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  environmentSpec: z.record(z.unknown()).optional(),
  promptTemplate: z.string().min(1).optional(),
  paramsSchema: z.record(z.unknown()).optional(),
  agentRuntime: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  budgetUsd: z.string().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  warmPoolSize: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const createTriggerSchema = z.object({
  type: z.enum(["manual", "schedule", "webhook"]),
  config: z.record(z.unknown()).optional(),
  paramMapping: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const createRunSchema = z
  .object({
    triggerId: z.string().optional(),
    params: z.record(z.unknown()).optional(),
  })
  .optional()
  .default({});

export async function workflowRoutes(app: FastifyInstance) {
  // ── Workflows ──────────────────────────────────────────────────────────────

  // List workflows
  app.get("/api/workflows", async (req, reply) => {
    const list = await workflowService.listWorkflows(req.user?.workspaceId ?? undefined);
    reply.send({ workflows: list });
  });

  // Get a workflow
  app.get("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const workflow = await workflowService.getWorkflow(id);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    reply.send({ workflow });
  });

  // Create a workflow
  app.post("/api/workflows", async (req, reply) => {
    const input = createWorkflowSchema.parse(req.body);
    const workflow = await workflowService.createWorkflow({
      ...input,
      workspaceId: req.user?.workspaceId ?? undefined,
    });
    reply.status(201).send({ workflow });
  });

  // Update a workflow
  app.patch("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = updateWorkflowSchema.parse(req.body);
    const workflow = await workflowService.updateWorkflow(id, input);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    reply.send({ workflow });
  });

  // Delete a workflow
  app.delete("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const deleted = await workflowService.deleteWorkflow(id);
    if (!deleted) return reply.status(404).send({ error: "Workflow not found" });
    reply.status(204).send();
  });

  // ── Workflow Triggers ──────────────────────────────────────────────────────

  // List triggers for a workflow
  app.get("/api/workflows/:id/triggers", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const triggers = await workflowService.listWorkflowTriggers(id);
    reply.send({ triggers });
  });

  // Create a trigger
  app.post("/api/workflows/:id/triggers", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = createTriggerSchema.parse(req.body);
    try {
      const trigger = await workflowService.createWorkflowTrigger({
        workflowId: id,
        ...input,
      });
      reply.status(201).send({ trigger });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete a trigger
  app.delete("/api/workflows/:id/triggers/:triggerId", async (req, reply) => {
    const params = z.object({ id: z.string(), triggerId: z.string() }).parse(req.params);
    const deleted = await workflowService.deleteWorkflowTrigger(params.triggerId);
    if (!deleted) return reply.status(404).send({ error: "Trigger not found" });
    reply.status(204).send();
  });

  // ── Workflow Runs ──────────────────────────────────────────────────────────

  // List runs for a workflow
  app.get("/api/workflows/:id/runs", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const runs = await workflowService.listWorkflowRuns(id);
    reply.send({ runs });
  });

  // Create a run (trigger a workflow)
  app.post("/api/workflows/:id/runs", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const parsed = createRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      const run = await workflowService.createWorkflowRun({
        workflowId: id,
        triggerId: parsed.data.triggerId,
        params: parsed.data.params,
      });
      reply.status(201).send({ run });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Get a workflow run
  app.get("/api/workflow-runs/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const run = await workflowService.getWorkflowRun(id);
    if (!run) return reply.status(404).send({ error: "Workflow run not found" });
    reply.send({ run });
  });
}
