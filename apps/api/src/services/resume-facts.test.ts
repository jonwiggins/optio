import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState, type WorldSnapshot } from "@optio/shared";

const mockRow = vi.fn();
const mockGetGitToken = vi.fn();
const mockGetPullRequest = vi.fn();
const mockFetchFailedJobLogs = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => mockRow() }) }),
  },
}));
vi.mock("../db/schema.js", () => ({
  tasks: { id: "id", createdBy: "created_by", workspaceId: "ws", ownerTeamId: "team" },
}));
vi.mock("./git-token-service.js", () => ({
  getGitToken: (...args: unknown[]) => mockGetGitToken(...args),
}));
vi.mock("./git-platform/index.js", () => ({
  createGitPlatform: () => ({ getPullRequest: (...a: unknown[]) => mockGetPullRequest(...a) }),
}));
vi.mock("./git-platform/gitlab-ci-logs.js", () => ({
  fetchFailedJobLogs: (...args: unknown[]) => mockFetchFailedJobLogs(...args),
}));
const mockFetchFailedGitHubJobLogs = vi.fn();
vi.mock("./git-platform/github-ci-logs.js", () => ({
  fetchFailedGitHubJobLogs: (...args: unknown[]) => mockFetchFailedGitHubJobLogs(...args),
}));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn() } }));

const { FACTS_TIMEOUT_MS, ciFailureLogsEnabled, loadResumeFacts } =
  await import("./resume-facts.js");

function snapshot(repoUrl = "https://gitlab.example.com/platform/my.service"): WorldSnapshot {
  return {
    run: {
      kind: "repo",
      ref: { kind: "repo", id: "task-1" },
      spec: { repoUrl, repoBranch: "develop", workspaceId: "ws-1" },
      status: {
        state: TaskState.PR_OPENED,
        prUrl: `${repoUrl}/-/merge_requests/12`,
      },
    },
    pr: { headSha: "snap-sha" },
  } as unknown as WorldSnapshot;
}

describe("loadResumeFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRow.mockReturnValue([{ createdBy: "u-1", workspaceId: "ws-1", ownerTeamId: "team-1" }]);
    mockGetGitToken.mockResolvedValue("glpat-token");
    mockGetPullRequest.mockResolvedValue({ baseBranch: "master", headSha: "head-sha" });
    mockFetchFailedJobLogs.mockResolvedValue({ pipelineId: 7, jobs: [], more: [] });
  });

  it("conflicts: the MR's target branch, read with the task's own token context", async () => {
    const facts = await loadResumeFacts(snapshot(), "conflicts");
    expect(facts).toEqual({ targetBranch: "master" });
    expect(mockGetGitToken).toHaveBeenCalledWith("gitlab", {
      userId: "u-1",
      workspaceId: "ws-1",
      ownerTeamId: "team-1",
      host: expect.any(String),
    });
    expect(mockGetPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "platform", repo: "my.service" }),
      12,
    );
    expect(mockFetchFailedJobLogs).not.toHaveBeenCalled();
  });

  it("ci_failure on GitLab: the failed jobs of the MR's head commit", async () => {
    const facts = await loadResumeFacts(snapshot(), "ci_failure");
    expect(facts).toEqual({
      targetBranch: "master",
      ciFailure: { pipelineId: 7, jobs: [], more: [] },
    });
    expect(mockFetchFailedJobLogs).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "gitlab" }),
      "glpat-token",
      "head-sha",
      { mrIid: 12 },
    );
  });

  it("falls back to the task's branch when the MR can't be read", async () => {
    mockGetPullRequest.mockRejectedValue(new Error("GitLab API error 500"));
    expect(await loadResumeFacts(snapshot(), "ci_failure")).toEqual({ targetBranch: "develop" });
  });

  it("falls back when there's no token", async () => {
    mockGetGitToken.mockRejectedValue(new Error("No GitLab token available"));
    expect(await loadResumeFacts(snapshot(), "conflicts")).toEqual({ targetBranch: "develop" });
  });

  it("keeps the target branch when only the logs fail", async () => {
    mockFetchFailedJobLogs.mockRejectedValue(new Error("timeout"));
    expect(await loadResumeFacts(snapshot(), "ci_failure")).toEqual({
      targetBranch: "master",
      ciFailure: null,
    });
  });

  it("asks nothing for a review resume", async () => {
    expect(await loadResumeFacts(snapshot(), "review")).toEqual({ targetBranch: "develop" });
    expect(mockGetGitToken).not.toHaveBeenCalled();
  });

  it("reads no logs from GitHub", async () => {
    const facts = await loadResumeFacts(snapshot("https://github.com/acme/repo"), "ci_failure");
    vi.unstubAllEnvs();
    expect(facts).toEqual({ targetBranch: "master" });
    expect(mockFetchFailedJobLogs).not.toHaveBeenCalled();
  });

  it("reads GitHub Actions' failed jobs with OPTIO_CI_FAILURE_LOGS=true", async () => {
    vi.stubEnv("OPTIO_PROFILE", "full");
    vi.stubEnv("OPTIO_CI_FAILURE_LOGS", "true");
    mockGetGitToken.mockResolvedValue("ghs-token");
    mockFetchFailedGitHubJobLogs.mockResolvedValue({ pipelineId: 9, jobs: [], more: [] });
    const facts = await loadResumeFacts(snapshot("https://github.com/acme/repo"), "ci_failure");
    vi.unstubAllEnvs();
    expect(facts).toEqual({
      targetBranch: "master",
      ciFailure: { pipelineId: 9, jobs: [], more: [] },
    });
    expect(mockFetchFailedGitHubJobLogs).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "github", owner: "acme", repo: "repo" }),
      "ghs-token",
      "head-sha",
    );
    expect(mockFetchFailedJobLogs).not.toHaveBeenCalled();
  });

  it("reads no logs at all with OPTIO_CI_FAILURE_LOGS=false", async () => {
    vi.stubEnv("OPTIO_CI_FAILURE_LOGS", "false");
    const facts = await loadResumeFacts(snapshot(), "ci_failure");
    vi.unstubAllEnvs();
    expect(facts).toEqual({ targetBranch: "master" });
    expect(mockFetchFailedJobLogs).not.toHaveBeenCalled();
  });

  it("stops waiting well inside the reconcile job's 30 s lock, with the fallback", async () => {
    expect(FACTS_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    vi.useFakeTimers();
    try {
      mockGetPullRequest.mockReturnValue(new Promise(() => {})); // GitLab never answers
      const pending = loadResumeFacts(snapshot(), "ci_failure");
      await vi.advanceTimersByTimeAsync(FACTS_TIMEOUT_MS);
      expect(await pending).toEqual({ targetBranch: "develop" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ciFailureLogsEnabled", () => {
  it("is GitLab's only by default, every platform's when true, none when false", () => {
    expect(ciFailureLogsEnabled("gitlab", {})).toBe(true);
    expect(ciFailureLogsEnabled("github", {})).toBe(false);
    expect(ciFailureLogsEnabled("github", { OPTIO_CI_FAILURE_LOGS: "true" })).toBe(true);
    expect(ciFailureLogsEnabled("codecommit", { OPTIO_CI_FAILURE_LOGS: "true" })).toBe(false);
    expect(ciFailureLogsEnabled("gitlab", { OPTIO_CI_FAILURE_LOGS: "false" })).toBe(false);
  });
});
