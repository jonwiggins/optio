import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRailStore } from "./rail-store";

describe("session rail preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useRailStore.setState({ width: 240, collapsed: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("restores width independently of the existing collapse preference", () => {
    useRailStore.getState().setWidth(360);
    useRailStore.getState().setCollapsed(true);
    useRailStore.setState({ width: 240, collapsed: false });
    useRailStore.getState().hydrate();
    expect(useRailStore.getState()).toMatchObject({ width: 360, collapsed: true });
    useRailStore.getState().toggle();
    expect(useRailStore.getState()).toMatchObject({ width: 360, collapsed: false });
  });

  it.each([
    ["9000", 440],
    ["-20", 200],
    ["junk", 240],
    ["Infinity", 240],
  ])("bounds a stored width of %s to %i", (stored, expected) => {
    window.localStorage.setItem("optio.local.railWidth", stored);
    useRailStore.getState().hydrate();
    expect(useRailStore.getState().width).toBe(expected);
  });

  it("still resizes when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    useRailStore.getState().hydrate();
    useRailStore.getState().setWidth(300);
    expect(useRailStore.getState().width).toBe(300);
  });
});
