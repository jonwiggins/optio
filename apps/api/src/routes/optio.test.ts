import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { optioRoutes } from "./optio.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await optioRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/optio/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns ready:true when optio pod is running", async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: "optio-optio-abc123" },
          status: {
            containerStatuses: [
              {
                state: { running: { startedAt: "2026-01-01T00:00:00Z" } },
                ready: true,
              },
            ],
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/optio/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.podName).toBe("optio-optio-abc123");
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
            containerStatuses: [
              {
                state: { waiting: { reason: "ContainerCreating" } },
                ready: false,
              },
            ],
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
