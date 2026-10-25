import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuthenticateWs = vi.fn();
vi.mock("./ws-auth.js", () => ({
  authenticateWs: (...a: unknown[]) => mockAuthenticateWs(...a),
}));

const mockGetTask = vi.fn();
const mockGetTaskLogs = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...a: unknown[]) => mockGetTask(...a),
  getTaskLogs: (...a: unknown[]) => mockGetTaskLogs(...a),
}));

const mockWsActor = vi.fn();
vi.mock("./ws-actor.js", () => ({ wsActor: (...a: unknown[]) => mockWsActor(...a) }));

const mockSubscribe = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  createSubscriber: () => ({
    subscribe: mockSubscribe,
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
  }),
}));

vi.mock("./ws-limits.js", () => ({
  getClientIp: () => "1.2.3.4",
  trackConnection: () => true,
  releaseConnection: vi.fn(),
  WS_CLOSE_CONNECTION_LIMIT: 4408,
}));

vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

import { logStreamWs } from "./log-stream.js";

function mockSocket() {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(() => {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      socket.emit("close");
    }),
  });
  return socket;
}

async function connect() {
  let handler!: (socket: unknown, req: unknown) => Promise<void>;
  await logStreamWs({
    get: (_p: string, _o: unknown, h: typeof handler) => {
      handler = h;
    },
  } as never);
  const socket = mockSocket();
  await handler(socket, { headers: {}, ip: "1.2.3.4", params: { taskId: "task-1" } });
  return socket;
}

const member = {
  userId: "user-2",
  workspaceId: "ws-1",
  isAdmin: false,
  teamIds: ["team-1"],
  adminTeamIds: [],
  workVisibility: "organization" as const,
};

describe("/ws/logs/:taskId — who sees a task's output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateWs.mockResolvedValue({
      id: "user-2",
      workspaceId: "ws-1",
      workspaceRole: null,
    });
    mockWsActor.mockResolvedValue(member);
    mockGetTaskLogs.mockResolvedValue([
      { id: "l1", content: "secret", stream: "stdout", timestamp: new Date() },
    ]);
  });

  it("closes 4404 on someone else's private task, sending nothing", async () => {
    mockGetTask.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", ownerUserId: "user-1" });
    const socket = await connect();
    expect(socket.close).toHaveBeenCalledWith(4404, "Task not found");
    expect(socket.send).not.toHaveBeenCalled();
    expect(mockGetTaskLogs).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("streams a team's task to its member", async () => {
    mockGetTask.mockResolvedValue({
      id: "task-1",
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: "team-1",
    });
    const socket = await connect();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith("optio:task:task-1");
  });
});
