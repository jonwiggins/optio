import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockRetrieveSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
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

// The model gateway (docs/model-gateway.md): none unless a test says so.
const mockAnyGatewayConfigured = vi.fn(async () => false);
vi.mock("../services/model-gateway-service.js", () => ({
  anyGatewayConfigured: () => mockAnyGatewayConfigured(),
}));

import { setupRoutes } from "./setup.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";

// The GitLab check goes through the outbound guard: route its client through
// the stubbed `fetch`, with a fixed public DNS answer (no real lookups).
setOutboundDefaults({
  fetchImpl: (url, init) => globalThis.fetch(url, init),
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
});

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

describe("GET /api/setup/status with OPTIO_GIT_PLATFORMS=gitlab", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);
    mockAnyGatewayConfigured.mockResolvedValue(true);
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("doesn't count a GitHub token as the git step; GITLAB_TOKEN and the gateway do", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    const github = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();
    expect(github.steps.gitToken.done).toBe(false);
    expect(github.isSetUp).toBe(false);

    mockListSecrets.mockResolvedValue([{ name: "GITLAB_TOKEN" }]);
    const gitlab = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();
    expect(gitlab.steps.gitToken.done).toBe(true);
    expect(gitlab.steps.anthropicKey.done).toBe(true);
    expect(gitlab.isSetUp).toBe(true);
  });

  it("with every platform offered (the default) the GitHub token still counts", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "");
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    const body = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();
    expect(body.steps.gitToken.done).toBe(true);
  });
});

describe("GET /api/setup/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAnyGatewayConfigured.mockResolvedValue(false);
    app = await buildTestApp();
  });

  it("counts a model gateway as the agent source", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITLAB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);
    mockAnyGatewayConfigured.mockResolvedValue(true);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSetUp).toBe(true);
    expect(body.steps.modelGateway.done).toBe(true);
    expect(body.steps.anthropicKey.done).toBe(true);
    expect(body.steps.anyAgentKey.done).toBe(true);
  });

  it("is not set up on a git token alone when no gateway exists", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITLAB_TOKEN" }]);
    mockRetrieveSecret.mockRejectedValue(new Error("not found"));
    mockCheckRuntimeHealth.mockResolvedValue(true);
    mockAnyGatewayConfigured.mockResolvedValue(false);

    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.json().isSetUp).toBe(false);
    expect(res.json().steps.modelGateway.done).toBe(false);
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

  it("falls back to the login when the account has no display name (#621)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser", name: null }),
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/github-token",
      payload: { token: "ghp_valid_token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(res.json().user).toEqual({ login: "testuser", name: "testuser" });
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

describe("POST /api/setup/validate/copilot-token + gitlab-token null names (#621)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copilot: falls back to the login when name is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "octo", name: null }),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/copilot-token",
      payload: { token: "github_pat_abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ login: "octo", name: "octo" });
  });

  it("gitlab: falls back to the username when name is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ username: "gl-user", name: null }),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/gitlab-token",
      payload: { token: "glpat-abc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ login: "gl-user", name: "gl-user" });
  });

  it("gitlab: signs in with Authorization: Bearer, which takes every GitLab token kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "gl-user", name: "GL User" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await app.inject({
      method: "POST",
      url: "/api/setup/validate/gitlab-token",
      payload: { token: "gloas-oauth" },
    });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer gloas-oauth");
    expect(headers.get("private-token")).toBeNull();
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
