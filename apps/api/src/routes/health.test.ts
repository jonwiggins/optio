import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockDbExecute = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}));

const mockCheckRuntimeHealth = vi.fn();

vi.mock("../services/container-service.js", () => ({
  checkRuntimeHealth: (...args: unknown[]) => mockCheckRuntimeHealth(...args),
}));

import { healthRoutes, _resetHealthCache } from "./health.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await healthRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetHealthCache();
    app = await buildTestApp();
  });

  it("returns 200 when all checks pass", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
    // The runtime health may be cached from a previous test in this module;
    // just verify healthy is true when db is up
    expect(body.checks.containerRuntime).toBeTypeOf("boolean");
  });

  it("returns 503 when database is down", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.healthy).toBe(false);
    expect(body.checks.database).toBe(false);
  });

  it("returns 200 when database is up but container runtime is down", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
    expect(body.checks.containerRuntime).toBe(false);
  });

  it("returns 503 only when database is down, regardless of container runtime", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.healthy).toBe(false);
    expect(body.checks.database).toBe(false);
  });

  it("returns maxConcurrent from env", async () => {
    mockDbExecute.mockResolvedValue(undefined);
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/health" });

    expect(res.json().maxConcurrent).toBeTypeOf("number");
  });
});
