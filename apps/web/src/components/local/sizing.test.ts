import { describe, expect, it } from "vitest";
import { ackSentGrid, onGridAnnounced, passiveFontPx, pushSentGrid, sameGrid } from "./sizing";

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
    expect(onGridAnnounced({ kind: "unclaimed" }, laptop, laptop, [])).toEqual({
      kind: "unclaimed",
    });
  });

  it("goes passive when another viewer's grid arrives", () => {
    expect(onGridAnnounced({ kind: "unclaimed" }, phone, laptop, [])).toEqual({
      kind: "passive",
      grid: phone,
    });
  });

  it("keeps ownership when its own request echoes back", () => {
    expect(onGridAnnounced({ kind: "owner" }, laptop, laptop, [laptop])).toEqual({
      kind: "owner",
    });
  });

  it("keeps ownership on a stale echo of an earlier request", () => {
    // A claim fits twice in quick succession (the strip leaves, the pane
    // grows, the observer refits): the echo of the first request arrives
    // after the second was sent. Both are ours.
    const first = { cols: 143, rows: 54 };
    const second = { cols: 143, rows: 56 };
    let sent = pushSentGrid([], first);
    sent = pushSentGrid(sent, second);
    expect(onGridAnnounced({ kind: "owner" }, first, second, sent)).toEqual({ kind: "owner" });
    sent = ackSentGrid(sent, first)!;
    expect(sent).toEqual([second]);
    expect(onGridAnnounced({ kind: "owner" }, second, second, sent)).toEqual({ kind: "owner" });
    expect(ackSentGrid(sent, second)).toEqual([]);
    // A grid we never asked for matches nothing.
    expect(ackSentGrid(sent, phone)).toBeNull();
  });

  it("caps the pending queue when a daemon never echoes", () => {
    let sent: ReturnType<typeof pushSentGrid> = [];
    for (let i = 0; i < 100; i++) sent = pushSentGrid(sent, { cols: 80 + i, rows: 24 });
    expect(sent.length).toBe(32);
    expect(sent[0]).toEqual({ cols: 148, rows: 24 });
  });

  it("loses ownership when someone else resizes the PTY", () => {
    expect(onGridAnnounced({ kind: "owner" }, phone, laptop, [laptop])).toEqual({
      kind: "passive",
      grid: phone,
    });
  });

  it("returns to unclaimed when the PTY comes back to our natural fit", () => {
    expect(onGridAnnounced({ kind: "passive", grid: phone }, laptop, laptop, [])).toEqual({
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
    expect(onGridAnnounced({ kind: "unclaimed" }, laptop, laptop, [], true)).toEqual({
      kind: "passive",
      grid: laptop,
    });
    expect(onGridAnnounced({ kind: "owner" }, laptop, laptop, [laptop], true)).toEqual({
      kind: "passive",
      grid: laptop,
    });
  });
});
