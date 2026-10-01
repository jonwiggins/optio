import { describe, it, expect, vi } from "vitest";
import type { GitPlatform, PrToolCallMatch, PullRequest } from "@optio/shared";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./git-token-service.js", () => ({ getGitPlatformForRepo: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { confirmToolCallPrs, findBranchPrs, prNumberFromUrl } from "./task-pr-service.js";

const TASK_ID = "0b5c2a8e-1111-4222-8333-944455556666";
const task = { id: TASK_ID, repoUrl: "https://github.com/acme/optio" };
const runStartedAt = new Date("2026-09-30T10:00:00Z");

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "x",
    body: "",
    state: "open",
    merged: false,
    mergeable: null,
    draft: false,
    headSha: "abc",
    baseBranch: "main",
    headBranch: `optio/task-${TASK_ID}`,
    headRepo: "acme/optio",
    url: "https://github.com/acme/optio/pull/12",
    author: "optio-bot",
    assignees: [],
    labels: [],
    createdAt: "2026-09-30T10:05:00Z",
    updatedAt: "2026-09-30T10:05:00Z",
    ...over,
  };
}

function platform(over: Partial<Record<keyof GitPlatform, unknown>> = {}): GitPlatform {
  return {
    getPullRequest: vi.fn(),
    listOpenPullRequests: vi.fn().mockResolvedValue([]),
    findPullRequestsByHeadPrefix: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as GitPlatform;
}

const match = (url: string): PrToolCallMatch => ({
  url,
  codecommit: null,
  toolName: "Bash",
  alreadyExisted: false,
});

describe("confirmToolCallPrs", () => {
  it("adopts a fresh PR the platform confirms", async () => {
    const p = platform({ getPullRequest: vi.fn().mockResolvedValue(pr()) });
    const out = await confirmToolCallPrs(task, [match("https://github.com/acme/optio/pull/12")], {
      runStartedAt,
      platform: p,
    });
    expect(out).toEqual([
      expect.objectContaining({
        url: "https://github.com/acme/optio/pull/12",
        number: 12,
        headBranch: `optio/task-${TASK_ID}`,
        state: "open",
        source: "tool_call",
      }),
    ]);
  });

  it("rejects PRs in another repo without asking the platform", async () => {
    const p = platform();
    const out = await confirmToolCallPrs(task, [match("https://github.com/other/repo/pull/3")], {
      runStartedAt,
      platform: p,
    });
    expect(out).toEqual([]);
    expect(p.getPullRequest).not.toHaveBeenCalled();
  });

  it("rejects closed PRs and old PRs on someone else's branch", async () => {
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce(pr({ state: "closed" }))
      .mockResolvedValueOnce(
        pr({ headBranch: "feature/x", createdAt: "2026-01-01T00:00:00Z", number: 13 }),
      );
    const out = await confirmToolCallPrs(
      task,
      [
        match("https://github.com/acme/optio/pull/12"),
        match("https://github.com/acme/optio/pull/13"),
      ],
      { runStartedAt, platform: platform({ getPullRequest }) },
    );
    expect(out).toEqual([]);
  });

  it("accepts an older PR on the task's branch (gh pr create: already exists) and a merged one", async () => {
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce(pr({ createdAt: "2026-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(
        pr({
          number: 14,
          url: "https://github.com/acme/optio/pull/14",
          state: "closed",
          merged: true,
          headBranch: "x",
        }),
      );
    const out = await confirmToolCallPrs(
      task,
      [
        match("https://github.com/acme/optio/pull/12"),
        match("https://github.com/acme/optio/pull/14"),
      ],
      { runStartedAt, platform: platform({ getPullRequest }) },
    );
    expect(out.map((p) => [p.number, p.state])).toEqual([
      [12, "open"],
      [14, "merged"],
    ]);
  });

  it("allows a little clock skew before the run start", async () => {
    const p = platform({
      getPullRequest: vi
        .fn()
        .mockResolvedValue(pr({ headBranch: "x", createdAt: "2026-09-30T09:59:00Z" })),
    });
    const out = await confirmToolCallPrs(task, [match("https://github.com/acme/optio/pull/12")], {
      runStartedAt,
      platform: p,
    });
    expect(out).toHaveLength(1);
  });

  it("adopts the tool call's PR unconfirmed when the platform is unavailable or errors", async () => {
    const none = await confirmToolCallPrs(task, [match("https://github.com/acme/optio/pull/12")], {
      runStartedAt,
      platform: null,
    });
    expect(none).toEqual([expect.objectContaining({ number: 12, source: "tool_call" })]);
    const failing = platform({
      getPullRequest: vi.fn().mockRejectedValue(new Error("GitHub API error 401: Bad credentials")),
    });
    const errored = await confirmToolCallPrs(
      task,
      [match("https://github.com/acme/optio/pull/12")],
      {
        runStartedAt,
        platform: failing,
      },
    );
    expect(errored).toHaveLength(1);
  });

  it("drops a PR the platform says does not exist", async () => {
    const err = Object.assign(new Error("GitHub API error 404: Not Found"), { status: 404 });
    const out = await confirmToolCallPrs(task, [match("https://github.com/acme/optio/pull/12")], {
      runStartedAt,
      platform: platform({ getPullRequest: vi.fn().mockRejectedValue(err) }),
    });
    expect(out).toEqual([]);
  });

  it("resolves a CodeCommit create result by id", async () => {
    const ccTask = {
      id: TASK_ID,
      repoUrl: "https://git-codecommit.us-east-1.amazonaws.com/v1/repos/svc",
    };
    const out = await confirmToolCallPrs(
      ccTask,
      [
        {
          url: null,
          codecommit: { pullRequestId: 5, repositoryName: "svc" },
          toolName: "Bash",
          alreadyExisted: false,
        },
      ],
      { runStartedAt, platform: null },
    );
    expect(out).toEqual([
      expect.objectContaining({
        number: 5,
        url: "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/svc/pull-requests/5",
      }),
    ]);
  });
});

describe("findBranchPrs", () => {
  it("looks up each pushed branch and the prefix, keeping only the task's branches", async () => {
    const extra = pr({
      number: 15,
      url: "https://github.com/acme/optio/pull/15",
      headBranch: `optio/task-${TASK_ID}-docs`,
    });
    const lookalike = pr({
      number: 16,
      url: "https://github.com/acme/optio/pull/16",
      headBranch: `optio/task-${TASK_ID}x`,
    });
    const p = platform({
      listOpenPullRequests: vi.fn().mockResolvedValue([pr()]),
      findPullRequestsByHeadPrefix: vi.fn().mockResolvedValue([pr(), extra, lookalike]),
    });
    const { prs, checked } = await findBranchPrs(task, {
      branches: [`optio/task-${TASK_ID}`, "main"],
      platform: p,
    });
    expect(checked).toBe(true);
    expect(prs.map((x) => x.number)).toEqual([12, 15]);
    expect(prs.every((x) => x.source === "branch")).toBe(true);
    expect(p.listOpenPullRequests).toHaveBeenCalledTimes(1);
    expect(p.findPullRequestsByHeadPrefix).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "optio" }),
      `optio/task-${TASK_ID}`,
    );
  });

  it("reports unchecked when the platform can't be asked", async () => {
    expect(await findBranchPrs(task, { platform: null })).toEqual({ prs: [], checked: false });
    const failing = platform({
      findPullRequestsByHeadPrefix: vi.fn().mockRejectedValue(new Error("x")),
    });
    expect((await findBranchPrs(task, { platform: failing })).checked).toBe(false);
  });
});

describe("prNumberFromUrl", () => {
  it("reads GitHub, GitLab and CodeCommit PR numbers", () => {
    expect(prNumberFromUrl("https://github.com/o/r/pull/42")).toBe(42);
    expect(prNumberFromUrl("https://gitlab.com/g/r/-/merge_requests/7")).toBe(7);
    expect(prNumberFromUrl("https://github.com/o/r")).toBeNull();
  });
});
