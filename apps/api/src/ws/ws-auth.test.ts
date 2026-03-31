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

  it("validates query param token via validateWsToken (single-use)", async () => {
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
    // Should NOT call validateSession for query param tokens (no cookie present)
    expect(mockValidateSession).not.toHaveBeenCalled();
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
    // Upgrade token should not be checked when cookie succeeds
    expect(mockValidateWsToken).not.toHaveBeenCalled();
  });

  it("falls back to upgrade token when cookie is invalid", async () => {
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

  it("closes socket when both cookie and upgrade token are invalid", async () => {
    mockValidateSession.mockResolvedValue(null);
    mockValidateWsToken.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ cookie: "optio_session=bad", token: "also-bad" });

    const user = await authenticateWs(socket as any, req);

    expect(user).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Invalid or expired session");
  });

  it("closes socket when upgrade token alone is invalid", async () => {
    mockValidateWsToken.mockResolvedValue(null);
    const socket = createMockSocket();
    const req = createMockRequest({ token: "consumed-token" });

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

  it("does NOT extract token from query param (security fix)", () => {
    const req = createMockRequest({ token: "query-token" });
    expect(extractSessionToken(req)).toBeUndefined();
  });

  it("returns cookie token even when query param is present", () => {
    const req = createMockRequest({ cookie: "optio_session=cookie-token", token: "query-token" });
    expect(extractSessionToken(req)).toBe("cookie-token");
  });

  it("returns undefined when no token is present", () => {
    const req = createMockRequest();
    expect(extractSessionToken(req)).toBeUndefined();
  });
});
