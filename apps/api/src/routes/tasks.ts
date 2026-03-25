import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";

const createTaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  repoUrl: z.string().url(),
  repoBranch: z.string().optional(),
  agentType: z.enum(["claude-code", "codex"]),
  ticketSource: z.string().optional(),
  ticketExternalId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  priority: z.number().int().min(1).max(1000).optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  // List tasks
  app.get("/api/tasks", async (req, reply) => {
    const query = req.query as { state?: string; limit?: string; offset?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const taskList = await taskService.listTasks({ state: query.state, limit, offset });
    reply.send({ tasks: taskList, limit, offset });
  });

  // Search tasks with advanced filtering and cursor-based pagination
  app.get("/api/tasks/search", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
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
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
    reply.send(result);
  });

  // Get task
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    reply.send({ task });
  });

  // Create task
  app.post("/api/tasks", async (req, reply) => {
    const input = createTaskSchema.parse(req.body);
    const task = await taskService.createTask(input);

    // Enqueue for processing
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

    reply.status(201).send({ task });
  });

  // Cancel task
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.transitionTask(
      id,
      TaskState.CANCELLED,
      "user_cancel",
      undefined,
      req.user?.id,
    );
    reply.send({ task });
  });

  // Retry task
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.transitionTask(
      id,
      TaskState.QUEUED,
      "user_retry",
      undefined,
      req.user?.id,
    );
    await taskQueue.add(
      "process-task",
      { taskId: id },
      {
        jobId: `${id}-retry-${Date.now()}`,
        attempts: 1,
      },
    );
    reply.send({ task });
  });

  // Force redo task — reset everything and re-queue from any state
  app.post("/api/tasks/:id/force-redo", async (req, reply) => {
    const { id } = req.params as { id: string };

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
  });

  // Get task logs
  app.get("/api/tasks/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as {
      limit?: string;
      offset?: string;
      search?: string;
      logType?: string;
    };
    const logs = await taskService.getTaskLogs(id, {
      limit: query.limit ? parseInt(query.limit, 10) : 200,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
      search: query.search || undefined,
      logType: query.logType || undefined,
    });
    reply.send({ logs });
  });

  // Export task logs
  app.get("/api/tasks/:id/logs/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { format?: string; search?: string; logType?: string };
    const format = query.format ?? "json";

    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });

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
    const events = await taskService.getTaskEvents(id);
    reply.send({ events });
  });

  // Launch a review for a task
  app.post("/api/tasks/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { launchReview } = await import("../services/review-service.js");
      const reviewTaskId = await launchReview(id);
      reply.status(201).send({ reviewTaskId });
    } catch (err) {
      reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Reorder tasks (update priorities)
  app.post("/api/tasks/reorder", async (req, reply) => {
    const body = req.body as { taskIds: string[] };
    if (!Array.isArray(body.taskIds)) {
      return reply.status(400).send({ error: "taskIds array required" });
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
