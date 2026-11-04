import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  taskMessages: {
    id: "id",
    taskId: "task_id",
    userId: "user_id",
    content: "content",
    mode: "mode",
    workspaceId: "workspace_id",
    createdAt: "created_at",
    deliveredAt: "delivered_at",
    ackedAt: "acked_at",
    deliveryError: "delivery_error",
  },
  tasks: {
    id: "id",
    lastMessageAt: "last_message_at",
    updatedAt: "updated_at",
  },
  users: {
    id: "id",
    displayName: "display_name",
    avatarUrl: "avatar_url",
  },
  workspaceMembers: {
    workspaceId: "workspace_id",
    userId: "user_id",
    role: "role",
  },
}));

vi.mock("./event-bus.js", () => ({ publishEvent: vi.fn() }));

const mockGetUserRole = vi.fn();
vi.mock("./workspace-service.js", () => ({
  getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
}));

import { db } from "../db/client.js";
import {
  sendMessage,
  listMessages,
  markDelivered,
  markAcked,
  markDeliveryError,
  canMessageTask,
} from "./task-message-service.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendMessage", () => {
  it("inserts a message and updates tasks.lastMessageAt", async () => {
    const mockMessage = {
      id: "msg-1",
      taskId: "task-1",
      content: "use Postgres",
      mode: "soft",
      userId: "user-1",
      workspaceId: "ws-1",
      createdAt: new Date(),
      deliveredAt: null,
      ackedAt: null,
      deliveryError: null,
    };
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockMessage]),
      }),
    });
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await sendMessage({
      taskId: "task-1",
      content: "use Postgres",
      mode: "soft",
      userId: "user-1",
      workspaceId: "ws-1",
    });

    expect(result).toEqual(mockMessage);
    expect(db.insert).toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});

describe("listMessages", () => {
  it("returns messages with user info", async () => {
    const rows = [
      {
        id: "m1",
        taskId: "t1",
        userId: "u1",
        content: "hello agent",
        mode: "soft",
        workspaceId: "ws1",
        createdAt: new Date("2026-01-01"),
        deliveredAt: new Date("2026-01-01"),
        ackedAt: null,
        deliveryError: null,
        userName: "Alice",
        userAvatar: "https://example.com/avatar.png",
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listMessages("t1");

    expect(result).toHaveLength(1);
    expect(result[0].user).toEqual({
      id: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(result[0].content).toBe("hello agent");
    expect(result[0].mode).toBe("soft");
  });

  it("returns undefined user when userId is null", async () => {
    const rows = [
      {
        id: "m1",
        taskId: "t1",
        userId: null,
        content: "system message",
        mode: "soft",
        workspaceId: null,
        createdAt: new Date("2026-01-01"),
        deliveredAt: null,
        ackedAt: null,
        deliveryError: null,
        userName: null,
        userAvatar: null,
      },
    ];
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    });

    const result = await listMessages("t1");
    expect(result[0].user).toBeUndefined();
  });
});

describe("markDelivered", () => {
  it("updates deliveredAt timestamp", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markDelivered("msg-1");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("markAcked", () => {
  it("updates ackedAt timestamp", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markAcked("msg-1");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("markDeliveryError", () => {
  it("sets delivery error on message", async () => {
    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    await markDeliveryError("msg-1", "session ended");
    expect(db.update).toHaveBeenCalled();
  });
});

describe("canMessageTask", () => {
  it("allows task creator to message", async () => {
    const result = await canMessageTask("user-1", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(true);
  });

  it("allows workspace admin to message any task", async () => {
    mockGetUserRole.mockResolvedValue("admin");

    const result = await canMessageTask("user-2", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(true);
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-1", "user-2");
  });

  it("denies non-creator non-admin member", async () => {
    mockGetUserRole.mockResolvedValue("member");

    const result = await canMessageTask("user-3", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });

  it("denies when no workspace membership", async () => {
    mockGetUserRole.mockResolvedValue(null);

    const result = await canMessageTask("user-3", {
      createdBy: "user-1",
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });

  it("denies when task has no creator and user is not admin", async () => {
    mockGetUserRole.mockResolvedValue("viewer");

    const result = await canMessageTask("user-3", {
      createdBy: null,
      workspaceId: "ws-1",
    });
    expect(result).toBe(false);
  });
});
