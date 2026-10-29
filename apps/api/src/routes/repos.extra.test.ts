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
  // As the service: on add only when the deployment set OPTIO_REPO_WEBHOOKS.
  repoWebhooksOnAdd: (platform: string) =>
    !!process.env.OPTIO_REPO_WEBHOOKS && mockRepoWebhooksFor(platform),
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

describe("POST /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
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
});

describe("PATCH /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
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
});
