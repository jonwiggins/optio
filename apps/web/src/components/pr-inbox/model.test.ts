import { describe, expect, it } from "vitest";
import type { PrFacts, PrInboxItem, PrInboxStatus } from "@optio/shared";
import {
  defaultView,
  inView,
  matchesQuery,
  primaryAction,
  rowActions,
  sections,
  shortAge,
  viewCounts,
  yourMoveCount,
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

describe("views and sections", () => {
  const mine = item({ role: "author", owner: "you", action: "fix_ci" });
  const review = item({ role: "reviewer", owner: "you", action: "review" });
  const agent = item({ role: "author", owner: "agent", action: "agent_working" });
  const theirs = item({});
  const all = [mine, review, agent, theirs];

  it("filters by view", () => {
    expect(all.filter((i) => inView(i, "needs-me"))).toEqual([mine, review, agent]);
    expect(all.filter((i) => inView(i, "mine"))).toEqual([mine, agent]);
    // Needs me lists your agents too, but counts only your moves.
    expect(viewCounts(all)).toEqual({ "needs-me": 2, mine: 2, all: 4 });
    expect(yourMoveCount(all)).toBe(2);
  });

  it("groups by whose move, dropping empty sections", () => {
    expect(sections(all, "needs-me").map((s) => [s.owner, s.items.length])).toEqual([
      ["you", 2],
      ["agent", 1],
    ]);
    expect(sections(all, "all").map((s) => s.title)).toEqual([
      "Your move",
      "Agents on it",
      "Waiting",
    ]);
  });

  it("opens on Needs me only when the viewer has a handle", () => {
    expect(defaultView(null)).toBe("all");
    expect(defaultView({ viewer: { handles: [], source: "none", suggestedHandle: null } })).toBe(
      "all",
    );
    expect(
      defaultView({ viewer: { handles: ["jon"], source: "sign-in", suggestedHandle: null } }),
    ).toBe("needs-me");
  });

  it("matches title, number, repo, author and branch", () => {
    const i = item({}, { number: 42, headBranch: "fix/flaky" });
    for (const q of ["speed", "#42", "42", "ACME/app", "kim", "flaky", ""]) {
      expect(matchesQuery(i, q)).toBe(true);
    }
    expect(matchesQuery(i, "nope")).toBe(false);
  });
});

describe("rowActions", () => {
  it("authors get an agent for fixable states; forks can't", () => {
    expect(primaryAction(item({ role: "author", owner: "you", action: "fix_ci" }))).toMatchObject({
      kind: "agent",
      action: "fix_ci",
      label: "Fix with agent",
    });
    expect(
      primaryAction(
        item({ role: "author", owner: "you", action: "resolve_conflicts" }, { isFork: true }),
      ),
    ).toMatchObject({ kind: "agent", disabled: expect.stringContaining("fork") });
    // A reviewer is never offered an agent for the author's work.
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
    expect(
      rowActions(
        item(
          { role: "reviewer", action: "optio_review_ready", owner: "you" },
          {},
          { optioReview: { id: "rv", state: "ready", verdict: null } },
        ),
      )[1],
    ).toEqual({ kind: "open-review", reviewId: "rv", label: "Optio's draft" });
  });

  it("agents and merges", () => {
    const agent = { taskId: "t1", title: "x", state: "running", startedByViewer: true };
    expect(primaryAction(item({ action: "agent_working", owner: "agent" }, {}, { agent }))).toEqual(
      {
        kind: "open-task",
        taskId: "t1",
        label: "Watch agent",
      },
    );
    expect(primaryAction(item({ role: "author", action: "merge", owner: "you" }))).toMatchObject({
      kind: "merge",
      method: "squash",
    });
    expect(
      primaryAction(
        item(
          { role: "author", action: "merge", owner: "you" },
          { mergeMethods: ["merge", "rebase"] },
        ),
      ),
    ).toMatchObject({ method: "merge" });
    expect(primaryAction(item({ action: "wait_review" }))).toBeNull();
  });
});

describe("shortAge", () => {
  const now = new Date("2026-11-01T12:00:00Z").getTime();
  it.each([
    ["2026-11-01T11:59:50Z", "1m"],
    ["2026-11-01T11:20:00Z", "40m"],
    ["2026-11-01T09:00:00Z", "3h"],
    ["2026-10-29T12:00:00Z", "3d"],
    ["2026-09-01T12:00:00Z", "8w"],
  ])("%s → %s", (iso, out) => expect(shortAge(iso, now)).toBe(out));
  it("no time, no age", () => expect(shortAge(null, now)).toBe(""));
});
