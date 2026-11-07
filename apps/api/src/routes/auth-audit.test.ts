/**
 * The sign-in routes' audit entries (docs/audit.md): refused and successful
 * sign-ins with the provider and the reason, API keys made and revoked, and
 * sign-out. The entries themselves are services/audit.ts's (mocked here);
 * services/audit.int.test.ts writes real ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const audit = vi.hoisted(() => ({
  auditEvent: vi.fn().mockResolvedValue(undefined),
  auditPersonEvent: vi.fn().mockResolvedValue(undefined),
  auditSignIn: vi.fn().mockResolvedValue(undefined),
  auditSignInFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/audit.js", () => audit);

const session = vi.hoisted(() => ({
  createSession: vi.fn(),
  revokeSession: vi.fn(),
  validateSession: vi.fn(),
  createWsToken: vi.fn(),
  linkAccountsByEmailEnabled: () => false,
}));
vi.mock("../services/session-service.js", () => session);

const keys = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock("../services/api-key-service.js", () => keys);

vi.mock("../services/auth-service.js", () => ({
  getClaudeAuthToken: () => ({ available: false }),
  getClaudeUsage: async () => ({ available: false }),
  invalidateCredentialsCache: () => {},
  invalidateUsageCache: () => {},
}));
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => false,
  listEnabledProviders: async () => [],
  getOAuthProvider: () => undefined,
}));

let decision = "allowed";
vi.mock("../services/sign-in-config-service.js", () => ({
  isSignInProvider: (name: string) => name === "oidc" || name === "ldap",
  completeSignIn: async () => ({}),
  accessDecision: () => decision,
  isDeploymentAdmin: async () => false,
  resolveProviderConfig: async () => ({ settings: { url: "ldaps://ldap" }, clientSecret: "x" }),
}));

vi.mock("../services/workspace-service.js", () => ({
  joinWorkspacesByEmailDomain: async () => {},
}));
vi.mock("../plugins/auth.js", () => ({
  SESSION_COOKIE_NAME: "optio_session",
  requireDeploymentAdmin: async () => {},
  requireRole: () => async () => {},
}));
const redis = new Map<string, string>();
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({
    setex: async (k: string, _t: number, v: string) => void redis.set(k, v),
    get: async (k: string) => redis.get(k) ?? null,
    getdel: async (k: string) => {
      const value = redis.get(k) ?? null;
      redis.delete(k);
      return value;
    },
    del: async (k: string) => void redis.delete(k),
  }),
}));

import { authRoutes } from "./auth.js";

const carol = {
  externalId: "uid=carol",
  email: "carol@example.test",
  displayName: "Carol",
  username: "carol",
  groups: ["developers"],
};

let anon: FastifyInstance;
let signedIn: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  redis.clear();
  decision = "allowed";
  session.createSession.mockResolvedValue({
    token: "session-token",
    user: { id: "carol-id", email: carol.email, displayName: "Carol" },
  });
  keys.createApiKey.mockResolvedValue({
    token: "optio_pat_x",
    tokenId: "key-1",
    prefix: "optio_pat_x",
    name: "CLI (2026-10-24)",
  });
  anon = await buildRouteTestApp(authRoutes, { user: null });
  signedIn = await buildRouteTestApp(authRoutes, {
    user: { id: "carol-id", workspaceId: "ws-1", workspaceRole: "member" },
  });
});

describe("OIDC callback", () => {
  it("records a callback whose state Optio never issued", async () => {
    const res = await anon.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=c&state=forged",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("error=invalid_state");
    expect(audit.auditSignInFailure).toHaveBeenCalledWith(expect.anything(), {
      provider: "oidc",
      reason: "invalid_state",
    });
  });

  it("records the identity provider's own error", async () => {
    await anon.inject({ method: "GET", url: "/api/auth/oidc/callback?error=access_denied" });
    expect(audit.auditSignInFailure).toHaveBeenCalledWith(expect.anything(), {
      provider: "oidc",
      reason: "provider_error",
    });
  });
});

describe("API keys and sign-out", () => {
  it("records a key made in Settings, and its revocation", async () => {
    keys.createApiKey.mockResolvedValue({
      token: "optio_pat_y",
      tokenId: "key-2",
      prefix: "optio_pat_y",
      name: "laptop",
    });
    const made = await signedIn.inject({
      method: "POST",
      url: "/api/auth/api-keys",
      payload: { name: "laptop" },
    });
    expect(made.statusCode).toBe(201);
    expect(audit.auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.create",
        details: { id: "key-2", name: "laptop", via: "settings", expiresAt: undefined },
      }),
    );

    keys.revokeApiKey.mockResolvedValue(true);
    const gone = await signedIn.inject({ method: "DELETE", url: "/api/auth/api-keys/key-2" });
    expect(gone.statusCode).toBe(200);
    expect(audit.auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "api_key.delete", details: { id: "key-2" } }),
    );
  });

  it("records nothing for a key that wasn't there", async () => {
    keys.revokeApiKey.mockResolvedValue(false);
    const res = await signedIn.inject({ method: "DELETE", url: "/api/auth/api-keys/nope" });
    expect(res.statusCode).toBe(404);
    expect(audit.auditEvent).not.toHaveBeenCalled();
  });

  it("records a sign-out", async () => {
    const res = await signedIn.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: "Bearer session-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(session.revokeSession).toHaveBeenCalledWith("session-token");
    expect(audit.auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.sign_out" }),
    );
  });
});
