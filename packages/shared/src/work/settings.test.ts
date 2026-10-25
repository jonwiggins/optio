import { describe, expect, it } from "vitest";
import {
  applyIdOverrides,
  cleanWorkSettings,
  effectivePrSettings,
  effectiveReviewDepth,
  parseReviewDepth,
  loadWithOverrides,
  withoutPrSettings,
} from "./settings.js";

const item = (id: string) => ({ id });
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("applyIdOverrides", () => {
  const defaults = [item("a"), item("b")];
  const available = [item("a"), item("b"), item("c"), item("d")];

  it("is the defaults when nothing is overridden", () => {
    expect(ids(applyIdOverrides(defaults, available, (i) => i.id, null))).toEqual(["a", "b"]);
    expect(ids(applyIdOverrides(defaults, available, (i) => i.id, {}))).toEqual(["a", "b"]);
  });

  it("takes out removed ids and adds available ones once, in order", () => {
    const out = applyIdOverrides(defaults, available, (i) => i.id, {
      add: ["d", "c", "d", "a"],
      remove: ["b"],
    });
    expect(ids(out)).toEqual(["a", "d", "c"]);
  });

  it("ignores ids that are not available (deleted, or another workspace's)", () => {
    const out = applyIdOverrides(defaults, available, (i) => i.id, { add: ["zzz"], remove: ["x"] });
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("an id both added and removed is added, as cleanWorkSettings stores it", () => {
    const out = applyIdOverrides(defaults, available, (i) => i.id, { add: ["b"], remove: ["b"] });
    expect(ids(out)).toEqual(["a", "b"]);
  });
});

describe("loadWithOverrides", () => {
  it("loads the full list only when something is added", async () => {
    let loads = 0;
    const all = async () => {
      loads++;
      return [item("a"), item("b"), item("c")];
    };
    const removed = await loadWithOverrides(
      Promise.resolve([item("a"), item("b")]),
      all,
      (i) => i.id,
      {
        remove: ["a"],
      },
    );
    expect(ids(removed)).toEqual(["b"]);
    expect(loads).toBe(0);
    const added = await loadWithOverrides(Promise.resolve([item("a")]), all, (i) => i.id, {
      add: ["c"],
    });
    expect(ids(added)).toEqual(["a", "c"]);
    expect(loads).toBe(1);
  });
});

describe("effectivePrSettings", () => {
  it("follows the repo when the work says nothing", () => {
    expect(
      effectivePrSettings(
        null,
        { cautiousMode: true, reviewEnabled: true, reviewTrigger: "on_pr", maxAutoResumes: 4 },
        10,
      ),
    ).toEqual({
      cautiousMode: true,
      reviewEnabled: true,
      reviewTrigger: "on_pr",
      maxAutoResumes: 4,
    });
    expect(effectivePrSettings({}, null, 10)).toEqual({
      cautiousMode: false,
      reviewEnabled: false,
      reviewTrigger: null,
      maxAutoResumes: 10,
    });
  });

  it("makes runs more careful than the repo, never less", () => {
    const repo = {
      cautiousMode: true,
      reviewEnabled: true,
      reviewTrigger: "on_pr",
      maxAutoResumes: 3,
    };
    expect(
      effectivePrSettings(
        { cautiousMode: false, review: { enabled: false }, maxAutoResumes: 50 },
        repo,
        10,
      ),
    ).toEqual({
      cautiousMode: true,
      reviewEnabled: true,
      reviewTrigger: "on_pr",
      maxAutoResumes: 3,
    });
    expect(
      effectivePrSettings(
        { cautiousMode: true, review: { enabled: true, trigger: "on_pr" }, maxAutoResumes: 1 },
        { reviewTrigger: "manual" },
        10,
      ),
    ).toEqual({
      cautiousMode: true,
      reviewEnabled: true,
      reviewTrigger: "on_pr",
      maxAutoResumes: 1,
    });
  });

  it("a review the work asks for launches by itself: its trigger, the repo's, or after CI", () => {
    expect(
      effectivePrSettings({ review: { enabled: true } }, { reviewTrigger: "on_pr" }, 10),
    ).toMatchObject({ reviewTrigger: "on_pr" });
    expect(
      effectivePrSettings({ review: { enabled: true } }, { reviewTrigger: "manual" }, 10),
    ).toMatchObject({ reviewTrigger: "on_ci_pass" });
    // A repo review that is manual only launches nothing by itself.
    expect(
      effectivePrSettings({}, { reviewEnabled: true, reviewTrigger: "manual" }, 10),
    ).toMatchObject({ reviewEnabled: true, reviewTrigger: null });
  });
});

describe("cleanWorkSettings", () => {
  it("stores nothing for settings that change nothing", () => {
    expect(cleanWorkSettings(null)).toBeNull();
    expect(cleanWorkSettings({})).toBeNull();
    expect(
      cleanWorkSettings({
        connections: { add: [], remove: [] },
        mcpServers: {},
        setupCommands: "   ",
        review: null,
        cautiousMode: null,
        maxAutoResumes: null,
      }),
    ).toBeNull();
  });

  it("dedupes ids, and an id both added and removed is added", () => {
    expect(
      cleanWorkSettings({ connections: { add: ["a", "a", "b"], remove: ["b", "c", "c"] } }),
    ).toEqual({ connections: { add: ["a", "b"], remove: ["c"] } });
  });

  it("keeps what tightens the repo's settings; 'no review' and 'ready PRs' say nothing", () => {
    expect(
      cleanWorkSettings({
        setupCommands: "  npm ci\n",
        review: { enabled: false },
        cautiousMode: false,
        maxAutoResumes: 0,
      }),
    ).toEqual({ setupCommands: "npm ci", maxAutoResumes: 0 });
    expect(cleanWorkSettings({ cautiousMode: true })).toEqual({ cautiousMode: true });
    expect(cleanWorkSettings({ review: { enabled: true, trigger: "on_pr" } })).toEqual({
      review: { enabled: true, trigger: "on_pr" },
    });
    expect(cleanWorkSettings({ maxAutoResumes: 2.7 })).toEqual({ maxAutoResumes: 2 });
  });
});

describe("withoutPrSettings", () => {
  it("drops what only means something for work that opens a PR", () => {
    expect(
      withoutPrSettings({
        skills: { add: ["s"] },
        review: { enabled: true },
        cautiousMode: true,
        maxAutoResumes: 3,
      }),
    ).toEqual({ skills: { add: ["s"] } });
    expect(withoutPrSettings({ review: { enabled: true } })).toBeNull();
    expect(withoutPrSettings(null)).toBeNull();
  });
});

describe("review depth", () => {
  it("keeps a work review's depth, and drops an unknown one", () => {
    expect(cleanWorkSettings({ review: { enabled: true, depth: "light" } })).toEqual({
      review: { enabled: true, depth: "light" },
    });
    expect(
      cleanWorkSettings({ review: { enabled: true, depth: "deep" as never, trigger: "on_pr" } }),
    ).toEqual({ review: { enabled: true, trigger: "on_pr" } });
    // A depth without a review of the work's own says nothing.
    expect(cleanWorkSettings({ review: { enabled: false, depth: "light" } })).toBeNull();
  });

  it("parses only the two depths", () => {
    expect(parseReviewDepth("light")).toBe("light");
    expect(parseReviewDepth("thorough")).toBe("thorough");
    expect(parseReviewDepth("deep")).toBeNull();
    expect(parseReviewDepth(null)).toBeNull();
  });

  it("is the repo's, else the workspace's, else thorough", () => {
    expect(effectiveReviewDepth(null, { reviewDepth: "light" }, "thorough")).toBe("light");
    expect(effectiveReviewDepth(null, { reviewDepth: null }, "light")).toBe("light");
    expect(effectiveReviewDepth(null, null, null)).toBe("thorough");
  });

  it("lets work be more careful than a reviewing repo, never less", () => {
    const light = { review: { enabled: true, depth: "light" as const } };
    const thorough = { review: { enabled: true, depth: "thorough" as const } };
    expect(effectiveReviewDepth(thorough, { reviewEnabled: true, reviewDepth: "light" })).toBe(
      "thorough",
    );
    expect(effectiveReviewDepth(light, { reviewEnabled: true, reviewDepth: "thorough" })).toBe(
      "thorough",
    );
    expect(effectiveReviewDepth(light, { reviewEnabled: true, reviewDepth: "light" })).toBe(
      "light",
    );
  });

  it("takes the work's own depth when only the work asks for a review", () => {
    const light = { review: { enabled: true, depth: "light" as const } };
    expect(effectiveReviewDepth(light, { reviewEnabled: false, reviewDepth: "thorough" })).toBe(
      "light",
    );
    // A review without a depth of its own goes as deep as the repo's default.
    expect(
      effectiveReviewDepth(
        { review: { enabled: true } },
        { reviewEnabled: false, reviewDepth: "light" },
      ),
    ).toBe("light");
  });
});
