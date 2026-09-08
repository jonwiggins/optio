import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockRetrieveSecret = vi.fn();
const mockGetCodexAuthAccount = vi.fn();
const mockUpsertCodexAuthAccount = vi.fn();
const mockImportCodexAuthFromSession = vi.fn();
const mockStartCodexAuthSession = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
}));
vi.mock("../services/codex-auth-service.js", () => ({
  getCodexAuthAccount: (...args: unknown[]) => mockGetCodexAuthAccount(...args),
  upsertCodexAuthAccount: (...args: unknown[]) => mockUpsertCodexAuthAccount(...args),
  importCodexAuthFromSession: (...args: unknown[]) => mockImportCodexAuthFromSession(...args),
  startCodexAuthSession: (...args: unknown[]) => mockStartCodexAuthSession(...args),
}));

const mockCheckRuntimeHealth = vi.fn();
vi.mock("../services/container-service.js", () => ({
  checkRuntimeHealth: (...args: unknown[]) => mockCheckRuntimeHealth(...args),
}));

vi.mock("../services/auth-service.js", () => ({
  isSubscriptionAvailable: () => false,
}));

let authDisabled = false;
vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => authDisabled,
}));

import { setupRoutes } from "./setup.js";

// ─── Helpers ───

async function buildTestApp(user?: { workspaceRole: string } | null): Promise<FastifyInstance> {
  return buildRouteTestApp(setupRoutes, {
    user:
      user === undefined
        ? undefined
        : user === null
          ? null
          : {
              id: "u1",
              workspaceId: "ws-1",
              workspaceRole: user.workspaceRole as "admin" | "member" | "viewer",
            },
  });
}

describe("GET /api/setup/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetCodexAuthAccount.mockResolvedValue(null);
    app = await buildTestApp();
  });

  it("returns fully set up when all keys exist and runtime is healthy", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.runtime.done).toBe(true);
    expect(body.steps.gitToken.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
    expect(body.steps.anyAgentKey.done).toBe(true);
  });

  it("returns fully set up when using GitLab token", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITLAB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.gitToken.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
  });

  it("returns not set up when no agent key exists", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().isSetUp).toBe(false);
    expect(res.json().steps.anyAgentKey.done).toBe(false);
  });

  it("stays set up when runtime is unhealthy but keys exist", async () => {
    mockListSecrets.mockResolvedValue([{ name: "ANTHROPIC_API_KEY" }, { name: "GITHUB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.runtime.done).toBe(false);
  });

  it("detects OAuth token mode", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN" },
    ]);
    mockRetrieveSecret.mockImplementation(async (name: string) => {
      if (name === "CLAUDE_AUTH_MODE") return "oauth-token";
      throw new Error("not found");
    });
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects OAuth token mode by name when CLAUDE_AUTH_MODE cannot be decrypted", async () => {
    // Regression: public setup/status has no req.user context, so it can't
    // build the AAD that workspace-scoped CLAUDE_AUTH_MODE rows need.
    // The endpoint must infer the mode from CLAUDE_CODE_OAUTH_TOKEN's presence
    // in the secret names rather than calling retrieveSecret.
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CLAUDE_AUTH_MODE" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects Codex app-server mode by name when CODEX_AUTH_MODE cannot be decrypted", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "CODEX_AUTH_MODE" },
      { name: "CODEX_APP_SERVER_URL" },
      { name: "CODEX_AUTH_JSON" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.codexAppServer.done).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });

  it("detects Gemini Vertex AI mode by name when GEMINI_AUTH_MODE cannot be decrypted", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN" },
      { name: "GEMINI_AUTH_MODE" },
      { name: "GOOGLE_CLOUD_PROJECT" },
    ]);
    mockRetrieveSecret.mockRejectedValue(new Error("decrypt failed: AAD mismatch"));
    mockCheckRuntimeHealth.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.json().isSetUp).toBe(true);
    expect(res.json().steps.geminiKey.done).toBe(true);
    expect(res.json().steps.anyAgentKey.done).toBe(true);
  });
});

describe("POST /api/setup/validate/github-token", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    // After type-provider migration, the 400 envelope is { error, details }
    // rather than { valid: false }
    expect(res.json().error).toBe("Validation error");
  });

  it("validates a valid GitHub token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test User" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_valid_token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().user.login).toBe("testuser");
  });

  it("returns invalid for bad token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "bad-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });
});

describe("POST /api/setup/codex-auth/import", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp({ workspaceRole: "admin" });
  });

  it("imports auth from a session for admins", async () => {
    mockImportCodexAuthFromSession.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/codex-auth/import",
      payload: { sessionId: "sess-123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ imported: true });
    expect(mockImportCodexAuthFromSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "sess-123",
      userId: "u1",
    });
  });

  it("rejects the import when the auth capture fails", async () => {
    mockImportCodexAuthFromSession.mockRejectedValue(
      new Error("Codex login has not completed in this session yet."),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/codex-auth/import",
      payload: { sessionId: "sess-123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Codex login has not completed");
  });
});

describe("GET /api/setup/codex-auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp({ workspaceRole: "admin" });
  });

  it("returns null when no account exists", async () => {
    mockGetCodexAuthAccount.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/api/setup/codex-auth" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ account: null });
  });

  it("returns the managed account summary", async () => {
    mockGetCodexAuthAccount.mockResolvedValue({
      id: "acct-1",
      status: "connected",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginSessionId: "sess-1",
      loginSessionRepoUrl: "https://github.com/owner/repo",
      lastImportedAt: new Date("2026-08-30T14:00:00.000Z"),
      lastValidatedAt: null,
      lastError: null,
    });
    const res = await app.inject({ method: "GET", url: "/api/setup/codex-auth" });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.appServerUrl).toBe("ws://localhost:3900/v1/connect");
    expect(res.json().account.status).toBe("connected");
  });
});

describe("POST /api/setup/codex-auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp({ workspaceRole: "admin" });
  });

  it("saves the managed Codex account", async () => {
    mockUpsertCodexAuthAccount.mockResolvedValue({
      id: "acct-1",
      status: "connected",
      appServerUrl: "ws://localhost:3900/v1/connect",
      loginSessionId: "sess-1",
      loginSessionRepoUrl: "https://github.com/owner/repo",
      lastImportedAt: new Date("2026-08-30T14:00:00.000Z"),
      lastValidatedAt: new Date("2026-08-30T14:00:00.000Z"),
      lastError: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/codex-auth",
      payload: {
        appServerUrl: "ws://localhost:3900/v1/connect",
        authJson: '{"token":"abc"}',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpsertCodexAuthAccount).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u1",
      appServerUrl: "ws://localhost:3900/v1/connect",
      authJson: '{"token":"abc"}',
    });
    expect(res.json().account.status).toBe("connected");
  });
});

describe("POST /api/setup/codex-auth/session", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp({ workspaceRole: "admin" });
  });

  it("starts a managed Codex login session", async () => {
    mockStartCodexAuthSession.mockResolvedValue({
      account: {
        id: "acct-1",
        status: "pending",
        appServerUrl: "ws://localhost:3900/v1/connect",
        loginSessionId: "sess-1",
      },
      session: { id: "sess-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/codex-auth/session",
      payload: {
        repoUrl: "https://github.com/owner/repo",
        appServerUrl: "ws://localhost:3900/v1/connect",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockStartCodexAuthSession).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "u1",
      repoUrl: "https://github.com/owner/repo",
      appServerUrl: "ws://localhost:3900/v1/connect",
    });
    expect(res.json().session.id).toBe("sess-1");
  });
});

describe("POST /api/setup/validate/anthropic-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("validates a valid Anthropic key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: { key: "sk-ant-valid" },
    });

    expect(res.json().valid).toBe(true);
  });
});

describe("POST /api/setup/validate/openai-key", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no key is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/openai-key",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("error sanitization in setup routes", () => {
  let app: FastifyInstance;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  it("returns generic error in production when github-token validation throws", async () => {
    process.env.NODE_ENV = "production";
    // Re-import to pick up the env change
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443")));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.json().valid).toBe(false);
    // Should NOT contain the internal error details
    expect(res.json().error).not.toContain("ECONNREFUSED");
  });

  it("returns detailed error in development when github-token validation throws", async () => {
    process.env.NODE_ENV = "development";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:443")));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.json().valid).toBe(false);
    expect(res.json().error).toContain("ECONNREFUSED");
  });

  it("returns generic error in production when repos listing throws", async () => {
    process.env.NODE_ENV = "production";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com")),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: { token: "ghp_test" },
    });

    expect(res.json().repos).toEqual([]);
    expect(res.json().error).not.toContain("ENOTFOUND");
    expect(res.json().error).toBe("An unexpected error occurred");
  });
});

describe("POST /api/setup/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when no token provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Token is required");
  });

  it("lists repos for a valid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            full_name: "org/repo",
            html_url: "https://github.com/org/repo",
            clone_url: "https://github.com/org/repo.git",
            default_branch: "main",
            private: false,
            description: "A repo",
            language: "TypeScript",
            pushed_at: "2026-03-27T10:00:00Z",
          },
        ],
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/repos",
      payload: { token: "ghp_valid" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(res.json().repos[0].fullName).toBe("org/repo");
  });
});

describe("admin guard on POST setup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows POST requests when no user is set (setup not yet complete)", async () => {
    const app = await buildTestApp(); // no user
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it("allows POST requests for admin users", async () => {
    const app = await buildTestApp({ workspaceRole: "admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it("rejects POST requests for non-admin users with 403", async () => {
    const app = await buildTestApp({ workspaceRole: "member" });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Admin role required");
  });

  it("rejects viewer role on POST routes", async () => {
    const app = await buildTestApp({ workspaceRole: "viewer" });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/anthropic-key",
      payload: { key: "sk-ant-test" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("skips admin guard when auth is disabled", async () => {
    authDisabled = true;
    const app = await buildTestApp({ workspaceRole: "viewer" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });
});
