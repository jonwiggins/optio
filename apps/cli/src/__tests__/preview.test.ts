import { describe, it, expect } from "vitest";
import { buildPreview, stripAnsi, PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "../local/preview.js";

describe("stripAnsi", () => {
  it("removes CSI color/cursor sequences", () => {
    expect(stripAnsi("\x1b[1;32mPASS\x1b[0m tests\x1b[2K")).toBe("PASS tests");
  });

  it("removes OSC sequences with both BEL and ST terminators", () => {
    expect(stripAnsi("\x1b]0;title\x07before \x1b]8;;http://x\x1b\\after")).toBe("before after");
  });

  it("removes stray control characters but keeps newlines and tabs", () => {
    expect(stripAnsi("a\x07b\x00c\nd\te")).toBe("abc\nd\te");
  });
});

describe("buildPreview", () => {
  it("strips ANSI and keeps content", () => {
    const preview = buildPreview("\x1b[31merror:\x1b[0m something failed\n");
    expect(preview).toBe("error: something failed");
  });

  it("keeps only the last non-empty lines", () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const preview = buildPreview(raw);
    const lines = preview.split("\n");
    expect(lines).toHaveLength(PREVIEW_MAX_LINES);
    expect(lines[0]).toBe("line 9");
    expect(lines.at(-1)).toBe("line 20");
  });

  it("drops blank and whitespace-only lines", () => {
    expect(buildPreview("one\n\n   \n\ntwo\n")).toBe("one\ntwo");
  });

  it("treats bare carriage returns as line separators", () => {
    expect(buildPreview("progress 1\rprogress 2\rdone")).toBe("progress 1\nprogress 2\ndone");
  });

  it("caps the preview at the char limit, keeping the most recent output", () => {
    const raw = Array.from({ length: 12 }, (_, i) => `${i}${"x".repeat(400)}`).join("\n");
    const preview = buildPreview(raw);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(preview.endsWith("x")).toBe(true);
    expect(preview).toContain("11"); // last line survives
  });
});
