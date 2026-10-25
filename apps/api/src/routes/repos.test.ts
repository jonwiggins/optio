import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { modelBelongsToAgentCatalog } from "@optio/shared";

// ─── Mocks ───

const mockListRepos = vi.fn();
const mockGetRepo = vi.fn();
const mockGetRepoByUrl = vi.fn();
const mockCreateRepo = vi.fn();
const mockUpdateRepo = vi.fn();
const mockDeleteRepo = vi.fn();

const mockModelBelongsToAgent = vi.fn(async (agentType: string, model: string) =>
  modelBelongsToAgentCatalog(agentType, model),
);
vi.mock("../services/agent-options-service.js", () => ({
  modelBelongsToAgent: (...args: unknown[]) =>
    mockModelBelongsToAgent(...(args as [string, string])),
}));

vi.mock("../services/repo-service.js", () => ({
  listRepos: (...args: unknown[]) => mockListRepos(...args),
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
  getRepoByUrl: (...args: unknown[]) => mockGetRepoByUrl(...args),
  createRepo: (...args: unknown[]) => mockCreateRepo(...args),
  updateRepo: (...args: unknown[]) => mockUpdateRepo(...args),
  deleteRepo: (...args: unknown[]) => mockDeleteRepo(...args),
  autoMergeConfirmerName: vi.fn().mockResolvedValue("Ann"),
}));

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("../services/repo-detect-service.js", () => ({
  detectRepoConfig: vi.fn().mockResolvedValue({ imagePreset: "node", testCommand: "npm test" }),
}));

const mockGetGitHubToken = vi.fn();
vi.mock("../services/github-token-service.js", () => ({
  getGitHubToken: (...args: unknown[]) => mockGetGitHubToken(...args),
}));

const mockBrowse = vi.fn();
vi.mock("../services/github-repo-browse-service.js", () => ({
  browseGitHubRepos: (...args: unknown[]) => mockBrowse(...args),
}));

const mockGetGitPlatformForRepo = vi.fn();
vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

// Both run after the reply and never throw; a plain vi.fn() would hand the
// route `undefined` instead of a promise.
const mockEnsureRepoWebhook = vi.fn().mockResolvedValue(undefined);
const mockRemoveRepoWebhook = vi.fn().mockResolvedValue(undefined);
const mockRepoWebhooksFor = vi.fn((platform: string) => platform === "gitlab");
vi.mock("../services/repo-webhook-service.js", () => ({
  ensureRepoWebhook: (...args: unknown[]) => mockEnsureRepoWebhook(...args),
  removeRepoWebhook: (...args: unknown[]) => mockRemoveRepoWebhook(...args),
  repoWebhooksFor: (platform: string) => mockRepoWebhooksFor(platform),
}));

import { repoRoutes } from "./repos.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(repoRoutes);
}

const mockRepoData = {
  id: "repo-1",
  repoUrl: "https://github.com/org/repo",
  fullName: "org/repo",
  workspaceId: "ws-1",
  cpuRequest: null,
  cpuLimit: null,
  memoryRequest: null,
  memoryLimit: null,
};

describe("GET /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists repos scoped to workspace", async () => {
    mockListRepos.mockResolvedValue([mockRepoData]);

    const res = await app.inject({ method: "GET", url: "/api/repos" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(mockListRepos).toHaveBeenCalledWith("ws-1");
  });
});

describe("GET /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repo.id).toBe("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for repo in different workspace", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/repos/:id/branches", () => {
  const gitlabRepo = {
    ...mockRepoData,
    repoUrl: "https://gitlab.example/group/project",
    fullName: "group/project",
    gitPlatform: "gitlab",
    defaultBranch: "develop",
  };
  const ri = {
    platform: "gitlab",
    host: "gitlab.example",
    owner: "group",
    repo: "project",
    apiBaseUrl: "https://gitlab.example/api/v4",
  };

  beforeEach(() => vi.clearAllMocks());

  it("asks the repo's platform (by the stored kind) for branches matching q", async () => {
    mockGetRepo.mockResolvedValue(gitlabRepo);
    const listBranches = vi.fn().mockResolvedValue([
      { name: "develop", default: true, protected: true },
      { name: "release/1.0", default: false, protected: false },
    ]);
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: { listBranches }, ri });
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: "u1", workspaceId: "ws-1", workspaceRole: "member" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/repo-1/branches?q=rel&limit=20",
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      branches: [
        { name: "develop", default: true, protected: true },
        { name: "release/1.0", default: false, protected: false },
      ],
      defaultBranch: "develop",
    });
    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith("https://gitlab.example/group/project", {
      server: true,
      workspaceId: "ws-1",
      platformHint: "gitlab",
    });
    expect(listBranches).toHaveBeenCalledWith(ri, { search: "rel", perPage: 20 });
  });

  it("lists up to 30 without a query", async () => {
    mockGetRepo.mockResolvedValue(gitlabRepo);
    const listBranches = vi.fn().mockResolvedValue([]);
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: { listBranches }, ri });
    const app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1/branches" });

    expect(res.statusCode).toBe(200);
    expect(listBranches).toHaveBeenCalledWith(ri, { search: undefined, perPage: 30 });
  });

  it("answers an empty list with the reason when the platform can't be asked", async () => {
    mockGetRepo.mockResolvedValue(gitlabRepo);
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No GitLab token available"));
    const app = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1/branches?q=x" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      branches: [],
      defaultBranch: "develop",
      error: "No GitLab token available",
    });
  });

  it("returns 404 for a missing repo or one in another workspace", async () => {
    const app = await buildTestApp();
    mockGetRepo.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url: "/api/repos/nope/branches" })).statusCode).toBe(
      404,
    );
    mockGetRepo.mockResolvedValueOnce({ ...gitlabRepo, workspaceId: "ws-other" });
    expect(
      (await app.inject({ method: "GET", url: "/api/repos/repo-1/branches" })).statusCode,
    ).toBe(404);
    expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
  });

  it("is closed to viewers", async () => {
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: "u2", workspaceId: "ws-1", workspaceRole: "viewer" },
    });
    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1/branches" });
    expect(res.statusCode).toBe(403);
    expect(mockGetRepo).not.toHaveBeenCalled();
  });
});

describe("POST /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
        workspaceId: "ws-1",
      }),
    );
  });

  it("passes the chosen platform for a host it cannot tell from the URL", async () => {
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue({ ...mockRepoData, gitPlatform: "gitlab" });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://git.example.com/group/app",
        fullName: "group/app",
        gitPlatform: "gitlab",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://git.example.com/group/app",
        gitPlatform: "gitlab",
      }),
    );
  });

  it("refuses an unknown gitPlatform", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: "https://git.example.com/g/a", fullName: "g/a", gitPlatform: "svn" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateRepo).not.toHaveBeenCalled();
  });

  it("rejects duplicate repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already been added");
  });

  it("refuses a repo on a git platform OPTIO_GIT_PLATFORMS leaves out", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    try {
      mockGetRepoByUrl.mockResolvedValue(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoUrl: "https://github.com/org/repo", fullName: "org/repo" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("github isn't available in this deployment");
      expect(mockCreateRepo).not.toHaveBeenCalled();

      // GitLab is on the list.
      mockCreateRepo.mockResolvedValue({
        ...mockRepoData,
        repoUrl: "https://gitlab.com/org/repo",
        gitPlatform: "gitlab",
      });
      const ok = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoUrl: "https://gitlab.com/org/repo", fullName: "org/repo" },
      });
      expect(ok.statusCode).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects missing required fields (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: "https://github.com/org/repo" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("auto-detects a GitLab repo's config without any GitHub token", async () => {
    const { detectRepoConfig } = await import("../services/repo-detect-service.js");
    mockGetRepoByUrl.mockResolvedValue(null);
    const gitlab = {
      ...mockRepoData,
      repoUrl: "https://gitlab.example.com/org/repo",
      gitPlatform: "gitlab",
    };
    mockCreateRepo.mockResolvedValue(gitlab);
    mockGetGitHubToken.mockRejectedValue(new Error("no GitHub token"));

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: gitlab.repoUrl, fullName: "org/repo" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockGetGitHubToken).not.toHaveBeenCalled();
    expect(detectRepoConfig).toHaveBeenCalledWith(gitlab.repoUrl, "");
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      gitlab.id,
      expect.objectContaining({ testCommand: "npm test" }),
    );
  });

  it("still waits on a GitHub token for a GitHub repo", async () => {
    const { detectRepoConfig } = await import("../services/repo-detect-service.js");
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue({ ...mockRepoData, gitPlatform: "github" });
    mockGetGitHubToken.mockRejectedValue(new Error("no GitHub token"));

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: mockRepoData.repoUrl, fullName: mockRepoData.fullName },
    });

    expect(res.statusCode).toBe(201);
    expect(detectRepoConfig).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, imagePreset: "node" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ imagePreset: "node" }),
    );
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/nonexistent",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(404);
  });

  describe("an image preset this deployment doesn't have (OPTIO_AGENT_PRESETS)", () => {
    const saved = process.env.OPTIO_AGENT_PRESETS;
    beforeEach(() => {
      process.env.OPTIO_AGENT_PRESETS = "base,node,python,go,rust,full";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.OPTIO_AGENT_PRESETS;
      else process.env.OPTIO_AGENT_PRESETS = saved;
    });

    it("is refused with a message naming it and what there is", async () => {
      mockGetRepo.mockResolvedValue(mockRepoData);
      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { imagePreset: "dind" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Image preset "dind" is not available in this deployment (available: base, node, python, go, rust, full)',
      );
      expect(mockUpdateRepo).not.toHaveBeenCalled();
    });

    it("is accepted once the deployment lists it", async () => {
      process.env.OPTIO_AGENT_PRESETS = "base,dind";
      mockGetRepo.mockResolvedValue(mockRepoData);
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, imagePreset: "dind" });
      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { imagePreset: "dind" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it("accepts a review model only the live list offers (#644)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      reviewAgentType: "claude-code",
      reviewModel: "claude-opus-5-5",
    });
    mockModelBelongsToAgent.mockResolvedValueOnce(true);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { reviewAgentType: "claude-code", reviewModel: "claude-opus-5-5" },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(mockModelBelongsToAgent).toHaveBeenCalledWith("claude-code", "claude-opus-5-5", {
      workspaceId: "ws-1",
    });
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ reviewModel: "claude-opus-5-5" }),
    );
  });

  it("rejects a review model the agent offers in neither list", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockModelBelongsToAgent.mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { reviewAgentType: "gemini", reviewModel: "sonnet" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not belong to the "gemini" catalog/);
    expect(mockUpdateRepo).not.toHaveBeenCalled();
  });

  it("clears reviewModel back to the default with null", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, reviewModel: "opus" });
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, reviewModel: null });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { reviewModel: null },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ reviewModel: null }),
    );
    expect(res.json().repo.reviewModel).toBeNull();
  });

  it("clears reviewModel while changing the review agent", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, reviewModel: "sonnet" });
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, reviewModel: null });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { reviewAgentType: "gemini", reviewModel: null },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ reviewAgentType: "gemini", reviewModel: null }),
    );
  });

  it("refuses an agent OPTIO_RUNTIMES leaves out, as the default or the reviewer", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    try {
      mockGetRepo.mockResolvedValue(mockRepoData);
      for (const payload of [{ defaultAgentType: "codex" }, { reviewAgentType: "gemini" }]) {
        const res = await app.inject({ method: "PATCH", url: "/api/repos/repo-1", payload });
        expect(res.statusCode).toBe(400);
        expect(JSON.stringify(res.json())).toMatch(/isn't available in this deployment/);
      }
      expect(mockUpdateRepo).not.toHaveBeenCalled();
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, defaultAgentType: "opencode" });
      const ok = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { defaultAgentType: "opencode", reviewAgentType: null },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts openclaw as the default agent type", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, defaultAgentType: "openclaw" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { defaultAgentType: "openclaw" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ defaultAgentType: "openclaw" }),
    );
  });

  it("persists openclawModel and openclawAgent settings", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      openclawModel: "openclaw-model-x",
      openclawAgent: "build",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { openclawModel: "openclaw-model-x", openclawAgent: "build" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ openclawModel: "openclaw-model-x", openclawAgent: "build" }),
    );
  });

  it("accepts null openclawModel and openclawAgent (clearing the fields)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      openclawModel: null,
      openclawAgent: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { openclawModel: null, openclawAgent: null },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ openclawModel: null, openclawAgent: null }),
    );
  });

  it("rejects invalid CPU quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { cpuRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("rejects invalid memory quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { memoryRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid public Slack webhook URL", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" }),
    );
  });

  it("accepts null slackWebhookUrl (clearing the field)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, slackWebhookUrl: null });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: null },
    });

    expect(res.statusCode).toBe(200);
  });

  it("rejects slackWebhookUrl targeting localhost (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://localhost:8080/hook" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting internal K8s address (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://postgres.default.svc.cluster.local:5432" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting AWS metadata endpoint (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://169.254.169.254/latest/meta-data/" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting private IP (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://10.0.0.1:8080/hook" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl that is not a valid URL", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "not-a-url" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  describe("automatic merging without the confirmation (the default)", () => {
    it("turns it on with the checkbox alone", async () => {
      delete process.env.OPTIO_MERGE_CONFIRMATION;
      mockGetRepo.mockResolvedValue({ ...mockRepoData, autoMerge: false });
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, autoMerge: true });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: true },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateRepo.mock.calls[0]![1]).toMatchObject({ autoMerge: true });
    });
  });

  describe("automatic merging (the checkbox AND the confirmation)", () => {
    // The deployment asks for the confirmation (off by default).
    beforeEach(() => {
      process.env.OPTIO_MERGE_CONFIRMATION = "true";
    });
    afterEach(() => {
      delete process.env.OPTIO_MERGE_CONFIRMATION;
    });
    it("refuses turning it on without the confirmation", async () => {
      mockGetRepo.mockResolvedValue({ ...mockRepoData, autoMerge: false });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: true },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Automatic merging needs the checkbox and the confirmation");
      expect(mockUpdateRepo).not.toHaveBeenCalled();
    });

    it("refuses a row that was on before anyone confirmed it", async () => {
      mockGetRepo.mockResolvedValue({
        ...mockRepoData,
        autoMerge: true,
        autoMergeConfirmedAt: null,
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: true, autoMergeConfirmed: false },
      });

      expect(res.statusCode).toBe(400);
      expect(mockUpdateRepo).not.toHaveBeenCalled();
    });

    it("stamps when and who once confirmed", async () => {
      mockGetRepo.mockResolvedValue({ ...mockRepoData, autoMerge: false });
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, autoMerge: true });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: true, autoMergeConfirmed: true },
      });

      expect(res.statusCode).toBe(200);
      const patch = mockUpdateRepo.mock.calls[0]![1];
      expect(patch).toMatchObject({ autoMerge: true, autoMergeConfirmedBy: "user-1" });
      expect(patch.autoMergeConfirmedAt).toBeInstanceOf(Date);
      expect(patch).not.toHaveProperty("autoMergeConfirmed");
    });

    it("keeps the stamp when a settings save sends it on again", async () => {
      mockGetRepo.mockResolvedValue({
        ...mockRepoData,
        autoMerge: true,
        autoMergeConfirmedAt: new Date("2026-10-01T00:00:00Z"),
        autoMergeConfirmedBy: "user-2",
      });
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, autoMerge: true });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: true, imagePreset: "node" },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateRepo.mock.calls[0]![1]).not.toHaveProperty("autoMergeConfirmedAt");
    });

    it("clears the stamp when it's turned off", async () => {
      mockGetRepo.mockResolvedValue({ ...mockRepoData, autoMerge: true });
      mockUpdateRepo.mockResolvedValue({ ...mockRepoData, autoMerge: false });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/repos/repo-1",
        payload: { autoMerge: false },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateRepo).toHaveBeenCalledWith(
        "repo-1",
        expect.objectContaining({
          autoMerge: false,
          autoMergeConfirmedAt: null,
          autoMergeConfirmedBy: null,
        }),
      );
    });
  });
});

describe("DELETE /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockDeleteRepo.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteRepo).toHaveBeenCalledWith("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/repos/github/accessible (#623)", () => {
  beforeEach(() => vi.clearAllMocks());

  const repo = {
    fullName: "acme/api",
    cloneUrl: "https://github.com/acme/api.git",
    htmlUrl: "https://github.com/acme/api",
    defaultBranch: "main",
    isPrivate: true,
    description: null,
    pushedAt: null,
  };

  it("lists repos with the server's workspace token, passing search + paging", async () => {
    mockGetGitHubToken.mockResolvedValue("ghs_install");
    mockBrowse.mockResolvedValue({ repos: [repo], hasMore: true });
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: "u1", workspaceId: "ws-1", workspaceRole: "member" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/repos/github/accessible?q=api&page=2&perPage=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repos: [repo], hasMore: true, page: 2, perPage: 10 });
    expect(mockGetGitHubToken).toHaveBeenCalledWith({ server: true, workspaceId: "ws-1" });
    expect(mockBrowse).toHaveBeenCalledWith("ghs_install", { q: "api", page: 2, perPage: 10 });
  });

  it("says so when no GitHub credentials are configured", async () => {
    mockGetGitHubToken.mockRejectedValue(new Error("No GitHub token available"));
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/repos/github/accessible" });
    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toEqual([]);
    expect(res.json().error).toMatch(/No GitHub credentials/);
    expect(mockBrowse).not.toHaveBeenCalled();
  });

  it("is closed to viewers", async () => {
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: "u2", workspaceId: "ws-1", workspaceRole: "viewer" },
    });
    const res = await app.inject({ method: "GET", url: "/api/repos/github/accessible" });
    expect(res.statusCode).toBe(403);
    expect(mockGetGitHubToken).not.toHaveBeenCalled();
  });
});

describe("the GitLab webhook Optio keeps on a repo", () => {
  const gitlabRepo = {
    ...mockRepoData,
    id: "repo-gl",
    repoUrl: "https://gitlab.example.com/acme/widgets",
    fullName: "acme/widgets",
    gitPlatform: "gitlab",
  };
  const okStatus = {
    hookId: "42",
    url: "https://optio.example.com/api/webhooks/gitlab",
    syncedAt: new Date("2026-10-22T10:00:00Z"),
    error: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureRepoWebhook.mockResolvedValue(okStatus);
    mockRemoveRepoWebhook.mockResolvedValue(undefined);
  });

  it("is created when a GitLab repo is added, with the adder as actor", async () => {
    const app = await buildTestApp();
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue(gitlabRepo);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: gitlabRepo.repoUrl, fullName: gitlabRepo.fullName },
    });

    expect(res.statusCode).toBe(201);
    expect(mockEnsureRepoWebhook).toHaveBeenCalledWith(gitlabRepo, { userId: "user-1" });
  });

  it("is not attempted for a repo on another platform", async () => {
    const app = await buildTestApp();
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue({ ...mockRepoData, gitPlatform: "github" });

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: mockRepoData.repoUrl, fullName: mockRepoData.fullName },
    });

    expect(res.statusCode).toBe(201);
    expect(mockEnsureRepoWebhook).not.toHaveBeenCalled();
  });

  it("comes off the project when the repo is removed", async () => {
    const app = await buildTestApp();
    mockGetRepo.mockResolvedValue({ ...gitlabRepo, webhookId: "42" });
    mockDeleteRepo.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/repo-gl" });

    expect(res.statusCode).toBe(204);
    expect(mockRemoveRepoWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: "repo-gl", webhookId: "42" }),
    );
    expect(mockDeleteRepo).toHaveBeenCalledWith("repo-gl");
  });

  describe("POST /api/repos/:id/webhook (repair)", () => {
    it("re-runs the setup and returns the stored outcome", async () => {
      const app = await buildTestApp();
      mockGetRepo.mockResolvedValue(gitlabRepo);

      const res = await app.inject({ method: "POST", url: "/api/repos/repo-gl/webhook" });

      expect(res.statusCode).toBe(200);
      expect(res.json().webhook).toEqual({
        hookId: "42",
        url: "https://optio.example.com/api/webhooks/gitlab",
        syncedAt: "2026-10-22T10:00:00.000Z",
        error: null,
      });
      expect(mockEnsureRepoWebhook).toHaveBeenCalledWith(gitlabRepo, { userId: "user-1" });
    });

    it("answers 200 with the error when GitLab refused", async () => {
      const app = await buildTestApp();
      mockGetRepo.mockResolvedValue(gitlabRepo);
      mockEnsureRepoWebhook.mockResolvedValue({
        hookId: null,
        url: null,
        syncedAt: null,
        error: "GitLab API error 403: forbidden",
      });

      const res = await app.inject({ method: "POST", url: "/api/repos/repo-gl/webhook" });

      expect(res.statusCode).toBe(200);
      expect(res.json().webhook.error).toBe("GitLab API error 403: forbidden");
    });

    it("is 404 for a missing repo or one in another workspace, 400 off GitLab", async () => {
      const app = await buildTestApp();
      mockGetRepo.mockResolvedValue(null);
      expect(
        (await app.inject({ method: "POST", url: "/api/repos/nope/webhook" })).statusCode,
      ).toBe(404);

      mockGetRepo.mockResolvedValue({ ...gitlabRepo, workspaceId: "ws-other" });
      expect(
        (await app.inject({ method: "POST", url: "/api/repos/repo-gl/webhook" })).statusCode,
      ).toBe(404);

      mockGetRepo.mockResolvedValue({ ...mockRepoData, gitPlatform: "github" });
      const res = await app.inject({ method: "POST", url: "/api/repos/repo-1/webhook" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not enabled for this platform/);
      expect(mockEnsureRepoWebhook).not.toHaveBeenCalled();
    });

    it("is closed to members", async () => {
      const app = await buildRouteTestApp(repoRoutes, {
        user: { id: "u2", workspaceId: "ws-1", workspaceRole: "member" },
      });
      mockGetRepo.mockResolvedValue(gitlabRepo);
      const res = await app.inject({ method: "POST", url: "/api/repos/repo-gl/webhook" });
      expect(res.statusCode).toBe(403);
      expect(mockEnsureRepoWebhook).not.toHaveBeenCalled();
    });
  });

  describe("on GitHub, when OPTIO_REPO_WEBHOOKS names it (repoWebhooksFor)", () => {
    const githubRepo = { ...mockRepoData, gitPlatform: "github" };

    beforeEach(() => {
      mockRepoWebhooksFor.mockImplementation((p: string) => p === "gitlab" || p === "github");
    });
    afterEach(() => {
      mockRepoWebhooksFor.mockImplementation((p: string) => p === "gitlab");
    });

    it("is created when a GitHub repo is added", async () => {
      const app = await buildTestApp();
      mockGetRepoByUrl.mockResolvedValue(null);
      mockCreateRepo.mockResolvedValue(githubRepo);
      const res = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoUrl: mockRepoData.repoUrl, fullName: mockRepoData.fullName },
      });
      expect(res.statusCode).toBe(201);
      expect(mockEnsureRepoWebhook).toHaveBeenCalledWith(githubRepo, { userId: "user-1" });
    });

    it("can be repaired", async () => {
      const app = await buildTestApp();
      mockGetRepo.mockResolvedValue(githubRepo);
      const res = await app.inject({ method: "POST", url: "/api/repos/repo-1/webhook" });
      expect(res.statusCode).toBe(200);
      expect(mockEnsureRepoWebhook).toHaveBeenCalledWith(githubRepo, { userId: "user-1" });
    });
  });
});
