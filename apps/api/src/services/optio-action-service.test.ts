import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../db/schema.js", () => ({
  optioActions: {
    id: "id",
    userId: "user_id",
    action: "action",
    params: "params",
    result: "result",
    success: "success",
    conversationSnippet: "conversation_snippet",
    createdAt: { desc: vi.fn() },
  },
  users: {
    id: "id",
    displayName: "display_name",
    avatarUrl: "avatar_url",
  },
}));

import { db } from "../db/client.js";
import { logAction, listActions } from "./optio-action-service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logAction", () => {
  it("inserts an action and returns it", async () => {
    const mockAction = {
      id: "action-1",
      userId: "user-1",
      action: "retry_task",
      params: { id: "task-1" },
      result: { retried: true },
      success: true,
      conversationSnippet: "Please retry task-1",
      createdAt: new Date(),
    };
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockAction]),
      }),
    });

    const result = await logAction({
      userId: "user-1",
      action: "retry_task",
      params: { id: "task-1" },
      result: { retried: true },
      success: true,
      conversationSnippet: "Please retry task-1",
    });

    expect(result).toEqual(mockAction);
  });

  it("persists the caller's workspaceId", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "a" }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    (db.insert as any).mockReturnValue({ values: mockValues });

    await logAction({
      workspaceId: "ws-42",
      action: "task.create",
      params: { taskId: "t1" },
      success: true,
    });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.workspaceId).toBe("ws-42");
  });

  it("defaults workspaceId to null when omitted (operator/legacy)", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "a" }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    (db.insert as any).mockReturnValue({ values: mockValues });

    await logAction({ action: "task.create", params: { taskId: "t1" }, success: true });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.workspaceId).toBeNull();
  });

  it("keeps only allowlisted params and drops everything else", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "a" }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    (db.insert as any).mockReturnValue({ values: mockValues });

    await logAction({
      action: "connection.update",
      params: {
        connectionId: "c1", // allowlisted id — kept
        name: "prod-db", // allowlisted label — kept
        // Everything below is NOT allowlisted and must be dropped, not stored:
        config: { url: "postgres://user:hunter2@db/app" },
        apiToken: "secret-value-123",
        password: "pass123",
        headers: { authorization: "Bearer xyz" },
        arbitraryField: "from ...req.body spread",
      },
      success: true,
    });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.params).toEqual({ connectionId: "c1", name: "prod-db" });
    // Explicitly assert secret-bearing keys are absent (not merely redacted).
    expect(insertedValues.params).not.toHaveProperty("config");
    expect(insertedValues.params).not.toHaveProperty("apiToken");
    expect(insertedValues.params).not.toHaveProperty("password");
    expect(insertedValues.params).not.toHaveProperty("headers");
    expect(insertedValues.params).not.toHaveProperty("arbitraryField");
  });

  it("handles null params", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "a" }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    (db.insert as any).mockReturnValue({ values: mockValues });

    await logAction({
      action: "bulk_cancel_active",
      params: null,
      success: true,
    });

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.params).toBeNull();
  });
});

describe("listActions", () => {
  it("returns actions with user info and total count", async () => {
    const rows = [
      {
        id: "a1",
        userId: "u1",
        action: "retry_task",
        params: { id: "task-1" },
        result: { retried: true },
        success: true,
        conversationSnippet: "Retry that task",
        createdAt: new Date("2026-01-01"),
        userName: "Alice",
        userAvatar: "https://example.com/alice.png",
      },
    ];

    // Mock the two parallel queries: rows + count
    const mockOffset = vi.fn().mockResolvedValue(rows);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere1 = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere1 });
    const mockFrom1 = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });

    const mockWhere2 = vi.fn().mockResolvedValue([{ count: "1" }]);
    const mockFrom2 = vi.fn().mockReturnValue({ where: mockWhere2 });

    let selectCallCount = 0;
    (db.select as any).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount % 2 === 1) {
        return { from: mockFrom1 };
      }
      return { from: mockFrom2 };
    });

    const result = await listActions({ limit: 10, offset: 0 });

    expect(result.actions).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.actions[0].user).toEqual({
      id: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
  });

  it("returns undefined user when userId is null", async () => {
    const rows = [
      {
        id: "a1",
        userId: null,
        action: "bulk_cancel_active",
        params: {},
        result: { cancelled: 3 },
        success: true,
        conversationSnippet: null,
        createdAt: new Date("2026-01-01"),
        userName: null,
        userAvatar: null,
      },
    ];

    const mockOffset = vi.fn().mockResolvedValue(rows);
    const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere1 = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockLeftJoin = vi.fn().mockReturnValue({ where: mockWhere1 });
    const mockFrom1 = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin });

    const mockWhere2 = vi.fn().mockResolvedValue([{ count: "1" }]);
    const mockFrom2 = vi.fn().mockReturnValue({ where: mockWhere2 });

    let selectCallCount = 0;
    (db.select as any).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount % 2 === 1) {
        return { from: mockFrom1 };
      }
      return { from: mockFrom2 };
    });

    const result = await listActions();

    expect(result.actions[0].user).toBeUndefined();
  });
});
