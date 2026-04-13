import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as workflowService from "../services/workflow-service.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  WorkflowSchema,
  WorkflowRunSchema,
  WorkflowRunLogEntrySchema,
} from "../schemas/workflow.js";

const createWorkflowSchema = z
  .object({
    name: z.string().min(1).describe("Unique workflow name"),
    description: z.string().optional().describe("Optional human-readable description"),
    promptTemplate: z
      .string()
      .min(1)
      .describe("Handlebars-style prompt template with {{param}} placeholders"),
    agentRuntime: z.string().optional().describe("Agent runtime (defaults to `claude-code`)"),
    model: z.string().optional().describe("Optional model override"),
    maxTurns: z.number().int().positive().optional().describe("Optional hard turn limit per run"),
    budgetUsd: z.string().optional().describe("Optional per-run budget in USD (decimal string)"),
    maxConcurrent: z.number().int().positive().optional().describe("Max concurrent runs allowed"),
    maxRetries: z.number().int().min(0).optional().describe("Max retry attempts on run failure"),
    warmPoolSize: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of warm pods kept ready for fast runs"),
    enabled: z.boolean().optional().describe("If false, new runs are blocked"),
    environmentSpec: z
      .record(z.unknown())
      .optional()
      .describe("Kubernetes env overrides for the worker pod"),
    paramsSchema: z
      .record(z.unknown())
      .optional()
      .describe("JSON Schema describing allowed run params"),
  })
  .describe("Body for creating a new workflow template");

const updateWorkflowSchema = z
  .object({
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
  })
  .describe("Partial update to a workflow template");

const limitQuerySchema = z
  .object({
    limit: z.string().optional().describe("Max number of items to return (stringified int)"),
  })
  .describe("Query parameter: page limit");

const runWorkflowBodySchema = z
  .object({
    params: z
      .record(z.unknown())
      .optional()
      .describe("Runtime parameter values substituted into the prompt template"),
    triggerId: z.string().optional().describe("Trigger that caused this run, if any"),
  })
  .optional()
  .default({})
  .describe("Body for creating a new workflow run");

const logsQuerySchema = z
  .object({
    logType: z.string().optional().describe("Filter by log category"),
    limit: z.coerce.number().int().positive().optional().describe("Max entries to return"),
  })
  .describe("Query parameters for workflow run log pagination");

const WorkflowListResponseSchema = z
  .object({
    workflows: z.array(WorkflowSchema),
  })
  .describe("All workflows in the current workspace, with aggregate run stats");

const WorkflowResponseSchema = z
  .object({
    workflow: WorkflowSchema,
  })
  .describe("Single workflow envelope");

const WorkflowRunResponseSchema = z
  .object({
    run: WorkflowRunSchema,
  })
  .describe("Single workflow run envelope");

const WorkflowRunsListResponseSchema = z
  .object({
    runs: z.array(WorkflowRunSchema),
  })
  .describe("List of workflow runs");

const WorkflowRunLogsResponseSchema = z
  .object({
    logs: z.array(WorkflowRunLogEntrySchema),
  })
  .describe("Paginated logs for a workflow run");

export async function workflowRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/workflows",
    {
      schema: {
        operationId: "listWorkflows",
        summary: "List workflows",
        description:
          "List all workflow templates in the current workspace with aggregate " +
          "run stats: `runCount`, `lastRunAt`, `totalCostUsd`.",
        tags: ["Workflows"],
        response: {
          200: WorkflowListResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workflows = await workflowService.listWorkflowsWithStats(
        req.user?.workspaceId ?? undefined,
      );
      reply.send({ workflows });
    },
  );

  app.post(
    "/api/workflows",
    {
      schema: {
        operationId: "createWorkflow",
        summary: "Create a workflow",
        description: "Create a new workflow template.",
        tags: ["Workflows"],
        body: createWorkflowSchema,
        response: {
          201: WorkflowResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      try {
        const workflow = await workflowService.createWorkflow({
          ...input,
          workspaceId: req.user?.workspaceId ?? undefined,
          createdBy: req.user?.id,
        });
        logAction({
          userId: req.user?.id,
          action: "workflow.create",
          params: { name: input.name },
          result: { id: workflow.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ workflow });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/workflows/:id",
    {
      schema: {
        operationId: "getWorkflow",
        summary: "Get a workflow",
        description: "Fetch a single workflow template with aggregate run stats.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: WorkflowResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const workflow = await workflowService.getWorkflowWithStats(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }
      reply.send({ workflow });
    },
  );

  app.patch(
    "/api/workflows/:id",
    {
      schema: {
        operationId: "updateWorkflow",
        summary: "Update a workflow",
        description: "Partial update to a workflow template.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        body: updateWorkflowSchema,
        response: {
          200: WorkflowResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const input = req.body;
      try {
        const workflow = await workflowService.updateWorkflow(id, input);
        if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
        logAction({
          userId: req.user?.id,
          action:
            input.enabled !== undefined
              ? input.enabled
                ? "workflow.enable"
                : "workflow.disable"
              : "workflow.update",
          params: { workflowId: id, ...input },
          result: { id },
          success: true,
        }).catch(() => {});
        reply.send({ workflow });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/workflows/:id/clone",
    {
      schema: {
        operationId: "cloneWorkflow",
        summary: "Clone a workflow",
        description:
          "Clone an existing workflow and its non-webhook triggers. The " +
          "clone has a new ID and is owned by the current workspace.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          201: WorkflowResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const cloned = await workflowService.cloneWorkflow(id, {
        workspaceId: req.user?.workspaceId ?? undefined,
        createdBy: req.user?.id,
      });
      if (!cloned) return reply.status(404).send({ error: "Workflow not found" });
      logAction({
        userId: req.user?.id,
        action: "workflow.clone",
        params: { sourceWorkflowId: id },
        result: { id: cloned.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ workflow: cloned });
    },
  );

  app.delete(
    "/api/workflows/:id",
    {
      schema: {
        operationId: "deleteWorkflow",
        summary: "Delete a workflow",
        description: "Delete a workflow and all of its runs. Returns 204 on success.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          204: z.null().describe("Workflow deleted"),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const deleted = await workflowService.deleteWorkflow(id);
      if (!deleted) return reply.status(404).send({ error: "Workflow not found" });
      logAction({
        userId: req.user?.id,
        action: "workflow.delete",
        params: { workflowId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  // ── Workflow Runs ─────────────────────────────────────────────────────────

  app.post(
    "/api/workflows/:id/runs",
    {
      schema: {
        operationId: "createWorkflowRun",
        summary: "Create a workflow run",
        description:
          "Create a new workflow run and enqueue it for the workflow worker. " +
          "The run is returned immediately in `queued` state — monitor its " +
          "progress via `/api/workflow-runs/:id` or the WebSocket log stream.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        body: runWorkflowBodySchema,
        response: {
          201: WorkflowRunResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const run = await workflowService.createWorkflowRun(id, req.body);

        await workflowRunQueue.add(
          "process-workflow-run",
          { workflowRunId: run.id },
          { jobId: run.id },
        );

        logAction({
          userId: req.user?.id,
          action: "workflow_run.create",
          params: { workflowId: id },
          result: { id: run.id },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ run });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/workflows/:id/runs",
    {
      schema: {
        operationId: "listWorkflowRuns",
        summary: "List runs for a workflow",
        description: "Return the most recent runs for a workflow, newest first.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        querystring: limitQuerySchema,
        response: {
          200: WorkflowRunsListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const workflow = await workflowService.getWorkflow(id);
      if (!workflow) return reply.status(404).send({ error: "Workflow not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && workflow.workspaceId && workflow.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Workflow not found" });
      }
      const { limit } = req.query;
      const runs = await workflowService.listWorkflowRuns(id, limit ? parseInt(limit, 10) : 50);
      reply.send({ runs });
    },
  );

  app.get(
    "/api/workflow-runs/:id",
    {
      schema: {
        operationId: "getWorkflowRun",
        summary: "Get a workflow run",
        description: "Fetch a single workflow run by ID.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: WorkflowRunResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const run = await workflowService.getWorkflowRun(id);
      if (!run) return reply.status(404).send({ error: "Workflow run not found" });
      reply.send({ run });
    },
  );

  app.post(
    "/api/workflow-runs/:id/retry",
    {
      schema: {
        operationId: "retryWorkflowRun",
        summary: "Retry a workflow run",
        description: "Re-queue a failed workflow run. Returns 400 if the run is not retryable.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: WorkflowRunResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const run = await workflowService.retryWorkflowRun(id);
        logAction({
          userId: req.user?.id,
          action: "workflow_run.retry",
          params: { workflowRunId: id },
          result: { id },
          success: true,
        }).catch(() => {});
        reply.send({ run });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/workflow-runs/:id/cancel",
    {
      schema: {
        operationId: "cancelWorkflowRun",
        summary: "Cancel a workflow run",
        description: "Cancel a running workflow run. Returns 400 if the run is not cancellable.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        response: {
          200: WorkflowRunResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const run = await workflowService.cancelWorkflowRun(id);
        logAction({
          userId: req.user?.id,
          action: "workflow_run.cancel",
          params: { workflowRunId: id },
          result: { id },
          success: true,
        }).catch(() => {});
        reply.send({ run });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.get(
    "/api/workflow-runs/:id/logs",
    {
      schema: {
        operationId: "getWorkflowRunLogs",
        summary: "Get workflow run logs",
        description: "Return aggregated logs for a workflow run.",
        tags: ["Workflows"],
        params: IdParamsSchema,
        querystring: logsQuerySchema,
        response: {
          200: WorkflowRunLogsResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const run = await workflowService.getWorkflowRun(id);
      if (!run) return reply.status(404).send({ error: "Workflow run not found" });
      const opts = req.query;
      const logs = await workflowService.getWorkflowRunLogs(id, opts);
      reply.send({ logs });
    },
  );
}
