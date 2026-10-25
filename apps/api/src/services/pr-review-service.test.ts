import { describe, it, expect, vi, beforeEach } from "vitest";

// enqueueReviewRun for someone else's MR: the depth it renders into the
// prompt, the test command, and the turn budget stored on the run.

const selectWhere = vi.fn();
const insertValues = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: (...a: unknown[]) => selectWhere(...a) }) }),
    insert: () => ({
      values: (v: unknown) => {
        insertValues(v);
        return { returning: async () => [{ id: "run-1", ...(v as object) }] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  },
}));

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn(),
  isKnownGitLabHost: vi.fn(async (host: string) => host === "git.example.com"),
}));
vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));
vi.mock("./run-log-service.js", () => ({}));
vi.mock("./event-bus.js", () => ({ publishEvent: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const queueAdd = vi.fn();
const reviewOwnerTeam = vi.fn();
vi.mock("../workers/pr-review-worker.js", () => ({
  prReviewRunQueue: { add: queueAdd },
  reviewOwnerTeam: (...a: unknown[]) => reviewOwnerTeam(...a),
}));

const getSettings = vi.fn();
vi.mock("./optio-settings-service.js", () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
}));

import { enqueueReviewRun, getPrStatus, mergePr } from "./pr-review-service.js";
import { getGitPlatformForRepo, isKnownGitLabHost } from "./git-token-service.js";

const review = {
  id: "rev-1",
  state: "reviewing",
  repoUrl: "https://gitlab.example.com/group/app",
  repoOwner: "group",
  repoName: "app",
  prNumber: 12,
  prUrl: "https://gitlab.example.com/group/app/-/merge_requests/12",
  headSha: "abc",
  workspaceId: "ws-1",
};

const prContext = {
  prTitle: "Speed up the parser",
  prBody: "",
  existingReviews: "",
  prComments: "",
  inlineComments: "",
  headSha: "abc",
};

async function enqueue(repoConfig: Record<string, unknown>, workspace?: Record<string, unknown>) {
  selectWhere.mockResolvedValueOnce([review]);
  getSettings.mockResolvedValueOnce({
    reviewDepth: "thorough",
    reviewTestCommand: null,
    ...workspace,
  });
  await enqueueReviewRun("rev-1", "initial", {
    prContext,
    repoConfig: { defaultBranch: "main", ...repoConfig } as never,
  });
  return insertValues.mock.calls[0][0] as {
    prompt: string;
    metadata: { reviewDepth: string; maxTurnsReview: number };
  };
}

describe("enqueueReviewRun: review depth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a light review reads the diff only: no tests, half the turns", async () => {
    const run = await enqueue({
      reviewDepth: "light",
      testCommand: "pnpm test",
      maxTurnsReview: 40,
    });
    expect(run.metadata.reviewDepth).toBe("light");
    expect(run.metadata.maxTurnsReview).toBe(20);
    expect(run.prompt).toContain("LIGHT review");
    expect(run.prompt).not.toContain("pnpm test");
    expect(run.prompt).toContain("cat > .optio/review-draft.json");
  });

  it("a thorough review runs the repo's test command", async () => {
    const run = await enqueue({ reviewDepth: "thorough", testCommand: "pnpm test" });
    expect(run.metadata.reviewDepth).toBe("thorough");
    expect(run.metadata.maxTurnsReview).toBe(30);
    expect(run.prompt).not.toContain("LIGHT review");
    expect(run.prompt).toContain("pnpm test");
  });

  it("follows the workspace's depth and test command when the repo leaves them unset", async () => {
    const run = await enqueue(
      { reviewDepth: null, testCommand: null },
      { reviewDepth: "thorough", reviewTestCommand: "make check" },
    );
    expect(run.prompt).toContain("make check");
    expect(getSettings).toHaveBeenCalledWith("ws-1");

    vi.clearAllMocks();
    const light = await enqueue({ reviewDepth: null }, { reviewDepth: "light" });
    expect(light.metadata.reviewDepth).toBe("light");
  });

  it("renders the repo's own review prompt with the depth variables", async () => {
    const run = await enqueue({
      reviewDepth: "light",
      reviewPromptTemplate:
        "Review !{{PR_NUMBER}} {{REVIEW_DEPTH}}{{#if REVIEW_LIGHT}} quickly{{/if}}",
    });
    expect(run.prompt).toBe("Review !12 light quickly");
  });
});

describe("enqueueReviewRun: whose token reads the PR (the run's rule, reviewOwnerTeam)", () => {
  const platform = {
    getPullRequest: vi.fn(async () => ({ title: "T", body: "", headSha: "def" })),
    getReviews: vi.fn(async () => []),
    getIssueComments: vi.fn(async () => []),
    getInlineComments: vi.fn(async () => []),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitPlatformForRepo).mockResolvedValue({ platform, ri: {} } as never);
  });

  async function rereview(createdBy?: string) {
    selectWhere.mockResolvedValueOnce([review]);
    getSettings.mockResolvedValueOnce({ reviewDepth: "light", reviewTestCommand: null });
    await enqueueReviewRun("rev-1", "rereview", {
      createdBy,
      repoConfig: { defaultBranch: "main" } as never,
    });
  }

  it("a team's work's PR: the team's token, then the organization's — never the asker's own", async () => {
    reviewOwnerTeam.mockResolvedValue("team-1");
    await rereview("member-1");
    expect(reviewOwnerTeam).toHaveBeenCalledWith({
      prUrl: review.prUrl,
      workspaceId: "ws-1",
      createdBy: "member-1",
    });
    expect(getGitPlatformForRepo).toHaveBeenCalledWith(review.repoUrl, {
      userId: undefined,
      workspaceId: "ws-1",
      ownerTeamId: "team-1",
      server: true,
    });
  });

  it("anyone else's: the asker's own, then the organization's", async () => {
    reviewOwnerTeam.mockResolvedValue(null);
    await rereview("someone");
    expect(getGitPlatformForRepo).toHaveBeenCalledWith(review.repoUrl, {
      userId: "someone",
      workspaceId: "ws-1",
      ownerTeamId: null,
      server: false,
    });
  });

  it("no one asked (the reconciler): the organization's", async () => {
    reviewOwnerTeam.mockResolvedValue(null);
    await rereview();
    expect(reviewOwnerTeam).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }));
    expect(getGitPlatformForRepo).toHaveBeenCalledWith(review.repoUrl, {
      userId: undefined,
      workspaceId: "ws-1",
      ownerTeamId: null,
      server: true,
    });
  });
});

describe("merging and reading a PR with the asker's token context", () => {
  const mergeWith = async (prUrl: string) => {
    const mergePullRequest = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getGitPlatformForRepo).mockResolvedValue({
      platform: { mergePullRequest } as never,
      ri: { platform: "gitlab", host: "git.example.com", owner: "g", repo: "app" } as never,
    });
    await mergePr({ prUrl, mergeMethod: "squash", userId: "u-1", workspaceId: "ws-1" });
    return mergePullRequest;
  };

  it("hints GitLab for a merge request on a GitLab Optio uses, with the workspace's GitLab scope", async () => {
    const mergePullRequest = await mergeWith("https://git.example.com/g/app/-/merge_requests/7");
    expect(isKnownGitLabHost).toHaveBeenLastCalledWith("git.example.com", "ws-1");
    expect(getGitPlatformForRepo).toHaveBeenLastCalledWith("https://git.example.com/g/app", {
      userId: "u-1",
      server: false,
      gitlabScope: { workspaceId: "ws-1" },
      platformHint: "gitlab",
    });
    expect(mergePullRequest).toHaveBeenCalledWith(expect.anything(), 7, "squash");
  });

  it("leaves a merge request on a host Optio doesn't use to its URL, as before", async () => {
    await mergeWith("https://evil.example/g/app/-/merge_requests/7");
    expect(getGitPlatformForRepo).toHaveBeenLastCalledWith(
      "https://evil.example/g/app",
      expect.objectContaining({ platformHint: undefined }),
    );
  });

  it("reads a pull request's status as upstream did: the workspace only for GitLab", async () => {
    vi.mocked(isKnownGitLabHost).mockClear();
    vi.mocked(getGitPlatformForRepo).mockResolvedValue({
      platform: {
        getPullRequest: vi.fn().mockResolvedValue({ headSha: "abc", state: "open", merged: false }),
        getCIChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
      } as never,
      ri: { platform: "github", host: "github.com", owner: "acme", repo: "web" } as never,
    });
    await getPrStatus("https://github.com/acme/web/pull/3", { workspaceId: "ws-2" }).catch(
      () => null,
    );
    expect(getGitPlatformForRepo).toHaveBeenLastCalledWith("https://github.com/acme/web", {
      server: true,
      gitlabScope: { workspaceId: "ws-2" },
      platformHint: undefined,
    });
    expect(isKnownGitLabHost).not.toHaveBeenCalled();
  });
});
