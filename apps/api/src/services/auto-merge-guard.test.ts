import { describe, it, expect } from "vitest";
import type { Review } from "@optio/shared";
import {
  AGENT_MERGE_MESSAGE,
  agentMergeBlocker,
  hasChangesRequested,
  markReviewsIncomplete,
  pullRequestBlocker,
  reviewsIncomplete,
} from "./auto-merge-guard.js";

const review = (author: string, state: Review["state"]): Review => ({ author, state, body: "" });

describe("agentMergeBlocker (the controller's merge_pr)", () => {
  it("a person's own token (no run) merges", () => {
    expect(agentMergeBlocker({})).toBeNull();
  });

  it("an agent in a session whose writes ask the person first merges after the card", () => {
    expect(
      agentMergeBlocker({ run: { sessionId: "s" }, sessionPolicy: { confirmWrites: true } }),
    ).toBeNull();
  });

  it("an agent run's own token never merges", () => {
    expect(agentMergeBlocker({ run: {} })).toBe(AGENT_MERGE_MESSAGE);
    expect(agentMergeBlocker({ run: {}, sessionPolicy: { confirmWrites: true } })).toBe(
      AGENT_MERGE_MESSAGE,
    );
    expect(
      agentMergeBlocker({ run: { sessionId: "s" }, sessionPolicy: { confirmWrites: false } }),
    ).toBe(AGENT_MERGE_MESSAGE);
    expect(agentMergeBlocker({ run: { sessionId: "s" } })).toBe(AGENT_MERGE_MESSAGE);
  });
});

describe("pullRequestBlocker", () => {
  it("a reviewer's latest changes-requested blocks, their own later approval clears it", () => {
    expect(hasChangesRequested([review("a", "CHANGES_REQUESTED"), review("b", "APPROVED")])).toBe(
      true,
    );
    expect(
      hasChangesRequested([
        review("a", "CHANGES_REQUESTED"),
        review("a", "COMMENTED"),
        review("a", "APPROVED"),
      ]),
    ).toBe(false);
  });

  it("drafts and conflicts block", () => {
    expect(pullRequestBlocker({ draft: true, mergeable: true }, [])).toBe("pr_draft");
    expect(pullRequestBlocker({ draft: false, mergeable: false }, [])).toBe("pr_not_mergeable");
    expect(pullRequestBlocker({ draft: false, mergeable: null }, [])).toBeNull();
  });

  it("an incomplete review read never allows a merge", () => {
    const partial = markReviewsIncomplete([review("a", "APPROVED")]);
    expect(reviewsIncomplete(partial)).toBe(true);
    expect(reviewsIncomplete([review("a", "APPROVED")])).toBe(false);
    expect(pullRequestBlocker({ draft: false, mergeable: true }, partial)).toBe(
      "pr_reviews_incomplete",
    );
    // A known change request still says so first.
    expect(
      pullRequestBlocker(
        { draft: false, mergeable: true },
        markReviewsIncomplete([review("b", "CHANGES_REQUESTED")]),
      ),
    ).toBe("pr_changes_requested");
  });
});
