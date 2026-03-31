import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import * as dependencyService from "../services/dependency-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { requireRole } from "../plugins/auth.js";

const listQuerySchema = z.object({
  state: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchQuerySchema = z.object({
  q: z.string().optional(),
  state: z.string().optional(),
  repoUrl: z.string().optional(),
  agentType: z.string().optional(),
  taskType: z.string().optional(),
  costMin: z.string().optional(),
  costMax: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  author: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
  logType: z.string().optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  repoUrl: z.string().url(),
  repoBranch: z
    .string()
    .regex(/^[a-zA-Z0-9._\/-]+$/, "Invalid branch name")
    .optional(),
  agentType: z.enum(["claude-code", "codex", "copilot"]).optional(),
  ticketSource: z.string().optional(),
  ticketExternalId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  dependsOn: z.array(z.string().uuid()).optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  // List tasks
  app.get("/api/tasks", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const { state, limit, offset } = parsed.data;
    const workspaceId = req.user?.workspaceId ?? null;
    const taskList = await taskService.listTasks({
      state,
      limit,
      offset,
      workspaceId,
    });
    reply.send({ tasks: taskList, limit, offset });
  });

  // Search tasks with advanced filtering and cursor-based pagination
  app.get("/api/tasks/search", async (req, reply) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const query = parsed.data;
    const result = await taskService.searchTasks({
      q: query.q,
      state: query.state,
      repoUrl: query.repoUrl,
      agentType: query.agentType,
      taskType: query.taskType,
      costMin: query.costMin,
      costMax: query.costMax,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      author: query.author,
      cursor: query.cursor,
      limit: query.limit,
      workspaceId: req.user?.workspaceId ?? null,
    });
    reply.send(result);
  });

  // Get task (enriched with pendingReason and pipelineProgress)
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }

    // Compute pending reason for non-terminal tasks
    let pendingReason: string | null = null;
    if (["pending", "waiting_on_deps", "queued"].includes(task.state)) {
      const { computePendingReason } = await import("../services/dependency-service.js");
      pendingReason = await computePendingReason(id);
    }

    // Compute pipeline progress if this task has step subtasks
    let pipelineProgress = null;
    const { getPipelineProgress } = await import("../services/subtask-service.js");
    pipelineProgress = await getPipelineProgress(id);

    reply.send({ task, pendingReason, pipelineProgress });
  });

  // Create task — member+
  app.post("/api/tasks", { preHandler: [requireRole("member")] }, async (req, reply) => {
    const input = createTaskSchema.parse(req.body);
    const { dependsOn, ...taskInput } = input;

    // Resolve agentType: explicit > repo default > "claude-code"
    let resolvedAgentType: string = taskInput.agentType ?? "";
    if (!resolvedAgentType) {
      const repoConfig = await import("../services/repo-service.js").then((m) =>
        m.getRepoByUrl(taskInput.repoUrl, req.user?.workspaceId ?? null),
      );
      resolvedAgentType = repoConfig?.defaultAgentType ?? "claude-code";
    }

    const task = await taskService.createTask({
      ...taskInput,
      agentType: resolvedAgentType,
      createdBy: req.user?.id,
      workspaceId: req.user?.workspaceId ?? null,
    });

    // Set up dependencies if specified
    const hasDeps = dependsOn && dependsOn.length > 0;
    if (hasDeps) {
      try {
        await dependencyService.addDependencies(task.id, dependsOn);
      } catch (err) {
        // Clean up the task if dependency setup fails
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    if (hasDeps) {
      // Task has dependencies — put it in waiting_on_deps state
      await taskService.transitionTask(
        task.id,
        TaskState.WAITING_ON_DEPS,
        "task_submitted_with_deps",
        undefined,
        req.user?.id,
      );
    } else {
      // No dependencies — enqueue immediately
      await taskService.transitionTask(
        task.id,
        TaskState.QUEUED,
        "task_submitted",
        undefined,
        req.user?.id,
      );
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
    }

    reply.status(201).send({ task });
  });

  // Cancel task — member+
  app.post("/api/tasks/:id/cancel", { preHandler: [requireRole("member")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await taskService.getTask(id);
    if (!existing) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const task = await taskService.transitionTask(
      id,
      TaskState.CANCELLED,
      "user_cancel",
      undefined,
      req.user?.id,
    );
    reply.send({ task });
  });

  // Retry task — member+
  app.post("/api/tasks/:id/retry", { preHandler: [requireRole("member")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await taskService.getTask(id);
    if (!existing) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const task = await taskService.transitionTask(
      id,
      TaskState.QUEUED,
      "user_retry",
      undefined,
      req.user?.id,
    );
    // If the task already has a PR, use restartFromBranch to reuse
    // the existing branch instead of starting fresh
    const hasPrBranch = !!existing.prUrl;
    await taskQueue.add(
      "process-task",
      { taskId: id, ...(hasPrBranch && { restartFromBranch: true }) },
      {
        jobId: `${id}-retry-${Date.now()}`,
        attempts: 1,
      },
    );
    reply.send({ task });
  });

  // Force redo task — reset everything and re-queue from any state (member+)
  app.post(
    "/api/tasks/:id/force-redo",
    { preHandler: [requireRole("member")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await taskService.getTask(id);
      if (!existing) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      // Remove any existing BullMQ jobs for this task (waiting/delayed) to prevent duplicates
      const existingJobs = await taskQueue.getJobs(["waiting", "delayed", "prioritized"]);
      for (const job of existingJobs) {
        if (job.data?.taskId === id) {
          await job.remove().catch(() => {});
        }
      }

      const task = await taskService.forceRedoTask(id);
      await taskQueue.add(
        "process-task",
        { taskId: id },
        {
          jobId: `${id}-redo-${Date.now()}`,
          attempts: 1,
        },
      );
      reply.send({ task });
    },
  );

  // Get task logs
  app.get("/api/tasks/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const logsParsed = logsQuerySchema.safeParse(req.query);
    if (!logsParsed.success) {
      return reply.status(400).send({ error: logsParsed.error.issues[0].message });
    }
    const logsQuery = logsParsed.data;
    const logs = await taskService.getTaskLogs(id, {
      limit: logsQuery.limit,
      offset: logsQuery.offset,
      search: logsQuery.search || undefined,
      logType: logsQuery.logType || undefined,
    });
    reply.send({ logs });
  });

  // Export task logs — verify workspace
  app.get("/api/tasks/:id/logs/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { format?: string; search?: string; logType?: string };
    const format = query.format ?? "json";

    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }

    const logs = await taskService.getAllTaskLogs(id, {
      search: query.search || undefined,
      logType: query.logType || undefined,
    });

    const meta = {
      taskId: task.id,
      title: task.title,
      repoUrl: task.repoUrl,
      state: task.state,
      agentType: task.agentType,
      prUrl: task.prUrl,
      costUsd: task.costUsd,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      exportedAt: new Date().toISOString(),
      totalLogs: logs.length,
    };

    if (format === "plaintext") {
      const lines = logs.map(
        (l) => `[${new Date(l.timestamp).toISOString()}] [${l.logType ?? "text"}] ${l.content}`,
      );
      const header = [
        `Task: ${meta.title} (${meta.taskId})`,
        `Repo: ${meta.repoUrl}`,
        `State: ${meta.state}`,
        meta.prUrl ? `PR: ${meta.prUrl}` : null,
        meta.costUsd ? `Cost: $${meta.costUsd}` : null,
        `Created: ${meta.createdAt}`,
        meta.startedAt ? `Started: ${meta.startedAt}` : null,
        meta.completedAt ? `Completed: ${meta.completedAt}` : null,
        `Exported: ${meta.exportedAt}`,
        `Total logs: ${meta.totalLogs}`,
        "",
        "---",
        "",
      ]
        .filter(Boolean)
        .join("\n");
      reply
        .header("Content-Type", "text/plain")
        .header("Content-Disposition", `attachment; filename="task-${id}-logs.txt"`)
        .send(header + lines.join("\n"));
      return;
    }

    if (format === "markdown") {
      const logLines = logs.map((l) => {
        const type = l.logType ?? "text";
        const ts = new Date(l.timestamp).toISOString();
        if (type === "error") return `> **ERROR** (${ts})\n> ${l.content}`;
        if (type === "tool_use")
          return `\`\`\`\n[${ts}] 🔧 ${(l.metadata as any)?.toolName ?? "Tool"}: ${l.content}\n\`\`\``;
        if (type === "tool_result")
          return `<details><summary>Result (${ts})</summary>\n\n\`\`\`\n${l.content}\n\`\`\`\n</details>`;
        if (type === "thinking") return `*${ts} — thinking:* ${l.content}`;
        return `${l.content}`;
      });
      const md = [
        `# Task Logs: ${meta.title}`,
        "",
        `| Field | Value |`,
        `| --- | --- |`,
        `| Task ID | \`${meta.taskId}\` |`,
        `| Repo | ${meta.repoUrl} |`,
        `| State | ${meta.state} |`,
        meta.prUrl ? `| PR | ${meta.prUrl} |` : null,
        meta.costUsd ? `| Cost | $${meta.costUsd} |` : null,
        `| Created | ${meta.createdAt} |`,
        meta.startedAt ? `| Started | ${meta.startedAt} |` : null,
        meta.completedAt ? `| Completed | ${meta.completedAt} |` : null,
        `| Exported | ${meta.exportedAt} |`,
        `| Total logs | ${meta.totalLogs} |`,
        "",
        "---",
        "",
        ...logLines,
      ]
        .filter((l) => l !== null)
        .join("\n");
      reply
        .header("Content-Type", "text/markdown")
        .header("Content-Disposition", `attachment; filename="task-${id}-logs.md"`)
        .send(md);
      return;
    }

    // Default: JSON
    reply
      .header("Content-Type", "application/json")
      .header("Content-Disposition", `attachment; filename="task-${id}-logs.json"`)
      .send({ meta, logs });
  });

  // Get task events
  app.get("/api/tasks/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const events = await taskService.getTaskEvents(id);
    reply.send({ events });
  });

  // Launch a review for a task — member+
  app.post("/api/tasks/:id/review", { preHandler: [requireRole("member")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await taskService.getTask(id);
    if (!existing) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && existing.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    try {
      const { launchReview } = await import("../services/review-service.js");
      const reviewTaskId = await launchReview(id);
      reply.status(201).send({ reviewTaskId });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Run now — override off-peak hold for a queued task (member+)
  app.post(
    "/api/tasks/:id/run-now",
    { preHandler: [requireRole("member")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = await taskService.getTask(id);
      if (!existing) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      if (existing.state !== "queued") {
        return reply.status(400).send({ error: "Task is not in queued state" });
      }

      // Set ignoreOffPeak flag
      await db
        .update(tasks)
        .set({ ignoreOffPeak: true, updatedAt: new Date() })
        .where(eq(tasks.id, id));

      // Remove existing delayed jobs for this task and re-queue immediately
      const existingJobs = await taskQueue.getJobs(["waiting", "delayed", "prioritized"]);
      for (const job of existingJobs) {
        if (job.data?.taskId === id) {
          await job.remove().catch(() => {});
        }
      }
      await taskQueue.add(
        "process-task",
        { taskId: id },
        {
          jobId: `${id}-runnow-${Date.now()}`,
          priority: existing.priority ?? 100,
        },
      );

      const task = await taskService.getTask(id);
      reply.send({ task });
    },
  );

  // Reorder tasks (update priorities) — member+, workspace-scoped
  app.post("/api/tasks/reorder", { preHandler: [requireRole("member")] }, async (req, reply) => {
    const body = req.body as { taskIds: string[] };
    if (!Array.isArray(body.taskIds)) {
      return reply.status(400).send({ error: "taskIds array required" });
    }
    const wsId = req.user?.workspaceId;
    // Verify all tasks belong to the user's workspace before reordering
    if (wsId) {
      for (const taskId of body.taskIds) {
        const task = await taskService.getTask(taskId);
        if (!task || task.workspaceId !== wsId) {
          return reply.status(404).send({ error: "Task not found" });
        }
      }
    }
    // Assign priorities based on position: first = 1, second = 2, etc.
    for (let i = 0; i < body.taskIds.length; i++) {
      await db
        .update(tasks)
        .set({ priority: i + 1, updatedAt: new Date() })
        .where(eq(tasks.id, body.taskIds[i]));
    }
    reply.send({ ok: true, reordered: body.taskIds.length });
  });
}
