import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests that session-chat and session-terminal WebSocket handlers
 * call authenticateWs() and verify session ownership.
 *
 * We import the handler modules and verify that:
 * 1. authenticateWs is called and unauthenticated connections are rejected
 * 2. Session ownership is checked (session.userId vs authenticated user.id)
 * 3. Non-owners are closed with code 4403
 */

// ─── Mocks ──────────────────────────────────────────────────────────

const mockAuthenticateWs = vi.fn();
const mockExtractSessionToken = vi.fn();
vi.mock("./ws-auth.js", () => ({
  authenticateWs: (...args: unknown[]) => mockAuthenticateWs(...args),
  extractSessionToken: (...args: unknown[]) => mockExtractSessionToken(...args),
}));

const mockGetSession = vi.fn();
const mockAddSessionPr = vi.fn();
vi.mock("../services/interactive-session-service.js", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  addSessionPr: (...args: unknown[]) => mockAddSessionPr(...args),
}));

vi.mock("../services/container-service.js", () => ({
  getRuntime: () => ({}),
}));

vi.mock("../services/optio-settings-service.js", () => ({
  getSettings: () =>
    Promise.resolve({
      model: "sonnet",
      maxTurns: 50,
      confirmWrites: true,
      enabledTools: [],
      systemPrompt: "",
    }),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  repoPods: {},
  repos: {},
  interactiveSessions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../services/agent-event-parser.js", () => ({
  parseClaudeEvent: () => ({ entries: [] }),
}));

vi.mock("../services/event-bus.js", () => ({
  publishSessionEvent: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────

function createMockSocket() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    readyState: 1,
  };
}

function createMockReq(sessionId: string) {
  return {
    params: { sessionId },
    headers: {},
    query: {},
    user: { workspaceId: null },
  } as any;
}

/**
 * Helper to register and invoke a WS handler.
 * Captures the route handler registered via app.get() and calls it.
 */
async function invokeHandler(registerFn: (app: any) => Promise<void>, socket: any, req: any) {
  const handlers: Array<(socket: any, req: any) => Promise<void>> = [];
  const mockApp = {
    get: (_path: string, _opts: any, fn: (socket: any, req: any) => Promise<void>) => {
      handlers.push(fn);
    },
  };
  await registerFn(mockApp);
  if (handlers.length === 0) throw new Error("Handler not registered");
  await handlers[0](socket, req);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("session-chat WS authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated connections", async () => {
    const { sessionChatWs } = await import("./session-chat.js");
    mockAuthenticateWs.mockResolvedValue(null);

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionChatWs, socket, req);

    expect(mockAuthenticateWs).toHaveBeenCalledWith(socket, req);
    // Should not proceed to getSession
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("closes with 4403 when user does not own the session", async () => {
    const { sessionChatWs } = await import("./session-chat.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockExtractSessionToken.mockReturnValue(undefined);
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: "user-B",
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionChatWs, socket, req);

    expect(socket.close).toHaveBeenCalledWith(4403, "Not authorized for this session");
  });

  it("allows access when user owns the session", async () => {
    const { sessionChatWs } = await import("./session-chat.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockExtractSessionToken.mockReturnValue(undefined);
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: "user-A",
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionChatWs, socket, req);

    // Should NOT close with 4403
    expect(socket.close).not.toHaveBeenCalledWith(4403, expect.any(String));
  });

  it("allows access when session has no userId (legacy sessions)", async () => {
    const { sessionChatWs } = await import("./session-chat.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockExtractSessionToken.mockReturnValue(undefined);
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: null,
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionChatWs, socket, req);

    // Should NOT close with 4403
    expect(socket.close).not.toHaveBeenCalledWith(4403, expect.any(String));
  });
});

describe("session-terminal WS authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated connections", async () => {
    const { sessionTerminalWs } = await import("./session-terminal.js");
    mockAuthenticateWs.mockResolvedValue(null);

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionTerminalWs, socket, req);

    expect(mockAuthenticateWs).toHaveBeenCalledWith(socket, req);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("closes with 4403 when user does not own the session", async () => {
    const { sessionTerminalWs } = await import("./session-terminal.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: "user-B",
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionTerminalWs, socket, req);

    expect(socket.close).toHaveBeenCalledWith(4403, "Not authorized for this session");
  });

  it("allows access when user owns the session", async () => {
    const { sessionTerminalWs } = await import("./session-terminal.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: "user-A",
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionTerminalWs, socket, req);

    // Should NOT close with 4403
    expect(socket.close).not.toHaveBeenCalledWith(4403, expect.any(String));
  });

  it("allows access when session has no userId (legacy sessions)", async () => {
    const { sessionTerminalWs } = await import("./session-terminal.js");
    mockAuthenticateWs.mockResolvedValue({ id: "user-A", workspaceId: null });
    mockGetSession.mockResolvedValue({
      id: "session-1",
      userId: null,
      state: "active",
      podId: "pod-1",
      repoUrl: "https://github.com/test/repo",
    });

    const socket = createMockSocket();
    const req = createMockReq("session-1");

    await invokeHandler(sessionTerminalWs, socket, req);

    // Should NOT close with 4403
    expect(socket.close).not.toHaveBeenCalledWith(4403, expect.any(String));
  });
});
