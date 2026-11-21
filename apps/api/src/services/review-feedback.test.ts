import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InlineComment, IssueComment, Review } from "@optio/shared";

const metadataPatches: Record<string, unknown>[] = [];

vi.mock("drizzle-orm", () => ({
  eq: () => null,
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({ values }),
}));

vi.mock("../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: { metadata: { values: unknown[] } }) => ({
        where: async () => {
          metadataPatches.push(JSON.parse(values.metadata.values[1] as string));
        },
      }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({ tasks: { id: "id", metadata: "metadata" } }));

const getTask = vi.fn();
vi.mock("./task-service.js", () => ({ getTask: (...a: unknown[]) => getTask(...a) }));

const platform = {
  type: "github",
  createIssueComment: vi.fn(),
  replyToInlineComment: vi.fn(),
};
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({ platform, ri: { repo: "r" } }),
}));

vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
  newReviewFeedback,
  nextFeedbackSince,
  postReviewReplies,
  recordFeedbackRound,
  reviewFeedbackPrompt,
} from "./review-feedback.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const inline = (c: Partial<InlineComment> & Pick<InlineComment, "id" | "author" | "body">) => ({
  path: "src/a.ts",
  line: 12,
  reviewId: null,
  inReplyToId: null,
  createdAt: at(10),
  ...c,
});

describe("newReviewFeedback", () => {
  it("keeps reviewers' comments and drops the PR author's, bots', change requests' and plain PR comments", () => {
    const reviews: Review[] = [
      {
        id: 1,
        author: "optio-bot",
        state: "COMMENTED",
        body: "My own review.",
        submittedAt: at(20),
      },
      {
        id: 2,
        author: "alice",
        state: "COMMENTED",
        body: "Please add a test.",
        submittedAt: at(10),
      },
      { id: 3, author: "bob", state: "CHANGES_REQUESTED", body: "Blocker.", submittedAt: at(10) },
      { id: 4, author: "carol", state: "APPROVED", body: "LGTM", submittedAt: at(5) },
    ];
    const comments: InlineComment[] = [
      inline({ id: 10, author: "optio-bot", body: "Optio's own note.", reviewId: 1 }),
      inline({ id: 11, author: "alice", body: "Rename this.", reviewId: 2 }),
      inline({ id: 12, author: "alice", body: "And this one.", reviewId: 5, inReplyToId: 10 }),
      inline({ id: 13, author: "bob", body: "Part of the change request.", reviewId: 3 }),
      inline({ id: 14, author: "lint[bot]", body: "Nit.", reviewId: 6 }),
    ];
    const conversation: IssueComment[] = [
      { id: 20, author: "alice", body: "Thanks, looking at it tomorrow.", createdAt: at(10) },
      { id: 21, author: "alice", body: "@optio also update the docs", createdAt: at(10) },
    ];

    const feedback = newReviewFeedback(reviews, comments, conversation, { prAuthor: "optio-bot" });

    expect(feedback.map((f) => f.id)).toEqual(["review-2", "11", "12", "comment-21"]);
    expect(feedback.find((f) => f.id === "11")?.where).toBe("src/a.ts:12");
    expect(feedback.find((f) => f.id === "12")?.thread).toBe("Optio's own note.");
  });

  it("only returns comments after the last handled one", () => {
    const comments = [
      inline({ id: 11, author: "alice", body: "Old.", createdAt: at(30) }),
      inline({ id: 12, author: "alice", body: "New.", createdAt: at(5) }),
    ];
    const feedback = newReviewFeedback([], comments, [], { prAuthor: "optio-bot", after: at(30) });
    expect(feedback.map((f) => f.id)).toEqual(["12"]);
  });
});

describe("nextFeedbackSince", () => {
  it("starts after the last round, and waits while its replies are pending", () => {
    expect(nextFeedbackSince(null)).toEqual({ after: undefined });
    expect(nextFeedbackSince({ reviewFeedbackHandledAt: "t1", reviewFeedbackOpen: null })).toEqual({
      after: "t1",
    });
    expect(nextFeedbackSince({ reviewFeedbackOpen: { "11": "alice" } })).toBeNull();
  });
});

describe("reviewFeedbackPrompt", () => {
  it("lists each comment under its id, quoted, and asks for the replies file", () => {
    const prompt = reviewFeedbackPrompt("PR", [
      {
        id: "12",
        author: "alice",
        body: "And this one.",
        createdAt: at(5),
        where: "src/a.ts:12",
        thread: "Optio's own note.",
      },
    ]);
    expect(prompt).toContain(
      "### Comment 12 by @alice on src/a.ts:12\nIn reply to:\n> Optio's own note.",
    );
    expect(prompt).toContain("> And this one.");
    expect(prompt).toContain(".optio/review-replies.json");
  });
});

describe("recordFeedbackRound", () => {
  beforeEach(() => {
    metadataPatches.length = 0;
  });

  it("remembers the newest comment and who wrote each one", async () => {
    await recordFeedbackRound("task-1", [
      { id: "11", author: "alice", body: "a", createdAt: "2026-11-20T10:00:00Z" },
      { id: "review-2", author: "bob", body: "b", createdAt: "2026-11-20T10:05:00Z" },
    ]);
    expect(metadataPatches).toEqual([
      {
        reviewFeedbackHandledAt: "2026-11-20T10:05:00Z",
        reviewFeedbackOpen: { "11": "alice", "review-2": "bob" },
      },
    ]);
  });
});

describe("postReviewReplies", () => {
  const withOpen = (open: Record<string, string> | undefined) => ({
    id: "task-1",
    prUrl: "https://github.com/o/r/pull/7",
    repoUrl: "https://github.com/o/r",
    workspaceId: "ws",
    ownerUserId: null,
    metadata: { reviewFeedbackOpen: open },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    metadataPatches.length = 0;
    platform.type = "github";
  });

  it("does nothing after a run that wasn't for review comments", async () => {
    getTask.mockResolvedValue(withOpen(undefined));
    await postReviewReplies("task-1", "[]", "report");
    expect(platform.createIssueComment).not.toHaveBeenCalled();
    expect(metadataPatches).toEqual([]);
  });

  it("replies under inline comments and puts the rest in one PR comment", async () => {
    getTask.mockResolvedValue(withOpen({ "11": "alice", "review-2": "bob" }));
    const file = JSON.stringify([
      { id: 11, reply: "Renamed in abc1234." },
      { id: "review-2", reply: "Added the test in def5678." },
    ]);

    await postReviewReplies("task-1", file, "Final report.");

    expect(metadataPatches).toEqual([{ reviewFeedbackOpen: null }]);
    expect(platform.replyToInlineComment).toHaveBeenCalledWith(
      { repo: "r" },
      7,
      11,
      "🤖 **Optio**: Renamed in abc1234.",
    );
    expect(platform.createIssueComment).toHaveBeenCalledWith(
      { repo: "r" },
      7,
      "🤖 **Optio** addressed the review comments.\n\n**@bob:** Added the test in def5678.",
    );
  });

  it("falls back to the PR comment with the report when replies are missing or fail", async () => {
    getTask.mockResolvedValue(withOpen({ "11": "alice", "12": "alice" }));
    platform.replyToInlineComment.mockRejectedValue(new Error("422"));

    await postReviewReplies("task-1", JSON.stringify([{ id: "11", reply: "Done." }]), "Report.");

    expect(platform.createIssueComment.mock.calls[0][2]).toBe(
      "🤖 **Optio** addressed the review comments.\n\n**@alice:** Done.\n\nReport.",
    );
  });

  it("posts nothing outside GitHub, where an MR isn't an issue", async () => {
    platform.type = "gitlab";
    getTask.mockResolvedValue(withOpen({ "11": "alice" }));
    await postReviewReplies("task-1", JSON.stringify([{ id: "11", reply: "Done." }]), "Report.");
    expect(platform.createIssueComment).not.toHaveBeenCalled();
    expect(platform.replyToInlineComment).not.toHaveBeenCalled();
  });
});
