import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TURNS_REVIEW, LIGHT_REVIEW_NOTE } from "@optio/shared";
import { planReviewRun, withReviewDepth } from "./review-defaults.js";

describe("planReviewRun", () => {
  it("a thorough review is the review Optio always ran", () => {
    const plan = planReviewRun({ repo: { testCommand: "npm test", maxTurnsReview: 40 } });
    expect(plan).toEqual({
      depth: "thorough",
      testCommand: "npm test",
      maxTurnsReview: undefined,
      vars: { REVIEW_DEPTH: "thorough" },
    });
    expect(withReviewDepth("Review it.", plan)).toBe("Review it.");
  });

  it("a light one runs no tests, has half the turns and says so after the prompt", () => {
    const plan = planReviewRun({
      repo: { reviewDepth: "light", testCommand: "npm test", maxTurnsReview: 40 },
    });
    expect(plan.testCommand).toBe("");
    expect(plan.maxTurnsReview).toBe(20);
    expect(withReviewDepth("Review it.", plan)).toBe(`Review it.${LIGHT_REVIEW_NOTE}`);
  });

  it("the workspace's depth applies when the repo sets none, with the default turns halved", () => {
    const plan = planReviewRun({ repo: {}, workspace: { reviewDepth: "light" } });
    expect(plan.depth).toBe("light");
    expect(plan.maxTurnsReview).toBe(Math.ceil(DEFAULT_MAX_TURNS_REVIEW / 2));
    expect(
      planReviewRun({ repo: { reviewDepth: "thorough" }, workspace: { reviewDepth: "light" } })
        .depth,
    ).toBe("thorough");
  });

  it("work can ask a light repo for a thorough review", () => {
    const plan = planReviewRun({
      repo: { reviewEnabled: true, reviewDepth: "light", testCommand: "make test" },
      work: { review: { enabled: true, depth: "thorough" } },
    });
    expect(plan.depth).toBe("thorough");
    expect(plan.testCommand).toBe("make test");
  });
});
