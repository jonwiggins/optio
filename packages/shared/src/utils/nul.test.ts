import { describe, expect, it } from "vitest";
import { sanitizeJson, stripNul } from "./nul.js";

describe("stripNul", () => {
  it("replaces every NUL with U+FFFD", () => {
    expect(stripNul("a\u0000b\u0000")).toBe("a�b�");
    expect(stripNul("\u0000")).toBe("�");
  });

  it("returns the same string when there is nothing to strip", () => {
    const s = "plain text, émojis 🎉, and \\u0000 spelled out";
    expect(stripNul(s)).toBe(s);
    expect(stripNul("")).toBe("");
  });
});

describe("sanitizeJson", () => {
  it("cleans every string, however deep, keys included", () => {
    expect(
      sanitizeJson({
        text: "a\u0000b",
        nested: { list: ["x\u0000", 1, null, { deep: "\u0000" }] },
        "k\u0000ey": true,
        n: 3,
        ok: "fine",
      }),
    ).toEqual({
      text: "a�b",
      nested: { list: ["x�", 1, null, { deep: "�" }] },
      "k�ey": true,
      n: 3,
      ok: "fine",
    });
  });

  it("returns the same reference when nothing holds a NUL", () => {
    const value = { a: "x", b: [1, "y", { c: "z" }], d: null };
    expect(sanitizeJson(value)).toBe(value);
    expect(sanitizeJson(value.b)).toBe(value.b);
  });

  it("passes non-JSON values through untouched", () => {
    const at = new Date("2026-04-07T12:00:00Z");
    expect(sanitizeJson(at)).toBe(at);
    expect(sanitizeJson(42)).toBe(42);
    expect(sanitizeJson(null)).toBe(null);
    expect(sanitizeJson(undefined)).toBe(undefined);
    expect(sanitizeJson(true)).toBe(true);
  });
});
