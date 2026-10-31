import { describe, expect, it } from "vitest";
import { viewOf, type CurrentUser } from "./use-current-user";

const user = (workspaceRole: string | null): CurrentUser => ({
  id: "u1",
  provider: "github",
  email: "u@example.com",
  displayName: "U",
  avatarUrl: null,
  workspaceId: "w1",
  workspaceRole,
});

describe("viewOf: the person's teams", () => {
  it("carries the team ids /api/auth/me returns", () => {
    const v = viewOf({
      user: { ...user("member"), teamIds: ["t1", "t2"], adminTeamIds: ["t2"] },
      authDisabled: false,
      loaded: true,
    });
    expect(v.teamIds).toEqual(["t1", "t2"]);
    expect(v.adminTeamIds).toEqual(["t2"]);
  });

  it("is empty before load and for a user without them", () => {
    expect(viewOf({ user: null, authDisabled: false, loaded: false }).teamIds).toEqual([]);
    const v = viewOf({ user: user("member"), authDisabled: false, loaded: true });
    expect(v.teamIds).toEqual([]);
    expect(v.adminTeamIds).toEqual([]);
  });
});
