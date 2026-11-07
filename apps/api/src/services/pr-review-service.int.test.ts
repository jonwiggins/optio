/**
 * The review row a launch builds on, against the real database: an active
 * review is picked over a historical cancelled duplicate of the same PR URL
 * whatever their order; with no active one, the newest.
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews } from "../db/schema.js";
import { findReviewByUrl, getPrStatus, mergePr, parseReviewOutput } from "./pr-review-service.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";

async function insertReview(prUrl: string, state: string, updatedAt: Date) {
  const [row] = await db
    .insert(prReviews)
    .values({
      prUrl,
      prNumber: 7,
      repoOwner: "o",
      repoName: "r",
      repoUrl: "https://github.com/o/r",
      headSha: "abc",
      state: state as never,
      updatedAt,
    })
    .returning();
  return row;
}

describe("findReviewByUrl", () => {
  it("prefers the active review over a newer cancelled duplicate", async () => {
    const url = "https://github.com/o/r/pull/7";
    const older = new Date(Date.now() - 3_600_000);
    const newer = new Date();
    const active = await insertReview(url, "reviewing", older);
    await insertReview(url, "cancelled", newer);
    expect((await findReviewByUrl(url))?.id).toBe(active.id);
  });

  it("prefers the active review over an older cancelled duplicate", async () => {
    const url = "https://github.com/o/r/pull/8";
    await insertReview(url, "cancelled", new Date(Date.now() - 3_600_000));
    const active = await insertReview(url, "ready", new Date());
    expect((await findReviewByUrl(url))?.id).toBe(active.id);
  });

  it("with no active review, picks the most recently updated", async () => {
    const url = "https://github.com/o/r/pull/9";
    await insertReview(url, "cancelled", new Date(Date.now() - 3_600_000));
    const newest = await insertReview(url, "submitted", new Date());
    expect((await findReviewByUrl(url))?.id).toBe(newest.id);
    expect(await findReviewByUrl("https://github.com/o/r/pull/404")).toBeUndefined();
  });

  it("the unique index keeps a second active review out", async () => {
    const url = "https://github.com/o/r/pull/10";
    await insertReview(url, "queued", new Date());
    await expect(insertReview(url, "reviewing", new Date())).rejects.toSatisfy((err: unknown) => {
      const cause = (err as { cause?: { message?: string } }).cause;
      return /pr_reviews_active_pr_url_key/.test(cause?.message ?? (err as Error).message);
    });
    await db.execute(sql`DELETE FROM "pr_reviews" WHERE "pr_url" = ${url}`);
  });
});

describe("getPrStatus / mergePr with a caller's workspace", () => {
  it("refuses a PR whose repo isn't registered in the caller's workspace, before any platform call", async () => {
    const own = await insertWorkspace();
    const other = await insertWorkspace();
    const repo = await insertRepo({ workspaceId: other.id });
    // Another workspace's repo, and a repo nobody registered: the server
    // token must not read or merge either on this caller's behalf.
    for (const prUrl of [
      `${repo.repoUrl}/pull/7`,
      "https://github.com/someone-else/private/pull/1",
    ]) {
      await expect(getPrStatus(prUrl, { workspaceId: own.id })).rejects.toThrow(
        /not configured in this workspace/,
      );
      await expect(mergePr({ prUrl, mergeMethod: "squash", workspaceId: own.id })).rejects.toThrow(
        /not configured in this workspace/,
      );
    }
  });
});

describe("parseReviewOutput", () => {
  it("applies the draft file the agent wrote", async () => {
    const review = await insertReview("https://github.com/o/r/pull/11", "reviewing", new Date());
    const [run] = await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, resultSummary: "Done." })
      .returning();
    const fileComments = [{ path: "src/a.ts", line: 3, body: "Off by one." }];
    await parseReviewOutput(
      run.id,
      JSON.stringify({ verdict: "request_changes", summary: "One bug.", fileComments }),
    );
    const [updated] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(updated).toMatchObject({
      state: "ready",
      verdict: "request_changes",
      summary: "One bug.",
      fileComments,
    });
  });
});
