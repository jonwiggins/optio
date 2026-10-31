vi.mock("../services/gitlab-instance-service.js", () => ({
  refreshGitLabInstances: vi.fn(async () => {}),
  listGitLabInstances: vi.fn(async () => []),
}));
import { isTrustedGitHost } from "../services/git-token-service.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// GET /api/repos/browse — the platform-neutral Add repository picker — and
// the platform-neutral POST /api/setup/validate/repo behind it.

const mockListRepos = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  listRepos: (...args: unknown[]) => mockListRepos(...args),
}));

const mockRetrieveSecretWithFallback = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: vi.fn().mockRejectedValue(new Error("not found")),
  retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
  listSecrets: vi.fn().mockResolvedValue([]),
}));

const mockGetGitToken = vi.fn();
vi.mock("../services/git-token-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-token-service.js")>();
  return {
    ...actual,
    isTrustedGitHost: vi.fn(actual.isTrustedGitHost),
    getGitToken: (...args: unknown[]) => mockGetGitToken(...args),
    getGitPlatformForRepo: vi.fn(),
  };
});

const mockBrowseGitHub = vi.fn();
vi.mock("../services/github-repo-browse-service.js", () => ({
  browseGitHubRepos: (...args: unknown[]) => mockBrowseGitHub(...args),
}));

vi.mock("../services/github-token-service.js", () => ({ getGitHubToken: vi.fn() }));
vi.mock("../services/agent-options-service.js", () => ({ modelBelongsToAgent: vi.fn() }));

vi.mock("../services/container-service.js", () => ({ checkRuntimeHealth: vi.fn() }));
vi.mock("../services/auth-service.js", () => ({ isSubscriptionAvailable: () => false }));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

vi.mock("../services/github-app-service.js", () => ({
  isGitHubAppConfigured: () => false,
  getInstallationToken: vi.fn(),
}));

import { repoRoutes } from "./repos.js";
import { setupRoutes } from "./setup.js";

const mockIsDeploymentAdmin = vi.fn();
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...args: unknown[]) => mockIsDeploymentAdmin(...args),
  hasDeploymentAdmin: async () => true,
  isFoundingWorkspaceAdmin: async () => false,
}));

const fetchMock = vi.fn();
let restoreOutbound: () => void;

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const PROJECT = {
  path_with_namespace: "platform/tools/optio",
  http_url_to_repo: "https://gitlab.corp.local/platform/tools/optio.git",
  web_url: "https://gitlab.corp.local/platform/tools/optio",
  default_branch: "develop",
  visibility: "internal",
  description: "Agents",
  last_activity_at: "2026-10-20T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsDeploymentAdmin.mockResolvedValue(true);
  vi.stubEnv("GITLAB_HOSTS", "gitlab.corp.local,git.example.org");
  restoreOutbound = setOutboundDefaults({
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    policy: {
      allowPrivate: false,
      allowAll: false,
      allowedHosts: ["gitlab.corp.local", "git.unknown.local"],
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  mockRetrieveSecretWithFallback.mockRejectedValue(new Error("not found"));
  mockListRepos.mockResolvedValue([]);
  mockGetGitToken.mockResolvedValue("glpat-person");
});

afterEach(() => {
  restoreOutbound();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/repos/browse with GitLab selected", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildRouteTestApp(repoRoutes);
  });

  it("lists the GitLab projects the person's token is a member of, searched server-side", async () => {
    mockRetrieveSecretWithFallback.mockResolvedValue("gitlab.corp.local");
    fetchMock.mockResolvedValue(json([PROJECT, { id: 1 }]));

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/browse?platform=gitlab&q=tools/opt",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      platform: "gitlab",
      host: "gitlab.corp.local",
      repos: [
        {
          fullName: "platform/tools/optio",
          cloneUrl: PROJECT.http_url_to_repo,
          htmlUrl: PROJECT.web_url,
          defaultBranch: "develop",
          isPrivate: true,
          description: "Agents",
          pushedAt: "2026-10-20T10:00:00Z",
        },
      ],
    });
    // The person's token (else the organization's) — never the server's GitHub one.
    expect(mockGetGitToken).toHaveBeenCalledWith("gitlab", {
      userId: "user-1",
      workspaceId: "ws-1",
      host: "gitlab.corp.local",
    });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://gitlab.corp.local/api/v4/projects");
    expect(url.searchParams.get("membership")).toBe("true");
    expect(url.searchParams.get("search")).toBe("tools/opt");
    expect(url.searchParams.get("search_namespaces")).toBe("true");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer glpat-person");
  });

  it("finds the GitLab host from a repo the workspace already has when no GITLAB_HOST is saved", async () => {
    vi.stubEnv("GITLAB_HOSTS", "");
    // Location selection is independent of the deployment trust service.
    vi.mocked(isTrustedGitHost).mockResolvedValueOnce(true);
    mockListRepos.mockResolvedValue([
      { repoUrl: "https://git.example.org/team/app", gitPlatform: "gitlab" },
    ]);
    fetchMock.mockResolvedValue(json([]));

    const res = await app.inject({ method: "GET", url: "/api/repos/browse?platform=gitlab" });

    expect(res.json().host).toBe("git.example.org");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.host).toBe("git.example.org");
    expect(url.searchParams.has("search")).toBe(false);
  });

  it("says how to fix a missing GitLab token instead of failing", async () => {
    mockGetGitToken.mockRejectedValue(new Error("No GitLab token available"));

    const res = await app.inject({ method: "GET", url: "/api/repos/browse?platform=gitlab" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toEqual([]);
    expect(res.json().error).toMatch(/GITLAB_TOKEN/);
  });

  it("keeps provider response details out of member-facing errors", async () => {
    mockRetrieveSecretWithFallback.mockResolvedValue("gitlab.corp.local");
    fetchMock.mockResolvedValue(json({ message: "secret-provider-detail" }, 401));

    const res = await app.inject({ method: "GET", url: "/api/repos/browse?platform=gitlab" });

    expect(res.json().repos).toEqual([]);
    expect(res.json().error).toBe("Failed to list repositories");
    expect(res.body).not.toContain("secret-provider-detail");
  });
});

describe("deployment credential boundaries for the platform picker", () => {
  it("does not resolve a token for an unlisted browse destination", async () => {
    mockRetrieveSecretWithFallback.mockResolvedValue("gitlab.attacker.test");
    const app = await buildRouteTestApp(repoRoutes);
    const res = await app.inject({ method: "GET", url: "/api/repos/browse?platform=gitlab" });
    expect(res.json()).toMatchObject({
      repos: [],
      error: expect.stringMatching(/deployment operator/),
    });
    expect(mockGetGitToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not resolve a stored token for unlisted repository validation", async () => {
    const app = await buildRouteTestApp(setupRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: {
        repoUrl: "https://gitlab.attacker.test/g/r",
        gitPlatform: "gitlab",
      },
    });
    expect(res.json()).toMatchObject({
      valid: false,
      error: expect.stringMatching(/deployment operator/),
    });
    expect(mockGetGitToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a deployment admin before stored-token validation", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(false);
    const app = await buildRouteTestApp(setupRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: {
        repoUrl: "https://gitlab.com/g/r",
        gitPlatform: "gitlab",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(mockGetGitToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/repos/browse with every platform offered (the default)", () => {
  it("defaults to GitHub, through the server's GitHub credentials", async () => {
    const app = await buildRouteTestApp(repoRoutes);
    mockGetGitToken.mockResolvedValue("ghp_server");
    mockBrowseGitHub.mockResolvedValue({
      repos: [
        {
          fullName: "acme/web",
          cloneUrl: "https://github.com/acme/web.git",
          htmlUrl: "https://github.com/acme/web",
          defaultBranch: "main",
          isPrivate: false,
          description: null,
          pushedAt: null,
        },
      ],
      hasMore: false,
    });

    const res = await app.inject({ method: "GET", url: "/api/repos/browse?q=web" });

    expect(res.json()).toMatchObject({ platform: "github", host: "github.com" });
    expect(res.json().repos[0].fullName).toBe("acme/web");
    expect(mockGetGitToken).toHaveBeenCalledWith("github", { server: true, workspaceId: "ws-1" });
    expect(mockBrowseGitHub).toHaveBeenCalledWith("ghp_server", { q: "web", perPage: 50 });
  });
});

describe("POST /api/setup/validate/repo for a GitLab URL", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.stubEnv("GITLAB_HOSTS", "gitlab.corp.local");
    app = await buildRouteTestApp(setupRoutes);
  });

  it("asks GitLab for the project's metadata with the person's token", async () => {
    fetchMock.mockResolvedValue(json(PROJECT));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: { repoUrl: "https://gitlab.corp.local/platform/tools/optio", gitPlatform: "gitlab" },
    });

    expect(res.json()).toEqual({
      valid: true,
      repo: { fullName: "platform/tools/optio", defaultBranch: "develop", isPrivate: true },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://gitlab.corp.local/api/v4/projects/platform%2Ftools%2Foptio",
    );
    expect(mockGetGitToken).toHaveBeenCalledWith("gitlab", {
      userId: "user-1",
      workspaceId: "ws-1",
      host: "gitlab.corp.local",
    });
  });

  it("reports a project the token cannot see", async () => {
    fetchMock.mockResolvedValue(json({ message: "404 Project Not Found" }, 404));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: { repoUrl: "https://gitlab.corp.local/platform/missing", gitPlatform: "gitlab" },
    });

    expect(res.json()).toEqual({ valid: false, error: "Repository not accessible (404)" });
  });

  it("requires an explicit platform for an unrecognized GitLab host", async () => {
    fetchMock.mockResolvedValue(json({ ...PROJECT, path_with_namespace: "team/app" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: { repoUrl: "https://git.unknown.local/team/app" },
    });

    expect(res.json().valid).toBe(false);
    expect(res.json().error).toMatch(/Could not parse GitHub repo/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("GITLAB_HOSTS", "gitlab.corp.local,git.unknown.local");
    const explicit = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: { repoUrl: "https://git.unknown.local/team/app", gitPlatform: "gitlab" },
    });
    expect(explicit.json().valid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://git.unknown.local/api/v4/projects/team%2Fapp");
  });
});

describe("POST /api/setup/validate/repo with every platform offered (the default)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildRouteTestApp(setupRoutes);
  });

  it("asks the configured GitLab host with a port when the person picked GitLab", async () => {
    vi.stubEnv("GITLAB_HOSTS", "git.example.com:8443");
    fetchMock.mockResolvedValue(json({ ...PROJECT, path_with_namespace: "team/sub/app" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/validate/repo",
      payload: { repoUrl: "https://git.example.com:8443/team/sub/app", gitPlatform: "gitlab" },
    });

    expect(res.json()).toMatchObject({ valid: true, repo: { fullName: "team/sub/app" } });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://git.example.com:8443/api/v4/projects/team%2Fsub%2Fapp",
    );
    expect(mockGetGitToken).toHaveBeenCalledWith("gitlab", expect.anything());
  });
});

it("rejects CodeCommit browsing before host, credentials, or provider lookups", async () => {
  const app = await buildRouteTestApp(repoRoutes);
  try {
    const res = await app.inject({ method: "GET", url: "/api/repos/browse?platform=codecommit" });
    expect(res.json()).toMatchObject({
      repos: [],
      platform: "codecommit",
      error: expect.stringContaining("not supported"),
    });
    expect(mockRetrieveSecretWithFallback).not.toHaveBeenCalled();
    expect(mockListRepos).not.toHaveBeenCalled();
    expect(mockGetGitToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
