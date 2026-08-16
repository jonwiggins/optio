import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mockWorkflow, mockWorkflowRun } from "../test-utils/fixtures.js";

// ─── Mocks ───

const mockListWorkflowsWithStats = vi.fn();
const mockCreateWorkflow = vi.fn();
const mockGetWorkflow = vi.fn();
const mockGetWorkflowWithStats = vi.fn();
const mockUpdateWorkflow = vi.fn();
const mockCloneWorkflow = vi.fn();
const mockDeleteWorkflow = vi.fn();
const mockCreateWorkflowRun = vi.fn();
const mockListWorkflowRuns = vi.fn();
const mockGetWorkflowRun = vi.fn();
const mockRetryWorkflowRun = vi.fn();
const mockCancelWorkflowRun = vi.fn();
const mockGetWorkflowRunLogs = vi.fn();

const mockQueueAdd = vi.fn().mockResolvedValue({});
vi.mock("../workers/workflow-worker.js", () => ({
  workflowRunQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) },
}));

vi.mock("../services/workflow-service.js", () => ({
  listWorkflowsWithStats: (...args: unknown[]) => mockListWorkflowsWithStats(...args),
  createWorkflow: (...args: unknown[]) => mockCreateWorkflow(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  getWorkflowWithStats: (...args: unknown[]) => mockGetWorkflowWithStats(...args),
  updateWorkflow: (...args: unknown[]) => mockUpdateWorkflow(...args),
  cloneWorkflow: (...args: unknown[]) => mockCloneWorkflow(...args),
  deleteWorkflow: (...args: unknown[]) => mockDeleteWorkflow(...args),
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
  listWorkflowRuns: (...args: unknown[]) => mockListWorkflowRuns(...args),
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
  retryWorkflowRun: (...args: unknown[]) => mockRetryWorkflowRun(...args),
  cancelWorkflowRun: (...args: unknown[]) => mockCancelWorkflowRun(...args),
  getWorkflowRunLogs: (...args: unknown[]) => mockGetWorkflowRunLogs(...args),
}));

import { workflowRoutes } from "./workflows.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(workflowRoutes);
}

describe("GET /api/jobs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists workflows with stats scoped to workspace", async () => {
    mockListWorkflowsWithStats.mockResolvedValue([
      {
        ...mockWorkflow,
        runCount: 3,
        lastRunAt: "2026-01-15T00:00:00Z",
        totalCostUsd: "1.5000",
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/jobs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toHaveLength(1);
    expect(res.json().workflows[0].runCount).toBe(3);
    expect(res.json().workflows[0].totalCostUsd).toBe("1.5000");
    expect(mockListWorkflowsWithStats).toHaveBeenCalledWith("ws-1");
  });

  it("returns empty array when no workflows", async () => {
    mockListWorkflowsWithStats.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/jobs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toEqual([]);
  });
});

describe("POST /api/jobs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workflow", async () => {
    mockCreateWorkflow.mockResolvedValue({ ...mockWorkflow, name: "Deploy" });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { name: "Deploy", promptTemplate: "Deploy the app" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Deploy",
        promptTemplate: "Deploy the app",
        workspaceId: "ws-1",
        createdBy: "user-1",
      }),
    );
  });

  it("returns 400 on service error", async () => {
    mockCreateWorkflow.mockRejectedValue(new Error("Duplicate name"));

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { name: "Bad", promptTemplate: "Do it" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Duplicate name");
  });

  it("rejects missing promptTemplate (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { name: "Missing prompt" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { name: "Deploy", promptTemplate: "Deploy the app" },
    });

    expect(res.statusCode).toBe(403);
    expect(mockCreateWorkflow).not.toHaveBeenCalled();
  });
});

describe("GET /api/jobs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a workflow with stats", async () => {
    mockGetWorkflowWithStats.mockResolvedValue({
      ...mockWorkflow,
      runCount: 5,
      lastRunAt: "2026-01-20T00:00:00Z",
      totalCostUsd: "2.0000",
    });

    const res = await app.inject({ method: "GET", url: "/api/jobs/w-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflow.runCount).toBe(5);
    expect(res.json().workflow.totalCostUsd).toBe("2.0000");
  });

  it("returns 404 when not found", async () => {
    mockGetWorkflowWithStats.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/jobs/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/jobs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("updates a workflow", async () => {
    mockUpdateWorkflow.mockResolvedValue({ ...mockWorkflow, name: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/jobs/w-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflow.name).toBe("Updated");
  });

  it("returns 404 when not found", async () => {
    mockGetWorkflow.mockResolvedValue(null);
    mockUpdateWorkflow.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/jobs/w-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(404);
    // Must not fall through to the mutation for a workflow that isn't resolved.
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 404 for a workflow in another workspace (no mutation)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/jobs/w-1",
      payload: { name: "Hijacked" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "PATCH",
      url: "/api/jobs/w-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(403);
    expect(mockUpdateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 on validation error", async () => {
    mockUpdateWorkflow.mockRejectedValue(new Error("Invalid update"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/jobs/w-1",
      payload: { name: "Bad" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/jobs/:id/clone", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("clones a workflow", async () => {
    mockCloneWorkflow.mockResolvedValue({ ...mockWorkflow, id: "wf-2" });

    const res = await app.inject({ method: "POST", url: "/api/jobs/wf-1/clone" });

    expect(res.statusCode).toBe(201);
    expect(res.json().workflow.id).toBe("wf-2");
  });

  it("returns 404 when source not found (no clone)", async () => {
    mockGetWorkflow.mockResolvedValue(null);

    const res = await app.inject({ method: "POST", url: "/api/jobs/nope/clone" });

    expect(res.statusCode).toBe(404);
    expect(mockCloneWorkflow).not.toHaveBeenCalled();
  });

  it("returns 404 for a workflow in another workspace (no clone)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "POST", url: "/api/jobs/wf-1/clone" });

    expect(res.statusCode).toBe(404);
    expect(mockCloneWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({ method: "POST", url: "/api/jobs/wf-1/clone" });

    expect(res.statusCode).toBe(403);
    expect(mockCloneWorkflow).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/jobs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("deletes a workflow", async () => {
    mockDeleteWorkflow.mockResolvedValue(true);

    const res = await app.inject({ method: "DELETE", url: "/api/jobs/w-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 when not found", async () => {
    mockGetWorkflow.mockResolvedValue(null);
    mockDeleteWorkflow.mockResolvedValue(false);

    const res = await app.inject({ method: "DELETE", url: "/api/jobs/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
  });

  it("returns 404 for a workflow in another workspace (no delete)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "DELETE", url: "/api/jobs/w-1" });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({ method: "DELETE", url: "/api/jobs/w-1" });

    expect(res.statusCode).toBe(403);
    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
  });
});

// ─── Workflow Runs ───

describe("POST /api/jobs/:id/runs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("creates a workflow run", async () => {
    mockCreateWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/wf-1/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {});
  });

  it("returns 400 when run creation fails", async () => {
    mockCreateWorkflowRun.mockRejectedValue(new Error("disabled"));

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/wf-1/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a workflow not in the workspace (no run created)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/wf-1/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({
      method: "POST",
      url: "/api/jobs/wf-1/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });
});

describe("GET /api/jobs/:id/runs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists runs for a workflow", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    mockListWorkflowRuns.mockResolvedValue([
      { ...mockWorkflowRun },
      { ...mockWorkflowRun, id: "run-2" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/jobs/w-1/runs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(2);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith("w-1", 50);
  });
});

describe("GET /api/workflow-runs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a workflow run", async () => {
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1" });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent run", async () => {
    mockGetWorkflowRun.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a run whose workflow is in another workspace", async () => {
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1" });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Workflow Run Operations ───

describe("POST /api/workflow-runs/:id/retry", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("retries a failed workflow run", async () => {
    mockRetryWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/retry" });

    expect(res.statusCode).toBe(200);
    expect(mockRetryWorkflowRun).toHaveBeenCalledWith("run-1");
  });

  it("returns 400 when retry fails", async () => {
    mockRetryWorkflowRun.mockRejectedValue(
      new Error('Cannot retry workflow run in state "running"'),
    );

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/retry" });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a run whose workflow is in another workspace (no retry)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/retry" });

    expect(res.statusCode).toBe(404);
    expect(mockRetryWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({ method: "POST", url: "/api/workflow-runs/run-1/retry" });

    expect(res.statusCode).toBe(403);
    expect(mockRetryWorkflowRun).not.toHaveBeenCalled();
  });
});

describe("POST /api/workflow-runs/:id/cancel", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun });
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow });
    app = await buildTestApp();
  });

  it("cancels a running workflow run", async () => {
    mockCancelWorkflowRun.mockResolvedValue({ ...mockWorkflowRun, state: "cancelled" });

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/cancel" });

    expect(res.statusCode).toBe(200);
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith("run-1");
  });

  it("returns 400 when cancel fails", async () => {
    mockCancelWorkflowRun.mockRejectedValue(
      new Error('Cannot cancel workflow run in state "completed"'),
    );

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/cancel" });

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for a run whose workflow is in another workspace (no cancel)", async () => {
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "POST", url: "/api/workflow-runs/run-1/cancel" });

    expect(res.statusCode).toBe(404);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer", async () => {
    const viewerApp = await buildRouteTestApp(workflowRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });

    const res = await viewerApp.inject({ method: "POST", url: "/api/workflow-runs/run-1/cancel" });

    expect(res.statusCode).toBe(403);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });
});

describe("GET /api/workflow-runs/:id/logs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns logs for a workflow run", async () => {
    const logs = [
      {
        id: "log-1",
        workflowRunId: "run-1",
        content: "Building...",
        logType: "text",
        metadata: null,
        timestamp: new Date("2026-04-11T12:00:00Z"),
      },
      {
        id: "log-2",
        workflowRunId: "run-1",
        content: "Testing...",
        logType: "text",
        metadata: null,
        timestamp: new Date("2026-04-11T12:01:00Z"),
      },
    ];
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun, state: "running" });
    mockGetWorkflowRunLogs.mockResolvedValue(logs);

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1/logs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(2);
    expect(mockGetWorkflowRunLogs).toHaveBeenCalledWith("run-1", {});
  });

  it("passes query params to service", async () => {
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun, state: "running" });
    mockGetWorkflowRunLogs.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/workflow-runs/run-1/logs?logType=error&limit=10",
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetWorkflowRunLogs).toHaveBeenCalledWith("run-1", {
      logType: "error",
      limit: 10,
    });
  });

  it("returns 404 when run not found", async () => {
    mockGetWorkflowRun.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/nonexistent/logs" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a run whose workflow is in another workspace", async () => {
    mockGetWorkflowRun.mockResolvedValue({ ...mockWorkflowRun, state: "running" });
    mockGetWorkflow.mockResolvedValue({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1/logs" });

    expect(res.statusCode).toBe(404);
    expect(mockGetWorkflowRunLogs).not.toHaveBeenCalled();
  });
});
