import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

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

const mockValidateApiKey = vi.fn();
const mockGetUserRole = vi.fn(async () => "member" as string | null);
vi.mock("../services/workspace-service.js", () => ({
  getUserRole: (...args: unknown[]) => mockGetUserRole(...(args as [])),
}));
vi.mock("../services/api-key-service.js", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

import { authenticateWs, authenticateWsWithCredentials } from "./ws-auth.js";
import type { FastifyRequest } from "fastify";

function createMockSocket() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  };
}

function createMockRequest(
  opts: { cookie?: string; token?: string; protocol?: string; origin?: string } = {},
): FastifyRequest {
  const headers: Record<string, string | undefined> = {
    cookie: opts.cookie,
    origin: opts.origin,
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

  it("rejects a hostile browser origin before checking cookies or native credentials", async () => {
    const socket = createMockSocket();
    const result = await authenticateWs(
      socket,
      createMockRequest({ cookie: "optio_session=valid", origin: "https://attacker.example" }),
    );
    expect(result).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4403, "Origin not allowed");
    expect(mockValidateSession).not.toHaveBeenCalled();
  });

  it("rejects revoked workspace membership even with a valid session", async () => {
    mockValidateSession.mockResolvedValue({ id: "user", workspaceId: "removed-workspace" });
    mockGetUserRole.mockResolvedValueOnce(null);
    const socket = createMockSocket();
    expect(
      await authenticateWs(socket, createMockRequest({ cookie: "optio_session=valid" })),
    ).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4403, "Workspace membership required");
  });

  it("never grants legacy unscoped resources to a signed-in user without a workspace", async () => {
    mockValidateSession.mockResolvedValue({ id: "orphan", workspaceId: null });
    const socket = createMockSocket();
    expect(
      await authenticateWs(socket, createMockRequest({ cookie: "optio_session=valid" })),
    ).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4403, "Workspace membership required");
  });

  it("treats a malformed percent-encoded cookie as absent", async () => {
    const socket = createMockSocket();
    expect(
      await authenticateWs(socket, createMockRequest({ cookie: "optio_session=%" })),
    ).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(4401, "Authentication required");
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
      username: null,
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
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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

describe("authenticated WebSocket credential passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
  });
  it("keeps the native PAT that actually authenticated, ignoring an invalid cookie", async () => {
    const user = { id: "native-user", workspaceId: "workspace-a" };
    mockValidateSession.mockResolvedValue(null);
    mockValidateApiKey.mockResolvedValue(user);
    const req = createMockRequest({ cookie: "optio_session=expired", token: "optio_pat_native" });
    expect(await authenticateWsWithCredentials(createMockSocket(), req)).toEqual({
      user,
      token: "optio_pat_native",
    });
    expect(mockValidateApiKey).toHaveBeenCalledWith("optio_pat_native");
  });
  it("never forwards a consumed one-time upgrade token", async () => {
    const user = { id: "cross-origin-user", workspaceId: "workspace-a" };
    mockValidateWsToken.mockResolvedValue(user);
    const result = await authenticateWsWithCredentials(
      createMockSocket(),
      createMockRequest({ token: "one-time" }),
    );
    expect(result).toEqual({ user });
  });
  it("does not forward a different PAT when the cookie authenticated", async () => {
    const user = { id: "browser-user", workspaceId: "workspace-b" };
    mockValidateSession.mockResolvedValue(user);
    const result = await authenticateWsWithCredentials(
      createMockSocket(),
      createMockRequest({ cookie: "optio_session=valid", token: "optio_pat_other" }),
    );
    expect(result).toEqual({ user, token: "valid" });
    expect(mockValidateApiKey).not.toHaveBeenCalled();
  });
});

describe("cookie auth and the upgrade's Origin (CSWSH)", () => {
  const user = {
    id: "u",
    provider: "github",
    email: "a@b.c",
    displayName: "A",
    avatarUrl: null,
    workspaceId: "ws",
  };
  const saved = {
    public: process.env.PUBLIC_URL,
    api: process.env.PUBLIC_API_URL,
    allowed: process.env.OPTIO_ALLOWED_ORIGINS,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
    process.env.PUBLIC_URL = "https://optio.example.com";
    process.env.PUBLIC_API_URL = "https://api.example.com";
    process.env.OPTIO_ALLOWED_ORIGINS = "https://web.example.com";
    mockValidateSession.mockResolvedValue(user);
  });
  afterAll(() => {
    if (saved.public === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = saved.public;
    if (saved.api === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = saved.api;
    if (saved.allowed === undefined) delete process.env.OPTIO_ALLOWED_ORIGINS;
    else process.env.OPTIO_ALLOWED_ORIGINS = saved.allowed;
  });

  function req(origin: string | undefined, token?: string) {
    const r = createMockRequest({ cookie: "optio_session=abc123", token });
    const headers = r.headers as Record<string, string>;
    if (origin !== undefined) headers.origin = origin;
    headers.host = "api.example.com";
    return r;
  }

  it.each([
    ["no Origin (not a browser)", undefined],
    ["the configured API origin", "https://api.example.com"],
    ["PUBLIC_URL", "https://optio.example.com"],
    ["an allowed origin", "https://web.example.com"],
  ])("accepts the cookie from %s", async (_name, origin) => {
    const socket = createMockSocket();
    expect(await authenticateWs(socket as any, req(origin))).toEqual(user);
    expect(mockValidateSession).toHaveBeenCalledWith("abc123");
  });

  it.each([
    ["another site", "https://evil.example.net"],
    ["a sibling subdomain", "https://evil.example.com"],
    ["an opaque Origin", "null"],
  ])("ignores the cookie from %s", async (_name, origin) => {
    const socket = createMockSocket();
    expect(await authenticateWs(socket as any, req(origin))).toBeNull();
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4403, "Origin not allowed");
  });

  it("rejects a hostile Origin even with a protocol token", async () => {
    mockValidateWsToken.mockResolvedValue(user);
    const socket = createMockSocket();
    expect(await authenticateWs(socket as any, req("https://evil.example.net", "t"))).toBeNull();
    expect(mockValidateWsToken).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(4403, "Origin not allowed");
    expect(mockValidateSession).not.toHaveBeenCalled();
  });
});
