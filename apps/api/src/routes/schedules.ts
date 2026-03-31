import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as scheduleService from "../services/schedule-service.js";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";

const taskConfigSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  repoUrl: z.string().url(),
  repoBranch: z
    .string()
    .regex(/^[a-zA-Z0-9._\/-]+$/, "Invalid branch name")
    .optional(),
  agentType: z.enum(["claude-code", "codex", "copilot"]),
  maxRetries: z.number().int().min(0).max(10).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
});

const createScheduleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cronExpression: z.string().min(1),
  enabled: z.boolean().optional(),
  taskConfig: taskConfigSchema,
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  cronExpression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  taskConfig: taskConfigSchema.optional(),
});

export async function scheduleRoutes(app: FastifyInstance) {
  // List schedules — scoped to workspace
  app.get("/api/schedules", async (req, reply) => {
    const workspaceId = req.user?.workspaceId ?? null;
    const list = await scheduleService.listSchedules(workspaceId);
    reply.send({ schedules: list });
  });

  // Get a single schedule — verify workspace ownership
  app.get("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await scheduleService.getSchedule(id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Schedule not found" });
    }
    reply.send({ schedule });
  });

  // Create a schedule — assign to workspace
  app.post("/api/schedules", async (req, reply) => {
    const body = createScheduleSchema.parse(req.body);

    // Validate the cron expression
    const validation = scheduleService.validateCronExpression(body.cronExpression);
    if (!validation.valid) {
      return reply.status(400).send({ error: `Invalid cron expression: ${validation.error}` });
    }

    const workspaceId = req.user?.workspaceId ?? null;
    const schedule = await scheduleService.createSchedule(body, req.user?.id, workspaceId);
    reply.status(201).send({ schedule });
  });

  // Update a schedule — verify workspace ownership
  app.patch("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await scheduleService.getSchedule(id);
    if (!existing) return reply.status(404).send({ error: "Schedule not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Schedule not found" });
    }

    const body = updateScheduleSchema.parse(req.body);

    if (body.cronExpression) {
      const validation = scheduleService.validateCronExpression(body.cronExpression);
      if (!validation.valid) {
        return reply.status(400).send({ error: `Invalid cron expression: ${validation.error}` });
      }
    }

    const schedule = await scheduleService.updateSchedule(id, body);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    reply.send({ schedule });
  });

  // Delete a schedule — verify workspace ownership
  app.delete("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await scheduleService.getSchedule(id);
    if (!existing) return reply.status(404).send({ error: "Schedule not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Schedule not found" });
    }
    const deleted = await scheduleService.deleteSchedule(id);
    if (!deleted) return reply.status(404).send({ error: "Schedule not found" });
    reply.status(204).send();
  });

  // Manually trigger a schedule — verify workspace ownership
  app.post("/api/schedules/:id/trigger", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await scheduleService.getSchedule(id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Schedule not found" });
    }

    const config = schedule.taskConfig as {
      title: string;
      prompt: string;
      repoUrl: string;
      repoBranch?: string;
      agentType: string;
      maxRetries?: number;
      priority?: number;
    };

    try {
      const task = await taskService.createTask({
        title: config.title,
        prompt: config.prompt,
        repoUrl: config.repoUrl,
        repoBranch: config.repoBranch,
        agentType: config.agentType,
        maxRetries: config.maxRetries,
        priority: config.priority,
        metadata: { scheduleId: schedule.id, scheduleName: schedule.name, triggeredManually: true },
        createdBy: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
      });

      await taskService.transitionTask(task.id, TaskState.QUEUED, "schedule_manual_trigger");
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

      await scheduleService.recordRun(schedule.id, task.id, "created");
      reply.send({ task });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      await scheduleService.recordRun(schedule.id, null, "failed", errorMsg);
      reply.status(500).send({ error: errorMsg });
    }
  });

  // Get schedule run history — verify workspace ownership
  app.get("/api/schedules/:id/runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const schedule = await scheduleService.getSchedule(id);
    if (!schedule) return reply.status(404).send({ error: "Schedule not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && schedule.workspaceId && schedule.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Schedule not found" });
    }
    const { limit } = (req.query as { limit?: string }) ?? {};
    const runs = await scheduleService.getScheduleRuns(id, limit ? parseInt(limit, 10) : 50);
    reply.send({ runs });
  });

  // Validate a cron expression
  app.post("/api/schedules/validate-cron", async (req, reply) => {
    const { cronExpression } = z.object({ cronExpression: z.string().min(1) }).parse(req.body);
    const result = scheduleService.validateCronExpression(cronExpression);
    reply.send(result);
  });
}
