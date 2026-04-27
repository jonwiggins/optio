import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListPersistentAgents = vi.fn();
const mockGetPersistentAgent = vi.fn();
const mockListInboxSummary = vi.fn();
const mockGetPersistentAgentStats = vi.fn();

vi.mock("../services/persistent-agent-service.js", () => ({
  listPersistentAgents: (...args: unknown[]) => mockListPersistentAgents(...args),
  getPersistentAgent: (...args: unknown[]) => mockGetPersistentAgent(...args),
  listInboxSummary: (...args: unknown[]) => mockListInboxSummary(...args),
  getPersistentAgentStats: (...args: unknown[]) => mockGetPersistentAgentStats(...args),
  // Stubs for the rest of the namespace import surface
  createPersistentAgent: vi.fn(),
  updatePersistentAgent: vi.fn(),
  deletePersistentAgent: vi.fn(),
  setControlIntent: vi.fn(),
  wakeAgent: vi.fn(),
  listRecentMessages: vi.fn(),
  listPersistentAgentTurns: vi.fn(),
  getPersistentAgentTurn: vi.fn(),
  listTurnLogs: vi.fn(),
}));

vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

import { persistentAgentRoutes } from "./persistent-agents.js";

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(persistentAgentRoutes);
}

describe("GET /api/persistent-agents/stats", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns aggregated agent stats and forwards the workspace ID", async () => {
    mockGetPersistentAgentStats.mockResolvedValue({
      total: 8,
      idle: 4,
      queued: 1,
      running: 2,
      paused: 0,
      failed: 1,
      archived: 3,
    });

    const res = await app.inject({ method: "GET", url: "/api/persistent-agents/stats" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toEqual({
      total: 8,
      idle: 4,
      queued: 1,
      running: 2,
      paused: 0,
      failed: 1,
      archived: 3,
    });
    expect(mockGetPersistentAgentStats).toHaveBeenCalledWith("ws-1");
  });

  it("matches the literal `/stats` segment, not the `/:id` route", async () => {
    // Regression: a GET /api/persistent-agents/stats request must hit the
    // stats handler, not the detail handler — the detail handler validates
    // `:id` as a UUID and would 400.
    mockGetPersistentAgentStats.mockResolvedValue({
      total: 0,
      idle: 0,
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      archived: 0,
    });

    const res = await app.inject({ method: "GET", url: "/api/persistent-agents/stats" });

    expect(res.statusCode).toBe(200);
    expect(mockGetPersistentAgentStats).toHaveBeenCalledTimes(1);
    expect(mockGetPersistentAgent).not.toHaveBeenCalled();
  });
});
