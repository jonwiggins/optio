import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListWorkflowsWithStats = vi.fn();
const mockCreateWorkflow = vi.fn();
const mockGetWorkflowWithStats = vi.fn();
const mockUpdateWorkflow = vi.fn();
const mockDeleteWorkflow = vi.fn();
const mockListWorkflowRuns = vi.fn();
const mockGetWorkflowRun = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  listWorkflowsWithStats: (...args: unknown[]) => mockListWorkflowsWithStats(...args),
  createWorkflow: (...args: unknown[]) => mockCreateWorkflow(...args),
  getWorkflowWithStats: (...args: unknown[]) => mockGetWorkflowWithStats(...args),
  updateWorkflow: (...args: unknown[]) => mockUpdateWorkflow(...args),
  deleteWorkflow: (...args: unknown[]) => mockDeleteWorkflow(...args),
  listWorkflowRuns: (...args: unknown[]) => mockListWorkflowRuns(...args),
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
}));

import { workflowRoutes } from "./workflows.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    done();
  });
  await workflowRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/workflows", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists workflows with stats scoped to workspace", async () => {
    mockListWorkflowsWithStats.mockResolvedValue([
      {
        id: "w-1",
        name: "Deploy",
        runCount: 3,
        lastRunAt: "2026-01-15T00:00:00Z",
        totalCostUsd: "1.5000",
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/workflows" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toHaveLength(1);
    expect(res.json().workflows[0].runCount).toBe(3);
    expect(res.json().workflows[0].totalCostUsd).toBe("1.5000");
    expect(mockListWorkflowsWithStats).toHaveBeenCalledWith("ws-1");
  });

  it("returns empty array when no workflows", async () => {
    mockListWorkflowsWithStats.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/workflows" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toEqual([]);
  });
});

describe("POST /api/workflows", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workflow", async () => {
    mockCreateWorkflow.mockResolvedValue({ id: "w-1", name: "Deploy" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
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
      url: "/api/workflows",
      payload: { name: "Bad", promptTemplate: "Do it" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Duplicate name");
  });

  it("rejects missing promptTemplate (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Missing prompt" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("GET /api/workflows/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a workflow with stats", async () => {
    mockGetWorkflowWithStats.mockResolvedValue({
      id: "w-1",
      name: "Deploy",
      runCount: 5,
      lastRunAt: "2026-01-20T00:00:00Z",
      totalCostUsd: "2.0000",
    });

    const res = await app.inject({ method: "GET", url: "/api/workflows/w-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflow.runCount).toBe(5);
    expect(res.json().workflow.totalCostUsd).toBe("2.0000");
  });

  it("returns 404 when not found", async () => {
    mockGetWorkflowWithStats.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workflows/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/workflows/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a workflow", async () => {
    mockUpdateWorkflow.mockResolvedValue({ id: "w-1", name: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/w-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflow.name).toBe("Updated");
  });

  it("returns 404 when not found", async () => {
    mockUpdateWorkflow.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/w-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 on validation error", async () => {
    mockUpdateWorkflow.mockRejectedValue(new Error("Invalid update"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/w-1",
      payload: { name: "Bad" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/workflows/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a workflow", async () => {
    mockDeleteWorkflow.mockResolvedValue(true);

    const res = await app.inject({ method: "DELETE", url: "/api/workflows/w-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 when not found", async () => {
    mockDeleteWorkflow.mockResolvedValue(false);

    const res = await app.inject({ method: "DELETE", url: "/api/workflows/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/workflows/:id/runs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists runs for a workflow", async () => {
    mockListWorkflowRuns.mockResolvedValue([{ id: "run-1" }, { id: "run-2" }]);

    const res = await app.inject({ method: "GET", url: "/api/workflows/w-1/runs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(2);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith("w-1");
  });
});

describe("GET /api/workflow-runs/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a workflow run", async () => {
    mockGetWorkflowRun.mockResolvedValue({ id: "run-1" });

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/run-1" });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent run", async () => {
    mockGetWorkflowRun.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/workflow-runs/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
