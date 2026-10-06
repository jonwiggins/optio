import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLLAPSED_GROUPS, readCollapsedGroups, useNavStore } from "./nav-store";

const KEY = "optio.nav.collapsedGroups";

describe("nav-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useNavStore.setState({ collapsed: [...DEFAULT_COLLAPSED_GROUPS] });
  });

  it("keeps Library discoverable and folds Insights by default", () => {
    expect(readCollapsedGroups()).toEqual(["Insights"]);
    expect(useNavStore.getState().isCollapsed("Library")).toBe(false);
    expect(useNavStore.getState().isCollapsed("Run")).toBe(false);
  });

  it("toggles a group and persists the choice", () => {
    useNavStore.getState().toggle("Insights");
    expect(useNavStore.getState().isCollapsed("Insights")).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([]);

    useNavStore.getState().toggle("Run");
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(["Run"]);
  });

  it("hydrates from storage and ignores malformed values", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["Run", 42, null]));
    useNavStore.getState().hydrate();
    expect(useNavStore.getState().collapsed).toEqual(["Run"]);

    window.localStorage.setItem(KEY, "{not json");
    useNavStore.getState().hydrate();
    expect(useNavStore.getState().collapsed).toEqual([...DEFAULT_COLLAPSED_GROUPS]);
  });
});
