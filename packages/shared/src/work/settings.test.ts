import { describe, expect, it } from "vitest";
import { applyIdOverrides, cleanWorkSettings, withoutPrSettings } from "./settings.js";

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

  it("does not add back an id it was told to remove", () => {
    const out = applyIdOverrides(defaults, available, (i) => i.id, { add: ["b"], remove: ["b"] });
    expect(ids(out)).toEqual(["a"]);
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

  it("keeps explicit choices, including turning things off", () => {
    expect(
      cleanWorkSettings({
        setupCommands: "  npm ci\n",
        review: { enabled: false },
        cautiousMode: false,
        maxAutoResumes: 0,
      }),
    ).toEqual({
      setupCommands: "npm ci",
      review: { enabled: false },
      cautiousMode: false,
      maxAutoResumes: 0,
    });
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
