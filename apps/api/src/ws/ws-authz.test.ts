import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks shared by the handler-level tests ──────────────────────────────────

const mockAuthenticateWs = vi.fn();
vi.mock("./ws-auth.js", () => ({
  authenticateWs: (...a: unknown[]) => mockAuthenticateWs(...a),
}));

const mockGetWorkflowRun = vi.fn();
const mockGetWorkflow = vi.fn();
const mockGetWorkflowRunLogs = vi.fn();
vi.mock("../services/workflow-service.js", () => ({
  getWorkflowRun: (...a: unknown[]) => mockGetWorkflowRun(...a),
  getWorkflow: (...a: unknown[]) => mockGetWorkflow(...a),
  getWorkflowRunLogs: (...a: unknown[]) => mockGetWorkflowRunLogs(...a),
}));

const mockGetPersistentAgent = vi.fn();
const mockListTurns = vi.fn();
const mockListTurnLogs = vi.fn();
vi.mock("../services/persistent-agent-service.js", () => ({
  getPersistentAgentUnscoped: (...a: unknown[]) => mockGetPersistentAgent(...a),
  listPersistentAgentTurns: (...a: unknown[]) => mockListTurns(...a),
  listTurnLogs: (...a: unknown[]) => mockListTurnLogs(...a),
}));

const mockCreateSubscriber = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  createSubscriber: (...a: unknown[]) => mockCreateSubscriber(...a),
}));

// ws-limits: always admit the connection; track release calls.
const mockReleaseConnection = vi.fn();
vi.mock("./ws-limits.js", () => ({
  getClientIp: () => "1.2.3.4",
  trackConnection: () => true,
  releaseConnection: (...a: unknown[]) => mockReleaseConnection(...a),
  WS_CLOSE_CONNECTION_LIMIT: 4408,
}));

let authDisabled = false;
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => authDisabled,
}));

const mockGetUserRole = vi.fn();
vi.mock("../services/workspace-service.js", () => ({
  getUserRole: (...a: unknown[]) => mockGetUserRole(...a),
}));

import { assertWorkspace, requireWsRole, WS_CLOSE_FORBIDDEN } from "./ws-authz.js";
import { workflowRunLogStreamWs } from "./workflow-run-log-stream.js";
import { persistentAgentStreamWs } from "./persistent-agent-stream.js";

function mockSocket() {
  return { close: vi.fn(), send: vi.fn(), on: vi.fn() };
}

function fakeSubscriber() {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}

/** Register a websocket handler against a fake app and hand back the closure. */
async function captureHandler(
  register: (app: unknown) => Promise<unknown>,
): Promise<(socket: unknown, req: unknown) => Promise<void>> {
  let handler!: (socket: unknown, req: unknown) => Promise<void>;
  const fakeApp = {
    get: (_path: string, _opts: unknown, h: (socket: unknown, req: unknown) => Promise<void>) => {
      handler = h;
    },
  };
  await register(fakeApp);
  return handler;
}

describe("assertWorkspace", () => {
  it("passes when workspaces match", () => {
    const socket = mockSocket();
    expect(assertWorkspace(socket, "ws-A", "ws-A")).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("passes when both are null (auth-disabled dev + null-workspace resource)", () => {
    const socket = mockSocket();
    expect(assertWorkspace(socket, null, null)).toBe(true);
    // undefined is normalized to null as well
    expect(assertWorkspace(socket, undefined, null)).toBe(true);
    expect(assertWorkspace(socket, null, undefined)).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes 4403 when the caller is in a different workspace than the resource", () => {
    const socket = mockSocket();
    expect(assertWorkspace(socket, "ws-A", "ws-B")).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_FORBIDDEN, "Access denied");
  });

  it("closes 4403 for a scoped caller against a legacy null-workspace resource", () => {
    const socket = mockSocket();
    expect(assertWorkspace(socket, "ws-A", null)).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(4403, "Access denied");
  });
});

describe("requireWsRole", () => {
  const user = { id: "user-1", workspaceId: "ws-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
  });

  it("passes for a member when 'member' is required", async () => {
    mockGetUserRole.mockResolvedValue("member");
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "member")).toBe(true);
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-1", "user-1");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("passes for an admin when 'member' is required", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "member")).toBe(true);
  });

  it("closes 4403 for a viewer when 'member' is required", async () => {
    mockGetUserRole.mockResolvedValue("viewer");
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "member")).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_FORBIDDEN, "Requires member role");
  });

  it("closes 4403 for a member when 'admin' is required", async () => {
    mockGetUserRole.mockResolvedValue("member");
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "admin")).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_FORBIDDEN, "Requires admin role");
  });

  it("prefers the resource workspace over the user's active workspace", async () => {
    mockGetUserRole.mockResolvedValue("member");
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "member", "ws-resource")).toBe(true);
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-resource", "user-1");
  });

  it("denies when no workspace can be resolved", async () => {
    const socket = mockSocket();
    expect(await requireWsRole(socket, { id: "user-1", workspaceId: null }, "member")).toBe(false);
    expect(mockGetUserRole).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_FORBIDDEN, "Requires member role");
  });

  it("denies a non-member (no role in workspace)", async () => {
    mockGetUserRole.mockResolvedValue(null);
    const socket = mockSocket();
    expect(await requireWsRole(socket, user, "member")).toBe(false);
  });

  it("always passes when auth is disabled", async () => {
    authDisabled = true;
    const socket = mockSocket();
    expect(await requireWsRole(socket, { id: "local", workspaceId: null }, "member")).toBe(true);
    expect(mockGetUserRole).not.toHaveBeenCalled();
  });
});

describe("workflow-run log stream: workspace enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSubscriber.mockReturnValue(fakeSubscriber());
    mockGetWorkflowRunLogs.mockResolvedValue([]);
  });

  it("closes 4403 and never subscribes when the run belongs to another workspace", async () => {
    mockAuthenticateWs.mockResolvedValue({ id: "u", workspaceId: "ws-A" });
    mockGetWorkflowRun.mockResolvedValue({ id: "run-1", workflowId: "wf-1" });
    mockGetWorkflow.mockResolvedValue({ id: "wf-1", workspaceId: "ws-B" });

    const handler = await captureHandler(workflowRunLogStreamWs as never);
    const socket = mockSocket();
    await handler(socket, { headers: {}, params: { workflowRunId: "run-1" } });

    expect(socket.close).toHaveBeenCalledWith(4403, "Access denied");
    expect(mockCreateSubscriber).not.toHaveBeenCalled();
    expect(mockReleaseConnection).toHaveBeenCalled();
  });

  it("streams when the run is in the caller's workspace", async () => {
    mockAuthenticateWs.mockResolvedValue({ id: "u", workspaceId: "ws-A" });
    mockGetWorkflowRun.mockResolvedValue({ id: "run-1", workflowId: "wf-1" });
    mockGetWorkflow.mockResolvedValue({ id: "wf-1", workspaceId: "ws-A" });

    const handler = await captureHandler(workflowRunLogStreamWs as never);
    const socket = mockSocket();
    await handler(socket, { headers: {}, params: { workflowRunId: "run-1" } });

    expect(socket.close).not.toHaveBeenCalledWith(4403, "Access denied");
    expect(mockCreateSubscriber).toHaveBeenCalled();
  });
});

describe("persistent-agent event stream: workspace enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSubscriber.mockReturnValue(fakeSubscriber());
    mockListTurns.mockResolvedValue([]);
    mockListTurnLogs.mockResolvedValue([]);
  });

  it("closes 4403 and never subscribes for a cross-workspace agent", async () => {
    mockAuthenticateWs.mockResolvedValue({ id: "u", workspaceId: "ws-A" });
    mockGetPersistentAgent.mockResolvedValue({ id: "ag-1", slug: "bot", workspaceId: "ws-B" });

    const handler = await captureHandler(persistentAgentStreamWs as never);
    const socket = mockSocket();
    await handler(socket, { headers: {}, params: { agentId: "ag-1" } });

    expect(socket.close).toHaveBeenCalledWith(4403, "Access denied");
    expect(mockCreateSubscriber).not.toHaveBeenCalled();
    expect(mockReleaseConnection).toHaveBeenCalled();
  });
});
