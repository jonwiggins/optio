import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock session service
const mockValidateSession = vi.fn();
vi.mock("../services/session-service.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));

// Mock oauth index for isAuthDisabled
let authDisabled = false;
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => authDisabled,
}));

import { authenticateWs, extractSessionToken } from "./ws-auth.js";
import type { FastifyRequest } from "fastify";

function createMockSocket() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  };
}

function createMockRequest(opts: { cookie?: string; token?: string } = {}): FastifyRequest {
  return {
    headers: {
      cookie: opts.cookie,
    },
    query: opts.token ? { token: opts.token } : {},
  } as unknown as FastifyRequest;
}

describe("authenticateWs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
  });

  it("returns synthetic user when auth is disabled", async () => {
    authDisabled = true;
    const socket = createMockSocket();
    const req = createMockRequest();

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual({
      id: "local",
      provider: "local",
      email: "dev@localhost",
      displayName: "Local Dev",
      avatarUrl: null,
      workspaceId: null,
      workspaceRole: null,
    });
    expect(socket.close).not.toHaveBeenCalled();
    expect(mockValidateSession).not.toHaveBeenCalled();
  });

  it("closes socket with 4401 when no token is provided", async () => {
    const socket = createMockSocket();
    const req = createMockRequest();

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Authentication required");
  });

  it("validates session from cookie", async () => {
    const mockUser = {
      id: "user-1",
      provider: "github",
      email: "test@example.com",
      displayName: "Test User",
      avatarUrl: null,
    };
    mockValidateSession.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=abc123" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual(mockUser);
    expect(mockValidateSession).toHaveBeenCalledWith("abc123");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("validates session from query param token", async () => {
    const mockUser = {
      id: "user-2",
      provider: "google",
      email: "user@example.com",
      displayName: "Query User",
      avatarUrl: null,
    };
    mockValidateSession.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ token: "token456" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual(mockUser);
    expect(mockValidateSession).toHaveBeenCalledWith("token456");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("prefers cookie over query param", async () => {
    const mockUser = {
      id: "user-3",
      provider: "github",
      email: "cookie@example.com",
      displayName: "Cookie User",
      avatarUrl: null,
    };
    mockValidateSession.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=fromcookie", token: "fromquery" });

    await authenticateWs(socket as any, req);

    expect(mockValidateSession).toHaveBeenCalledWith("fromcookie");
  });

  it("closes socket with 4401 when session is invalid", async () => {
    mockValidateSession.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=expired-token" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Invalid or expired session");
  });
});

describe("extractSessionToken", () => {
  beforeEach(() => {
    authDisabled = false;
  });

  it("returns undefined when auth is disabled", () => {
    authDisabled = true;
    const req = createMockRequest({ cookie: "optio_session=abc123" });
    expect(extractSessionToken(req)).toBeUndefined();
  });

  it("extracts token from cookie", () => {
    const req = createMockRequest({ cookie: "optio_session=my-token" });
    expect(extractSessionToken(req)).toBe("my-token");
  });

  it("extracts token from query param", () => {
    const req = createMockRequest({ token: "query-token" });
    expect(extractSessionToken(req)).toBe("query-token");
  });

  it("prefers cookie over query param", () => {
    const req = createMockRequest({ cookie: "optio_session=cookie-token", token: "query-token" });
    expect(extractSessionToken(req)).toBe("cookie-token");
  });

  it("returns undefined when no token is present", () => {
    const req = createMockRequest();
    expect(extractSessionToken(req)).toBeUndefined();
  });
});
