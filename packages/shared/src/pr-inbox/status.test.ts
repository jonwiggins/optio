import { describe, expect, it } from "vitest";
import {
  comparePrInboxItems,
  derivePrStatus,
  extractMentions,
  isBotHandle,
  prNeedsViewer,
  prRole,
  type PrFacts,
} from "./status.js";

const NOW = new Date("2026-11-01T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    url: "https://github.com/acme/app/pull/7",
    number: 7,
    title: "Fix the thing",
    platform: "github",
    repoFullName: "acme/app",
    author: "jon",
    draft: false,
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(1),
    headBranch: "fix-thing",
    baseBranch: "main",
    headSha: "abc",
    isFork: false,
    lastPushAt: hoursAgo(10),
    checks: "passing",
    failingChecks: [],
    mergeState: "clean",
    reviewDecision: "review_required",
    reviews: [],
    requestedReviewers: ["kim"],
    requestedTeams: [],
    assignees: [],
    threads: [],
    comments: [],
    bodyMentions: [],
    ...over,
  };
}

const jon = { handles: ["Jon"] };
const kim = { handles: ["kim"] };
const derive = (f: PrFacts, v = jon, o = {}) => derivePrStatus(f, v, { now: NOW, ...o });

describe("prRole", () => {
  it("matches handles case-insensitively", () => {
    expect(prRole(pr(), jon)).toBe("author");
    expect(prRole(pr(), kim)).toBe("reviewer");
    expect(prRole(pr({ assignees: ["lee"] }), { handles: ["LEE"] })).toBe("assignee");
    expect(prRole(pr({ bodyMentions: ["sam"] }), { handles: ["sam"] })).toBe("mentioned");
    expect(prRole(pr(), { handles: ["nobody"] })).toBe("none");
    expect(prRole(pr(), { handles: [] })).toBe("none");
  });

  it("makes the viewer the author of an agent PR they started", () => {
    const facts = pr({ author: "optio[bot]" });
    expect(
      prRole(facts, jon, { taskId: "t", title: "x", state: "pr_opened", startedByViewer: true }),
    ).toBe("author");
  });
});

describe("derivePrStatus — author", () => {
  it("fix CI comes first, naming the checks", () => {
    const s = derive(
      pr({
        checks: "failing",
        failingChecks: ["lint", "e2e", "unit"],
        mergeState: "conflict",
        reviewDecision: "changes_requested",
      }),
    );
    expect(s).toMatchObject({ action: "fix_ci", owner: "you", detail: "3 failing: lint, e2e +1" });
  });

  it("a draft is the author's, quietly: not a move anyone waits on, never stale", () => {
    const s = derive(pr({ draft: true, createdAt: hoursAgo(200) }));
    expect(s).toMatchObject({ action: "draft", owner: "others", stale: false });
    // Still yours: Needs me lists it under Waiting.
    expect(prNeedsViewer(s)).toBe(true);
  });

  it("approved but mergeability not computed yet → not Merge", () => {
    const s = derive(
      pr({
        mergeState: "unknown",
        reviewDecision: "approved",
        reviews: [{ author: "kim", state: "approved", submittedAt: hoursAgo(2) }],
      }),
    );
    expect(s).toMatchObject({ action: "wait_ci", label: "Checking", owner: "others" });
  });

  it("the viewer's own move goes stale after a day", () => {
    expect(derive(pr({ checks: "failing", lastPushAt: hoursAgo(30) })).stale).toBe(true);
    expect(derive(pr({ checks: "failing", lastPushAt: hoursAgo(3) })).stale).toBe(false);
  });

  it("conflicts before reviews", () => {
    expect(derive(pr({ mergeState: "conflict" })).action).toBe("resolve_conflicts");
  });

  it("changes requested and not pushed since → address changes", () => {
    const s = derive(
      pr({
        reviews: [{ author: "kim", state: "changes_requested", submittedAt: hoursAgo(5) }],
        reviewDecision: "changes_requested",
      }),
    );
    expect(s).toMatchObject({ action: "address_changes", detail: "@kim requested changes" });
    expect(s.since).toBe(hoursAgo(5));
  });

  it("pushed after the request → waiting on the reviewer", () => {
    const s = derive(
      pr({
        lastPushAt: hoursAgo(2),
        reviews: [{ author: "kim", state: "changes_requested", submittedAt: hoursAgo(5) }],
        reviewDecision: "changes_requested",
        requestedReviewers: [],
      }),
    );
    expect(s).toMatchObject({ action: "wait_review", owner: "others" });
    expect(s.detail).toContain("@kim to re-review");
  });

  it("an unresolved thread where the reviewer spoke last → reply", () => {
    const s = derive(
      pr({
        threads: [
          {
            resolved: false,
            participants: ["kim", "jon"],
            lastAuthor: "kim",
            lastAt: hoursAgo(1),
          },
          { resolved: true, participants: ["kim"], lastAuthor: "kim", lastAt: hoursAgo(1) },
          { resolved: false, participants: ["kim", "jon"], lastAuthor: "jon", lastAt: hoursAgo(1) },
        ],
      }),
    );
    expect(s).toMatchObject({ action: "reply", detail: "@kim replied on 1 thread" });
  });

  it("bot comments never need a reply", () => {
    const s = derive(
      pr({
        comments: [{ author: "codecov[bot]", at: hoursAgo(1), mentions: [] }],
        threads: [
          {
            resolved: false,
            participants: ["sonarcloud"],
            lastAuthor: "sonarcloud",
            lastAt: hoursAgo(1),
          },
        ],
      }),
    );
    expect(s.action).toBe("wait_review");
  });

  it("a conversation comment after the author's last word → reply", () => {
    const s = derive(
      pr({
        comments: [
          { author: "jon", at: hoursAgo(5), mentions: [] },
          { author: "lee", at: hoursAgo(3), mentions: [] },
        ],
      }),
    );
    expect(s.action).toBe("reply");
    expect(s.detail).toBe("@lee replied");
  });

  it("an answered comment does not", () => {
    const s = derive(
      pr({
        comments: [
          { author: "lee", at: hoursAgo(5), mentions: [] },
          { author: "jon", at: hoursAgo(3), mentions: [] },
        ],
      }),
    );
    expect(s.action).toBe("wait_review");
  });

  it("behind the base (when branch rules care) → update branch", () => {
    expect(derive(pr({ mergeState: "behind" })).action).toBe("update_branch");
  });

  it("pending CI is someone else's move", () => {
    expect(derive(pr({ checks: "pending" }))).toMatchObject({ action: "wait_ci", owner: "others" });
  });

  it("approved + green + clean → merge", () => {
    const s = derive(
      pr({
        reviewDecision: "approved",
        reviews: [{ author: "kim", state: "approved", submittedAt: hoursAgo(2) }],
      }),
    );
    expect(s).toMatchObject({
      action: "merge",
      owner: "you",
      detail: "Approved by @kim · CI green",
    });
  });

  it("approved but blocked by branch rules → waiting", () => {
    const s = derive(
      pr({
        mergeState: "blocked",
        reviewDecision: "approved",
        reviews: [{ author: "kim", state: "approved", submittedAt: hoursAgo(2) }],
      }),
    );
    expect(s).toMatchObject({ action: "wait_review", owner: "others" });
  });

  it("no reviewers at all → request a review", () => {
    expect(derive(pr({ requestedReviewers: [] })).action).toBe("request_review");
  });

  it("your PR waiting on reviewers stays in Needs me, as someone else's move", () => {
    const s = derive(pr());
    expect(s).toMatchObject({ action: "wait_review", owner: "others" });
    expect(prNeedsViewer(s)).toBe(true);
  });

  it("waiting on reviewers for over two days is stale", () => {
    const s = derive(pr({ lastPushAt: hoursAgo(72) }));
    expect(s).toMatchObject({ action: "wait_review", stale: true, detail: "Waiting on @kim" });
    expect(derive(pr()).stale).toBe(false);
  });
});

describe("derivePrStatus — reviewer", () => {
  it("requested and not reviewed → review", () => {
    expect(derive(pr(), kim)).toMatchObject({ action: "review", owner: "you", role: "reviewer" });
  });

  it("a red PR isn't ready for review: the author's move", () => {
    expect(derive(pr({ checks: "failing" }), kim)).toMatchObject({
      action: "wait_author",
      owner: "others",
      detail: "Review requested · CI failing",
    });
  });

  it("an Optio draft waiting turns it into its own action", () => {
    expect(
      derive(pr(), kim, { optioReview: { id: "r", state: "ready", verdict: "approve" } }).action,
    ).toBe("optio_review_ready");
  });

  it("re-requested after a review → re-review", () => {
    const s = derive(
      pr({ reviews: [{ author: "kim", state: "commented", submittedAt: hoursAgo(20) }] }),
      kim,
    );
    expect(s.action).toBe("rereview");
  });

  it("requested changes, no push since → author's move; pushed since → re-review", () => {
    const base = {
      requestedReviewers: [],
      reviews: [{ author: "kim", state: "changes_requested" as const, submittedAt: hoursAgo(5) }],
    };
    expect(derive(pr(base), kim)).toMatchObject({ action: "wait_author", owner: "others" });
    expect(derive(pr({ ...base, lastPushAt: hoursAgo(1) }), kim).action).toBe("rereview");
    // …but only once CI has had its say.
    expect(derive(pr({ ...base, lastPushAt: hoursAgo(1), checks: "pending" }), kim).action).toBe(
      "wait_ci",
    );
    expect(derive(pr({ ...base, lastPushAt: hoursAgo(1), checks: "failing" }), kim)).toMatchObject({
      action: "wait_author",
      detail: "Pushed since your review · CI failing",
    });
  });

  it("the author answered the reviewer's thread → reply", () => {
    const s = derive(
      pr({
        requestedReviewers: [],
        reviews: [{ author: "kim", state: "commented", submittedAt: hoursAgo(5) }],
        threads: [
          { resolved: false, participants: ["kim", "jon"], lastAuthor: "jon", lastAt: hoursAgo(1) },
        ],
      }),
      kim,
    );
    expect(s).toMatchObject({ action: "reply", detail: "@jon replied on 1 thread" });
  });

  it("an approved, green fork PR is the approving maintainer's to merge", () => {
    const base = {
      isFork: true,
      reviewDecision: "approved" as const,
      requestedReviewers: [],
      reviews: [{ author: "kim", state: "approved" as const, submittedAt: hoursAgo(5) }],
    };
    expect(derive(pr(base), kim)).toMatchObject({ action: "merge", owner: "you" });
    expect(derive(pr({ ...base, checks: "pending" }), kim).action).toBe("watching");
  });

  it("approved → watching", () => {
    const s = derive(
      pr({
        requestedReviewers: [],
        reviews: [{ author: "kim", state: "approved", submittedAt: hoursAgo(5) }],
      }),
      kim,
    );
    expect(s).toMatchObject({ action: "watching", detail: "You approved", owner: "others" });
  });
});

describe("derivePrStatus — mentioned / none", () => {
  it("a fresh mention → reply", () => {
    const s = derive(pr({ comments: [{ author: "kim", at: hoursAgo(1), mentions: ["sam"] }] }), {
      handles: ["sam"],
    });
    expect(s).toMatchObject({ role: "mentioned", action: "reply", detail: "@kim mentioned you" });
  });

  it("someone else's PR reads its plain state", () => {
    const s = derive(pr({ checks: "failing" }), { handles: ["zed"] });
    expect(s).toMatchObject({
      action: "watching",
      label: "CI failing",
      detail: "",
      owner: "others",
    });
    expect(prNeedsViewer(s)).toBe(false);
  });

  it("an outside contribution nobody picked up needs a reviewer — after a few hours", () => {
    const fork = { isFork: true, author: "outsider", requestedReviewers: [] };
    expect(derive(pr({ ...fork, createdAt: hoursAgo(6) }), { handles: ["zed"] })).toMatchObject({
      action: "needs_reviewer",
      owner: "you",
      detail: "Outside contribution from @outsider",
    });
    expect(derive(pr({ ...fork, createdAt: hoursAgo(1) }), { handles: ["zed"] }).action).toBe(
      "watching",
    );
    expect(
      derive(pr({ ...fork, createdAt: hoursAgo(6), draft: true }), { handles: ["zed"] }).action,
    ).toBe("watching");
  });
});

describe("derivePrStatus — agents", () => {
  const agent = { taskId: "t1", title: "Fix the flaky test", startedByViewer: true };
  it("a running agent owns the move", () => {
    const s = derive(pr({ author: "optio[bot]", checks: "failing" }), jon, {
      agent: { ...agent, state: "running" },
    });
    expect(s).toMatchObject({ action: "agent_working", owner: "agent", role: "author" });
    expect(s.detail).toBe("Running now: Fix the flaky test");
    const same = derive(pr({ title: "Fix the flaky test" }), jon, {
      agent: { ...agent, state: "queued" },
    });
    expect(same.detail).toBe("Queued");
  });

  it("an agent waiting on a person comes first", () => {
    const s = derive(pr({ author: "optio[bot]" }), jon, {
      agent: { ...agent, state: "needs_attention" },
    });
    expect(s).toMatchObject({ action: "agent_needs_you", owner: "you" });
  });

  it("someone else's stuck agent is not your move", () => {
    const s = derive(pr({ author: "optio[bot]" }), jon, {
      agent: { ...agent, state: "needs_attention", startedByViewer: false },
    });
    expect(s).toMatchObject({ action: "watching", owner: "others", label: "Agent waiting" });
  });

  it("an agent PR in pr_opened is judged like any other", () => {
    const s = derive(pr({ author: "optio[bot]", checks: "failing" }), jon, {
      agent: { ...agent, state: "pr_opened" },
    });
    expect(s.action).toBe("fix_ci");
  });
});

describe("comparePrInboxItems", () => {
  it("orders by rank, then longest-waiting first for the viewer's moves", () => {
    const a = {
      facts: { updatedAt: hoursAgo(1) },
      status: derive(pr({ checks: "failing", lastPushAt: hoursAgo(2) })),
    };
    const b = {
      facts: { updatedAt: hoursAgo(1) },
      status: derive(pr({ checks: "failing", lastPushAt: hoursAgo(9) })),
    };
    const c = { facts: { updatedAt: hoursAgo(1) }, status: derive(pr(), kim) };
    expect([c, a, b].sort(comparePrInboxItems)).toEqual([b, a, c]);
  });
});

describe("extractMentions / isBotHandle", () => {
  it("finds handles outside code and emails", () => {
    expect(
      extractMentions("cc @kim and @lee-2, see `@notme` and\n```\n@nope\n```\nmail a@b.com"),
    ).toEqual(["kim", "lee-2"]);
    expect(extractMentions(null)).toEqual([]);
  });

  it("knows the usual bots", () => {
    expect(isBotHandle("dependabot[bot]")).toBe(true);
    expect(isBotHandle("renovate")).toBe(true);
    expect(isBotHandle("ci-bot")).toBe(true);
    expect(isBotHandle("abbott")).toBe(false);
    expect(isBotHandle("kim")).toBe(false);
  });
});
