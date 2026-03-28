import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

vi.mock("../db/client.js", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          groupBy: vi.fn().mockResolvedValue([]),
        }),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));

const mockListTasks = vi.fn().mockResolvedValue([]);
const mockSearchTasks = vi.fn().mockResolvedValue({ tasks: [], cursor: null });
const mockGetTask = vi.fn().mockResolvedValue({ id: "t1", state: "running", workspaceId: null });
const mockGetTaskLogs = vi.fn().mockResolvedValue([]);

vi.mock("../services/task-service.js", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  searchTasks: (...args: unknown[]) => mockSearchTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskLogs: (...args: unknown[]) => mockGetTaskLogs(...args),
  getTaskEvents: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
  transitionTask: vi.fn(),
  getAllTaskLogs: vi.fn().mockResolvedValue([]),
  forceRedoTask: vi.fn(),
}));

vi.mock("../services/dependency-service.js", () => ({
  addDependencies: vi.fn(),
  computePendingReason: vi.fn(),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: {},
  repoPods: {},
  podHealthEvents: {},
  repos: {},
}));

const mockListSessions = vi.fn().mockResolvedValue([]);
const mockGetActiveSessionCount = vi.fn().mockResolvedValue(0);

vi.mock("../services/interactive-session-service.js", () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getActiveSessionCount: (...args: unknown[]) => mockGetActiveSessionCount(...args),
  getSession: vi.fn(),
  createSession: vi.fn(),
  endSession: vi.fn(),
}));

import { taskRoutes } from "./tasks.js";
import { sessionRoutes } from "./sessions.js";

// ─── Helpers ───

async function buildTaskApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Decorate with a fake user to satisfy workspace checks
  app.decorateRequest("user", undefined);
  app.addHook("preHandler", async (req) => {
    (req as any).user = { id: "u1", workspaceId: null };
  });
  await taskRoutes(app);
  await app.ready();
  return app;
}

async function buildSessionApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined);
  app.addHook("preHandler", async (req) => {
    (req as any).user = { id: "u1", workspaceId: null };
  });
  await sessionRoutes(app);
  await app.ready();
  return app;
}

// ─── Tests ───

describe("query parameter validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/tasks", () => {
    it("accepts valid limit and offset", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?limit=10&offset=5",
      });
      expect(res.statusCode).toBe(200);
      expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 5 }));
    });

    it("uses defaults when no params provided", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks",
      });
      expect(res.statusCode).toBe(200);
      expect(mockListTasks).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
    });

    it("rejects negative limit", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?limit=-1",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    });

    it("rejects limit exceeding max (1000)", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?limit=5000",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    });

    it("rejects negative offset", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?offset=-10",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    });

    it("rejects non-integer limit", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?limit=3.5",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    });

    it("rejects zero limit", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks?limit=0",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toHaveProperty("error");
    });
  });

  describe("GET /api/tasks/search", () => {
    it("accepts valid limit", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/search?limit=25&q=test",
      });
      expect(res.statusCode).toBe(200);
      expect(mockSearchTasks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25, q: "test" }),
      );
    });

    it("rejects limit over 1000", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/search?limit=2000",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/tasks/:id/logs", () => {
    it("accepts valid limit and offset", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/t1/logs?limit=100&offset=50",
      });
      expect(res.statusCode).toBe(200);
      expect(mockGetTaskLogs).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ limit: 100, offset: 50 }),
      );
    });

    it("uses default limit of 200", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/t1/logs",
      });
      expect(res.statusCode).toBe(200);
      expect(mockGetTaskLogs).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ limit: 200, offset: 0 }),
      );
    });

    it("rejects negative limit", async () => {
      const app = await buildTaskApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/t1/logs?limit=-5",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/sessions", () => {
    it("accepts valid limit and offset", async () => {
      const app = await buildSessionApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions?limit=20&offset=10",
      });
      expect(res.statusCode).toBe(200);
      expect(mockListSessions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, offset: 10 }),
      );
    });

    it("rejects limit exceeding 1000", async () => {
      const app = await buildSessionApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions?limit=9999",
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects negative offset", async () => {
      const app = await buildSessionApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions?offset=-1",
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
