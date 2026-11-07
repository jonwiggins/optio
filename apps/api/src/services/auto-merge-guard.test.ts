import { describe, it, expect } from "vitest";
import type { Review, WorldSnapshot } from "@optio/shared";
import {
  AGENT_MERGE_MESSAGE,
  agentMergeBlocker,
  autoMergeSettingBlocker,
  hasChangesRequested,
  pullRequestBlocker,
} from "./auto-merge-guard.js";
import { determineReviewStatus } from "../workers/pr-watcher-worker.js";
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

  it("a dismissed change request no longer blocks", () => {
    expect(
      pullRequestBlocker({ draft: false, mergeable: true }, [
        review("a", "CHANGES_REQUESTED"),
        review("a", "DISMISSED"),
        review("b", "APPROVED"),
      ]),
    ).toBeNull();
    expect(
      pullRequestBlocker({ draft: false, mergeable: true }, [
        review("a", "CHANGES_REQUESTED"),
        review("b", "APPROVED"),
      ]),
    ).toBe("pr_changes_requested");
  });
});

describe("determineReviewStatus agrees with the merge guard", () => {
  it.each([
    [[review("a", "CHANGES_REQUESTED"), review("b", "APPROVED")]],
    [[review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")]],
    [[review("a", "APPROVED"), review("b", "CHANGES_REQUESTED"), review("b", "COMMENTED")]],
    [[review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED"), review("b", "APPROVED")]],
    [[review("a", "APPROVED"), review("b", "APPROVED")]],
  ])("%j", (reviews) => {
    expect(determineReviewStatus(reviews).status === "changes_requested").toBe(
      hasChangesRequested(reviews),
    );
  });

  it("carries every open request's text", () => {
    const reviews: Review[] = [
      { author: "a", state: "CHANGES_REQUESTED", body: "Fix X" },
      { author: "b", state: "CHANGES_REQUESTED", body: "Fix Y" },
      { author: "c", state: "APPROVED", body: "" },
    ];
    expect(determineReviewStatus(reviews)).toEqual({
      status: "changes_requested",
      comments: "Fix X\n\nFix Y",
    });
  });
});

describe("autoMergeSettingBlocker", () => {
  const snap = (s: { autoMerge: boolean; autoMergeConfirmed?: boolean; cautiousMode?: boolean }) =>
    ({ settings: { cautiousMode: false, ...s } }) as unknown as WorldSnapshot;

  it("only a confirmed setting outside cautious mode merges", () => {
    expect(autoMergeSettingBlocker(snap({ autoMerge: true, autoMergeConfirmed: true }))).toBeNull();
    expect(autoMergeSettingBlocker(snap({ autoMerge: true }))).toBe("auto_merge_not_confirmed");
    expect(autoMergeSettingBlocker(snap({ autoMerge: false, autoMergeConfirmed: true }))).toBe(
      "auto_merge_not_confirmed",
    );
    expect(
      autoMergeSettingBlocker(
        snap({ autoMerge: true, autoMergeConfirmed: true, cautiousMode: true }),
      ),
    ).toBe("auto_merge_not_confirmed");
  });
});
