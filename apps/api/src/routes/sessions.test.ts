import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockCreateSession = vi.fn();
const mockEndSession = vi.fn();
const mockGetSessionPrs = vi.fn();
const mockAddSessionPr = vi.fn();
const mockGetActiveSessionCount = vi.fn();

vi.mock("../services/interactive-session-service.js", () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  endSession: (...args: unknown[]) => mockEndSession(...args),
  getSessionPrs: (...args: unknown[]) => mockGetSessionPrs(...args),
  addSessionPr: (...args: unknown[]) => mockAddSessionPr(...args),
  getActiveSessionCount: (...args: unknown[]) => mockGetActiveSessionCount(...args),
}));

const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockDbSelect(...args),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { repoUrl: "repoUrl" },
}));

import { sessionRoutes } from "./sessions.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.decorateRequest("userId", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    (req as any).userId = "user-1";
    done();
  });
  await sessionRoutes(app);
  await app.ready();
  return app;
}

const mockSession = {
  id: "session-1",
  repoUrl: "https://github.com/org/repo",
  state: "active",
  userId: "user-1",
};

describe("GET /api/sessions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists sessions with default pagination", async () => {
    mockListSessions.mockResolvedValue([mockSession]);
    mockGetActiveSessionCount.mockResolvedValue(1);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.activeCount).toBe(1);
    expect(mockListSessions).toHaveBeenCalledWith({
      repoUrl: undefined,
      state: undefined,
      limit: 50,
      offset: 0,
      userId: "user-1",
    });
  });

  it("passes query filters", async () => {
    mockListSessions.mockResolvedValue([]);
    mockGetActiveSessionCount.mockResolvedValue(0);

    const res = await app.inject({
      method: "GET",
      url: "/api/sessions?state=active&limit=10&offset=5",
    });

    expect(res.statusCode).toBe(200);
    expect(mockListSessions).toHaveBeenCalledWith({
      repoUrl: undefined,
      state: "active",
      limit: 10,
      offset: 5,
      userId: "user-1",
    });
  });
});

describe("GET /api/sessions/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns session with model config", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockDbSelect.mockResolvedValue([{ claudeModel: "opus" }]);

    const res = await app.inject({ method: "GET", url: "/api/sessions/session-1" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session).toEqual(mockSession);
    expect(body.modelConfig).toEqual({
      claudeModel: "opus",
      availableModels: ["haiku", "sonnet", "opus"],
    });
  });

  it("returns 404 for nonexistent session", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/sessions/nonexistent" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Session not found");
  });

  it("returns 404 for another user's session", async () => {
    mockGetSession.mockResolvedValue({ ...mockSession, userId: "other-user" });

    const res = await app.inject({ method: "GET", url: "/api/sessions/session-1" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Session not found");
  });

  it("returns default model config when repo lookup fails", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockDbSelect.mockRejectedValue(new Error("DB error"));

    const res = await app.inject({ method: "GET", url: "/api/sessions/session-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().modelConfig).toBeNull();
  });
});

describe("POST /api/sessions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a session", async () => {
    mockCreateSession.mockResolvedValue(mockSession);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { repoUrl: "https://github.com/org/repo" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().session).toEqual(mockSession);
    expect(mockCreateSession).toHaveBeenCalledWith({
      repoUrl: "https://github.com/org/repo",
      userId: "user-1",
      workspaceId: "ws-1",
    });
  });

  it("rejects invalid repoUrl (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { repoUrl: "not-a-url" },
    });

    // Zod validation errors propagate as 500 (no global error handler)
    expect(res.statusCode).toBe(500);
  });
});

describe("POST /api/sessions/:id/end", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("ends a session", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockEndSession.mockResolvedValue({ ...mockSession, state: "ended" });

    const res = await app.inject({ method: "POST", url: "/api/sessions/session-1/end" });

    expect(res.statusCode).toBe(200);
    expect(res.json().session.state).toBe("ended");
  });

  it("returns 404 when ending another user's session", async () => {
    mockGetSession.mockResolvedValue({ ...mockSession, userId: "other-user" });

    const res = await app.inject({ method: "POST", url: "/api/sessions/session-1/end" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Session not found");
  });

  it("returns 404 when session does not exist", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await app.inject({ method: "POST", url: "/api/sessions/nonexistent/end" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Session not found");
  });

  it("returns 400 when session cannot be ended", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockEndSession.mockRejectedValue(new Error("Session already ended"));

    const res = await app.inject({ method: "POST", url: "/api/sessions/session-1/end" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Session already ended");
  });
});

describe("session PRs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("GET /api/sessions/:id/prs lists PRs", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockGetSessionPrs.mockResolvedValue([
      { id: "pr-1", prUrl: "https://github.com/org/repo/pull/1" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/sessions/session-1/prs" });

    expect(res.statusCode).toBe(200);
    expect(res.json().prs).toHaveLength(1);
  });

  it("GET /api/sessions/:id/prs returns 404 for other user's session", async () => {
    mockGetSession.mockResolvedValue({ ...mockSession, userId: "other-user" });

    const res = await app.inject({ method: "GET", url: "/api/sessions/session-1/prs" });

    expect(res.statusCode).toBe(404);
  });

  it("POST /api/sessions/:id/prs adds a PR", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAddSessionPr.mockResolvedValue({
      id: "pr-1",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/prs",
      payload: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddSessionPr).toHaveBeenCalledWith(
      "session-1",
      "https://github.com/org/repo/pull/1",
      1,
    );
  });

  it("POST /api/sessions/:id/prs rejects missing fields", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/prs",
      payload: { prUrl: "https://github.com/org/repo/pull/1" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("prUrl and prNumber required");
  });
});

describe("GET /api/sessions/active-count", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns active session count", async () => {
    mockGetActiveSessionCount.mockResolvedValue(3);

    const res = await app.inject({ method: "GET", url: "/api/sessions/active-count" });

    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(3);
  });
});
