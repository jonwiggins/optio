import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TaskState, isTaskStalled, getSilentDuration, parseIntEnv } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import * as dependencyService from "../services/dependency-service.js";
import * as unifiedTaskService from "../services/unified-task-service.js";
import * as taskConfigService from "../services/task-config-service.js";
import * as workflowService from "../services/workflow-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { requireRole } from "../plugins/auth.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  TaskSchema,
  EnrichedTaskSchema,
  TaskEventSchema,
  LogEntrySchema,
  TaskStatsSchema,
  TaskStateSchema,
  AgentTypeSchema,
  PendingReasonSchema,
  PipelineProgressSchema,
  StallInfoSchema,
} from "../schemas/task.js";

// ─── Request schemas ───

const TaskKindEnum = z.enum(["repo-task", "repo-blueprint", "standalone", "all"]);

const listQuerySchema = z
  .object({
    state: TaskStateSchema.optional().describe("Filter by task state (repo-task only)"),
    limit: z.coerce.number().int().min(1).max(1000).default(50).describe("Page size (1–1000)"),
    offset: z.coerce.number().int().min(0).default(0).describe("Offset from start"),
    type: TaskKindEnum.optional().describe(
      "Filter by task kind: repo-task (ad-hoc Repo Tasks, default), repo-blueprint (scheduled Repo Task configs), standalone (Standalone Tasks), all (union of all three)",
    ),
  })
  .describe("Task list query parameters");

const searchQuerySchema = z
  .object({
    q: z.string().optional().describe("Free-text search across title and prompt"),
    state: z.string().optional().describe("Filter by state"),
    repoUrl: z.string().optional().describe("Filter by repository URL (exact match)"),
    agentType: z.string().optional().describe("Filter by agent runtime"),
    taskType: z.string().optional().describe("`coding` or `review`"),
    costMin: z.string().optional().describe("Minimum cost (decimal string)"),
    costMax: z.string().optional().describe("Maximum cost (decimal string)"),
    createdAfter: z.string().optional().describe("ISO-8601 lower bound on createdAt"),
    createdBefore: z.string().optional().describe("ISO-8601 upper bound on createdAt"),
    author: z.string().optional().describe("Filter by createdBy user ID"),
    cursor: z.string().optional().describe("Opaque cursor from a previous page"),
    limit: z.coerce.number().int().min(1).max(1000).optional().describe("Page size"),
  })
  .describe("Task search query parameters with cursor pagination");

const exportLogsQuerySchema = z
  .object({
    format: z
      .enum(["json", "plaintext", "markdown"])
      .optional()
      .describe("Output format — defaults to `json`"),
    search: z.string().optional().describe("Free-text filter over log content"),
    logType: z.string().optional().describe("Filter by log category"),
  })
  .describe("Query parameters for exporting task logs");

const reorderTasksSchema = z
  .object({
    taskIds: z
      .array(z.string().describe("Task UUID"))
      .describe("Task IDs in the desired order (first = highest priority)"),
  })
  .describe("Reorder tasks by assigning incremental priorities");

const logsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(10000).default(200).describe("Page size (1–10000)"),
    offset: z.coerce.number().int().min(0).default(0).describe("Offset from start"),
    search: z.string().optional().describe("Free-text filter over log content"),
    logType: z.string().optional().describe("Filter by log category"),
  })
  .describe("Query parameters for paginated task logs");

const createTaskSchema = z
  .object({
    type: z
      .enum(["repo-task", "repo-blueprint", "standalone"])
      .optional()
      .describe(
        "Task kind. Defaults to `repo-task` (ad-hoc Repo Task). Use `repo-blueprint` for a scheduled Repo Task config, `standalone` for a Standalone Task definition.",
      ),
    // Fields common to all kinds
    title: z.string().min(1).optional().describe("Human-readable task title"),
    name: z.string().min(1).optional().describe("Name (required for blueprints)"),
    prompt: z.string().min(1).describe("Prompt passed to the agent"),
    description: z.string().optional(),
    agentType: AgentTypeSchema.optional().describe("Agent runtime override"),
    maxRetries: z.number().int().min(0).max(10).optional(),
    // Repo-task / repo-blueprint fields
    repoUrl: z.string().url().optional().describe("Repository URL (required for repo kinds)"),
    repoBranch: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name")
      .optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    // Repo-task-only fields
    ticketSource: z.string().optional(),
    ticketExternalId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    dependsOn: z.array(z.string().uuid()).optional(),
    // Repo-blueprint-only fields
    enabled: z.boolean().optional(),
  })
  .describe("Body for creating a task (polymorphic via `type`)");

// ─── Response envelopes ───

const TaskListResponseSchema = z
  .object({
    tasks: z
      .array(
        z
          .record(z.unknown())
          .describe(
            "Task row. For `type=repo-task` rows match EnrichedTaskSchema; for `type=repo-blueprint` and `type=standalone` the shape follows the respective backing table. Every row has a `type` discriminator.",
          ),
      )
      .describe("Page of tasks"),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .describe("Paginated task list response");

const TaskSearchResponseSchema = z
  .object({
    tasks: z.array(TaskSchema),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  })
  .passthrough()
  .describe("Search result envelope with cursor pagination");

const TaskStatsResponseSchema = z
  .object({
    stats: TaskStatsSchema,
  })
  .describe("Aggregated pipeline counts");

const TaskDetailResponseSchema = z
  .object({
    task: z
      .record(z.unknown())
      .describe(
        "Task row with a `type` discriminator. repo-task: tasks schema + pendingReason/pipelineProgress/stallInfo. repo-blueprint: task_config row. standalone: workflow row.",
      ),
    pendingReason: PendingReasonSchema,
    pipelineProgress: PipelineProgressSchema,
    stallInfo: StallInfoSchema,
  })
  .describe("Task detail with stall/pending/pipeline enrichment (repo-task only)");

const TaskResponseSchema = z
  .object({
    task: z
      .record(z.unknown())
      .describe(
        "Task row with a `type` discriminator. Shape depends on type: repo-task (matches TaskSchema), repo-blueprint (task_config row), standalone (workflow row).",
      ),
  })
  .describe("Task envelope");

const ReviewLaunchedResponseSchema = z
  .object({
    reviewTaskId: z.string().describe("ID of the launched review subtask"),
  })
  .describe("Result of launching a review for a task");

const LogsResponseSchema = z
  .object({
    logs: z.array(LogEntrySchema),
  })
  .describe("Paginated task logs");

const TaskEventsResponseSchema = z
  .object({
    events: z.array(TaskEventSchema),
  })
  .describe("Task state-transition events in chronological order");

const ReorderResponseSchema = z
  .object({
    ok: z.boolean(),
    reordered: z.number().int().describe("Number of tasks repriorized"),
  })
  .describe("Result of reordering a batch of tasks");

// ─── Routes ───

export async function taskRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // List tasks
  app.get(
    "/api/tasks",
    {
      schema: {
        operationId: "listTasks",
        summary: "List tasks",
        description:
          "List tasks in the current workspace. Returns an enriched view " +
          "with an `isStalled` flag for running tasks. Use `/api/tasks/search` " +
          "for advanced filtering and cursor-based pagination.",
        tags: ["Tasks"],
        querystring: listQuerySchema,
        response: {
          200: TaskListResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { state, limit, offset, type } = req.query;
      const workspaceId = req.user?.workspaceId ?? null;

      // Default (no type, or type=repo-task) — preserves existing shape for back-compat
      if (!type || type === "repo-task") {
        const taskList = await taskService.listTasks({
          state,
          limit,
          offset,
          workspaceId,
        });

        // Enrich running tasks with isStalled flag (lightweight — no lastLogSummary)
        const globalThreshold = parseIntEnv("OPTIO_STALL_THRESHOLD_MS", 300000);
        const now = new Date();
        const hydrated = await taskService.hydratePrReviewPrUrls(taskList);
        const enriched = hydrated.map((t) => ({
          ...t,
          type: "repo-task" as const,
          isStalled: isTaskStalled(t, now, globalThreshold),
        }));
        return reply.send({ tasks: enriched, limit, offset });
      }

      // Polymorphic list — blueprint or standalone or all
      const resolved = await unifiedTaskService.listUnifiedTasks({
        type: type === "all" ? undefined : type,
        workspaceId,
        limit,
      });
      const tasksOut = resolved.map((r) => ({ type: r.type, ...r.data }));
      return reply.send({ tasks: tasksOut, limit, offset });
    },
  );

  // Aggregated pipeline stats
  app.get(
    "/api/tasks/stats",
    {
      schema: {
        operationId: "getTaskStats",
        summary: "Get aggregated task stats",
        description:
          "Returns server-side counts of tasks grouped by state for the " +
          "current workspace. No pagination — useful for dashboards.",
        tags: ["Tasks"],
        response: {
          200: TaskStatsResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const stats = await taskService.getTaskStats(workspaceId);
      reply.send({ stats });
    },
  );

  // Search tasks
  app.get(
    "/api/tasks/search",
    {
      schema: {
        operationId: "searchTasks",
        summary: "Search tasks",
        description:
          "Full-text search across task titles and prompts with optional " +
          "filters and cursor-based pagination. Prefer this over the list " +
          "endpoint when filtering by anything other than state.",
        tags: ["Tasks"],
        querystring: searchQuerySchema,
        response: {
          200: TaskSearchResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query;
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
    },
  );

  // Get task (enriched)
  app.get(
    "/api/tasks/:id",
    {
      schema: {
        operationId: "getTask",
        summary: "Get task by ID",
        description:
          "Fetch a single task with enrichment: `pendingReason` (why a " +
          "non-terminal task is waiting), `pipelineProgress` (for step " +
          "subtask pipelines), and `stallInfo` (for running tasks that " +
          "may be silent).",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskDetailResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const workspaceId = req.user?.workspaceId ?? null;

      // Try the repo-task (tasks table) path first — this is the most common
      // case and returns the full enriched shape (pendingReason, pipelineProgress,
      // stallInfo).
      const rawTask = await taskService.getTask(id);
      if (rawTask) {
        if (workspaceId && rawTask.workspaceId !== workspaceId) {
          return reply.status(404).send({ error: "Task not found" });
        }
        const [task] = await taskService.hydratePrReviewPrUrls([rawTask]);

        let pendingReason: string | null = null;
        if (["pending", "waiting_on_deps", "queued"].includes(task.state)) {
          const { computePendingReason } = await import("../services/dependency-service.js");
          pendingReason = await computePendingReason(id);
        }

        const { getPipelineProgress } = await import("../services/subtask-service.js");
        const pipelineProgress = await getPipelineProgress(id);

        let stallInfo = null;
        if (task.state === "running" && task.lastActivityAt) {
          const repoConfig = await taskService.getRepoConfig(task.repoUrl);
          const thresholdMs = taskService.getStallThresholdForRepo(repoConfig);
          const now = new Date();
          const stalled = isTaskStalled(task, now, thresholdMs);
          const silentForMs = getSilentDuration(task, now);
          const lastLogSummary = stalled ? await taskService.getLastLogSummary(id) : undefined;
          stallInfo = { isStalled: stalled, silentForMs, thresholdMs, lastLogSummary };
        }

        return reply.send({
          task: { type: "repo-task", ...task },
          pendingReason,
          pipelineProgress,
          stallInfo,
        });
      }

      // Fall through: maybe this id refers to a blueprint (task_config) or a
      // standalone workflow. Return the native row with a type discriminator
      // and no enrichment fields.
      const resolved = await unifiedTaskService.resolveAnyTaskById(id, workspaceId);
      if (!resolved) return reply.status(404).send({ error: "Task not found" });

      return reply.send({
        task: { type: resolved.type, ...resolved.data },
        pendingReason: null,
        pipelineProgress: null,
        stallInfo: null,
      });
    },
  );

  // Create task
  app.post(
    "/api/tasks",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTask",
        summary: "Create a task",
        description:
          "Submit a new task to run against a repository. The task is " +
          "created in `pending` state and immediately transitioned to " +
          "`queued` (or `waiting_on_deps` if `dependsOn` is non-empty). " +
          "Requires `member` role.",
        tags: ["Tasks"],
        body: createTaskSchema,
        response: {
          201: TaskResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const type = input.type ?? "repo-task";

      // ── Standalone: create a workflow row ─────────────────────────────
      if (type === "standalone") {
        const name = input.name ?? input.title;
        if (!name) {
          return reply.status(400).send({ error: "Standalone tasks require `name` or `title`" });
        }
        try {
          const workflow = await workflowService.createWorkflow({
            name,
            description: input.description,
            promptTemplate: input.prompt,
            agentRuntime: input.agentType,
            maxRetries: input.maxRetries,
            enabled: input.enabled ?? true,
            createdBy: req.user?.id,
            workspaceId: req.user?.workspaceId ?? undefined,
          });
          logAction({
            userId: req.user?.id,
            action: "task.create",
            params: { type, workflowId: workflow.id, name },
            result: { id: workflow.id },
            success: true,
          }).catch(() => {});
          return reply.status(201).send({ task: { type: "standalone", ...workflow } });
        } catch (err) {
          return reply
            .status(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      // ── Repo blueprint: create a task_config row ──────────────────────
      if (type === "repo-blueprint") {
        if (!input.repoUrl) {
          return reply.status(400).send({ error: "repo-blueprint requires `repoUrl`" });
        }
        const name = input.name ?? input.title;
        if (!name) {
          return reply.status(400).send({ error: "repo-blueprint requires `name` or `title`" });
        }
        try {
          const row = await taskConfigService.createTaskConfig({
            name,
            description: input.description ?? null,
            title: input.title ?? name,
            prompt: input.prompt,
            repoUrl: input.repoUrl,
            repoBranch: input.repoBranch ?? "main",
            agentType: input.agentType ?? null,
            maxRetries: input.maxRetries ?? 3,
            priority: input.priority ?? 100,
            enabled: input.enabled ?? true,
            workspaceId: req.user?.workspaceId ?? null,
            createdBy: req.user?.id ?? null,
          });
          logAction({
            userId: req.user?.id,
            action: "task.create",
            params: { type, taskConfigId: row.id, name },
            result: { id: row.id },
            success: true,
          }).catch(() => {});
          return reply.status(201).send({ task: { type: "repo-blueprint", ...row } });
        } catch (err) {
          return reply
            .status(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      // ── Default: ad-hoc Repo Task ─────────────────────────────────────
      if (!input.repoUrl) {
        return reply.status(400).send({ error: "repo-task requires `repoUrl`" });
      }
      if (!input.title) {
        return reply.status(400).send({ error: "repo-task requires `title`" });
      }
      const { dependsOn, type: _t, name: _n, description: _d, enabled: _e, ...taskInput } = input;

      let resolvedAgentType: string = taskInput.agentType ?? "";
      if (!resolvedAgentType) {
        const repoConfig = await import("../services/repo-service.js").then((m) =>
          m.getRepoByUrl(taskInput.repoUrl!, req.user?.workspaceId ?? null),
        );
        resolvedAgentType = repoConfig?.defaultAgentType ?? "claude-code";
      }

      const task = await taskService.createTask({
        title: taskInput.title!,
        prompt: taskInput.prompt,
        repoUrl: taskInput.repoUrl!,
        repoBranch: taskInput.repoBranch,
        agentType: resolvedAgentType,
        ticketSource: taskInput.ticketSource,
        ticketExternalId: taskInput.ticketExternalId,
        metadata: taskInput.metadata,
        maxRetries: taskInput.maxRetries,
        priority: taskInput.priority,
        createdBy: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
      });
      logAction({
        userId: req.user?.id,
        action: "task.create",
        params: { taskId: task.id, title: taskInput.title, repoUrl: taskInput.repoUrl },
        result: { id: task.id },
        success: true,
      }).catch(() => {});

      const hasDeps = dependsOn && dependsOn.length > 0;
      if (hasDeps) {
        try {
          await dependencyService.addDependencies(task.id, dependsOn);
        } catch (err) {
          reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      if (hasDeps) {
        await taskService.transitionTask(
          task.id,
          TaskState.WAITING_ON_DEPS,
          "task_submitted_with_deps",
          undefined,
          req.user?.id,
        );
      } else {
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

      reply.status(201).send({ task: { type: "repo-task", ...task } });
    },
  );

  // Cancel task
  app.post(
    "/api/tasks/:id/cancel",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "cancelTask",
        summary: "Cancel a task",
        description:
          "Transition a task to the `cancelled` state. Requires `member` role. " +
          "Returns 404 if the task does not exist or belongs to a different workspace.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
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
      logAction({
        userId: req.user?.id,
        action: "task.cancel",
        params: { taskId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ task });
    },
  );

  // Retry task
  app.post(
    "/api/tasks/:id/retry",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "retryTask",
        summary: "Retry a task",
        description:
          "Re-queue a task. If the task already has a PR, the retry reuses " +
          "the existing branch via `restartFromBranch`. Requires `member` role.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
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
      const hasPrBranch = !!existing.prUrl;
      await taskQueue.add(
        "process-task",
        { taskId: id, ...(hasPrBranch && { restartFromBranch: true }) },
        {
          jobId: `${id}-retry-${Date.now()}`,
          attempts: 1,
        },
      );
      logAction({
        userId: req.user?.id,
        action: "task.retry",
        params: { taskId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ task });
    },
  );

  // Force redo
  app.post(
    "/api/tasks/:id/force-redo",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "forceRedoTask",
        summary: "Force redo a task",
        description:
          "Reset a task from any state and re-queue it, including removing " +
          "any pending BullMQ jobs for the same task ID. Use sparingly — " +
          "this bypasses normal state-machine transitions. Requires `member` role.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskService.getTask(id);
      if (!existing) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

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
      logAction({
        userId: req.user?.id,
        action: "task.force_redo",
        params: { taskId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ task });
    },
  );

  // Get logs
  app.get(
    "/api/tasks/:id/logs",
    {
      schema: {
        operationId: "getTaskLogs",
        summary: "Get task logs",
        description:
          "Returns paginated log entries for a task. Use `search` for " +
          "free-text filtering and `logType` to restrict to a specific " +
          "category (e.g. `tool_use`, `error`).",
        tags: ["Tasks"],
        params: IdParamsSchema,
        querystring: logsQuerySchema,
        response: {
          200: LogsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const logsQuery = req.query;
      const logs = await taskService.getTaskLogs(id, {
        limit: logsQuery.limit,
        offset: logsQuery.offset,
        search: logsQuery.search || undefined,
        logType: logsQuery.logType || undefined,
      });
      reply.send({ logs });
    },
  );

  // Export logs — multi-content-type endpoint. The response body varies
  // by the `format` query parameter: JSON envelope, text/plain transcript,
  // or a markdown document. Response schemas are intentionally omitted
  // because Zod / JSON Schema cannot cleanly express "one of three
  // disjoint content-types with disjoint bodies". The narrative
  // description covers all three variants for documentation purposes.
  app.get(
    "/api/tasks/:id/logs/export",
    {
      schema: {
        operationId: "exportTaskLogs",
        summary: "Export task logs",
        description:
          "Export all logs for a task as a downloadable file. The response " +
          "format is selected by the `format` query parameter: `json` " +
          "(default) returns a JSON envelope with metadata plus the log " +
          "array; `plaintext` returns a human-readable text transcript " +
          "with a metadata header; `markdown` returns a formatted " +
          "GitHub-compatible markdown document. The response `Content-Type` " +
          "matches the selected format, and a `Content-Disposition` " +
          "attachment header is set so browsers save the file. Returns " +
          "404 if the task does not exist or belongs to a different workspace.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        querystring: exportLogsQuerySchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const query = req.query;
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
            return `\`\`\`\n[${ts}] 🔧 ${(l.metadata as { toolName?: string } | null)?.toolName ?? "Tool"}: ${l.content}\n\`\`\``;
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
    },
  );

  // Get task events
  app.get(
    "/api/tasks/:id/events",
    {
      schema: {
        operationId: "getTaskEvents",
        summary: "Get task state-transition events",
        description:
          "Returns all state-transition events recorded for a task in " +
          "chronological order. Useful for audit trails and debugging " +
          "unexpected state changes.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskEventsResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const events = await taskService.getTaskEvents(id);
      reply.send({ events });
    },
  );

  // Launch a review
  app.post(
    "/api/tasks/:id/review",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "launchTaskReview",
        summary: "Launch a code review for a task",
        description:
          "Kicks off the code review agent as a blocking subtask of the " +
          "target task. Returns the ID of the newly created review subtask. " +
          "Fails with 400 if the task has no PR to review. Requires `member` role.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          201: ReviewLaunchedResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskService.getTask(id);
      if (!existing) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      try {
        const { launchReview } = await import("../services/review-service.js");
        const reviewTaskId = await launchReview(id);
        logAction({
          userId: req.user?.id,
          action: "task.review",
          params: { taskId: id },
          result: { reviewTaskId },
          success: true,
        }).catch(() => {});
        reply.status(201).send({ reviewTaskId });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Run now — override off-peak hold
  app.post(
    "/api/tasks/:id/run-now",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "runTaskNow",
        summary: "Run a queued task immediately",
        description:
          "Override the off-peak hold on a queued task and re-queue it at " +
          "the front of the line. Fails with 400 if the task is not in " +
          "the `queued` state. Requires `member` role.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: TaskResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await taskService.getTask(id);
      if (!existing) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      if (existing.state !== "queued") {
        return reply.status(400).send({ error: "Task is not in queued state" });
      }

      await db
        .update(tasks)
        .set({ ignoreOffPeak: true, updatedAt: new Date() })
        .where(eq(tasks.id, id));

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
      logAction({
        userId: req.user?.id,
        action: "task.run_now",
        params: { taskId: id },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.send({ task });
    },
  );

  // Reorder tasks
  app.post(
    "/api/tasks/reorder",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "reorderTasks",
        summary: "Reorder tasks by priority",
        description:
          "Assign incremental priorities to a batch of tasks based on " +
          "position — first ID in the array becomes priority 1, second " +
          "becomes priority 2, and so on. All tasks must belong to the " +
          "caller's workspace. Requires `member` role.",
        tags: ["Tasks"],
        body: reorderTasksSchema,
        response: {
          200: ReorderResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const wsId = req.user?.workspaceId;
      if (wsId) {
        for (const taskId of body.taskIds) {
          const task = await taskService.getTask(taskId);
          if (!task || task.workspaceId !== wsId) {
            return reply.status(404).send({ error: "Task not found" });
          }
        }
      }
      for (let i = 0; i < body.taskIds.length; i++) {
        await db
          .update(tasks)
          .set({ priority: i + 1, updatedAt: new Date() })
          .where(eq(tasks.id, body.taskIds[i]));
      }
      logAction({
        userId: req.user?.id,
        action: "task.reorder",
        params: { taskIds: body.taskIds },
        result: { reordered: body.taskIds.length },
        success: true,
      }).catch(() => {});
      reply.send({ ok: true, reordered: body.taskIds.length });
    },
  );
}
