import { describe, expect, it } from "vitest";
import {
  cleanWorkSettings,
  effectiveReviewDepth,
  parseReviewDepth,
  reviewMaxTurns,
} from "./settings.js";

describe("review depth", () => {
  it("parses only the two depths", () => {
    expect(parseReviewDepth("thorough")).toBe("thorough");
    expect(parseReviewDepth("light")).toBe("light");
    expect(parseReviewDepth("deep")).toBeNull();
    expect(parseReviewDepth(null)).toBeNull();
  });

  it("the repo's depth, else the workspace's, else thorough", () => {
    expect(effectiveReviewDepth(null, null)).toBe("thorough");
    expect(effectiveReviewDepth(null, null, "light")).toBe("light");
    expect(effectiveReviewDepth(null, { reviewDepth: "thorough" }, "light")).toBe("thorough");
    expect(effectiveReviewDepth(null, { reviewDepth: "light" }, "thorough")).toBe("light");
    expect(effectiveReviewDepth(null, { reviewDepth: "bogus" }, "bogus")).toBe("thorough");
  });

  it("work can only make a repo's review more careful", () => {
    const light = { review: { enabled: true, depth: "light" as const } };
    const thorough = { review: { enabled: true, depth: "thorough" as const } };
    // Over a repo that reviews thoroughly, a light ask stays thorough.
    expect(effectiveReviewDepth(light, { reviewEnabled: true, reviewDepth: "thorough" })).toBe(
      "thorough",
    );
    // A light repo goes thorough when the work asks.
    expect(effectiveReviewDepth(thorough, { reviewEnabled: true, reviewDepth: "light" })).toBe(
      "thorough",
    );
    // Without a repo review, the work's own review is as the work says.
    expect(effectiveReviewDepth(light, { reviewEnabled: false, reviewDepth: "thorough" })).toBe(
      "light",
    );
    // A depth without the work's own review says nothing.
    expect(
      effectiveReviewDepth(
        { review: { enabled: false, depth: "thorough" } },
        { reviewDepth: "light" },
      ),
    ).toBe("light");
  });

  it("a light review has half the turns, at least five", () => {
    expect(reviewMaxTurns("thorough", 30)).toBe(30);
    expect(reviewMaxTurns("light", 30)).toBe(15);
    expect(reviewMaxTurns("light", 7)).toBe(5);
  });

  it("keeps a known depth with the work's own review, drops anything else", () => {
    expect(cleanWorkSettings({ review: { enabled: true, depth: "light" } })?.review).toEqual({
      enabled: true,
      depth: "light",
    });
    expect(
      cleanWorkSettings({ review: { enabled: true, depth: "deep" as never } })?.review,
    ).toEqual({ enabled: true });
  });
});
