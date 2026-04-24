import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetTask = vi.fn();
const mockRecordTaskEvent = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  recordTaskEvent: (...args: unknown[]) => mockRecordTaskEvent(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn();
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

const mockSendMessage = vi.fn();
const mockListMessages = vi.fn();
const mockCanMessageTask = vi.fn();
const mockMarkDelivered = vi.fn();

vi.mock("../services/task-message-service.js", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  listMessages: (...args: unknown[]) => mockListMessages(...args),
  canMessageTask: (...args: unknown[]) => mockCanMessageTask(...args),
  markDelivered: (...args: unknown[]) => mockMarkDelivered(...args),
}));

const mockPublishTaskMessage = vi.fn();
vi.mock("../services/task-message-bus.js", () => ({
  publishTaskMessage: (...args: unknown[]) => mockPublishTaskMessage(...args),
}));

const mockPublishEvent = vi.fn();
const mockGetRedisClient = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
  getRedisClient: () => mockGetRedisClient(),
}));

import { messageRoutes } from "./messages.js";

// ─── Helpers ───

async function buildTestApp(userOverrides?: Record<string, unknown>): Promise<FastifyInstance> {
  return buildRouteTestApp(messageRoutes, {
    user: {
      id: "user-1",
      workspaceId: "ws-1",
      workspaceRole: "admin",
      ...(userOverrides as object),
    } as {
      id: string;
      workspaceId: string | null;
      workspaceRole: "admin" | "member" | "viewer";
    },
  });
}

const runningClaudeTask = {
  id: "task-1",
  state: "running",
  agentType: "claude-code",
  workspaceId: "ws-1",
  createdBy: "user-1",
};

describe("POST /api/tasks/:id/message", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Mock Redis client for rate limiting
    mockGetRedisClient.mockReturnValue({
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    });
    mockMarkDelivered.mockResolvedValue(undefined);
    app = await buildTestApp();
  });

  it("sends a message and returns 202", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);
    mockCanMessageTask.mockResolvedValue(true);
    const mockMsg = {
      id: "msg-1",
      taskId: "task-1",
      userId: "user-1",
      content: "use Postgres",
      mode: "soft",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deliveredAt: null,
      ackedAt: null,
    };
    mockSendMessage.mockResolvedValue(mockMsg);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "use Postgres" },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.message.id).toBe("msg-1");
    expect(body.message.content).toBe("use Postgres");
    expect(body.message.mode).toBe("soft");
    expect(body.message.deliveredAt).toBeNull();
    expect(mockPublishTaskMessage).toHaveBeenCalled();
    expect(mockPublishEvent).toHaveBeenCalled();
    expect(mockRecordTaskEvent).toHaveBeenCalled();
  });

  it("sends an interrupt message", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);
    mockCanMessageTask.mockResolvedValue(true);
    const mockMsg = {
      id: "msg-2",
      taskId: "task-1",
      userId: "user-1",
      content: "STOP",
      mode: "interrupt",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deliveredAt: null,
      ackedAt: null,
    };
    mockSendMessage.mockResolvedValue(mockMsg);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "STOP", mode: "interrupt" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().message.mode).toBe("interrupt");
  });

  it("returns 404 when task not found", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/nonexistent/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when task is in different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...runningClaudeTask, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when user cannot message task", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);
    mockCanMessageTask.mockResolvedValue(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("returns 409 when task is completed (terminal, not resumable)", async () => {
    mockGetTask.mockResolvedValue({ ...runningClaudeTask, state: "completed" });
    mockCanMessageTask.mockResolvedValue(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when task is pending (hasn't started, no agent to message)", async () => {
    mockGetTask.mockResolvedValue({ ...runningClaudeTask, state: "pending" });
    mockCanMessageTask.mockResolvedValue(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("returns 501 for non-claude-code agent in running state", async () => {
    mockGetTask.mockResolvedValue({ ...runningClaudeTask, agentType: "codex" });
    mockCanMessageTask.mockResolvedValue(true);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(501);
  });

  it.each(["needs_attention", "failed", "pr_opened", "cancelled"])(
    "resumes a stopped task when in %s state",
    async (state) => {
      mockGetTask.mockResolvedValue({
        ...runningClaudeTask,
        state,
        sessionId: "prior-session-xyz",
      });
      mockCanMessageTask.mockResolvedValue(true);
      const mockMsg = {
        id: "msg-resume-1",
        taskId: "task-1",
        userId: "user-1",
        content: "please address the review comments",
        mode: "soft",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        deliveredAt: null,
        ackedAt: null,
      };
      mockSendMessage.mockResolvedValue(mockMsg);
      mockTransitionTask.mockResolvedValue(undefined);
      mockQueueAdd.mockResolvedValue({ id: "job-1" });

      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/task-1/message",
        payload: { content: "please address the review comments" },
      });

      expect(res.statusCode).toBe(202);
      // recordTaskEvent fires with the message trigger (non-transitioning),
      // transitionTask fires with user_message_resume for the actual resume.
      expect(mockRecordTaskEvent).toHaveBeenCalledWith(
        "task-1",
        state,
        "user_message",
        expect.stringContaining("please address"),
        expect.anything(),
      );
      expect(mockTransitionTask).toHaveBeenCalledWith(
        "task-1",
        "queued",
        "user_message_resume",
        expect.stringContaining("please address"),
      );
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "process-task",
        expect.objectContaining({
          taskId: "task-1",
          resumeSessionId: "prior-session-xyz",
          resumePrompt: "please address the review comments",
        }),
        expect.any(Object),
      );
      // Running-stream publish path should NOT fire for stopped tasks.
      expect(mockPublishTaskMessage).not.toHaveBeenCalled();
      // deliveredAt is stamped immediately for the resume path.
      expect(res.json().message.deliveredAt).not.toBeNull();
    },
  );

  it("resumes a stopped non-claude-code task (agent type is irrelevant for resume)", async () => {
    mockGetTask.mockResolvedValue({
      ...runningClaudeTask,
      state: "needs_attention",
      agentType: "codex",
      sessionId: "s1",
    });
    mockCanMessageTask.mockResolvedValue(true);
    mockSendMessage.mockResolvedValue({
      id: "msg-x",
      taskId: "task-1",
      userId: "user-1",
      content: "retry please",
      mode: "soft",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deliveredAt: null,
      ackedAt: null,
    });
    mockTransitionTask.mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue({ id: "job-2" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "retry please" },
    });

    expect(res.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);
    mockCanMessageTask.mockResolvedValue(true);
    mockGetRedisClient.mockReturnValue({
      incr: vi.fn().mockResolvedValue(11),
      expire: vi.fn().mockResolvedValue(1),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(429);
  });

  it("validates content length", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/message",
      payload: { content: "" },
    });

    // Zod validation error returns 400 via error handler or
    // could throw - check for non-2xx
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/tasks/:id/messages", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetRedisClient.mockReturnValue({
      incr: vi.fn(),
      expire: vi.fn(),
    });
    app = await buildTestApp();
  });

  it("lists messages for a task", async () => {
    mockGetTask.mockResolvedValue(runningClaudeTask);
    mockListMessages.mockResolvedValue([
      {
        id: "m1",
        taskId: "task-1",
        userId: "user-1",
        content: "hello",
        mode: "soft",
        createdAt: new Date("2026-01-01"),
        deliveredAt: null,
        ackedAt: null,
        deliveryError: null,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/messages",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toHaveLength(1);
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/nonexistent/messages",
    });

    expect(res.statusCode).toBe(404);
  });
});
