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

const authDisabled = false;
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

  it("doesn't count a GitHub token as the git step; GitLab credentials satisfy git without changing agent setup", async () => {
    mockListSecrets.mockResolvedValue([{ name: "GITHUB_TOKEN" }]);
    const github = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();
    expect(github.steps.gitToken.done).toBe(false);
    expect(github.isSetUp).toBe(false);

    mockListSecrets.mockResolvedValue([{ name: "GITLAB_TOKEN" }, { name: "ANTHROPIC_API_KEY" }]);
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
  it("does not count a GitLab token when only GitHub is offered", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "github");
    mockListSecrets.mockResolvedValue([{ name: "GITLAB_TOKEN" }]);
    const body = (await app.inject({ method: "GET", url: "/api/setup/status" })).json();
    expect(body.steps.gitToken.done).toBe(false);
    expect(body.isSetUp).toBe(false);
  });
});
