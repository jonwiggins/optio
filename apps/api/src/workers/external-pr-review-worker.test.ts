/**
 * The external-PR sweep resolves each repo's platform and token in the
 * repo's own scope: its workspace (a workspace's GITLAB_TOKEN or GitHub PAT)
 * and the platform the repo was added as (a self-hosted GitLab on a host
 * the URL alone doesn't name).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const selectResults: unknown[][] = [];
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => selectResults.shift() ?? [] }),
    }),
  },
}));

const mockGetGitPlatformForRepo = vi.fn();
vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

const mockLaunchPrReview = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/pr-review-service.js", () => ({
  launchPrReview: (...args: unknown[]) => mockLaunchPrReview(...args),
  isOptioAuthoredPr: async () => false,
  preferredReview: (_a: unknown, b: unknown) => b,
}));

vi.mock("bullmq", () => ({ Queue: class {}, Worker: class {} }));
vi.mock("../services/redis-config.js", () => ({ getBullMQOptions: () => ({}) }));
vi.mock("../services/repeat-jobs.js", () => ({ scheduleRepeat: async () => {} }));
vi.mock("../services/poller-lease.js", () => ({ underPollerLease: async () => {} }));
vi.mock("../telemetry/instrument-worker.js", () => ({
  instrumentWorkerProcessor: (_n: string, fn: unknown) => fn,
}));
vi.mock("./pr-watcher-worker.js", () => ({ determineCheckStatus: () => "passing" }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { sweepExternalPrs } from "./external-pr-review-worker.js";

const repo = {
  id: "repo-1",
  repoUrl: "https://git.example.com/acme/app",
  workspaceId: "ws-1",
  gitPlatform: "gitlab",
  externalReviewMode: "on_pr_post",
  externalReviewFilters: null,
  externalReviewWaitForCi: false,
};
const ri = { platform: "gitlab", host: "git.example.com", owner: "acme", repo: "app" };
const pr = {
  url: "https://git.example.com/acme/app/-/merge_requests/3",
  number: 3,
  headSha: "abc123",
  draft: false,
  author: "alice",
  labels: [],
};

describe("sweepExternalPrs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.length = 0;
  });

  it("resolves the platform in the repo's workspace, as the platform it was added as", async () => {
    const listOpenPullRequests = vi.fn().mockResolvedValue([pr]);
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: { listOpenPullRequests }, ri });
    selectResults.push([repo], []);

    await sweepExternalPrs();

    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith(repo.repoUrl, {
      server: true,
      workspaceId: "ws-1",
      platformHint: "gitlab",
    });
    expect(listOpenPullRequests).toHaveBeenCalledWith(ri, { perPage: 50 });
    expect(mockLaunchPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: pr.url, workspaceId: "ws-1", origin: "auto" }),
    );
  });

  it("skips a repo whose platform can't be resolved and goes on with the next", async () => {
    const listOpenPullRequests = vi.fn().mockResolvedValue([]);
    mockGetGitPlatformForRepo
      .mockRejectedValueOnce(new Error("Refusing to send git credentials"))
      .mockResolvedValueOnce({ platform: { listOpenPullRequests }, ri });
    selectResults.push([repo, { ...repo, id: "repo-2", workspaceId: null, gitPlatform: null }]);

    await sweepExternalPrs();

    expect(mockGetGitPlatformForRepo).toHaveBeenCalledTimes(2);
    expect(mockGetGitPlatformForRepo).toHaveBeenLastCalledWith(repo.repoUrl, {
      server: true,
      workspaceId: null,
      platformHint: undefined,
    });
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
  });
});
