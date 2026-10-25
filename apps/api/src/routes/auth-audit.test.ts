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
vi.mock("../services/scim.js", () => ({
  scimAccountFor: async () => null,
  scimGroupsForSignIn: async () => [],
}));

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

const ldap = vi.hoisted(() => {
  class LdapAuthError extends Error {
    constructor(
      public code: string,
      message = code,
    ) {
      super(message);
    }
  }
  return { LdapAuthError, ldapAuthenticate: vi.fn() };
});
vi.mock("../services/auth/ldap.js", () => ldap);
vi.mock("../services/workspace-service.js", () => ({
  joinWorkspacesByEmailDomain: async () => {},
}));
// A disabled account (services/offboarding.ts; the real check is in
// routes/directory-sync.int.test.ts).
let accountCheck: "allowed" | "account_disabled" = "allowed";
vi.mock("../services/offboarding.js", () => ({
  ACCOUNT_DISABLED_MESSAGE: "Your Optio account is disabled.",
  signInAccountCheck: async () => accountCheck,
}));
vi.mock("../plugins/auth.js", () => ({
  SESSION_COOKIE_NAME: "optio_session",
  requireRole: () => async () => {},
}));
const redis = new Map<string, string>();
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({
    setex: async (k: string, _t: number, v: string) => void redis.set(k, v),
    get: async (k: string) => redis.get(k) ?? null,
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
  accountCheck = "allowed";
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

describe("LDAP sign-in", () => {
  it("records a wrong password with the name it was tried with", async () => {
    ldap.ldapAuthenticate.mockRejectedValue(new ldap.LdapAuthError("invalid_credentials"));
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "carol", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(audit.auditSignInFailure).toHaveBeenCalledWith(expect.anything(), {
      provider: "ldap",
      reason: "invalid_credentials",
      username: "carol",
    });
    expect(audit.auditSignIn).not.toHaveBeenCalled();
  });

  it("records a refusal by group with the directory's email", async () => {
    ldap.ldapAuthenticate.mockResolvedValue(carol);
    decision = "group_not_allowed";
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "carol", password: "pw" },
    });
    expect(res.statusCode).toBe(403);
    expect(audit.auditSignInFailure).toHaveBeenCalledWith(expect.anything(), {
      provider: "ldap",
      reason: "group_not_allowed",
      username: "carol",
      email: "carol@example.test",
    });
  });

  it("refuses a disabled account with its own message, and records why", async () => {
    ldap.ldapAuthenticate.mockResolvedValue(carol);
    accountCheck = "account_disabled";
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "carol", password: "pw", cli: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Your Optio account is disabled.");
    expect(audit.auditSignInFailure).toHaveBeenCalledWith(expect.anything(), {
      provider: "ldap",
      reason: "account_disabled",
      username: "carol",
      email: "carol@example.test",
    });
    expect(session.createSession).not.toHaveBeenCalled();
    expect(keys.createApiKey).not.toHaveBeenCalled();
  });

  it("records the sign-in and, for the CLI, the API key it gets", async () => {
    ldap.ldapAuthenticate.mockResolvedValue(carol);
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "carol", password: "pw", cli: true },
    });
    expect(res.statusCode).toBe(200);
    expect(audit.auditSignIn).toHaveBeenCalledWith(expect.anything(), {
      provider: "ldap",
      userId: "carol-id",
      via: "cli",
    });
    expect(audit.auditPersonEvent).toHaveBeenCalledWith(expect.anything(), {
      action: "api_key.create",
      userId: "carol-id",
      details: { id: "key-1", name: "CLI (2026-10-24)", via: "cli" },
    });
  });

  it("a browser sign-in is via web and makes no key", async () => {
    ldap.ldapAuthenticate.mockResolvedValue(carol);
    const res = await anon.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "carol", password: "pw" },
    });
    expect(res.statusCode).toBe(200);
    expect(audit.auditSignIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ via: "web" }),
    );
    expect(audit.auditPersonEvent).not.toHaveBeenCalled();
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
