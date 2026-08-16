import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListPersistentAgents = vi.fn();
const mockGetPersistentAgentScoped = vi.fn();
const mockListInboxSummary = vi.fn();
const mockGetPersistentAgentStats = vi.fn();
const mockUpdatePersistentAgent = vi.fn();
const mockDeletePersistentAgent = vi.fn();
const mockSetControlIntent = vi.fn();
const mockWakeAgent = vi.fn();
const mockListRecentMessages = vi.fn();
const mockListPersistentAgentTurns = vi.fn();
const mockGetPersistentAgentTurn = vi.fn();
const mockListTurnLogs = vi.fn();

vi.mock("../services/persistent-agent-service.js", () => ({
  listPersistentAgents: (...args: unknown[]) => mockListPersistentAgents(...args),
  getPersistentAgentScoped: (...args: unknown[]) => mockGetPersistentAgentScoped(...args),
  // Unscoped getter exists for workers/reconciler/internal callers; routes must
  // never reach it. Present here only so the namespace import surface is complete.
  getPersistentAgentUnscoped: vi.fn(),
  listInboxSummary: (...args: unknown[]) => mockListInboxSummary(...args),
  getPersistentAgentStats: (...args: unknown[]) => mockGetPersistentAgentStats(...args),
  createPersistentAgent: vi.fn(),
  updatePersistentAgent: (...args: unknown[]) => mockUpdatePersistentAgent(...args),
  deletePersistentAgent: (...args: unknown[]) => mockDeletePersistentAgent(...args),
  setControlIntent: (...args: unknown[]) => mockSetControlIntent(...args),
  wakeAgent: (...args: unknown[]) => mockWakeAgent(...args),
  listRecentMessages: (...args: unknown[]) => mockListRecentMessages(...args),
  listPersistentAgentTurns: (...args: unknown[]) => mockListPersistentAgentTurns(...args),
  getPersistentAgentTurn: (...args: unknown[]) => mockGetPersistentAgentTurn(...args),
  listTurnLogs: (...args: unknown[]) => mockListTurnLogs(...args),
}));

vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

// Trigger routes reach into the DB directly via dynamic import. Mock the client
// and schema so the same-workspace happy path can complete; the cross-workspace
// tests short-circuit at the workspace guard and never touch these.
const mockTriggerDeleteReturning = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "trigger-1" }]) }) }),
    delete: () => ({ where: () => ({ returning: () => mockTriggerDeleteReturning() }) }),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflowTriggers: { id: "id", targetType: "targetType", targetId: "targetId" },
}));

vi.mock("../services/reconcile-queue.js", () => ({
  enqueueReconcile: vi.fn().mockResolvedValue(undefined),
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
    expect(mockGetPersistentAgentScoped).not.toHaveBeenCalled();
  });
});

// ─── Cross-tenant workspace scoping ───
//
// Every id-addressed handler must resolve the agent through the
// workspace-scoped getter. A caller whose workspace differs from the agent's
// must get 404 (not 403 — no cross-tenant existence oracle) and must not
// mutate, wake, or read the foreign agent.

describe("persistent-agent routes enforce workspace scoping", () => {
  // Agent lives in ws-1. The default test user (from buildRouteTestApp) is also
  // in ws-1; the "attacker" app below is a member of ws-2.
  const AGENT_ID = "11111111-1111-1111-1111-111111111111";
  const TURN_ID = "22222222-2222-2222-2222-222222222222";
  const TRIGGER_ID = "33333333-3333-3333-3333-333333333333";
  const AGENT = {
    id: AGENT_ID,
    workspaceId: "ws-1",
    slug: "forge",
    name: "Forge",
    enabled: true,
  };

  // The mocked scoped getter mirrors the real SQL predicate: it returns the
  // agent only when the requested workspace matches the agent's.
  function installScopedGetter() {
    mockGetPersistentAgentScoped.mockImplementation(
      async (id: string, workspaceId: string | null) =>
        id === AGENT.id && workspaceId === AGENT.workspaceId ? AGENT : null,
    );
  }

  let sameWsApp: FastifyInstance;
  let foreignApp: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    installScopedGetter();
    // Same admin role in both so the requireRole("member") guard passes and we
    // isolate the workspace check (403 would mask a scoping bug).
    sameWsApp = await buildRouteTestApp(persistentAgentRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "admin" },
    });
    foreignApp = await buildRouteTestApp(persistentAgentRoutes, {
      user: { id: "user-2", workspaceId: "ws-2", workspaceRole: "admin" },
    });
  });

  describe("GET /:id (detail)", () => {
    it("404s for a foreign workspace and forwards the caller's workspace to the scoped getter", async () => {
      const res = await foreignApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockGetPersistentAgentScoped).toHaveBeenCalledWith(AGENT_ID, "ws-2");
      expect(mockListInboxSummary).not.toHaveBeenCalled();
    });

    it("returns the agent for a same-workspace caller", async () => {
      mockListInboxSummary.mockResolvedValue({ pending: 0, oldest: null });
      const res = await sameWsApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agent.id).toBe(AGENT_ID);
      expect(mockGetPersistentAgentScoped).toHaveBeenCalledWith(AGENT_ID, "ws-1");
    });
  });

  describe("PATCH /:id", () => {
    it("404s for a foreign workspace and does not update", async () => {
      const res = await foreignApp.inject({
        method: "PATCH",
        url: `/api/persistent-agents/${AGENT_ID}`,
        payload: { name: "Pwned" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockUpdatePersistentAgent).not.toHaveBeenCalled();
    });

    it("updates for a same-workspace caller and passes the workspace to the scoped update", async () => {
      mockUpdatePersistentAgent.mockResolvedValue({ ...AGENT, name: "Renamed" });
      const res = await sameWsApp.inject({
        method: "PATCH",
        url: `/api/persistent-agents/${AGENT_ID}`,
        payload: { name: "Renamed" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockUpdatePersistentAgent).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({ name: "Renamed" }),
        "ws-1",
      );
    });
  });

  describe("DELETE /:id", () => {
    it("404s for a foreign workspace and does not delete", async () => {
      const res = await foreignApp.inject({
        method: "DELETE",
        url: `/api/persistent-agents/${AGENT_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockDeletePersistentAgent).not.toHaveBeenCalled();
    });

    it("deletes for a same-workspace caller and passes the workspace to the scoped delete", async () => {
      mockDeletePersistentAgent.mockResolvedValue(true);
      const res = await sameWsApp.inject({
        method: "DELETE",
        url: `/api/persistent-agents/${AGENT_ID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(mockDeletePersistentAgent).toHaveBeenCalledWith(AGENT_ID, "ws-1");
    });
  });

  describe("POST /:id/messages", () => {
    it("404s for a foreign workspace and does not wake the agent", async () => {
      const res = await foreignApp.inject({
        method: "POST",
        url: `/api/persistent-agents/${AGENT_ID}/messages`,
        payload: { body: "run this in the victim's pod" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockWakeAgent).not.toHaveBeenCalled();
    });

    it("wakes the agent for a same-workspace caller", async () => {
      mockWakeAgent.mockResolvedValue(undefined);
      const res = await sameWsApp.inject({
        method: "POST",
        url: `/api/persistent-agents/${AGENT_ID}/messages`,
        payload: { body: "hello" },
      });
      expect(res.statusCode).toBe(202);
      expect(mockWakeAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /:id/turns", () => {
    it("404s for a foreign workspace and does not list turns", async () => {
      const res = await foreignApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}/turns`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockListPersistentAgentTurns).not.toHaveBeenCalled();
    });

    it("lists turns for a same-workspace caller", async () => {
      mockListPersistentAgentTurns.mockResolvedValue([]);
      const res = await sameWsApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}/turns`,
      });
      expect(res.statusCode).toBe(200);
      expect(mockListPersistentAgentTurns).toHaveBeenCalled();
    });
  });

  describe("GET /:id/turns/:turnId", () => {
    it("404s for a foreign workspace and does not read the turn", async () => {
      const res = await foreignApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}/turns/${TURN_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockGetPersistentAgentTurn).not.toHaveBeenCalled();
    });

    it("404s when the turn belongs to a different agent", async () => {
      mockGetPersistentAgentTurn.mockResolvedValue({ id: TURN_ID, agentId: "some-other-agent" });
      const res = await sameWsApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}/turns/${TURN_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockListTurnLogs).not.toHaveBeenCalled();
    });

    it("returns the turn for a same-workspace caller", async () => {
      mockGetPersistentAgentTurn.mockResolvedValue({ id: TURN_ID, agentId: AGENT_ID });
      mockListTurnLogs.mockResolvedValue([]);
      const res = await sameWsApp.inject({
        method: "GET",
        url: `/api/persistent-agents/${AGENT_ID}/turns/${TURN_ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().turn.id).toBe(TURN_ID);
    });
  });

  describe("DELETE /:id/triggers/:triggerId", () => {
    it("404s for a foreign workspace and does not delete the trigger", async () => {
      const res = await foreignApp.inject({
        method: "DELETE",
        url: `/api/persistent-agents/${AGENT_ID}/triggers/${TRIGGER_ID}`,
      });
      expect(res.statusCode).toBe(404);
      expect(mockTriggerDeleteReturning).not.toHaveBeenCalled();
    });

    it("deletes the trigger for a same-workspace caller", async () => {
      mockTriggerDeleteReturning.mockResolvedValue([{ id: TRIGGER_ID }]);
      const res = await sameWsApp.inject({
        method: "DELETE",
        url: `/api/persistent-agents/${AGENT_ID}/triggers/${TRIGGER_ID}`,
      });
      expect(res.statusCode).toBe(204);
      expect(mockTriggerDeleteReturning).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /:id/control", () => {
    it("404s for a foreign workspace and does not set a control intent", async () => {
      const res = await foreignApp.inject({
        method: "POST",
        url: `/api/persistent-agents/${AGENT_ID}/control`,
        payload: { intent: "archive" },
      });
      expect(res.statusCode).toBe(404);
      expect(mockSetControlIntent).not.toHaveBeenCalled();
    });

    it("sets the control intent for a same-workspace caller and passes the workspace", async () => {
      mockSetControlIntent.mockResolvedValue(AGENT);
      const res = await sameWsApp.inject({
        method: "POST",
        url: `/api/persistent-agents/${AGENT_ID}/control`,
        payload: { intent: "pause" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockSetControlIntent).toHaveBeenCalledWith(AGENT_ID, "pause", "ws-1");
    });
  });
});
