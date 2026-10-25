import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoRecord } from "./repo-service.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockEnsureWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();
const mockPlatform: Record<string, unknown> = {
  type: "gitlab",
  ensureWebhook: (...args: unknown[]) => mockEnsureWebhook(...args),
  deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
};
const ri = {
  platform: "gitlab",
  host: "gitlab.example.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://gitlab.example.com/api/v4",
};
const mockGetGitPlatformForRepo = vi.fn();
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

const mockUpdateRepo = vi.fn();
vi.mock("./repo-service.js", () => ({
  updateRepo: (...args: unknown[]) => mockUpdateRepo(...args),
}));

const mockEnsureSecret = vi.fn();
const mockEnsureGithubSecret = vi.fn();
vi.mock("./webhook-secret-service.js", () => ({
  ensureGitlabWebhookSecret: (...args: unknown[]) => mockEnsureSecret(...args),
  ensureGithubWebhookSecret: (...args: unknown[]) => mockEnsureGithubSecret(...args),
}));

const mockAppConfigured = vi.fn(() => false);
vi.mock("./github-app-service.js", () => ({
  isGitHubAppConfigured: () => mockAppConfigured(),
}));

import {
  GITHUB_WEBHOOK_EVENTS,
  GITLAB_WEBHOOK_EVENTS,
  ensureRepoWebhook,
  gitlabWebhookUrl,
  removeRepoWebhook,
  repoWebhookPlatforms,
  repoWebhooksFor,
} from "./repo-webhook-service.js";

const repo = {
  id: "repo-1",
  repoUrl: "https://gitlab.example.com/acme/widgets",
  gitPlatform: "gitlab",
  workspaceId: "ws-1",
  fullName: "acme/widgets",
  webhookId: null,
  webhookUrl: null,
  webhookSyncedAt: null,
  webhookError: null,
} as unknown as RepoRecord;

describe("repo-webhook-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://optio.example.com/api";
    delete process.env.PUBLIC_URL;
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: mockPlatform, ri });
    mockEnsureSecret.mockResolvedValue("tok-1");
    mockUpdateRepo.mockImplementation(async (_id: string, fields: Record<string, unknown>) => ({
      ...repo,
      ...fields,
    }));
  });

  afterEach(() => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_URL;
  });

  it("points the hook at the public API origin, or nowhere without one", () => {
    expect(gitlabWebhookUrl()).toBe("https://optio.example.com/api/webhooks/gitlab");
    delete process.env.PUBLIC_API_URL;
    process.env.PUBLIC_URL = "https://optio.example.com/";
    expect(gitlabWebhookUrl()).toBe("https://optio.example.com/api/webhooks/gitlab");
    delete process.env.PUBLIC_URL;
    expect(gitlabWebhookUrl()).toBeNull();
  });

  it("leaves a repo that is not on GitLab alone", async () => {
    const status = await ensureRepoWebhook({ ...repo, gitPlatform: "github" });
    expect(status).toEqual({ hookId: null, url: null, syncedAt: null, error: null });
    expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
    expect(mockUpdateRepo).not.toHaveBeenCalled();
  });

  it("stores why when the deployment has no public address, without calling GitLab", async () => {
    delete process.env.PUBLIC_API_URL;
    const status = await ensureRepoWebhook(repo);
    expect(status.error).toMatch(/PUBLIC_API_URL/);
    expect(status.hookId).toBeNull();
    expect(mockEnsureSecret).not.toHaveBeenCalled();
    expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
    expect(mockUpdateRepo).toHaveBeenCalledWith("repo-1", {
      webhookError: expect.stringMatching(/PUBLIC_API_URL/),
    });
  });

  it("creates the hook with the server's token and the shared secret, and records it", async () => {
    mockEnsureWebhook.mockResolvedValue({ hookId: "42", created: true });
    const status = await ensureRepoWebhook(repo, { userId: "u1" });

    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith(repo.repoUrl, {
      server: true,
      workspaceId: "ws-1",
      platformHint: "gitlab",
    });
    expect(mockEnsureWebhook).toHaveBeenCalledWith(ri, {
      url: "https://optio.example.com/api/webhooks/gitlab",
      token: "tok-1",
      events: [...GITLAB_WEBHOOK_EVENTS],
    });
    expect(GITLAB_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining(["push", "merge_requests", "note", "issues", "pipeline"]),
    );
    expect(mockUpdateRepo).toHaveBeenCalledWith("repo-1", {
      webhookId: "42",
      webhookUrl: "https://optio.example.com/api/webhooks/gitlab",
      webhookSyncedAt: expect.any(Date),
      webhookError: null,
    });
    expect(status).toEqual({
      hookId: "42",
      url: "https://optio.example.com/api/webhooks/gitlab",
      syncedAt: expect.any(Date),
      error: null,
    });
  });

  it("hands GitLab the hook it made before, so a moved public URL updates that hook", async () => {
    mockEnsureWebhook.mockResolvedValue({ hookId: "7", created: false });
    await ensureRepoWebhook({
      ...repo,
      webhookId: "7",
      webhookUrl: "https://old-optio.example.com/api/webhooks/gitlab",
    });
    expect(mockEnsureWebhook).toHaveBeenCalledWith(ri, {
      url: "https://optio.example.com/api/webhooks/gitlab",
      token: "tok-1",
      events: [...GITLAB_WEBHOOK_EVENTS],
      hookId: "7",
    });
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({
        webhookId: "7",
        webhookUrl: "https://optio.example.com/api/webhooks/gitlab",
      }),
    );
  });

  it("stores GitLab's refusal instead of throwing, keeping the old hook id", async () => {
    mockEnsureWebhook.mockRejectedValue(new Error("GitLab API error 403: forbidden"));
    mockUpdateRepo.mockImplementation(async (_id: string, fields: Record<string, unknown>) => ({
      ...repo,
      webhookId: "7",
      ...fields,
    }));
    const status = await ensureRepoWebhook({ ...repo, webhookId: "7" });
    expect(status.error).toBe("GitLab API error 403: forbidden");
    expect(status.hookId).toBe("7");
    expect(mockUpdateRepo).toHaveBeenCalledWith("repo-1", {
      webhookError: "GitLab API error 403: forbidden",
    });
  });

  it("reports a platform that cannot register hooks", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: { type: "gitlab" }, ri });
    const status = await ensureRepoWebhook(repo);
    expect(status.error).toMatch(/not supported/);
  });

  it("does not fail when the status cannot be stored", async () => {
    mockEnsureWebhook.mockResolvedValue({ hookId: "42", created: false });
    mockUpdateRepo.mockRejectedValue(new Error("db down"));
    const status = await ensureRepoWebhook(repo);
    expect(status.hookId).toBe("42");
    expect(status.error).toBeNull();
  });

  describe("removeRepoWebhook", () => {
    it("takes the hook off the project", async () => {
      mockDeleteWebhook.mockResolvedValue(undefined);
      await removeRepoWebhook({ ...repo, webhookId: "42" });
      expect(mockDeleteWebhook).toHaveBeenCalledWith(ri, "42");
    });

    it("does nothing without a hook, and swallows a refusal", async () => {
      await removeRepoWebhook(repo);
      expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
      mockDeleteWebhook.mockRejectedValue(new Error("GitLab API error 500"));
      await expect(removeRepoWebhook({ ...repo, webhookId: "42" })).resolves.toBeUndefined();
    });
  });

  describe("on GitHub (OPTIO_REPO_WEBHOOKS)", () => {
    const githubRepo = {
      ...repo,
      repoUrl: "https://github.com/acme/widgets",
      gitPlatform: "github",
    } as unknown as RepoRecord;
    const githubRi = { ...ri, platform: "github", host: "github.com" };

    afterEach(() => {
      delete process.env.OPTIO_REPO_WEBHOOKS;
      mockAppConfigured.mockReturnValue(false);
    });

    it("lists GitLab only by default; names, all and none otherwise", () => {
      expect(repoWebhookPlatforms({})).toEqual(["gitlab"]);
      expect(repoWebhookPlatforms({ OPTIO_REPO_WEBHOOKS: "github,gitlab" })).toEqual([
        "github",
        "gitlab",
      ]);
      expect(repoWebhookPlatforms({ OPTIO_REPO_WEBHOOKS: "github" })).toEqual(["github"]);
      expect(repoWebhookPlatforms({ OPTIO_REPO_WEBHOOKS: "all" })).toEqual(["github", "gitlab"]);
      expect(repoWebhookPlatforms({ OPTIO_REPO_WEBHOOKS: "none" })).toEqual([]);
    });

    it("registers nothing on GitHub by default", async () => {
      expect(repoWebhooksFor("github")).toBe(false);
      await ensureRepoWebhook(githubRepo);
      expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
    });

    it("registers the repository hook with a generated secret when named", async () => {
      process.env.OPTIO_REPO_WEBHOOKS = "gitlab,github";
      mockGetGitPlatformForRepo.mockResolvedValue({ platform: mockPlatform, ri: githubRi });
      mockEnsureGithubSecret.mockResolvedValue("gh-secret");
      mockEnsureWebhook.mockResolvedValue({ hookId: "99", created: true });

      const status = await ensureRepoWebhook(githubRepo);

      expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith(githubRepo.repoUrl, {
        server: true,
        workspaceId: "ws-1",
        platformHint: "github",
      });
      expect(mockEnsureWebhook).toHaveBeenCalledWith(githubRi, {
        url: "https://optio.example.com/api/webhooks/github",
        token: "gh-secret",
        events: [...GITHUB_WEBHOOK_EVENTS],
      });
      expect(GITHUB_WEBHOOK_EVENTS).toEqual(
        expect.arrayContaining(["push", "pull_request", "issues", "issue_comment"]),
      );
      expect(mockEnsureSecret).not.toHaveBeenCalled();
      expect(status).toMatchObject({
        hookId: "99",
        url: "https://optio.example.com/api/webhooks/github",
      });
    });

    it("leaves it to a configured GitHub App's own webhook", async () => {
      process.env.OPTIO_REPO_WEBHOOKS = "github";
      mockAppConfigured.mockReturnValue(true);
      expect(repoWebhooksFor("github")).toBe(false);
      await ensureRepoWebhook(githubRepo);
      expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
    });

    it("stops GitLab's too with none", async () => {
      process.env.OPTIO_REPO_WEBHOOKS = "none";
      await ensureRepoWebhook(repo);
      expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
    });

    it("takes the GitHub hook off when the repo goes", async () => {
      mockGetGitPlatformForRepo.mockResolvedValue({ platform: mockPlatform, ri: githubRi });
      await removeRepoWebhook({ ...githubRepo, webhookId: "99" });
      expect(mockDeleteWebhook).toHaveBeenCalledWith(githubRi, "99");
    });
  });
});
