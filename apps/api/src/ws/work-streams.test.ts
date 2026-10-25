import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuthenticateWs = vi.fn();
vi.mock("./ws-auth.js", () => ({
  authenticateWs: (...a: unknown[]) => mockAuthenticateWs(...a),
}));

const mockWsActor = vi.fn();
vi.mock("./ws-actor.js", () => ({ wsActor: (...a: unknown[]) => mockWsActor(...a) }));

const mockGetWorkflow = vi.fn();
const mockGetWorkflowRun = vi.fn();
const mockGetWorkflowRunLogs = vi.fn();
vi.mock("../services/workflow-service.js", () => ({
  getWorkflow: (...a: unknown[]) => mockGetWorkflow(...a),
  getWorkflowRun: (...a: unknown[]) => mockGetWorkflowRun(...a),
  getWorkflowRunLogs: (...a: unknown[]) => mockGetWorkflowRunLogs(...a),
}));

const mockGetAgent = vi.fn();
const mockListTurns = vi.fn();
const mockListTurnLogs = vi.fn();
vi.mock("../services/persistent-agent-service.js", () => ({
  getPersistentAgentUnscoped: (...a: unknown[]) => mockGetAgent(...a),
  listPersistentAgentTurns: (...a: unknown[]) => mockListTurns(...a),
  listTurnLogs: (...a: unknown[]) => mockListTurnLogs(...a),
}));

const mockSubscribe = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  createSubscriber: () => ({
    subscribe: mockSubscribe,
    psubscribe: mockSubscribe,
    unsubscribe: vi.fn(),
    punsubscribe: vi.fn(),
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

import { workflowRunLogStreamWs } from "./workflow-run-log-stream.js";
import { persistentAgentStreamWs } from "./persistent-agent-stream.js";

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

async function connect(
  register: (app: never) => Promise<void> | void,
  params: Record<string, string>,
) {
  let handler!: (socket: unknown, req: unknown) => Promise<void>;
  await register({
    get: (_p: string, _o: unknown, h: typeof handler) => {
      handler = h;
    },
  } as never);
  const socket = mockSocket();
  await handler(socket, { headers: {}, ip: "1.2.3.4", params });
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateWs.mockResolvedValue({ id: "user-2", workspaceId: "ws-1", workspaceRole: null });
  mockWsActor.mockResolvedValue(member);
  mockGetWorkflowRun.mockResolvedValue({ id: "run-1", workflowId: "wf-1" });
  mockGetWorkflowRunLogs.mockResolvedValue([{ id: "l1", content: "secret" }]);
  mockListTurns.mockResolvedValue([{ id: "turn-1" }]);
  mockListTurnLogs.mockResolvedValue([{ id: "l1", content: "secret" }]);
});

describe("/ws/workflow-runs/:id/logs — who sees a Job run's output", () => {
  const open = () => connect(workflowRunLogStreamWs, { workflowRunId: "run-1" });

  it("closes 4404 on someone else's private Job, sending nothing", async () => {
    mockGetWorkflow.mockResolvedValue({ id: "wf-1", workspaceId: "ws-1", ownerUserId: "user-1" });
    const socket = await open();
    expect(socket.close).toHaveBeenCalledWith(4404, "Workflow run not found");
    expect(socket.send).not.toHaveBeenCalled();
    expect(mockGetWorkflowRunLogs).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("streams a team's Job to its member", async () => {
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: "team-1",
    });
    const socket = await open();
    expect(socket.close).not.toHaveBeenCalled();
    expect(mockGetWorkflowRunLogs).toHaveBeenCalled();
  });
});

describe("/ws/persistent-agents/:agentId/events — who sees an agent's turns", () => {
  const open = () => connect(persistentAgentStreamWs, { agentId: "agent-1" });

  it("closes 4404 on someone else's private agent, sending nothing", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", ownerUserId: "user-1" });
    const socket = await open();
    expect(socket.close).toHaveBeenCalledWith(4404, "Persistent agent not found");
    expect(socket.send).not.toHaveBeenCalled();
    expect(mockListTurnLogs).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("streams the organization's agent to a member", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", ownerUserId: null });
    const socket = await open();
    expect(socket.close).not.toHaveBeenCalled();
    expect(mockListTurnLogs).toHaveBeenCalled();
  });
});
