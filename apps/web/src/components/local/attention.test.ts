import { describe, it, expect } from "vitest";
import { faviconDataUrl, ringingBells, summarizeAttention, TONE_COLOR } from "./attention";

const t = (id: string, attentionState: string, state = "running") => ({
  id,
  attentionState,
  state,
});

describe("summarizeAttention", () => {
  it("is idle with nothing live", () => {
    expect(summarizeAttention([]).tone).toBe("idle");
    expect(summarizeAttention([t("a", "idle"), t("b", "working", "exited")]).tone).toBe("idle");
  });

  it("is working when any live terminal works", () => {
    const s = summarizeAttention([t("a", "idle"), t("b", "working")]);
    expect(s.tone).toBe("working");
    expect(s.working).toBe(1);
  });

  it("needs-you wins over working and counts", () => {
    const s = summarizeAttention([t("a", "working"), t("b", "needs_you"), t("c", "needs_you")]);
    expect(s.tone).toBe("needs_you");
    expect(s.needsYou).toBe(2);
  });
});

describe("faviconDataUrl", () => {
  it("embeds the tone color", () => {
    const url = decodeURIComponent(faviconDataUrl("needs_you"));
    expect(url.startsWith("data:image/svg+xml,<svg")).toBe(true);
    expect(url).toContain(TONE_COLOR.needs_you);
  });
});

describe("ringingBells", () => {
  const prev = new Map([
    ["a", "working"],
    ["b", "needs_you"],
  ]);

  it("rings for an armed terminal that just flipped to needs-you", () => {
    const out = ringingBells(prev, [t("a", "needs_you")], ["a"]);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("stays quiet when not armed, already ringing, or not needing you", () => {
    expect(ringingBells(prev, [t("a", "needs_you")], [])).toEqual([]);
    expect(ringingBells(prev, [t("b", "needs_you")], ["b"])).toEqual([]);
    expect(ringingBells(prev, [t("a", "working")], ["a"])).toEqual([]);
  });

  it("does not ring on first load for something already waiting", () => {
    expect(ringingBells(new Map(), [t("c", "needs_you")], ["c"])).toEqual([]);
  });
});
