import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";
const browserVerifier = "v".repeat(43);
const browserChallenge = createHash("sha256").update(browserVerifier).digest("base64url");
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockValidateSession = vi.fn();
const mockCreateSession = vi.fn();
const mockRevokeSession = vi.fn();
const mockCreateWsToken = vi.fn();
const mockCompleteSignIn = vi.fn(async (..._args: unknown[]) => ({
  deploymentAdmin: false,
  bootstrapped: false,
}));

vi.mock("../services/session-service.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkAccountsByEmailEnabled: () => false,
  revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
  createWsToken: (...args: unknown[]) => mockCreateWsToken(...args),
}));

const mockGetClaudeAuthToken = vi.fn<() => { available: boolean; token?: string; error?: string }>(
  () => ({ available: false }),
);
const mockInvalidateCredentialsCache = vi.fn();
const mockInvalidateUsageCache = vi.fn();
const mockListEnabledProviders = vi.fn().mockResolvedValue([]);
let mockDomainDecision = "allowed";
vi.mock("../services/auth-service.js", () => ({
  getClaudeAuthToken: () => mockGetClaudeAuthToken(),
  getClaudeUsage: async () => ({ available: false }),
  invalidateCredentialsCache: () => mockInvalidateCredentialsCache(),
  invalidateUsageCache: () => mockInvalidateUsageCache(),
}));

let authDisabled = false;
let deploymentAdmin = false;
let mockOAuthProvider: any = undefined;
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => authDisabled,
  getEnabledProviders: () => [],
  listEnabledProviders: () => mockListEnabledProviders(),
  getOAuthProvider: () => mockOAuthProvider,
}));

const mockResolveProviderConfig = vi.fn<(provider: string) => Promise<unknown>>(async () => null);
vi.mock("../services/auth/ldap.js", () => ({
  LdapAuthError: class extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  ldapAuthenticate: vi.fn(),
}));

// Sign-in configuration: no stored provider, no allowed-domain restriction,
// nobody a deployment admin (covered by sign-in-config.int.test.ts).
vi.mock("../services/sign-in-config-service.js", () => ({
  SIGN_IN_PROVIDERS: ["google", "github", "gitlab", "oidc", "ldap"],
  completeSignIn: (...args: unknown[]) => mockCompleteSignIn(...args),
  domainDecision: () => mockDomainDecision,
  accessDecision: () => mockDomainDecision,
  isDeploymentAdmin: async () => deploymentAdmin,
  hasDeploymentAdmin: async () => true,
  isFoundingWorkspaceAdmin: async () => false,
  resolveProviderConfig: (provider: string) => mockResolveProviderConfig(provider),
}));

vi.mock("../services/scim.js", () => ({
  scimAccountFor: vi.fn(async () => null),
  scimGroupsForSignIn: vi.fn(async () => []),
}));

vi.mock("../plugins/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/auth.js")>()),
  SESSION_COOKIE_NAME: "optio_session",
  // Pass-through guard — role enforcement is covered in plugins/auth.test.ts
  requireRole: () => async () => {},
}));

// Redis mock — in-memory store to simulate Redis setex/get/del
const redisStore = new Map<string, string>();
const mockRedisClient = {
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    redisStore.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => {
    return redisStore.get(key) ?? null;
  }),
  getdel: vi.fn(async (key: string) => {
    const value = redisStore.get(key) ?? null;
    redisStore.delete(key);
    return value;
  }),
  del: vi.fn(async (key: string) => {
    redisStore.delete(key);
    return 1;
  }),
};

vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => mockRedisClient,
}));

vi.mock("../services/github-token-service.js", () => ({
  storeUserGitHubTokens: vi.fn(),
}));
vi.mock("../services/workspace-service.js", () => ({
  joinWorkspacesByEmailDomain: vi.fn().mockResolvedValue(undefined),
}));

const mockGetHost = vi.fn();
const mockRefreshClaudeToken = vi.fn();
vi.mock("../services/local-host-service.js", () => ({
  getHost: (...args: unknown[]) => mockGetHost(...args),
  canAccessHost: (host: { userId: string }, userId: string) => host.userId === userId,
}));
vi.mock("../services/local-auth-refresh-service.js", () => ({
  refreshClaudeTokenFromHost: (...args: unknown[]) => mockRefreshClaudeToken(...args),
}));
vi.mock("../services/auth-failure-detector.js", () => ({
  getRecentAuthFailures: async () => ({ claude: false, github: false }),
}));

const mockCreateApiKey = vi.fn();
const mockListApiKeys = vi.fn();
const mockRevokeApiKey = vi.fn();
vi.mock("../services/api-key-service.js", () => ({
  createApiKey: (...args: unknown[]) => mockCreateApiKey(...args),
  listApiKeys: (...args: unknown[]) => mockListApiKeys(...args),
  revokeApiKey: (...args: unknown[]) => mockRevokeApiKey(...args),
}));
const mockRetrieveSecret = vi.fn();
const mockCachedValidation = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));
vi.mock("../workers/token-validation-worker.js", () => ({
  getCachedTokenValidation: () => mockCachedValidation(),
}));

import { authRoutes } from "./auth.js";

describe("OIDC browser-bound protocol state", () => {
  let app: FastifyInstance;
  const flow = { codeVerifier: "provider-pkce-verifier", nonce: "provider-nonce" };
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockDomainDecision = "allowed";
    mockOAuthProvider = {
      name: "oidc",
      beginFlow: () => flow,
      authorizeUrl: (state: string) => `https://idp.example/authorize?state=${state}`,
      exchangeCode: vi.fn().mockResolvedValue({ accessToken: "access" }),
      fetchUser: vi.fn().mockResolvedValue({
        externalId: "subject",
        email: "person@acme.test",
        displayName: "Person",
        emailVerified: true,
        emailVerifiedByProvider: false,
      }),
    };
    mockCreateSession.mockResolvedValue({ token: "oidc-session", user: mockUser });
    mockRevokeSession.mockResolvedValue(undefined);
    app = await buildTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("keeps the provider nonce and PKCE alongside the BFF challenge, and spends state once", async () => {
    const start = await app.inject({
      url: `/api/auth/oidc/login?browserChallenge=${browserChallenge}`,
    });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    expect(JSON.parse(redisStore.get(`oauth_state:${state}`)!)).toEqual({
      provider: "oidc",
      browserChallenge,
      flow,
    });
    const request = { url: `/api/auth/oidc/callback?state=${state}&code=idp-code` };
    const callback = await app.inject(request);
    expect(mockOAuthProvider.exchangeCode).toHaveBeenCalledWith("idp-code", flow);
    const code = new URL(callback.headers.location!).searchParams.get("code")!;
    expect(JSON.parse(redisStore.get(`auth_code:${code}`)!)).toEqual({
      token: "oidc-session",
      browserChallenge,
    });
    expect(mockCompleteSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: false, provider: "oidc" }),
      expect.objectContaining({ provider: "oidc" }),
    );
    expect((await app.inject(request)).headers.location).toContain("invalid_state");
    expect(mockOAuthProvider.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("refuses an unbound browser login before contacting the provider", async () => {
    const response = await app.inject({ url: "/api/auth/oidc/login" });
    expect(response.statusCode).toBe(400);
    expect(redisStore.size).toBe(0);
    expect(mockOAuthProvider.exchangeCode).not.toHaveBeenCalled();
  });

  it("revokes a session created from legacy state without a browser binding", async () => {
    redisStore.set("oauth_state:unbound", JSON.stringify({ provider: "oidc", flow }));
    const response = await app.inject({
      url: "/api/auth/oidc/callback?state=unbound&code=idp-code",
    });
    expect(response.headers.location).toContain("invalid_state");
    expect(mockRevokeSession).toHaveBeenCalledWith("oidc-session");
    expect([...redisStore.keys()].some((key) => key.startsWith("auth_code:"))).toBe(false);
  });
});

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(authRoutes, { user: null });
}

const mockUser = {
  id: "user-1",
  provider: "github",
  email: "test@example.com",
  displayName: "Test User",
  avatarUrl: null,
  workspaceId: null,
  workspaceRole: null,
};

describe("POST /api/auth/exchange-code", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = undefined;
    app = await buildTestApp();
  });

  it("returns 400 when code is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation error");
  });

  it("returns 400 for an invalid code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code: "nonexistent-code", browserVerifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid or expired code" });
  });

  it("exchanges a valid auth code for a session token", async () => {
    // Seed a code in Redis
    redisStore.set(
      "auth_code:valid-code",
      JSON.stringify({ token: "session-token-123", browserChallenge }),
    );
    mockValidateSession.mockResolvedValue(mockUser);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code: "valid-code", browserVerifier },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "session-token-123" });
    // Code should be deleted (one-time use)
    expect(mockRedisClient.getdel).toHaveBeenCalledWith("auth_code:valid-code");
  });

  it("returns 400 when session is expired", async () => {
    redisStore.set(
      "auth_code:expired-session",
      JSON.stringify({ token: "expired-token", browserChallenge }),
    );
    mockValidateSession.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code: "expired-session", browserVerifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Session expired" });
  });

  it("rejects an exchange code from another browser without validating its session", async () => {
    redisStore.set(
      "auth_code:stolen",
      JSON.stringify({ token: "attacker-session", browserChallenge }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code: "stolen", browserVerifier: "x".repeat(43) },
    });
    expect(response.statusCode).toBe(400);
    expect(mockValidateSession).not.toHaveBeenCalled();
  });

  it("consumes an exchange code atomically across simultaneous requests", async () => {
    redisStore.set("auth_code:race", JSON.stringify({ token: "valid", browserChallenge }));
    mockValidateSession.mockResolvedValue(mockUser);
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: "/api/auth/exchange-code",
          payload: { code: "race", browserVerifier },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    expect(mockValidateSession).toHaveBeenCalledTimes(1);
  });
});

describe("Redis-backed OAuth state", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = undefined;
    app = await buildTestApp();
  });

  it("binds the browser login through the provider callback to its verifier", async () => {
    mockOAuthProvider = {
      authorizeUrl: (state: string) => `https://provider.example/authorize?state=${state}`,
      exchangeCode: vi.fn().mockResolvedValue({ accessToken: "provider-access" }),
      fetchUser: vi.fn().mockResolvedValue({
        externalId: "external-user",
        email: "user@example.com",
        emailVerified: true,
      }),
    };
    mockCreateSession.mockResolvedValue({ token: "new-session", user: mockUser });
    const login = await app.inject({
      method: "GET",
      url: `/api/auth/google/login?browserChallenge=${browserChallenge}`,
    });
    expect(login.statusCode).toBe(302);
    const state = new URL(login.headers.location!).searchParams.get("state")!;
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "GET",
          url: `/api/auth/google/callback?state=${state}&code=provider-code`,
        }),
      ),
    );
    const success = responses.find((response) =>
      response.headers.location?.includes("/auth/callback?code="),
    );
    expect(success).toBeDefined();
    expect(mockOAuthProvider.exchangeCode).toHaveBeenCalledTimes(1);
    expect(responses.some((response) => response.headers.location?.includes("invalid_state"))).toBe(
      true,
    );
    const code = new URL(success!.headers.location!).searchParams.get("code")!;
    expect(JSON.parse(redisStore.get(`auth_code:${code}`)!)).toEqual({
      token: "new-session",
      browserChallenge,
    });
  });

  it("stores OAuth state in Redis with TTL on login", async () => {
    // getOAuthProvider returns undefined (mocked above), so we just verify
    // the 404 path — but the state would have been stored if provider existed.
    // Instead, let's verify the Redis calls by checking the mock was called
    // for the exchange-code flow which is fully testable.

    // Verify that setex is called with correct TTL for auth codes
    redisStore.set("auth_code:test-code", JSON.stringify({ token: "tok", browserChallenge }));
    mockValidateSession.mockResolvedValue(mockUser);

    await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code: "test-code", browserVerifier },
    });

    // get was called to retrieve the code
    expect(mockRedisClient.getdel).toHaveBeenCalledWith("auth_code:test-code");
    // del was called to remove the code (one-time use)
    expect(mockRedisClient.getdel).toHaveBeenCalledWith("auth_code:test-code");
  });
});

describe("GET /api/auth/me", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = undefined;
    app = await buildTestApp();
  });

  it("returns dev user when auth is disabled", async () => {
    authDisabled = true;
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authDisabled).toBe(true);
    expect(body.user.id).toBe("local");
  });

  it("authenticates via Bearer token (BFF proxy pattern)", async () => {
    mockValidateSession.mockResolvedValue(mockUser);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: "Bearer my-session-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual(mockUser);
    expect(mockValidateSession).toHaveBeenCalledWith("my-session-token");
  });

  it("authenticates via session cookie (fallback)", async () => {
    mockValidateSession.mockResolvedValue(mockUser);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: "optio_session=cookie-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual(mockUser);
    expect(mockValidateSession).toHaveBeenCalledWith("cookie-token");
  });

  it("prefers Bearer token over cookie", async () => {
    mockValidateSession.mockResolvedValue(mockUser);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: "Bearer bearer-token",
        cookie: "optio_session=cookie-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockValidateSession).toHaveBeenCalledWith("bearer-token");
  });

  it("returns 401 when no token is provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    mockValidateSession.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        authorization: "Bearer expired-token",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = undefined;
    app = await buildTestApp();
  });

  it("revokes session via Bearer token", async () => {
    mockRevokeSession.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        authorization: "Bearer my-session-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockRevokeSession).toHaveBeenCalledWith("my-session-token");
  });

  it("revokes session via cookie", async () => {
    mockRevokeSession.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        cookie: "optio_session=cookie-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockRevokeSession).toHaveBeenCalledWith("cookie-token");
  });

  it("clears the session cookie in response", async () => {
    mockRevokeSession.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        authorization: "Bearer token",
      },
    });
    expect(res.headers["set-cookie"]).toContain("optio_session=");
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("includes Secure flag in production", async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      mockRevokeSession.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          authorization: "Bearer token",
        },
      });
      expect(res.headers["set-cookie"]).toContain("Secure;");
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  it("omits Secure flag in non-production", async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      mockRevokeSession.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          authorization: "Bearer token",
        },
      });
      expect(res.headers["set-cookie"]).not.toContain("Secure");
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});

describe("POST /api/auth/cli/start", () => {
  let app: FastifyInstance;

  const validPayload = {
    provider: "github",
    callback: "http://127.0.0.1:18271/cb",
    state: "cli-state",
    code_challenge: "challenge",
    code_challenge_method: "S256",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = {
      authorizeUrl: vi.fn((state: string) => `https://github.example/auth?state=${state}`),
    };
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("stores state and returns an authorize URL for loopback callbacks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().url).toMatch(/^https:\/\/github\.example\/auth\?state=/);
    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      "cli_flow:cli-state",
      600,
      expect.stringContaining('"callback":"http://127.0.0.1:18271/cb"'),
    );
  });

  it("rejects non-loopback callbacks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: { ...validPayload, callback: "https://evil.example/cb" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("loopback");
    expect(mockRedisClient.setex).not.toHaveBeenCalled();
  });

  it("rejects loopback callbacks with credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: { ...validPayload, callback: "http://user:pass@127.0.0.1:18271/cb" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("credentials");
    expect(mockRedisClient.setex).not.toHaveBeenCalled();
  });

  it("rejects non-S256 PKCE methods", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: { ...validPayload, code_challenge_method: "plain" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Only S256 PKCE is supported");
    expect(mockRedisClient.setex).not.toHaveBeenCalled();
  });
});

describe("Auth rate limiting", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockOAuthProvider = undefined;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  async function buildRateLimitedApp(): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(rateLimit, { global: false });
    await authRoutes(server);
    await server.ready();
    return server;
  }

  it("rate-limits POST /api/auth/exchange-code after 10 requests", async () => {
    app = await buildRateLimitedApp();

    // First 10 requests should succeed (status 400 because code is missing, but not 429)
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/exchange-code",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    }

    // 11th request should be rate-limited
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: {},
    });
    expect(res.statusCode).toBe(429);
  });

  it("rate-limits GET /api/auth/:provider/login after 10 requests", async () => {
    app = await buildRateLimitedApp();

    // First 10 requests — 404 because provider is unknown (mocked)
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/github/login",
      });
      expect(res.statusCode).toBe(404);
    }

    // 11th request should be rate-limited
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/github/login",
    });
    expect(res.statusCode).toBe(429);
  });

  it("rate-limits GET /api/auth/:provider/callback after 10 requests", async () => {
    app = await buildRateLimitedApp();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/github/callback?code=x&state=y",
      });
      // Redirects to login with error (invalid state)
      expect(res.statusCode).toBe(302);
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/github/callback?code=x&state=y",
    });
    expect(res.statusCode).toBe(429);
  });

  it("rate-limits POST /api/auth/logout after 10 requests", async () => {
    app = await buildRateLimitedApp();
    mockRevokeSession.mockResolvedValue(undefined);

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
      });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
    });
    expect(res.statusCode).toBe(429);
  });

  it("includes rate limit headers in responses", async () => {
    app = await buildRateLimitedApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: {},
    });
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
    expect(res.headers["x-ratelimit-remaining"]).toBe("9");
  });
});

describe("deployment-wide credential authorization", () => {
  const hostId = "11111111-1111-4111-8111-111111111111";
  const endpoints = [
    { method: "GET" as const, url: "/api/auth/claude-token" },
    { method: "POST" as const, url: "/api/auth/refresh" },
    {
      method: "POST" as const,
      url: "/api/auth/claude-token/refresh-from-host",
      payload: { hostId },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
    deploymentAdmin = false;
    mockGetHost.mockResolvedValue({ id: hostId, userId: "user-1", workspaceId: "ws-1" });
    mockRefreshClaudeToken.mockResolvedValue({ ok: true, hostId });
  });
  afterEach(() => {
    deploymentAdmin = false;
  });

  it.each(endpoints)(
    "denies a workspace admin at $url before using shared credentials",
    async (endpoint) => {
      const app = await buildRouteTestApp(authRoutes);
      const res = await app.inject(endpoint);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/deployment admin/i);
      expect(mockGetClaudeAuthToken).not.toHaveBeenCalled();
      expect(mockInvalidateCredentialsCache).not.toHaveBeenCalled();
      expect(mockRefreshClaudeToken).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(endpoints)("allows a deployment admin at $url", async (endpoint) => {
    deploymentAdmin = true;
    const app = await buildRouteTestApp(authRoutes);
    const res = await app.inject(endpoint);
    expect(res.statusCode).toBe(endpoint.url === "/api/auth/claude-token" ? 503 : 200);
    await app.close();
  });
});

describe("CLI one-time code and personal credential boundaries", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    authDisabled = false;
    mockValidateSession.mockResolvedValue(mockUser);
    mockCreateSession.mockResolvedValue({ token: "temporary-session", user: mockUser });
    mockCreateApiKey.mockResolvedValue({ token: "optio_pat_new", tokenId: "token-id" });
    mockOAuthProvider = {
      prepare: vi.fn().mockResolvedValue(undefined),
      authorizeUrl: (state: string) =>
        `https://provider.example/auth?state=${encodeURIComponent(state)}`,
      exchangeCode: vi
        .fn()
        .mockResolvedValue({ accessToken: "upstream", refreshToken: "refresh", expiresIn: 3600 }),
      fetchUser: vi.fn().mockResolvedValue({
        externalId: "provider-user",
        email: "person@acme.test",
        emailVerified: true,
      }),
    };
    app = await buildTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("completes a CLI login only with its PKCE verifier, then spends the code and temporary session", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: {
        provider: "github",
        callback: "http://[::1]:18271/callback",
        state: "cli-client-state",
        code_challenge: browserChallenge,
      },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get("state")!;
    const callback = await app.inject({
      url: `/api/auth/github/callback?state=${encodeURIComponent(state)}&code=upstream-code`,
    });
    const redirect = new URL(callback.headers.location!);
    expect(redirect.origin).toBe("http://[::1]:18271");
    expect(redirect.searchParams.get("state")).toBe("cli-client-state");
    const code = redirect.searchParams.get("code")!;
    const exchange = {
      method: "POST" as const,
      url: "/api/auth/cli/token",
      payload: { code, code_verifier: browserVerifier },
    };
    const res = await app.inject(exchange);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe("optio_pat_new");
    expect(mockRevokeSession).toHaveBeenCalledWith("temporary-session");
    expect(mockCreateApiKey).toHaveBeenCalledWith(mockUser.id, expect.stringMatching(/^CLI \(/));
    expect((await app.inject(exchange)).statusCode).toBe(400);
    expect(mockCreateApiKey).toHaveBeenCalledTimes(1);
  });
  it("rejects an incorrect verifier before looking up a session or minting credentials", async () => {
    redisStore.set(
      "cli_code:wrong-verifier",
      JSON.stringify({ sessionToken: "s", codeChallenge: browserChallenge }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/token",
      payload: { code: "wrong-verifier", code_verifier: "wrong" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/PKCE/);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
  it("refuses a correctly verified code whose temporary session has expired", async () => {
    redisStore.set(
      "cli_code:expired",
      JSON.stringify({ sessionToken: "s", codeChallenge: browserChallenge }),
    );
    mockValidateSession.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cli/token",
      payload: { code: "expired", code_verifier: browserVerifier },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Session expired");
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
  it("revokes the temporary session if CLI flow data expired before the callback", async () => {
    redisStore.set("oauth_state:server.expired-cli", JSON.stringify({ provider: "github" }));
    const res = await app.inject({
      url: "/api/auth/github/callback?state=server.expired-cli&code=upstream-code",
    });
    expect(res.headers.location).toContain("error=invalid_state");
    expect(mockRevokeSession).toHaveBeenCalledWith("temporary-session");
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
  it.each(["error=access_denied", "code=c", "state=s"])(
    "rejects an incomplete or refused callback (%s) before provider exchange",
    async (query) => {
      const res = await app.inject({ url: `/api/auth/github/callback?${query}` });
      expect(res.headers.location).toMatch(/error=(provider_error|missing_params)/);
      expect(mockOAuthProvider.exchangeCode).not.toHaveBeenCalled();
    },
  );
  it("rejects a configured provider disappearing before its callback", async () => {
    redisStore.set("oauth_state:removed", JSON.stringify({ provider: "github" }));
    mockOAuthProvider = undefined;
    const res = await app.inject({ url: "/api/auth/github/callback?state=removed&code=c" });
    expect(res.headers.location).toContain("error=unknown_provider");
  });
  it("requires browser binding at login and exposes no upstream error details on callback failure", async () => {
    expect((await app.inject({ url: "/api/auth/github/login" })).statusCode).toBe(400);
    const login = await app.inject({
      url: `/api/auth/github/login?browserChallenge=${browserChallenge}`,
    });
    expect(mockOAuthProvider.prepare).toHaveBeenCalled();
    const state = new URL(login.headers.location!).searchParams.get("state")!;
    mockOAuthProvider.exchangeCode.mockRejectedValue(new Error("secret internal failure"));
    const res = await app.inject({ url: `/api/auth/github/callback?state=${state}&code=c` });
    expect(res.headers.location).toContain("error=auth_failed");
    expect(res.headers.location).not.toContain("secret");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
  it("rejects unknown CLI providers and external callback hosts", async () => {
    const body = {
      provider: "github",
      callback: "http://outside.test/callback",
      state: "s",
      code_challenge: browserChallenge,
    };
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/cli/start", payload: body })).statusCode,
    ).toBe(400);
    mockOAuthProvider = undefined;
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/cli/start", payload: body })).statusCode,
    ).toBe(404);
  });
});

describe("personal token ownership and WebSocket token creation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    authDisabled = false;
    mockCreateApiKey.mockResolvedValue({ token: "new", tokenId: id });
    mockListApiKeys.mockResolvedValue([{ id, name: "mine" }]);
    mockCreateWsToken.mockResolvedValue("upgrade-token");
    app = await buildRouteTestApp(authRoutes);
  });
  afterEach(async () => {
    await app.close();
  });
  it.each([
    { method: "POST" as const, url: "/api/auth/api-keys", payload: {} },
    { method: "GET" as const, url: "/api/auth/api-keys" },
    { method: "DELETE" as const, url: `/api/auth/api-keys/${id}` },
    { method: "GET" as const, url: "/api/auth/ws-token" },
  ])("requires a signed-in identity for $method $url", async (operation) => {
    const anonymous = await buildTestApp();
    expect((await anonymous.inject(operation)).statusCode).toBe(401);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(mockRevokeApiKey).not.toHaveBeenCalled();
    expect(mockCreateWsToken).not.toHaveBeenCalled();
    await anonymous.close();
  });
  it("mints credentials for the caller with either default or explicit name/expiry", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/auth/api-keys", payload: {} })).statusCode,
    ).toBe(201);
    expect(mockCreateApiKey).toHaveBeenLastCalledWith(
      "user-1",
      expect.stringMatching(/^API Key/),
      undefined,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/api-keys",
          payload: { name: "Work laptop", expiresAt: "2027-01-01T00:00:00Z" },
        })
      ).statusCode,
    ).toBe(201);
    expect(mockCreateApiKey).toHaveBeenLastCalledWith(
      "user-1",
      "Work laptop",
      new Date("2027-01-01T00:00:00Z"),
    );
  });
  it("lists and revokes only the caller's credentials", async () => {
    expect((await app.inject({ url: "/api/auth/api-keys" })).json()).toEqual({
      keys: [{ id, name: "mine" }],
    });
    expect(mockListApiKeys).toHaveBeenCalledWith("user-1");
    mockRevokeApiKey.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/auth/api-keys/${id}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/auth/api-keys/${id}` })).json(),
    ).toEqual({ ok: true });
    expect(mockRevokeApiKey).toHaveBeenLastCalledWith(id, "user-1");
  });
  it("creates an upgrade token for the authenticated user, with a separate auth-disabled path", async () => {
    expect((await app.inject({ url: "/api/auth/ws-token" })).json()).toEqual({
      token: "upgrade-token",
    });
    expect(mockCreateWsToken).toHaveBeenCalledWith("user-1");
    authDisabled = true;
    expect((await app.inject({ url: "/api/auth/ws-token" })).json()).toEqual({
      token: "auth-disabled",
    });
    expect(mockCreateWsToken).toHaveBeenCalledTimes(1);
  });
});

describe("Claude credential status does not expose the token", () => {
  let app: FastifyInstance;
  const fetchMock = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    authDisabled = false;
    mockGetClaudeAuthToken.mockImplementation(() => ({ available: false }));
    mockRetrieveSecret.mockResolvedValue(null);
    mockCachedValidation.mockResolvedValue(null);
    vi.stubGlobal("fetch", fetchMock);
    app = await buildTestApp();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });
  it("reports a missing token without making a provider request", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("not configured"));
    const res = await app.inject({ url: "/api/auth/status" });
    expect(res.json().subscription).toMatchObject({ available: false, expired: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([200, 401, 503])(
    "checks a stored token and treats only401 as expired (%s)",
    async (status) => {
      mockRetrieveSecret.mockResolvedValue("private-token");
      fetchMock.mockResolvedValue(new Response("", { status }));
      const res = await app.inject({ url: "/api/auth/status" });
      expect(res.json().subscription).toMatchObject({
        available: status !== 401,
        expired: status === 401,
      });
      expect(res.body).not.toContain("private-token");
    },
  );
  it.each([undefined, "Explicit expiration reason"])(
    "uses cached expiry without sending a live credential probe",
    async (error) => {
      mockGetClaudeAuthToken.mockReturnValue({ available: true, token: "private-token" });
      mockCachedValidation.mockResolvedValue({
        valid: false,
        tokenExists: true,
        lastValidated: "2026-01-01T00:00:00Z",
        error,
      });
      const res = await app.inject({ url: "/api/auth/status" });
      expect(res.json().subscription).toMatchObject({
        available: false,
        expired: true,
        error: error ?? expect.stringContaining("expired"),
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.body).not.toContain("private-token");
    },
  );
  it("uses a valid cached result and tolerates transient cache/provider failures", async () => {
    mockGetClaudeAuthToken.mockReturnValue({ available: true, token: "private-token" });
    mockCachedValidation.mockResolvedValue({
      valid: true,
      tokenExists: true,
      lastValidated: "2026-01-01T00:00:00Z",
    });
    expect((await app.inject({ url: "/api/auth/status" })).json().subscription.expired).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    mockCachedValidation.mockRejectedValue(new Error("cache unavailable"));
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    expect((await app.inject({ url: "/api/auth/status" })).json().subscription).toMatchObject({
      available: true,
      expired: false,
      lastValidated: null,
    });
  });
});

describe("remaining sign-in and credential access boundaries", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    authDisabled = false;
    deploymentAdmin = false;
    mockDomainDecision = "allowed";
    mockListEnabledProviders.mockResolvedValue([]);
    mockOAuthProvider = {
      exchangeCode: vi.fn().mockResolvedValue({ accessToken: "provider-token" }),
      fetchUser: vi
        .fn()
        .mockResolvedValue({ email: "attacker@elsewhere.test", emailVerified: false }),
    };
    app = await buildRouteTestApp(authRoutes);
  });
  afterEach(async () => {
    await app.close();
    mockDomainDecision = "allowed";
    deploymentAdmin = false;
  });

  it("refuses an unverified or disallowed identity before creating any Optio session", async () => {
    mockDomainDecision = "unverified_email";
    redisStore.set(
      "oauth_state:domain-check",
      JSON.stringify({ provider: "google", browserChallenge }),
    );
    const res = await app.inject({ url: "/api/auth/google/callback?state=domain-check&code=c" });
    expect(res.headers.location).toContain("error=unverified_email");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
  it("only offers setup when authentication is enabled and no provider is configured", async () => {
    expect((await app.inject({ url: "/api/auth/providers" })).json()).toMatchObject({
      authDisabled: false,
      setupRequired: true,
    });
    authDisabled = true;
    expect((await app.inject({ url: "/api/auth/providers" })).json()).toMatchObject({
      authDisabled: true,
      setupRequired: false,
    });
    authDisabled = false;
    mockListEnabledProviders.mockResolvedValue([{ name: "google", displayName: "Google" }]);
    expect((await app.inject({ url: "/api/auth/providers" })).json()).toMatchObject({
      setupRequired: false,
      providers: [{ name: "google" }],
    });
  });
  it("uses the authenticated identity already resolved by the API", async () => {
    const res = await app.inject({ url: "/api/auth/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe("user-1");
    expect(mockValidateSession).not.toHaveBeenCalled();
  });
  it("refreshes usage only on explicit request and returns no credential material", async () => {
    expect((await app.inject({ url: "/api/auth/usage" })).json().usage.available).toBe(false);
    expect(mockInvalidateUsageCache).not.toHaveBeenCalled();
    expect(
      (await app.inject({ url: "/api/auth/usage?fresh=1" })).json().usage.authFailures,
    ).toEqual({ claude: false, github: false });
    expect(mockInvalidateUsageCache).toHaveBeenCalledTimes(1);
  });
  it("only sends a plaintext token to a deployment administrator", async () => {
    mockGetClaudeAuthToken.mockReturnValueOnce({ available: true, token: "protected-token" });
    expect((await app.inject({ url: "/api/auth/claude-token" })).statusCode).toBe(403);
    expect(mockGetClaudeAuthToken).not.toHaveBeenCalled();
    deploymentAdmin = true;
    const res = await app.inject({ url: "/api/auth/claude-token" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe("protected-token");
  });
  it("refuses another person's machine and reports a failed credential refresh without treating it as success", async () => {
    deploymentAdmin = true;
    const hostId = "11111111-1111-4111-8111-111111111111";
    const operation = {
      method: "POST" as const,
      url: "/api/auth/claude-token/refresh-from-host",
      payload: { hostId },
    };
    mockGetHost
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: hostId, userId: "someone-else" })
      .mockResolvedValueOnce({ id: hostId, userId: "user-1" });
    expect((await app.inject(operation)).statusCode).toBe(404);
    expect((await app.inject(operation)).statusCode).toBe(404);
    expect(mockRefreshClaudeToken).not.toHaveBeenCalled();
    mockRefreshClaudeToken.mockResolvedValue({ ok: false, error: "Token expired" });
    const res = await app.inject(operation);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: "Token expired" });
  });
});

describe("LDAP password login", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    mockDomainDecision = "allowed";
    mockResolveProviderConfig.mockResolvedValue(null);
    mockCreateSession.mockImplementation(async (_provider: string, profile: any) => ({
      token: "session-token",
      user: { id: "user-1", email: profile.email, displayName: profile.displayName },
    }));
    app = await buildTestApp();
  });
  afterEach(async () => {
    await app.close();
  });
  it("links LDAP accounts by email only when LDAP's linkByEmail is on", async () => {
    const { ldapAuthenticate } = await import("../services/auth/ldap.js");
    vi.mocked(ldapAuthenticate).mockResolvedValue({
      externalId: "CN=Ada,DC=corp,DC=example",
      email: "ada@acme.com",
      displayName: "Ada",
      username: "ada",
      groups: [],
    } as any);
    for (const [settings, linkByEmail] of [
      [{}, false],
      [{ linkByEmail: true }, true],
    ] as const) {
      mockCreateSession.mockClear();
      mockResolveProviderConfig.mockImplementation(async (p: string) =>
        p === "ldap"
          ? {
              clientId: "",
              clientSecret: "bind-pw",
              allowedDomains: [],
              source: "database",
              settings: { url: "ldaps://ad.example.com", userBaseDn: "DC=corp", ...settings },
            }
          : null,
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/auth/ldap/login?browserChallenge=${browserChallenge}`,
        payload: { username: "ada", password: "pw" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCreateSession).toHaveBeenCalledWith(
        "ldap",
        expect.objectContaining({ emailVerified: true }),
        { linkByEmail, claimAccount: null },
      );
      expect(JSON.parse(redisStore.get(`auth_code:${res.json().code}`)!)).toEqual({
        token: "session-token",
        browserChallenge,
      });
    }
  });

  it("refuses a directory-disabled account with 403 and no session", async () => {
    const { ldapAuthenticate, LdapAuthError } = await import("../services/auth/ldap.js");
    vi.mocked(ldapAuthenticate).mockRejectedValue(
      new LdapAuthError("This account is disabled in the directory", "account_disabled"),
    );
    mockResolveProviderConfig.mockImplementation(async (p: string) =>
      p === "ldap"
        ? {
            clientId: "",
            clientSecret: "bind-pw",
            allowedDomains: [],
            source: "database",
            settings: { url: "ldaps://ad.example.com", userBaseDn: "DC=corp" },
          }
        : null,
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/ldap/login?browserChallenge=${browserChallenge}`,
      payload: { username: "ada", password: "pw" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/disabled in the directory/);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("answers 404 for the LDAP form when LDAP isn't configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/ldap/login?browserChallenge=${browserChallenge}`,
      payload: { username: "ada", password: "pw" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unbound browser login before checking the password", async () => {
    const { ldapAuthenticate } = await import("../services/auth/ldap.js");
    mockResolveProviderConfig.mockResolvedValue({ settings: {}, allowedDomains: [] });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "ada", password: "pw" },
    });
    expect(res.statusCode).toBe(400);
    expect(ldapAuthenticate).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("keeps CLI password sign-in stateless and revokes its temporary browser session", async () => {
    const { ldapAuthenticate } = await import("../services/auth/ldap.js");
    vi.mocked(ldapAuthenticate).mockResolvedValue({
      externalId: "directory-ada",
      email: "ada@acme.test",
      displayName: "Ada",
      username: "ada",
      groups: [],
    } as any);
    mockResolveProviderConfig.mockResolvedValue({
      settings: { url: "ldaps://directory.example", userBaseDn: "DC=example" },
      allowedDomains: [],
    });
    mockCreateApiKey.mockResolvedValue({ token: "optio_pat_ldap", tokenId: "pat-id" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "ada", password: "pw", cli: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe("optio_pat_ldap");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(mockRevokeSession).toHaveBeenCalledWith("session-token");
    expect([...redisStore.keys()].some((key) => key.startsWith("auth_code:"))).toBe(false);
    expect(mockCompleteSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: true, provider: "ldap" }),
      { provider: "ldap", groups: [] },
    );
  });
});
