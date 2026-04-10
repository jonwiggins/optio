import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListWorkflows = vi.fn();
const mockGetWorkflow = vi.fn();
const mockCreateWorkflow = vi.fn();
const mockUpdateWorkflow = vi.fn();
const mockDeleteWorkflow = vi.fn();
const mockListWorkflowTriggers = vi.fn();
const mockCreateWorkflowTrigger = vi.fn();
const mockDeleteWorkflowTrigger = vi.fn();
const mockListWorkflowRuns = vi.fn();
const mockGetWorkflowRun = vi.fn();
const mockCreateWorkflowRun = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  createWorkflow: (...args: unknown[]) => mockCreateWorkflow(...args),
  updateWorkflow: (...args: unknown[]) => mockUpdateWorkflow(...args),
  deleteWorkflow: (...args: unknown[]) => mockDeleteWorkflow(...args),
  listWorkflowTriggers: (...args: unknown[]) => mockListWorkflowTriggers(...args),
  createWorkflowTrigger: (...args: unknown[]) => mockCreateWorkflowTrigger(...args),
  deleteWorkflowTrigger: (...args: unknown[]) => mockDeleteWorkflowTrigger(...args),
  listWorkflowRuns: (...args: unknown[]) => mockListWorkflowRuns(...args),
  getWorkflowRun: (...args: unknown[]) => mockGetWorkflowRun(...args),
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
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

  it("lists workflows scoped to workspace", async () => {
    mockListWorkflows.mockResolvedValue([{ id: "wf-1", name: "Deploy" }]);

    const res = await app.inject({ method: "GET", url: "/api/workflows" });

    expect(res.statusCode).toBe(200);
    expect(res.json().workflows).toHaveLength(1);
    expect(mockListWorkflows).toHaveBeenCalledWith("ws-1");
  });
});

describe("POST /api/workflows", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workflow", async () => {
    mockCreateWorkflow.mockResolvedValue({ id: "wf-1", name: "Deploy" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Deploy", promptTemplate: "Do the deploy" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Deploy", workspaceId: "ws-1" }),
    );
  });

  it("rejects missing promptTemplate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Deploy" },
    });

    // Zod validation error
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/workflows/:id/runs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a workflow run", async () => {
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-1", state: "queued" });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf-1" }),
    );
  });

  it("returns 400 when run creation fails", async () => {
    mockCreateWorkflowRun.mockRejectedValue(new Error("Workflow not found"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/nonexistent/runs",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
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

describe("DELETE /api/workflows/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a workflow", async () => {
    mockDeleteWorkflow.mockResolvedValue(true);

    const res = await app.inject({ method: "DELETE", url: "/api/workflows/wf-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent workflow", async () => {
    mockDeleteWorkflow.mockResolvedValue(false);

    const res = await app.inject({ method: "DELETE", url: "/api/workflows/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
