import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as taskTemplateService from "../services/task-template-service.js";
import * as taskService from "../services/task-service.js";
import { TaskState } from "@optio/shared";
import { taskQueue } from "../workers/task-worker.js";

const createTemplateSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().optional(),
  prompt: z.string().min(1),
  agentType: z.enum(["claude-code", "codex"]).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().nullable().optional(),
  prompt: z.string().min(1).optional(),
  agentType: z.enum(["claude-code", "codex"]).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createFromTemplateSchema = z.object({
  title: z.string().min(1),
  repoUrl: z.string().url().optional(),
  repoBranch: z.string().optional(),
  prompt: z.string().optional(),
  agentType: z.enum(["claude-code", "codex"]).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function taskTemplateRoutes(app: FastifyInstance) {
  // List templates
  app.get("/api/task-templates", async (req, reply) => {
    const query = req.query as { repoUrl?: string };
    const templates = await taskTemplateService.listTaskTemplates(query.repoUrl);
    reply.send({ templates });
  });

  // Get template
  app.get("/api/task-templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const template = await taskTemplateService.getTaskTemplate(id);
    if (!template) return reply.status(404).send({ error: "Template not found" });
    reply.send({ template });
  });

  // Create template
  app.post("/api/task-templates", async (req, reply) => {
    const body = createTemplateSchema.parse(req.body);
    const template = await taskTemplateService.createTaskTemplate(body);
    reply.status(201).send({ template });
  });

  // Update template
  app.patch("/api/task-templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateTemplateSchema.parse(req.body);
    const template = await taskTemplateService.updateTaskTemplate(id, body);
    if (!template) return reply.status(404).send({ error: "Template not found" });
    reply.send({ template });
  });

  // Delete template
  app.delete("/api/task-templates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await taskTemplateService.deleteTaskTemplate(id);
    reply.status(204).send();
  });

  // Create task from template
  app.post("/api/tasks/from-template/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const overrides = createFromTemplateSchema.parse(req.body);

    const template = await taskTemplateService.getTaskTemplate(id);
    if (!template) return reply.status(404).send({ error: "Template not found" });

    if (!template.repoUrl && !overrides.repoUrl) {
      return reply.status(400).send({ error: "repoUrl is required (template has no default)" });
    }

    const task = await taskService.createTask({
      title: overrides.title,
      prompt: overrides.prompt ?? template.prompt,
      repoUrl: (overrides.repoUrl ?? template.repoUrl)!,
      repoBranch: overrides.repoBranch,
      agentType: overrides.agentType ?? template.agentType,
      priority: overrides.priority ?? template.priority,
      maxRetries: overrides.maxRetries,
      metadata: overrides.metadata ?? (template.metadata as Record<string, unknown> | undefined),
    });

    await taskService.transitionTask(task.id, TaskState.QUEUED, "task_from_template");
    await taskQueue.add(
      "process-task",
      { taskId: task.id },
      {
        jobId: task.id,
        priority: task.priority ?? 100,
        attempts: task.maxRetries + 1,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    reply.status(201).send({ task });
  });
}
