import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListComments = vi.fn();
const mockAddComment = vi.fn();
const mockUpdateComment = vi.fn();
const mockDeleteComment = vi.fn();

vi.mock("../services/comment-service.js", () => ({
  listComments: (...args: unknown[]) => mockListComments(...args),
  addComment: (...args: unknown[]) => mockAddComment(...args),
  updateComment: (...args: unknown[]) => mockUpdateComment(...args),
  deleteComment: (...args: unknown[]) => mockDeleteComment(...args),
}));

const mockGetTask = vi.fn();
const mockGetTaskEvents = vi.fn();

vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskEvents: (...args: unknown[]) => mockGetTaskEvents(...args),
}));

import { commentRoutes } from "./comments.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    done();
  });
  await commentRoutes(app);
  await app.ready();
  return app;
}

describe("GET /api/tasks/:id/comments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists comments for a task", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockListComments.mockResolvedValue([{ id: "c-1", content: "Hello" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/comments" });

    expect(res.statusCode).toBe(200);
    expect(res.json().comments).toHaveLength(1);
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/comments" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/comments", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("adds a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockAddComment.mockResolvedValue({ id: "c-1", content: "New comment", taskId: "task-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/comments",
      payload: { content: "New comment" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockAddComment).toHaveBeenCalledWith("task-1", "New comment", "user-1");
  });

  it("rejects empty content (Zod throws)", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/comments",
      payload: { content: "" },
    });

    expect(res.statusCode).toBe(500);
  });
});

describe("PATCH /api/tasks/:taskId/comments/:commentId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockResolvedValue({ id: "c-1", content: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateComment).toHaveBeenCalledWith("c-1", "Updated", "user-1");
  });

  it("returns 404 for nonexistent comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockRejectedValue(new Error("Comment not found"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/nonexistent",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for unauthorized edit", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockUpdateComment.mockRejectedValue(new Error("Not authorized to edit"));

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/tasks/:taskId/comments/:commentId", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockDeleteComment.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/tasks/task-1/comments/c-1" });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteComment).toHaveBeenCalledWith("c-1", "user-1");
  });

  it("returns 404 for nonexistent comment", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockDeleteComment.mockRejectedValue(new Error("Comment not found"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/comments/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/tasks/:id/activity", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns interleaved activity feed", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1" });
    mockListComments.mockResolvedValue([
      {
        id: "c-1",
        taskId: "task-1",
        content: "Comment",
        user: "user-1",
        createdAt: "2026-03-27T10:00:00Z",
      },
    ]);
    mockGetTaskEvents.mockResolvedValue([
      {
        id: "e-1",
        taskId: "task-1",
        fromState: "pending",
        toState: "queued",
        trigger: "submit",
        message: null,
        userId: null,
        createdAt: "2026-03-27T09:00:00Z",
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/activity" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activity).toHaveLength(2);
    // Sorted by createdAt: event first (09:00), then comment (10:00)
    expect(body.activity[0].type).toBe("event");
    expect(body.activity[1].type).toBe("comment");
  });
});

describe("workspace scoping", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 404 for PATCH comment on task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1/comments/c-1",
      payload: { content: "Updated" },
    });

    expect(res.statusCode).toBe(404);
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });

  it("returns 404 for DELETE comment on task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-other" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/task-1/comments/c-1",
    });

    expect(res.statusCode).toBe(404);
    expect(mockDeleteComment).not.toHaveBeenCalled();
  });
});
