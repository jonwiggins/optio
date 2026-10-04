import { describe, expect, it } from "vitest";
import { compact, fieldChanges, norm, sameSet } from "./compare.js";

describe("fieldChanges", () => {
  it("names the desired fields that differ, treating null and undefined alike", () => {
    const row = { name: "a", prompt: "p", settings: null, maxTurns: null, budgetUsd: "5.0" };
    expect(fieldChanges(row, { name: "a", prompt: "q" })).toEqual(["prompt"]);
    expect(fieldChanges(row, { settings: undefined, maxTurns: null })).toEqual([]);
    expect(fieldChanges(row, { budgetUsd: 5 })).toEqual([]);
    expect(fieldChanges(row, { budgetUsd: "6" })).toEqual(["budgetUsd"]);
  });

  it("compares jsonb with keys in any order", () => {
    const row = { settings: { connections: { add: ["x"] }, review: { enabled: true } } };
    expect(
      fieldChanges(row, { settings: { review: { enabled: true }, connections: { add: ["x"] } } }),
    ).toEqual([]);
    expect(fieldChanges(row, { settings: { review: { enabled: false } } })).toEqual(["settings"]);
  });

  it("compares dates as instants", () => {
    const at = new Date("2026-10-04T00:00:00Z");
    expect(norm(at)).toBe("2026-10-04T00:00:00.000Z");
    expect(fieldChanges({ at }, { at: new Date(at.getTime()) })).toEqual([]);
  });
});

describe("sameSet", () => {
  it("ignores order and duplicates; null, undefined and [] are the same", () => {
    expect(sameSet(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameSet(null, [])).toBe(true);
    expect(sameSet(undefined, null)).toBe(true);
    expect(sameSet(["a"], ["b"])).toBe(false);
  });
});

describe("compact", () => {
  it("drops null, undefined and empty objects but keeps false, 0 and arrays", () => {
    expect(compact({ a: null, b: undefined, c: {}, d: false, e: 0, f: [], g: "x" })).toEqual({
      d: false,
      e: 0,
      f: [],
      g: "x",
    });
  });
});
