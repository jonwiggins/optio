import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock session service
const mockValidateSession = vi.fn();
const mockValidateWsToken = vi.fn();
vi.mock("../services/session-service.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
  validateWsToken: (...args: unknown[]) => mockValidateWsToken(...args),
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

function createMockRequest(
  opts: { cookie?: string; token?: string; protocol?: string } = {},
): FastifyRequest {
  const headers: Record<string, string | undefined> = {
    cookie: opts.cookie,
  };
  // Token via Sec-WebSocket-Protocol header (new secure approach)
  if (opts.protocol) {
    headers["sec-websocket-protocol"] = opts.protocol;
  } else if (opts.token) {
    headers["sec-websocket-protocol"] = `optio-ws-v1, optio-auth-${opts.token}`;
  }
  return {
    headers,
    query: {},
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
    expect(mockValidateWsToken).not.toHaveBeenCalled();
  });

  it("closes socket with 4401 when no token is provided", async () => {
    const socket = createMockSocket();
    const req = createMockRequest();

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Authentication required");
  });

  it("validates session from cookie via validateSession", async () => {
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
    expect(mockValidateWsToken).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("validates upgrade token from Sec-WebSocket-Protocol header via validateWsToken", async () => {
    const mockUser = {
      id: "user-2",
      provider: "google",
      email: "user@example.com",
      displayName: "Query User",
      avatarUrl: null,
    };
    mockValidateWsToken.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ token: "upgrade-token-456" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual(mockUser);
    expect(mockValidateWsToken).toHaveBeenCalledWith("upgrade-token-456");
    // Should NOT call validateSession for protocol header tokens (no cookie present)
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("does NOT read token from query param (security: tokens must not be in URLs)", async () => {
    const socket = createMockSocket();
    // Simulate old-style query param token — should be ignored
    const req = {
      headers: {},
      query: { token: "leaked-token" },
    } as unknown as FastifyRequest;

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(mockValidateWsToken).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4401, "Authentication required");
  });

  it("prefers cookie over protocol header token", async () => {
    const mockUser = {
      id: "user-3",
      provider: "github",
      email: "cookie@example.com",
      displayName: "Cookie User",
      avatarUrl: null,
    };
    mockValidateSession.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=fromcookie", token: "fromprotocol" });

    await authenticateWs(socket as any, req);

    expect(mockValidateSession).toHaveBeenCalledWith("fromcookie");
    // Upgrade token should not be checked when cookie succeeds
    expect(mockValidateWsToken).not.toHaveBeenCalled();
  });

  it("falls back to protocol header token when cookie is invalid", async () => {
    const mockUser = {
      id: "user-4",
      provider: "github",
      email: "fallback@example.com",
      displayName: "Fallback User",
      avatarUrl: null,
    };
    mockValidateSession.mockResolvedValue(null); // cookie invalid
    mockValidateWsToken.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=bad-cookie", token: "good-upgrade" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual(mockUser);
    expect(mockValidateSession).toHaveBeenCalledWith("bad-cookie");
    expect(mockValidateWsToken).toHaveBeenCalledWith("good-upgrade");
  });

  it("closes socket with 4401 when session is invalid", async () => {
    mockValidateSession.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=expired-token" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Invalid or expired session");
  });

  it("closes socket when both cookie and protocol header token are invalid", async () => {
    mockValidateSession.mockResolvedValue(null);
    mockValidateWsToken.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=bad", token: "also-bad" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Invalid or expired session");
  });

  it("closes socket when protocol header token alone is invalid", async () => {
    mockValidateWsToken.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ token: "consumed-token" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Invalid or expired session");
  });

  it("extracts token from raw Sec-WebSocket-Protocol header with multiple protocols", async () => {
    const mockUser = {
      id: "user-5",
      provider: "github",
      email: "proto@example.com",
      displayName: "Proto User",
      avatarUrl: null,
    };
    mockValidateWsToken.mockResolvedValue(mockUser);
    const socket = createMockSocket();
    const req = createMockRequest({
      protocol: "optio-ws-v1, optio-auth-abc123hex",
    });

    const user = await authenticateWs(socket as any, req);

    expect(user).toEqual(mockUser);
    expect(mockValidateWsToken).toHaveBeenCalledWith("abc123hex");
  });

  it("ignores Sec-WebSocket-Protocol header without optio-auth- prefix", async () => {
    const socket = createMockSocket();
    const req = createMockRequest({
      protocol: "graphql-ws, some-other-protocol",
    });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(mockValidateWsToken).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4401, "Authentication required");
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

  it("does NOT extract token from protocol header (cookie only)", () => {
    const req = createMockRequest({ token: "protocol-token" });
    expect(extractSessionToken(req)).toBeUndefined();
  });

  it("returns cookie token even when protocol header is present", () => {
    const req = createMockRequest({
      cookie: "optio_session=cookie-token",
      token: "protocol-token",
    });
    expect(extractSessionToken(req)).toBe("cookie-token");
  });

  it("returns undefined when no token is present", () => {
    const req = createMockRequest();
    expect(extractSessionToken(req)).toBeUndefined();
  });
});
