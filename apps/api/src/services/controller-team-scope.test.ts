import { expect, it, vi } from "vitest";
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));
import { canSee, canChange, canUse, ownerColumnsForNew } from "./ownership.js";
import { requireChange } from "./controller-access.js";
import type { ControllerPrincipal } from "./controller-auth.js";

it("a delegated team cannot use creator-private resources or mutate another scope", () => {
  const actor = {
    userId: "creator",
    workspaceId: "workspace",
    isAdmin: false,
    teamIds: ["a"],
    adminTeamIds: ["a"],
    executionTeamId: "a",
  };
  const p: ControllerPrincipal = { actor, access: "manage", name: "Team A" };
  expect(canSee("creator", actor)).toBe(false);
  expect(canSee("creator", actor, "b")).toBe(false);
  expect(canSee("peer", actor, "a")).toBe(true);
  expect(canChange("creator", actor, true)).toBe(false);
  expect(canUse(null, "creator", "b", "a")).toBe(false);
  expect(() => requireChange(p, { workspaceId: "workspace", ownerUserId: "creator" })).toThrow();
  expect(() =>
    requireChange(p, { workspaceId: "workspace", ownerUserId: "peer", ownerTeamId: "a" }),
  ).not.toThrow();
  expect(ownerColumnsForNew(undefined, actor)).toEqual({
    ownerUserId: "creator",
    ownerTeamId: "a",
  });
  expect(() => ownerColumnsForNew("workspace", actor)).toThrow();
});

it("a team resource keeps its team boundary even without a creator", () => {
  const outsider = {
    userId: "outsider",
    workspaceId: "workspace",
    isAdmin: false,
    teamIds: [],
    adminTeamIds: [],
  };
  expect(canChange(null, outsider, true, "edit", { ownerTeamId: "a", orgNeeds: "member" })).toBe(
    false,
  );
  expect(
    canChange(null, { ...outsider, teamIds: ["a"] }, true, "edit", {
      ownerTeamId: "a",
      orgNeeds: "member",
    }),
  ).toBe(true);
});
