/**
 * Tests that route handlers properly validate request input using Zod schemas
 * instead of unsafe `req.body as Type` casts.
 *
 * These tests verify that invalid bodies, query params, and params are rejected
 * with 400 status codes rather than silently proceeding with bad data.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

// tickets.ts mocks
const mockSyncAllTickets = vi.fn();
vi.mock("../services/ticket-sync-service.js", () => ({
  syncAllTickets: (...args: unknown[]) => mockSyncAllTickets(...args),
}));

const mockStoreSecret = vi.fn();
const mockDeleteSecret = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
  listSecrets: vi.fn().mockResolvedValue([]),
  retrieveSecret: vi.fn().mockResolvedValue(null),
}));

const mockDbInsert = vi.fn();
const mockDbDelete = vi.fn();
const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: () => ({
        returning: () => mockDbInsert(),
      }),
    }),
    delete: () => ({
      where: (...args: unknown[]) => mockDbDelete(...args),
    }),
    select: (...args: unknown[]) => ({
      from: () => ({
        where: (...args2: unknown[]) => mockDbSelect(...args2),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => [] }),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  ticketProviders: { id: "id" },
  repos: { id: "id", workspaceId: "workspaceId", repoUrl: "repoUrl" },
  tasks: {
    ticketSource: "ticketSource",
    ticketExternalId: "ticketExternalId",
    repoUrl: "repoUrl",
    id: "id",
    state: "state",
    workspaceId: "workspaceId",
  },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// pr-reviews.ts mocks
const mockLaunchPrReview = vi.fn();
const mockGetReviewDraft = vi.fn();
const mockUpdateReviewDraft = vi.fn();
const mockMergePr = vi.fn();
const mockGetPrStatus = vi.fn();
vi.mock("../services/pr-review-service.js", () => ({
  listOpenPrs: vi.fn().mockResolvedValue([]),
  launchPrReview: (...args: unknown[]) => mockLaunchPrReview(...args),
  getReviewDraft: (...args: unknown[]) => mockGetReviewDraft(...args),
  updateReviewDraft: (...args: unknown[]) => mockUpdateReviewDraft(...args),
  submitReview: vi.fn(),
  reReview: vi.fn(),
  mergePr: (...args: unknown[]) => mockMergePr(...args),
  getPrStatus: (...args: unknown[]) => mockGetPrStatus(...args),
}));

vi.mock("../plugins/auth.js", () => ({
  requireRole: () => async () => {},
}));

// sessions.ts mocks
const mockGetSession = vi.fn();
const mockAddSessionPr = vi.fn();
const mockGetActiveSessionCount = vi.fn();
vi.mock("../services/interactive-session-service.js", () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  createSession: vi.fn().mockResolvedValue({ id: "s1" }),
  endSession: vi.fn(),
  getSessionPrs: vi.fn().mockResolvedValue([]),
  addSessionPr: (...args: unknown[]) => mockAddSessionPr(...args),
  getActiveSessionCount: (...args: unknown[]) => mockGetActiveSessionCount(...args),
}));

// tasks.ts mocks
vi.mock("../services/task-service.js", () => ({
  getTask: vi.fn().mockResolvedValue(null),
  listTasks: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
  transitionTask: vi.fn(),
  updateTask: vi.fn(),
  searchTasks: vi.fn().mockResolvedValue([]),
  getAllTaskLogs: vi.fn().mockResolvedValue([]),
  getTaskLogs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn().mockRejectedValue(new Error("mock")),
}));

// Import routes after mocks
import { ticketRoutes } from "./tickets.js";
import { prReviewRoutes } from "./pr-reviews.js";
import { sessionRoutes } from "./sessions.js";
// ─── Helpers ───

function decorateApp(app: FastifyInstance) {
  app.decorateRequest("user", undefined as any);
  app.decorateRequest("userId", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1", workspaceRole: "admin" };
    (req as any).userId = "user-1";
    done();
  });
}

// ─── Tests ───

describe("tickets route body validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(ticketRoutes);
  });

  it("rejects POST /api/tickets/providers with missing source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { config: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/tickets/providers with wrong type for source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: 123, config: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/tickets/providers with missing config", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: "github" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts POST /api/tickets/providers with valid body", async () => {
    mockDbInsert.mockResolvedValue([{ id: "p1", source: "github", config: {} }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: "github", config: { token: "ghp_test", org: "test" }, enabled: true },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects POST /api/tickets/providers for GitHub when no token is available", async () => {
    // In the test env, getGitHubToken will fail by default as no secrets/app are configured
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: "github", config: { org: "test" }, enabled: true },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("No GitHub token available");
  });
});

describe("pr-reviews route body validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(prReviewRoutes);
  });

  it("rejects POST /api/pr-reviews with missing prUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/pr-reviews with non-string prUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/pull-requests/merge with missing mergeMethod", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: "https://github.com/org/repo/pull/1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/pull-requests/merge with invalid mergeMethod", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: "https://github.com/org/repo/pull/1", mergeMethod: "yolo" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects PATCH /api/pr-reviews/:id with non-string summary", async () => {
    mockGetReviewDraft.mockResolvedValue({ id: "d1" });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/pr-reviews/d1",
      payload: { summary: 123 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects GET /api/pull-requests/status with missing prUrl query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/pull-requests/status",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("sessions route body validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(sessionRoutes);
  });

  it("rejects POST /api/sessions/:id/prs with missing prNumber", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", userId: "user-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/s1/prs",
      payload: { prUrl: "https://github.com/org/repo/pull/1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects POST /api/sessions/:id/prs with wrong type for prNumber", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", userId: "user-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/s1/prs",
      payload: { prUrl: "https://github.com/org/repo/pull/1", prNumber: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts POST /api/sessions/:id/prs with valid body", async () => {
    mockGetSession.mockResolvedValue({ id: "s1", userId: "user-1" });
    mockAddSessionPr.mockResolvedValue({
      id: "pr-1",
      sessionId: "s1",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
      createdAt: new Date("2026-04-11T12:00:00Z"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/s1/prs",
      payload: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
    });
    expect(res.statusCode).toBe(201);
  });
});
