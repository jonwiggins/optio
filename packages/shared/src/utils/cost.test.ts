import { describe, it, expect } from "vitest";
import { addCostStrings, addTokenCounts } from "./cost.js";

describe("addCostStrings", () => {
  it("accumulates prior + current cost (the resume undercount fix)", () => {
    // Original run cost $0.0534; resumed run reports only its own $0.0212.
    // The task total must reflect both, not just the resumed invocation.
    expect(addCostStrings("0.0534", "0.0212")).toBe("0.0746");
  });

  it("treats a null prior cost as zero (first run)", () => {
    expect(addCostStrings(null, "0.0123")).toBe("0.0123");
    expect(addCostStrings(undefined, "0.0123")).toBe("0.0123");
  });

  it("treats an empty-string prior cost as zero", () => {
    expect(addCostStrings("", "0.5")).toBe("0.5");
  });

  it("returns the prior cost when the new cost is missing", () => {
    expect(addCostStrings("0.42", null)).toBe("0.42");
  });

  it("is decimal-safe: 0.1 + 0.2 does not drift to 0.30000000000000004", () => {
    expect(addCostStrings("0.1", "0.2")).toBe("0.3");
  });

  it("handles differing decimal precision without drift", () => {
    expect(addCostStrings("0.001", "0.00012345")).toBe("0.00112345");
  });

  it("accepts numbers as well as strings", () => {
    expect(addCostStrings(0.0534, 0.0212)).toBe("0.0746");
  });

  it("never emits scientific notation for tiny costs", () => {
    const sum = addCostStrings("0.0000001", "0.0000002");
    expect(sum).not.toMatch(/e/i);
    expect(Number(sum)).toBeCloseTo(0.0000003, 12);
  });

  it("treats non-numeric junk as zero rather than NaN", () => {
    expect(addCostStrings("not-a-number", "0.25")).toBe("0.25");
    expect(addCostStrings("0.25", "junk")).toBe("0.25");
  });

  it("accumulates repeatedly across multiple resumes", () => {
    let total = addCostStrings(null, "0.05");
    total = addCostStrings(total, "0.03");
    total = addCostStrings(total, "0.02");
    expect(total).toBe("0.1");
  });
});

describe("addTokenCounts", () => {
  it("adds two token counts", () => {
    expect(addTokenCounts(300, 125)).toBe(425);
  });

  it("treats nullish operands as zero", () => {
    expect(addTokenCounts(null, 125)).toBe(125);
    expect(addTokenCounts(300, undefined)).toBe(300);
    expect(addTokenCounts(null, null)).toBe(0);
  });
});
