import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListTriggers = vi.fn();
const mockGetTrigger = vi.fn();
const mockCreateTrigger = vi.fn();
const mockUpdateTrigger = vi.fn();
const mockDeleteTrigger = vi.fn();

vi.mock("../services/workflow-trigger-service.js", () => ({
  listTriggers: (...args: unknown[]) => mockListTriggers(...args),
  getTrigger: (...args: unknown[]) => mockGetTrigger(...args),
  createTrigger: (...args: unknown[]) => mockCreateTrigger(...args),
  updateTrigger: (...args: unknown[]) => mockUpdateTrigger(...args),
  deleteTrigger: (...args: unknown[]) => mockDeleteTrigger(...args),
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflows: "workflows_table",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
}));

import { workflowTriggerRoutes } from "./workflow-triggers.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    done();
  });
  await workflowTriggerRoutes(app);
  await app.ready();
  return app;
}

const mockWorkflow = {
  id: "wf-1",
  name: "Deploy",
  workspaceId: "ws-1",
};

const mockTriggerData = {
  id: "trig-1",
  workflowId: "wf-1",
  type: "manual",
  config: {},
  paramMapping: null,
  enabled: true,
};

function mockGetWorkflowReturns(workflow: Record<string, unknown> | null) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(workflow ? [workflow] : []),
    }),
  });
}

// ─── GET /api/workflows/:id/triggers ───

describe("GET /api/workflows/:id/triggers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists triggers for a workflow", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockListTriggers.mockResolvedValue([mockTriggerData]);

    const res = await app.inject({
      method: "GET",
      url: "/api/workflows/wf-1/triggers",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().triggers).toHaveLength(1);
    expect(mockListTriggers).toHaveBeenCalledWith("wf-1");
  });

  it("returns 404 for nonexistent workflow", async () => {
    mockGetWorkflowReturns(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/workflows/nonexistent/triggers",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for workflow from another workspace", async () => {
    mockGetWorkflowReturns({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "GET",
      url: "/api/workflows/wf-1/triggers",
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /api/workflows/:id/triggers ───

describe("POST /api/workflows/:id/triggers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a manual trigger", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockResolvedValue(mockTriggerData);

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "manual", config: {} },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        type: "manual",
      }),
    );
  });

  it("creates a schedule trigger with cronExpression", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "schedule",
      config: { cronExpression: "0 0 * * *" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "schedule", config: { cronExpression: "0 0 * * *" } },
    });

    expect(res.statusCode).toBe(201);
  });

  it("creates a webhook trigger with path", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "webhook",
      config: { path: "/hooks/deploy" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "webhook", config: { path: "/hooks/deploy" } },
    });

    expect(res.statusCode).toBe(201);
  });

  it("passes paramMapping when provided", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockResolvedValue({
      ...mockTriggerData,
      paramMapping: { issueId: "$.issue.id" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "manual", config: {}, paramMapping: { issueId: "$.issue.id" } },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        paramMapping: { issueId: "$.issue.id" },
      }),
    );
  });

  it("rejects schedule trigger without cronExpression", async () => {
    mockGetWorkflowReturns(mockWorkflow);

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "schedule", config: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cronExpression");
  });

  it("rejects webhook trigger without path", async () => {
    mockGetWorkflowReturns(mockWorkflow);

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "webhook", config: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("path");
  });

  it("rejects invalid trigger type", async () => {
    mockGetWorkflowReturns(mockWorkflow);

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "invalid", config: {} },
    });

    // Zod validation failure
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for nonexistent workflow", async () => {
    mockGetWorkflowReturns(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/nonexistent/triggers",
      payload: { type: "manual", config: {} },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when duplicate type exists", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockRejectedValue(new Error("duplicate_type"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "manual", config: {} },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when webhook path already in use", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockCreateTrigger.mockRejectedValue(new Error("duplicate_webhook_path"));

    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf-1/triggers",
      payload: { type: "webhook", config: { path: "/hooks/deploy" } },
    });

    expect(res.statusCode).toBe(409);
  });
});

// ─── PATCH /api/workflows/:id/triggers/:triggerId ───

describe("PATCH /api/workflows/:id/triggers/:triggerId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a trigger", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue(mockTriggerData);
    mockUpdateTrigger.mockResolvedValue({ ...mockTriggerData, enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      "trig-1",
      expect.objectContaining({ enabled: false }),
    );
  });

  it("updates trigger config", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "schedule",
      config: { cronExpression: "0 0 * * *" },
    });
    mockUpdateTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "schedule",
      config: { cronExpression: "0 6 * * *" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { config: { cronExpression: "0 6 * * *" } },
    });

    expect(res.statusCode).toBe(200);
  });

  it("updates trigger paramMapping", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue(mockTriggerData);
    mockUpdateTrigger.mockResolvedValue({
      ...mockTriggerData,
      paramMapping: { foo: "bar" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { paramMapping: { foo: "bar" } },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateTrigger).toHaveBeenCalledWith(
      "trig-1",
      expect.objectContaining({ paramMapping: { foo: "bar" } }),
    );
  });

  it("returns 404 for nonexistent trigger", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/nonexistent",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when trigger belongs to different workflow", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({ ...mockTriggerData, workflowId: "wf-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects schedule config update without cronExpression", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "schedule",
      config: { cronExpression: "0 0 * * *" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { config: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cronExpression");
  });

  it("rejects webhook config update without path", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "webhook",
      config: { path: "/hooks/deploy" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { config: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("path");
  });

  it("returns 409 when webhook path already in use", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({
      ...mockTriggerData,
      type: "webhook",
      config: { path: "/hooks/deploy" },
    });
    mockUpdateTrigger.mockRejectedValue(new Error("duplicate_webhook_path"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/wf-1/triggers/trig-1",
      payload: { config: { path: "/hooks/other" } },
    });

    expect(res.statusCode).toBe(409);
  });
});

// ─── DELETE /api/workflows/:id/triggers/:triggerId ───

describe("DELETE /api/workflows/:id/triggers/:triggerId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a trigger", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue(mockTriggerData);
    mockDeleteTrigger.mockResolvedValue(true);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/workflows/wf-1/triggers/trig-1",
    });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteTrigger).toHaveBeenCalledWith("trig-1");
  });

  it("returns 404 for nonexistent trigger", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue(null);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/workflows/wf-1/triggers/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for workflow from another workspace", async () => {
    mockGetWorkflowReturns({ ...mockWorkflow, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/workflows/wf-1/triggers/trig-1",
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when trigger belongs to different workflow", async () => {
    mockGetWorkflowReturns(mockWorkflow);
    mockGetTrigger.mockResolvedValue({ ...mockTriggerData, workflowId: "wf-other" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/workflows/wf-1/triggers/trig-1",
    });

    expect(res.statusCode).toBe(404);
  });
});
