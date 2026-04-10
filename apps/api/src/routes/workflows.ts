import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workflowService from "../services/workflow-service.js";

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  promptTemplate: z.string().min(1),
  agentRuntime: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  budgetUsd: z.string().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  warmPoolSize: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  environmentSpec: z.record(z.unknown()).optional(),
  paramsSchema: z.record(z.unknown()).optional(),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  promptTemplate: z.string().min(1).optional(),
  agentRuntime: z.string().optional(),
  model: z.string().nullable().optional(),
  maxTurns: z.number().int().positive().nullable().optional(),
  budgetUsd: z.string().nullable().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  warmPoolSize: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  environmentSpec: z.record(z.unknown()).nullable().optional(),
  paramsSchema: z.record(z.unknown()).nullable().optional(),
});

const idParamsSchema = z.object({ id: z.string() });

export async function workflowRoutes(app: FastifyInstance) {
  // List workflows with aggregate run stats (runCount, lastRunAt, totalCostUsd)
  app.get("/api/workflows", async (req, reply) => {
    const workflows = await workflowService.listWorkflowsWithStats(
      req.user?.workspaceId ?? undefined,
    );
    reply.send({ workflows });
  });

  // Create a workflow
  app.post("/api/workflows", async (req, reply) => {
    const input = createWorkflowSchema.parse(req.body);
    try {
      const workflow = await workflowService.createWorkflow({
        ...input,
        workspaceId: req.user?.workspaceId ?? undefined,
        createdBy: req.user?.id,
      });
      reply.status(201).send({ workflow });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Get a workflow with aggregate run stats
  app.get("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const workflow = await workflowService.getWorkflowWithStats(id);
    if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
    reply.send({ workflow });
  });

  // Update a workflow
  app.patch("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = updateWorkflowSchema.parse(req.body);
    try {
      const workflow = await workflowService.updateWorkflow(id, input);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      reply.send({ workflow });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete a workflow
  app.delete("/api/workflows/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const deleted = await workflowService.deleteWorkflow(id);
    if (!deleted) return reply.status(404).send({ error: "Workflow not found" });
    reply.status(204).send();
  });

  // List runs for a workflow
  app.get("/api/workflows/:id/runs", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const runs = await workflowService.listWorkflowRuns(id);
    reply.send({ runs });
  });

  // List triggers for a workflow
  app.get("/api/workflows/:id/triggers", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const triggers = await workflowService.listWorkflowTriggers(id);
    reply.send({ triggers });
  });

  // Get a single workflow run
  app.get("/api/workflow-runs/:id", async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const run = await workflowService.getWorkflowRun(id);
    if (!run) return reply.status(404).send({ error: "Workflow run not found" });
    reply.send({ run });
  });
}
