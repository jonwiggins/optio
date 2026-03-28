import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListNamespacedPod = vi.fn();

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

import { optioRoutes, _resetCache } from "./optio.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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

  it("caches K8s API result for subsequent requests", async () => {
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

    // First request hits the K8s API
    const res1 = await app.inject({ method: "GET", url: "/api/optio/status" });
    expect(res1.json().ready).toBe(true);
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(1);

    // Second request within the TTL should use cache
    const res2 = await app.inject({ method: "GET", url: "/api/optio/status" });
    expect(res2.json().ready).toBe(true);
    expect(mockListNamespacedPod).toHaveBeenCalledTimes(1);
  });
});
