import { describe, expect, it } from "vitest";
import { onGridAnnounced, passiveFontPx, sameGrid } from "./sizing";

describe("passiveFontPx", () => {
  it("shrinks the font so an oversize grid fits the width", () => {
    // 390px phone, 160-col laptop grid, 0.6 cell ratio → 4.06 → floored 4 → clamped to 5
    expect(passiveFontPx(390, 160, 0.6)).toBe(5);
    // 1000px, 120 cols → 13.8 → 13 (never above base)
    expect(passiveFontPx(1000, 120, 0.6)).toBe(13);
    // 600px, 120 cols → 8.3 → 8
    expect(passiveFontPx(600, 120, 0.6)).toBe(8);
  });

  it("never grows past the base size for a small grid", () => {
    expect(passiveFontPx(1600, 40, 0.6)).toBe(13);
  });

  it("falls back to the base size on degenerate input", () => {
    expect(passiveFontPx(0, 120, 0.6)).toBe(13);
    expect(passiveFontPx(600, 0, 0.6)).toBe(13);
    expect(passiveFontPx(600, 120, 0)).toBe(13);
  });
});

describe("onGridAnnounced", () => {
  const laptop = { cols: 160, rows: 45 };
  const phone = { cols: 45, rows: 30 };

  it("stays unclaimed when the PTY already matches our natural fit", () => {
    expect(onGridAnnounced({ kind: "unclaimed" }, laptop, laptop, null)).toEqual({
      kind: "unclaimed",
    });
  });

  it("goes passive when another viewer's grid arrives", () => {
    expect(onGridAnnounced({ kind: "unclaimed" }, phone, laptop, null)).toEqual({
      kind: "passive",
      grid: phone,
    });
  });

  it("keeps ownership when its own request echoes back", () => {
    expect(onGridAnnounced({ kind: "owner" }, laptop, laptop, laptop)).toEqual({ kind: "owner" });
  });

  it("loses ownership when someone else resizes the PTY", () => {
    expect(onGridAnnounced({ kind: "owner" }, phone, laptop, laptop)).toEqual({
      kind: "passive",
      grid: phone,
    });
  });

  it("returns to unclaimed when the PTY comes back to our natural fit", () => {
    expect(onGridAnnounced({ kind: "passive", grid: phone }, laptop, laptop, null)).toEqual({
      kind: "unclaimed",
    });
  });

  it("sameGrid handles nulls", () => {
    expect(sameGrid(null, laptop)).toBe(false);
    expect(sameGrid(laptop, { ...laptop })).toBe(true);
  });

  it("pins a recorded grid even when it matches our natural fit", () => {
    // An exited terminal's final screen was drawn for `laptop`; there is no
    // PTY to size, so the grid stays passive rather than following resizes.
    expect(onGridAnnounced({ kind: "unclaimed" }, laptop, laptop, null, true)).toEqual({
      kind: "passive",
      grid: laptop,
    });
    expect(onGridAnnounced({ kind: "owner" }, laptop, laptop, laptop, true)).toEqual({
      kind: "passive",
      grid: laptop,
    });
  });
});
