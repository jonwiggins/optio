import { describe, it, expect, vi } from "vitest";
import type { GitPlatform, RepoIdentifier } from "@optio/shared";
import { CONVERSATION_LIMITS, readPrConversation } from "./pr-conversation.js";

const ri = { platform: "gitlab", host: "gitlab.com", owner: "a", repo: "b" } as RepoIdentifier;

function platformWith(type: "github" | "gitlab", extra: Partial<GitPlatform> = {}) {
  return {
    type,
    getReviews: vi.fn(async () => [
      { author: "carol", state: "CHANGES_REQUESTED" as const, body: "Changes requested: fix" },
      { author: "bob", state: "COMMENTED" as const, body: "Why this approach?" },
      { author: "bob", state: "COMMENTED" as const, body: "On line 3" },
    ]),
    getIssueComments: vi.fn(async () => [
      { author: "dana", body: "issue #7's thread", createdAt: "t0" },
    ]),
    getInlineComments: vi.fn(async () => [
      { author: "bob", path: "a.ts", line: 3, body: "On line 3", createdAt: "t2" },
    ]),
    ...extra,
  } as unknown as GitPlatform;
}

describe("readPrConversation", () => {
  it("reads a GitLab MR's own discussion, and doesn't repeat its notes as reviews", async () => {
    const getPullRequestComments = vi.fn(async () => [
      { author: "bob", body: "Why this approach?", createdAt: "t1" },
    ]);
    const platform = platformWith("gitlab", { getPullRequestComments });

    const c = await readPrConversation(platform, ri, 7);

    expect(getPullRequestComments).toHaveBeenCalledWith(ri, 7);
    expect(platform.getIssueComments).not.toHaveBeenCalled();
    expect(c.prComments).toBe("**bob** (t1):\nWhy this approach?");
    expect(c.existingReviews).toBe("**carol** (CHANGES_REQUESTED):\nChanges requested: fix");
    expect(c.inlineComments).toBe("**bob** on `a.ts:3`:\nOn line 3");
  });

  it("on GitHub, the PR's issue comments and every review with a body, as before", async () => {
    const platform = platformWith("github");

    const c = await readPrConversation(platform, ri, 7);

    expect(platform.getIssueComments).toHaveBeenCalledWith(ri, 7);
    expect(c.prComments).toBe("**dana** (t0):\nissue #7's thread");
    expect(c.existingReviews.split("\n\n")).toHaveLength(3);
  });

  it("a busy PR gives only the newest 30 reviews, 30 comments and 50 inline comments", async () => {
    const many = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));
    const big = "x".repeat(700);
    const platform = platformWith("github", {
      getReviews: vi.fn(async () =>
        many(500, (i) => ({ author: "bot", state: "COMMENTED", body: `review ${i} ${big}` })),
      ),
      getIssueComments: vi.fn(async () =>
        many(500, (i) => ({ author: "bob", body: `comment ${i} ${big}`, createdAt: `t${i}` })),
      ),
      getInlineComments: vi.fn(async () =>
        many(500, (i) => ({ author: "bot", path: "a.ts", line: i, body: `inline ${i} ${big}` })),
      ),
    } as Partial<GitPlatform>);

    const c = await readPrConversation(platform, ri, 7);

    expect(c.existingReviews.split("\n\n")).toHaveLength(CONVERSATION_LIMITS.reviews);
    expect(c.prComments.split("\n\n")).toHaveLength(CONVERSATION_LIMITS.comments);
    expect(c.inlineComments.split("\n\n")).toHaveLength(CONVERSATION_LIMITS.inline);
    expect(c.existingReviews).toContain("review 499 ");
    expect(c.existingReviews).not.toContain("review 469 ");
    expect(c.prComments).toContain("comment 499 ");
    expect(c.inlineComments).toContain("inline 499 ");
    // The context reaches the pod inside its start script (one 128 KiB argument).
    const size = c.existingReviews.length + c.prComments.length + c.inlineComments.length;
    expect(size).toBeLessThan(96 * 1024);
  });

  it("a read that fails leaves only its part empty", async () => {
    const platform = platformWith("github", {
      getInlineComments: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const c = await readPrConversation(platform, ri, 7);

    expect(c.inlineComments).toBe("");
    expect(c.prComments).not.toBe("");
  });
});
