/**
 * The sign-in providers side by side through the auth routes: Google, GitHub
 * and GitLab (the account providers) beside OpenID Connect and the LDAP form.
 * Who may sign in is decided by the real `accessDecision`; the session,
 * Redis, the database-backed steps and the providers themselves are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockCreateSession = vi.fn();
let linkByEmailOn = false;
vi.mock("../services/session-service.js", () => ({
  validateSession: vi.fn(),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  revokeSession: vi.fn(),
  createWsToken: vi.fn(),
  linkAccountsByEmailEnabled: () => linkByEmailOn,
}));

// SCIM provisioning: no provisioned account unless a test says so.
const mockScimAccountFor = vi.fn(async (): Promise<string | null> => null);
const mockScimGroups = vi.fn(async (): Promise<string[]> => []);
vi.mock("../services/scim.js", () => ({
  scimAccountFor: (...args: unknown[]) => mockScimAccountFor(...(args as [])),
  scimGroupsForSignIn: (...args: unknown[]) => mockScimGroups(...(args as [])),
}));

vi.mock("../services/auth-service.js", () => ({
  getClaudeAuthToken: () => ({ available: false }),
  getClaudeUsage: async () => ({ available: false }),
  invalidateCredentialsCache: () => {},
}));

let enabledProviders: unknown[] = [];
const oauthProviders: Record<string, any> = {};
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => false,
  listEnabledProviders: async () => enabledProviders,
  getOAuthProvider: (name: string) => oauthProviders[name],
}));

const mockResolveProviderConfig = vi.fn();
const mockCompleteSignIn = vi.fn();
vi.mock("../services/sign-in-config-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sign-in-config-service.js")>();
  return {
    isSignInProvider: actual.isSignInProvider,
    accessDecision: actual.accessDecision,
    domainDecision: actual.domainDecision,
    completeSignIn: (...args: unknown[]) => mockCompleteSignIn(...args),
    isDeploymentAdmin: async () => false,
    resolveProviderConfig: (...args: unknown[]) => mockResolveProviderConfig(...args),
  };
});

const mockStoreGitHubTokens = vi.fn();
vi.mock("../services/github-token-service.js", () => ({
  storeUserGitHubTokens: (...args: unknown[]) => mockStoreGitHubTokens(...args),
}));

const mockStoreGitLabTokens = vi.fn();
vi.mock("../services/gitlab-user-token-service.js", () => ({
  gitlabUserTokensEnabled: () => process.env.GITLAB_OAUTH_STORE_USER_TOKEN === "true",
  storeUserGitLabTokens: (...args: unknown[]) => mockStoreGitLabTokens(...args),
}));

vi.mock("../services/workspace-service.js", () => ({
  joinWorkspacesByEmailDomain: vi.fn(async () => {}),
}));

vi.mock("../services/auth/ldap.js", () => ({
  LdapAuthError: class extends Error {},
  ldapAuthenticate: vi.fn(),
}));

vi.mock("../services/offboarding.js", () => ({
  ACCOUNT_DISABLED_MESSAGE: "Your Optio account is disabled.",
  signInAccountCheck: async () => "allowed",
}));

vi.mock("../services/audit.js", () => ({
  auditEvent: vi.fn(async () => {}),
  auditPersonEvent: vi.fn(async () => {}),
  auditSignIn: vi.fn(async () => {}),
  auditSignInFailure: vi.fn(async () => {}),
}));

vi.mock("../plugins/auth.js", () => ({
  SESSION_COOKIE_NAME: "optio_session",
  requireRole: () => async () => {},
}));

const redisStore = new Map<string, string>();
const mockRedisClient = {
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    redisStore.set(key, value);
    return "OK";
  }),
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    redisStore.delete(key);
    return 1;
  }),
};
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => mockRedisClient,
}));

import { authRoutes } from "./auth.js";

// ─── Helpers ───

function fakeProvider(name: string, authorizeBase: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    authorizeUrl: vi.fn((state: string) => `${authorizeBase}?state=${state}`),
    exchangeCode: vi.fn(async () => ({ accessToken: `${name}-at` })),
    fetchUser: vi.fn(async () => ({
      externalId: `${name}-1`,
      email: "ada@acme.com",
      displayName: "Ada",
      emailVerified: true,
    })),
    ...extra,
  };
}

/** Start a redirect sign-in and return the state the API remembered for it. */
async function startLogin(app: FastifyInstance, provider: string): Promise<string> {
  const res = await app.inject({ method: "GET", url: `/api/auth/${provider}/login` });
  expect(res.statusCode).toBe(302);
  const state = new URL(res.headers.location as string).searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

describe("sign-in providers side by side", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    for (const k of Object.keys(oauthProviders)) delete oauthProviders[k];
    oauthProviders.google = fakeProvider("google", "https://accounts.google.com/o/oauth2/v2/auth");
    oauthProviders.github = fakeProvider("github", "https://github.com/login/oauth/authorize");
    oauthProviders.gitlab = fakeProvider("gitlab", "https://gitlab.com/oauth/authorize");
    oauthProviders.oidc = fakeProvider("oidc", "https://sso.example.com/auth");
    mockResolveProviderConfig.mockResolvedValue(null);
    mockCompleteSignIn.mockResolvedValue({ deploymentAdmin: false, bootstrapped: false });
    mockCreateSession.mockImplementation(async (_provider: string, profile: any) => ({
      token: "session-token",
      user: { id: "user-1", email: profile.email, displayName: profile.displayName },
    }));
    app = await buildRouteTestApp(authRoutes, { user: null });
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the account providers beside OIDC and the LDAP form", async () => {
    enabledProviders = [
      { name: "github", displayName: "GitHub", method: "redirect" },
      { name: "google", displayName: "Google", method: "redirect" },
      { name: "gitlab", displayName: "GitLab", method: "redirect" },
      { name: "oidc", displayName: "Corp SSO", method: "redirect" },
      { name: "ldap", displayName: "Corporate account", method: "password", usernameLabel: "ID" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/auth/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      providers: enabledProviders,
      authDisabled: false,
      setupRequired: false,
    });
  });

  it("sends each account provider's login to its own authorize URL", async () => {
    for (const [name, base] of [
      ["google", "https://accounts.google.com/o/oauth2/v2/auth"],
      ["github", "https://github.com/login/oauth/authorize"],
      ["gitlab", "https://gitlab.com/oauth/authorize"],
    ] as const) {
      const state = await startLogin(app, name);
      expect(JSON.parse(redisStore.get(`oauth_state:${state}`)!)).toMatchObject({ provider: name });
      expect(oauthProviders[name].authorizeUrl).toHaveBeenCalledWith(state, undefined);
      expect(oauthProviders[name].authorizeUrl.mock.results[0].value).toMatch(
        new RegExp(`^${base.replace(/[.\/]/g, "\\$&")}`),
      );
    }
  });

  it("signs in with GitHub and keeps its App user tokens for git operations", async () => {
    const tokens = { accessToken: "gh-at", refreshToken: "gh-rt", expiresIn: 28800 };
    oauthProviders.github.exchangeCode.mockResolvedValue(tokens);
    const state = await startLogin(app, "github");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=the-code&state=${state}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/callback\?code=[0-9a-f]+$/);
    expect(oauthProviders.github.fetchUser).toHaveBeenCalledWith("gh-at", tokens);
    expect(mockStoreGitHubTokens).toHaveBeenCalledWith("user-1", tokens);
    expect(mockCompleteSignIn).toHaveBeenCalledWith(
      { id: "user-1", email: "ada@acme.com" },
      { provider: "github", groups: undefined },
    );
  });

  it("signs in with GitLab without touching GitHub's tokens", async () => {
    const state = await startLogin(app, "gitlab");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/gitlab/callback?code=c&state=${state}`,
    });
    expect(res.headers.location).toMatch(/\/auth\/callback\?code=/);
    // A new identity never takes over another account by its email by default.
    expect(mockCreateSession).toHaveBeenCalledWith("gitlab", expect.objectContaining({}), {
      linkByEmail: false,
      claimAccount: null,
    });
    expect(mockStoreGitHubTokens).not.toHaveBeenCalled();
    // "Use my GitLab account for my work" is off: nothing kept.
    expect(mockStoreGitLabTokens).not.toHaveBeenCalled();
  });

  it("keeps the person's GitLab tokens only when the deployment opted in", async () => {
    const tokens = { accessToken: "gl-at", refreshToken: "gl-rt", expiresIn: 7200 };
    oauthProviders.gitlab.exchangeCode.mockResolvedValue(tokens);
    vi.stubEnv("GITLAB_OAUTH_STORE_USER_TOKEN", "true");
    try {
      const state = await startLogin(app, "gitlab");
      await app.inject({ method: "GET", url: `/api/auth/gitlab/callback?code=c&state=${state}` });
      expect(mockStoreGitLabTokens).toHaveBeenCalledWith("user-1", tokens);
      expect(mockStoreGitHubTokens).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a Google account from another Workspace under the allowed domains", async () => {
    mockResolveProviderConfig.mockImplementation(async (p: string) =>
      p === "google"
        ? { clientId: "g", clientSecret: "s", allowedDomains: ["acme.com"], source: "database" }
        : null,
    );
    oauthProviders.google.fetchUser.mockResolvedValue({
      externalId: "g-1",
      email: "ada@acme.com",
      displayName: "Ada",
      emailVerified: true,
      hostedDomain: "evil.com",
    });
    const state = await startLogin(app, "google");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=c&state=${state}`,
    });
    expect(res.headers.location).toMatch(/\/login\?error=domain_not_allowed$/);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("keeps OIDC's PKCE verifier and nonce with the state for the callback", async () => {
    const flow = { codeVerifier: "verifier", nonce: "nonce" };
    oauthProviders.oidc.beginFlow = vi.fn(() => flow);
    oauthProviders.oidc.prepare = vi.fn(async () => {});
    const state = await startLogin(app, "oidc");
    expect(oauthProviders.oidc.authorizeUrl).toHaveBeenCalledWith(state, flow);
    await app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=c&state=${state}` });
    expect(oauthProviders.oidc.exchangeCode).toHaveBeenCalledWith("c", flow);
  });

  it("links OIDC accounts by email only when the provider's linkByEmail is on", async () => {
    for (const [source, settings, linkByEmail] of [
      ["environment", {}, false],
      ["database", {}, false],
      ["database", { linkByEmail: false }, false],
      ["database", { linkByEmail: true }, true],
      ["environment", { linkByEmail: true }, true],
    ] as const) {
      mockCreateSession.mockClear();
      mockResolveProviderConfig.mockImplementation(async (p: string) =>
        p === "oidc"
          ? {
              clientId: "o",
              clientSecret: "s",
              allowedDomains: [],
              source,
              settings: { issuerUrl: "https://sso.example.com", ...settings },
            }
          : null,
      );
      const state = await startLogin(app, "oidc");
      await app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=c&state=${state}` });
      expect(mockCreateSession).toHaveBeenCalledWith("oidc", expect.objectContaining({}), {
        linkByEmail,
        claimAccount: null,
      });
    }
  });

  it("links by email only when the deployment turns it on, whatever the provider", async () => {
    mockResolveProviderConfig.mockImplementation(async (p: string) =>
      p === "oidc"
        ? {
            clientId: "o",
            clientSecret: "s",
            allowedDomains: [],
            source: "database",
            settings: { issuerUrl: "https://sso.example.com" },
          }
        : null,
    );
    for (const on of [false, true]) {
      linkByEmailOn = on;
      for (const provider of ["oidc", "github"]) {
        mockCreateSession.mockClear();
        const state = await startLogin(app, provider);
        await app.inject({
          method: "GET",
          url: `/api/auth/${provider}/callback?code=c&state=${state}`,
        });
        expect(mockCreateSession).toHaveBeenCalledWith(provider, expect.objectContaining({}), {
          linkByEmail: on,
          claimAccount: null,
        });
      }
    }
    linkByEmailOn = false;
  });

  it("claims the account SCIM provisioned, and its groups count toward required groups", async () => {
    mockResolveProviderConfig.mockImplementation(async (p: string) =>
      p === "oidc"
        ? {
            clientId: "o",
            clientSecret: "s",
            allowedDomains: [],
            source: "database",
            settings: { issuerUrl: "https://sso.example.com", requiredGroups: ["optio-users"] },
          }
        : null,
    );
    mockScimAccountFor.mockResolvedValueOnce("provisioned-1");
    mockScimGroups.mockResolvedValueOnce(["optio-users"]);
    const state = await startLogin(app, "oidc");
    const res = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=c&state=${state}`,
    });
    expect(res.headers.location).toMatch(/\/auth\/callback\?code=/);
    expect(mockCreateSession).toHaveBeenCalledWith(
      "oidc",
      expect.objectContaining({ groups: ["optio-users"] }),
      { linkByEmail: false, claimAccount: "provisioned-1" },
    );
    expect(mockCompleteSignIn).toHaveBeenCalledWith(
      { id: "user-1", email: "ada@acme.com" },
      { provider: "oidc", groups: ["optio-users"] },
    );
  });

  it("refuses an OIDC sign-in outside the required groups, not a Google one", async () => {
    mockResolveProviderConfig.mockImplementation(async (p: string) =>
      p === "oidc"
        ? {
            clientId: "o",
            clientSecret: "s",
            allowedDomains: [],
            source: "database",
            settings: { issuerUrl: "https://sso.example.com", requiredGroups: ["optio-users"] },
          }
        : null,
    );
    const oidcState = await startLogin(app, "oidc");
    const refused = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?code=c&state=${oidcState}`,
    });
    expect(refused.headers.location).toMatch(/\/login\?error=group_not_allowed$/);

    const googleState = await startLogin(app, "google");
    const allowed = await app.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=c&state=${googleState}`,
    });
    expect(allowed.headers.location).toMatch(/\/auth\/callback\?code=/);
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
        url: "/api/auth/ldap/login",
        payload: { username: "ada", password: "pw" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCreateSession).toHaveBeenCalledWith(
        "ldap",
        expect.objectContaining({ emailVerified: true }),
        { linkByEmail, claimAccount: null },
      );
    }
  });

  it("answers 404 for the LDAP form when LDAP isn't configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      payload: { username: "ada", password: "pw" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/auth/me — teams", () => {
  it("carries the person's teams when the auth plugin resolved them", async () => {
    const withTeams = {
      id: "user-1",
      provider: "oidc",
      email: "test@example.com",
      displayName: "Test User",
      avatarUrl: null,
      workspaceId: "ws-1",
      workspaceRole: "member" as const,
      teamIds: ["t1", "t2"],
      adminTeamIds: ["t2"],
    };
    const teamApp = await buildRouteTestApp(authRoutes, { user: withTeams });
    try {
      const res = await teamApp.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        id: "user-1",
        teamIds: ["t1", "t2"],
        adminTeamIds: ["t2"],
        deploymentAdmin: false,
      });
    } finally {
      await teamApp.close();
    }
  });
});
