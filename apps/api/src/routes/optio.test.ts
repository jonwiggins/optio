import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListNamespacedPod = vi.fn();
const mockExecute = vi.fn();

vi.mock("@kubernetes/client-node", () => {
  return {
    KubeConfig: vi.fn().mockImplementation(() => ({
      loadFromDefault: vi.fn(),
      makeApiClient: vi.fn(() => ({
        listNamespacedPod: mockListNamespacedPod,
      })),
    })),
    CoreV1Api: vi.fn(),
  };
});

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

import { optioRoutes, _resetCache } from "./optio.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await optioRoutes(app);
  await app.ready();
  return app;
}

async function buildTestAppWithAuth(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { workspaceId: "ws-1", workspaceRole: "admin" };
    done();
  });
  await optioRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/optio/status", () => {
  let app: FastifyInstance;
  const originalEnv = process.env.OPTIO_POD_ENABLED;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCache();
    process.env.OPTIO_POD_ENABLED = "true";
    app = await buildTestApp();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPTIO_POD_ENABLED;
    } else {
      process.env.OPTIO_POD_ENABLED = originalEnv;
    }
  });

  it("returns enabled:false when OPTIO_POD_ENABLED is not set", async () => {
    delete process.env.OPTIO_POD_ENABLED;

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.podName).toBeNull();
    expect(body.enabled).toBe(false);
  });

  it("returns ready:true when optio pod is running", async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: "optio-optio-abc123" },
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.podName).toBe("optio-optio-abc123");
    expect(body.enabled).toBe(true);
  });

  it("returns ready:false when no pods found", async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.podName).toBeNull();
  });

  it("returns ready:false when pod is not ready", async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: "optio-optio-abc123" },
          status: {
            phase: "Pending",
            conditions: [{ type: "Ready", status: "False" }],
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.podName).toBe("optio-optio-abc123");
  });

  it("returns ready:false when K8s API fails", async () => {
    mockListNamespacedPod.mockRejectedValue(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.podName).toBeNull();
  });
});

describe("GET /api/optio/system-status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestAppWithAuth();
  });

  it("returns aggregate system status", async () => {
    mockExecute
      // 1. Task counts by state
      .mockResolvedValueOnce([
        { state: "running", count: "3" },
        { state: "queued", count: "5" },
        { state: "needs_attention", count: "1" },
        { state: "pr_opened", count: "2" },
      ])
      // 2. Failed/completed today
      .mockResolvedValueOnce([{ failed_today: "2", completed_today: "7" }])
      // 3. Pod health
      .mockResolvedValueOnce([
        { state: "ready", count: "4" },
        { state: "error", count: "1" },
        { state: "provisioning", count: "1" },
      ])
      // 4. Cost today
      .mockResolvedValueOnce([{ cost_today: "3.5000" }])
      // 5. Alerts
      .mockResolvedValueOnce([
        {
          event_type: "oom_killed",
          message: "Pod ran out of memory",
          created_at: "2026-03-28T10:00:00Z",
          pod_name: "optio-repo-abc",
        },
      ]);

    const res = await app.inject({ method: "GET", url: "/api/optio/system-status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.tasks.running).toBe(3);
    expect(body.tasks.queued).toBe(5);
    expect(body.tasks.needsAttention).toBe(1);
    expect(body.tasks.prOpened).toBe(2);
    expect(body.tasks.failedToday).toBe(2);
    expect(body.tasks.completedToday).toBe(7);

    expect(body.pods.total).toBe(6);
    expect(body.pods.healthy).toBe(4);
    expect(body.pods.unhealthy).toBe(1);

    expect(body.queueDepth).toBe(5);
    expect(body.costToday).toBe(3.5);

    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].type).toBe("oom_killed");
  });

  it("returns zeros when no data exists", async () => {
    mockExecute
      .mockResolvedValueOnce([]) // task counts
      .mockResolvedValueOnce([{ failed_today: "0", completed_today: "0" }]) // today counts
      .mockResolvedValueOnce([]) // pod health
      .mockResolvedValueOnce([{ cost_today: "0" }]) // cost
      .mockResolvedValueOnce([]); // alerts

    const res = await app.inject({ method: "GET", url: "/api/optio/system-status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.tasks.running).toBe(0);
    expect(body.tasks.queued).toBe(0);
    expect(body.pods.total).toBe(0);
    expect(body.queueDepth).toBe(0);
    expect(body.costToday).toBe(0);
    expect(body.alerts).toHaveLength(0);
  });

  it("returns 500 when DB fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection error"));

    const res = await app.inject({ method: "GET", url: "/api/optio/system-status" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to fetch system status");
  });
});
