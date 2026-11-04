import { describe, expect, it } from "vitest";
import type { PrFacts, PrInboxItem, PrInboxStatus } from "@optio/shared";
import {
  bucketCounts,
  bulkActions,
  defaultLens,
  inBucket,
  inLens,
  isReadyToMerge,
  lensCounts,
  matchesQuery,
  menuActions,
  primaryAction,
  rowActions,
  sections,
  shortAge,
  viewerSet,
} from "./model";

function item(
  status: Partial<PrInboxStatus>,
  facts: Partial<PrFacts> = {},
  extra: Partial<PrInboxItem> = {},
): PrInboxItem {
  return {
    facts: {
      url: `https://github.com/acme/app/pull/${Math.floor(Math.random() * 1e6)}`,
      number: 7,
      title: "Speed up the build",
      platform: "github",
      repoFullName: "acme/app",
      author: "kim",
      draft: false,
      createdAt: "2026-10-30T10:00:00Z",
      updatedAt: "2026-11-01T10:00:00Z",
      headBranch: "speed",
      baseBranch: "main",
      headSha: "abc",
      isFork: false,
      lastPushAt: null,
      checks: "passing",
      failingChecks: [],
      mergeState: "clean",
      reviewDecision: "none",
      reviews: [],
      requestedReviewers: [],
      requestedTeams: [],
      assignees: [],
      threads: [],
      comments: [],
      bodyMentions: [],
      ...facts,
    },
    status: {
      role: "none",
      owner: "others",
      action: "watching",
      label: "Watching",
      detail: "",
      since: null,
      rank: 99,
      stale: false,
      ...status,
    },
    repo: { id: "r1", fullName: "acme/app", repoUrl: "https://github.com/acme/app" },
    agent: null,
    optioReview: null,
    ...extra,
  };
}

const me = viewerSet(["Jon"]);
const approved = {
  reviewDecision: "approved" as const,
  reviews: [{ author: "kim", state: "approved" as const, submittedAt: "2026-10-31T00:00:00Z" }],
};

describe("lenses", () => {
  const mine = item({ role: "author", owner: "you", action: "fix_ci" }, { author: "jon" });
  const asked = item(
    { role: "reviewer", owner: "you", action: "review" },
    { requestedReviewers: ["jon"] },
  );
  const reviewed = item(
    { role: "reviewer", owner: "others", action: "wait_author" },
    {
      reviews: [{ author: "jon", state: "changes_requested", submittedAt: "2026-10-31T00:00:00Z" }],
    },
  );
  const agent = item({ role: "author", owner: "agent", action: "agent_working" });
  const theirs = item({});
  const waitingMine = item({ role: "author", owner: "others", action: "wait_review" });
  const all = [mine, asked, reviewed, agent, theirs, waitingMine];

  it("each lens is a relation to the PR", () => {
    // Needs me: your moves, plus every PR of yours (an agent's, one waiting for review).
    expect(all.filter((i) => inLens(i, "needs-me", me))).toEqual([mine, asked, agent, waitingMine]);
    expect(all.filter((i) => inLens(i, "requested", me))).toEqual([asked]);
    expect(all.filter((i) => inLens(i, "mine", me))).toEqual([mine, agent, waitingMine]);
    expect(all.filter((i) => inLens(i, "reviewed", me))).toEqual([reviewed]);
    expect(all.filter((i) => inLens(i, "all", me))).toEqual(all);
  });

  it("counts: Needs me counts your moves only", () => {
    expect(lensCounts(all, me)).toEqual({
      "needs-me": 2,
      requested: 1,
      mine: 3,
      reviewed: 1,
      all: 6,
    });
  });

  it("opens on Needs me only when the viewer has a handle", () => {
    expect(defaultLens(null)).toBe("all");
    expect(defaultLens({ viewer: { handles: [], source: "none", suggestedHandle: null } })).toBe(
      "all",
    );
    expect(
      defaultLens({ viewer: { handles: ["jon"], source: "sign-in", suggestedHandle: null } }),
    ).toBe("needs-me");
  });

  it("groups by whose move, dropping empty sections", () => {
    expect(sections(all).map((s) => [s.title, s.items.length])).toEqual([
      ["Your move", 2],
      ["Agents on it", 1],
      ["Waiting", 3],
    ]);
  });
});

describe("tiles", () => {
  it("ready to merge = approved, green, clean, not a draft", () => {
    expect(isReadyToMerge(item({}, approved).facts)).toBe(true);
    expect(isReadyToMerge(item({}, { ...approved, draft: true }).facts)).toBe(false);
    expect(isReadyToMerge(item({}, { ...approved, checks: "pending" }).facts)).toBe(false);
    expect(isReadyToMerge(item({}, { ...approved, mergeState: "unknown" }).facts)).toBe(false);
  });

  it("each PR lands in every tile it fits", () => {
    const rows = [
      item({}, approved),
      item({}, { checks: "failing" }),
      item({}, { mergeState: "conflict", checks: "failing" }),
      item({}, { mergeState: "behind" }),
      item(
        {},
        { threads: [{ resolved: false, participants: ["a"], lastAuthor: "a", lastAt: "x" }] },
      ),
      item({ action: "review", role: "reviewer", owner: "you" }),
      item({}, {}, { agent: { taskId: "t", title: "x", state: "running", startedByViewer: true } }),
    ];
    expect(bucketCounts(rows)).toEqual({
      ready: 1,
      ci: 2,
      rebase: 2,
      comments: 1,
      review: 1,
      agents: 1,
    });
    expect(inBucket(rows[2], "ci") && inBucket(rows[2], "rebase")).toBe(true);
  });
});

describe("row actions", () => {
  it("authors get an agent for fixable states, plus re-run for red CI; forks can't push", () => {
    expect(rowActions(item({ role: "author", owner: "you", action: "fix_ci" }))).toEqual([
      { kind: "agent", action: "fix_ci", label: "Fix with agent", disabled: undefined },
      { kind: "quick", action: "rerun_checks", label: "Re-run failed" },
    ]);
    expect(
      primaryAction(
        item({ role: "author", owner: "you", action: "resolve_conflicts" }, { isFork: true }),
      ),
    ).toMatchObject({ kind: "agent", disabled: expect.stringContaining("fork") });
    expect(primaryAction(item({ role: "author", owner: "you", action: "update_branch" }))).toEqual({
      kind: "quick",
      action: "update_branch",
      label: "Update branch",
    });
    expect(rowActions(item({ role: "reviewer", owner: "others", action: "wait_author" }))).toEqual(
      [],
    );
  });

  it("reviewing is the diff first, Optio's review beside it", () => {
    expect(
      rowActions(
        item(
          { role: "reviewer", action: "review", owner: "you" },
          { url: "https://github.com/a/b/pull/3" },
        ),
      ),
    ).toEqual([
      { kind: "open-files", href: "https://github.com/a/b/pull/3/files", label: "Review" },
      { kind: "optio-review", label: "Draft with Optio" },
    ]);
    expect(
      rowActions(
        item(
          { role: "reviewer", action: "review", owner: "you" },
          { platform: "gitlab", url: "https://gitlab.com/a/b/-/merge_requests/3" },
        ),
      )[0],
    ).toMatchObject({ href: "https://gitlab.com/a/b/-/merge_requests/3/diffs" });
  });

  it("merge uses the repo's preferred method", () => {
    expect(primaryAction(item({ role: "author", action: "merge", owner: "you" }))).toMatchObject({
      method: "squash",
    });
    expect(
      primaryAction(
        item({ role: "author", action: "merge", owner: "you" }, { mergeMethods: ["merge"] }),
      ),
    ).toMatchObject({ method: "merge" });
  });

  it("the menu offers whatever the PR's state makes possible", () => {
    const labels = (i: PrInboxItem) => menuActions(i, me).map((a) => a.label);
    expect(labels(item({}, approved))).toEqual([
      "Open the diff",
      "Squash and merge",
      "Approve",
      "Draft a review with Optio",
      "Copy link",
    ]);
    expect(labels(item({}, { checks: "failing", mergeState: "behind" }))).toEqual([
      "Open the diff",
      "Update branch",
      "Re-run failed checks",
      "Fix CI with an agent",
      "Approve",
      "Draft a review with Optio",
      "Copy link",
    ]);
    // Your own PR, or one you already approved: no Approve.
    expect(labels(item({ role: "author" }))).not.toContain("Approve");
    expect(
      labels(item({}, { reviews: [{ author: "jon", state: "approved", submittedAt: "x" }] })),
    ).not.toContain("Approve");
    // An agent already at work: no second one offered.
    expect(
      labels(
        item(
          {},
          { checks: "failing" },
          { agent: { taskId: "t", title: "x", state: "running", startedByViewer: true } },
        ),
      ),
    ).not.toContain("Fix CI with an agent");
  });
});

describe("bulk actions", () => {
  it("only offers each action for the rows it can apply to", () => {
    const behind = item({}, { mergeState: "behind" });
    const conflictFork = item({}, { mergeState: "conflict", isFork: true });
    const conflict = item({}, { mergeState: "conflict" });
    expect(
      bulkActions("rebase", [behind, conflictFork, conflict]).map((b) => [
        b.action.label,
        b.items.length,
      ]),
    ).toEqual([
      ["Update branches", 1],
      ["Resolve conflicts with agents", 1],
    ]);
    expect(bulkActions("ready", [item({}, approved), item({})]).map((b) => b.items.length)).toEqual(
      [1],
    );
    expect(bulkActions("agents", [behind])).toEqual([]);
  });
});

describe("filters and ages", () => {
  it("matches title, number, repo, author and branch", () => {
    const i = item({}, { number: 42, headBranch: "fix/flaky" });
    for (const q of ["speed", "#42", "42", "ACME/app", "kim", "flaky", ""]) {
      expect(matchesQuery(i, q)).toBe(true);
    }
    expect(matchesQuery(i, "nope")).toBe(false);
  });

  const now = new Date("2026-11-01T12:00:00Z").getTime();
  it.each([
    ["2026-11-01T11:59:50Z", "1m"],
    ["2026-11-01T11:20:00Z", "40m"],
    ["2026-11-01T09:00:00Z", "3h"],
    ["2026-10-29T12:00:00Z", "3d"],
    ["2026-09-01T12:00:00Z", "8w"],
  ])("%s → %s", (iso, out) => expect(shortAge(iso, now)).toBe(out));
});
