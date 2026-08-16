import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// Mock unified-task-service — the polymorphic resolver lives here.
const mockResolveAnyTaskById = vi.fn();
const mockListUnifiedRuns = vi.fn();
const mockGetUnifiedRun = vi.fn();
const mockListTriggersForParent = vi.fn();
const mockGetTriggerForParent = vi.fn();

vi.mock("../services/unified-task-service.js", () => ({
  resolveAnyTaskById: (...args: unknown[]) => mockResolveAnyTaskById(...args),
  listUnifiedTasks: vi.fn().mockResolvedValue([]),
  listUnifiedRuns: (...args: unknown[]) => mockListUnifiedRuns(...args),
  getUnifiedRun: (...args: unknown[]) => mockGetUnifiedRun(...args),
  listTriggersForParent: (...args: unknown[]) => mockListTriggersForParent(...args),
  getTriggerForParent: (...args: unknown[]) => mockGetTriggerForParent(...args),
}));

const mockCreateWorkflowRun = vi.fn();
const mockCreateWorkflowTrigger = vi.fn();
const mockUpdateWorkflowTrigger = vi.fn();
const mockDeleteWorkflowTrigger = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
  createWorkflowTrigger: (...args: unknown[]) => mockCreateWorkflowTrigger(...args),
  updateWorkflowTrigger: (...args: unknown[]) => mockUpdateWorkflowTrigger(...args),
  deleteWorkflowTrigger: (...args: unknown[]) => mockDeleteWorkflowTrigger(...args),
}));

const mockInstantiateTask = vi.fn();
const mockCreateTaskConfigTrigger = vi.fn();
const mockUpdateTaskConfigTrigger = vi.fn();
const mockDeleteTaskConfigTrigger = vi.fn();

vi.mock("../services/task-config-service.js", () => ({
  instantiateTask: (...args: unknown[]) => mockInstantiateTask(...args),
  createTaskConfigTrigger: (...args: unknown[]) => mockCreateTaskConfigTrigger(...args),
  updateTaskConfigTrigger: (...args: unknown[]) => mockUpdateTaskConfigTrigger(...args),
  deleteTaskConfigTrigger: (...args: unknown[]) => mockDeleteTaskConfigTrigger(...args),
}));

import { tasksUnifiedRoutes } from "./tasks-unified.js";

async function buildApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(tasksUnifiedRoutes);
}

describe("GET /api/tasks/:id/runs", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("returns runs for a standalone parent", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "standalone",
      data: { id: "wf-1" },
    });
    mockListUnifiedRuns.mockResolvedValue([{ id: "run-1" }, { id: "run-2" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/wf-1/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(2);
  });

  it("returns runs for a repo-blueprint parent", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-blueprint",
      data: { id: "tc-1" },
    });
    mockListUnifiedRuns.mockResolvedValue([{ id: "task-99" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/tc-1/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs[0].id).toBe("task-99");
  });

  it("returns empty runs for an ad-hoc repo-task", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-task",
      data: { id: "task-1" },
    });
    mockListUnifiedRuns.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toEqual([]);
  });

  it("returns 404 when the id doesn't match anything", async () => {
    mockResolveAnyTaskById.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/api/tasks/ghost/runs" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/runs", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("instantiates a task from a repo-blueprint parent", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-blueprint",
      data: { id: "tc-1" },
    });
    mockInstantiateTask.mockResolvedValue({ id: "task-new" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/tc-1/runs",
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "task-new", type: "repo-task" });
    expect(mockInstantiateTask).toHaveBeenCalledWith("tc-1", expect.any(Object));
  });

  it("creates a workflow_run for a standalone parent", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "standalone",
      data: { id: "wf-1" },
    });
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-new" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/wf-1/runs",
      payload: { params: { env: "prod" } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-new", type: "workflow-run" });
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", { params: { env: "prod" } });
  });

  it("returns 405 for ad-hoc repo-task parents", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-task",
      data: { id: "task-1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/runs",
      payload: {},
    });
    expect(res.statusCode).toBe(405);
  });
});

describe("POST /api/tasks/:id/triggers", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("dispatches to task-config-service for repo-blueprint parents", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-blueprint",
      data: { id: "tc-1" },
    });
    mockCreateTaskConfigTrigger.mockResolvedValue({
      id: "trg-1",
      targetType: "task_config",
      targetId: "tc-1",
      type: "schedule",
      config: { cronExpression: "0 9 * * *" },
      paramMapping: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/tc-1/triggers",
      payload: {
        type: "schedule",
        config: { cronExpression: "0 9 * * *" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateTaskConfigTrigger).toHaveBeenCalled();
    expect(mockCreateWorkflowTrigger).not.toHaveBeenCalled();
  });

  it("dispatches to workflow-service for standalone parents", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "standalone",
      data: { id: "wf-1" },
    });
    mockCreateWorkflowTrigger.mockResolvedValue({
      id: "trg-2",
      targetType: "job",
      targetId: "wf-1",
      type: "schedule",
      config: { cronExpression: "*/5 * * * *" },
      paramMapping: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/wf-1/triggers",
      payload: {
        type: "schedule",
        config: { cronExpression: "*/5 * * * *" },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflowTrigger).toHaveBeenCalled();
    expect(mockCreateTaskConfigTrigger).not.toHaveBeenCalled();
  });

  it("rejects trigger creation on ad-hoc repo-task with 405", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-task",
      data: { id: "task-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/triggers",
      payload: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
    });
    expect(res.statusCode).toBe(405);
  });

  it("validates schedule trigger requires cronExpression", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "standalone",
      data: { id: "wf-1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/wf-1/triggers",
      payload: { type: "schedule", config: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cronExpression");
  });
});

describe("GET /api/tasks/:id/triggers", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("lists triggers for a standalone parent", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "standalone",
      data: { id: "wf-1" },
    });
    mockListTriggersForParent.mockResolvedValue([
      {
        id: "t-1",
        targetType: "job",
        targetId: "wf-1",
        type: "schedule",
        config: {},
        paramMapping: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/wf-1/triggers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().triggers).toHaveLength(1);
  });

  it("returns 405 for ad-hoc repo-task parents", async () => {
    mockResolveAnyTaskById.mockResolvedValue({
      type: "repo-task",
      data: { id: "task-1" },
    });
    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/triggers" });
    expect(res.statusCode).toBe(405);
  });
});

describe("workspace scoping + role enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function viewerApp(): Promise<FastifyInstance> {
    return buildRouteTestApp(tasksUnifiedRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });
  }

  it("scopes the parent lookup to the caller's workspace (404 for foreign id)", async () => {
    // Simulate the resolver rejecting a foreign id (it enforces workspace).
    mockResolveAnyTaskById.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: "POST", url: "/api/tasks/foreign/runs", payload: {} });

    expect(res.statusCode).toBe(404);
    expect(mockResolveAnyTaskById).toHaveBeenCalledWith("foreign", "ws-1");
  });

  it("403s a viewer kicking off a run", async () => {
    const app = await viewerApp();
    const res = await app.inject({ method: "POST", url: "/api/tasks/wf-1/runs", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(mockResolveAnyTaskById).not.toHaveBeenCalled();
  });

  it("403s a viewer creating a trigger", async () => {
    const app = await viewerApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/wf-1/triggers",
      payload: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
    });
    expect(res.statusCode).toBe(403);
    expect(mockResolveAnyTaskById).not.toHaveBeenCalled();
  });

  it("403s a viewer updating a trigger", async () => {
    const app = await viewerApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/wf-1/triggers/trg-1",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a viewer deleting a trigger", async () => {
    const app = await viewerApp();
    const res = await app.inject({ method: "DELETE", url: "/api/tasks/wf-1/triggers/trg-1" });
    expect(res.statusCode).toBe(403);
  });
});
