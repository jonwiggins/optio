import { describe, expect, it } from "vitest";
import { addToSplit, parseSplit, splitHref } from "./split-state";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

describe("split-state", () => {
  it("parses split ids, dropping junk, duplicates, the primary, and anything past 3 panes", () => {
    const sp = new URLSearchParams(`split=${B},nope,${B},${A},${C},${D}&layout=rows`);
    expect(parseSplit(sp, A)).toEqual({ split: [B, C], layout: "rows" });
    expect(parseSplit(null)).toEqual({ split: [], layout: "cols" });
  });

  it("builds hrefs that omit empty state and the default layout", () => {
    expect(splitHref(A, [], "rows")).toBe(`/local/${A}`);
    expect(splitHref(A, [B], "cols")).toBe(`/local/${A}?split=${B}`);
    expect(splitHref(A, [B, A, C], "rows")).toBe(`/local/${A}?split=${B}%2C${C}&layout=rows`);
  });

  it("addToSplit keeps the newest panes when full and ignores what is already shown", () => {
    const s = { split: [B, C], layout: "cols" as const };
    expect(addToSplit(A, s, D)).toEqual([C, D]);
    expect(addToSplit(A, s, B)).toEqual([B, C]);
    expect(addToSplit(A, s, A)).toEqual([B, C]);
  });
});
