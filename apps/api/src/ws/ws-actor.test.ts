import { describe, it, expect, vi, beforeEach } from "vitest";

let authDisabled = false;
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => authDisabled }));

const mockGetUserRole = vi.fn();
vi.mock("../services/workspace-service.js", () => ({
  getUserRole: (...a: unknown[]) => mockGetUserRole(...a),
}));

const mockTeamMembershipsOf = vi.fn();
vi.mock("../services/team-service.js", () => ({
  teamMembershipsOf: (...a: unknown[]) => mockTeamMembershipsOf(...a),
}));

const mockGetWorkVisibility = vi.fn();
vi.mock("../services/work-visibility.js", () => ({
  getWorkVisibility: (...a: unknown[]) => mockGetWorkVisibility(...a),
}));

import { wsActor, wsActorIn } from "./ws-actor.js";

const user = {
  id: "user-1",
  provider: "oidc",
  email: "a@example.com",
  displayName: "A",
  username: null,
  avatarUrl: null,
  workspaceId: "ws-1",
  // A socket's user comes without a role or teams (ws-auth.ts).
  workspaceRole: null,
};

describe("wsActor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
    mockGetWorkVisibility.mockResolvedValue("teams");
  });

  it("fills in the role, teams and visibility mode the auth plugin would", async () => {
    mockGetUserRole.mockResolvedValue("member");
    mockTeamMembershipsOf.mockResolvedValue([
      { teamId: "team-1", role: "member" },
      { teamId: "team-2", role: "admin" },
    ]);
    expect(await wsActor(user)).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      isAdmin: false,
      teamIds: ["team-1", "team-2"],
      adminTeamIds: ["team-2"],
      workVisibility: "teams",
    });
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-1", "user-1");
    expect(mockTeamMembershipsOf).toHaveBeenCalledWith("user-1", "ws-1");
  });

  it("makes a workspace admin an admin", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockTeamMembershipsOf.mockResolvedValue([]);
    expect((await wsActor(user)).isAdmin).toBe(true);
  });

  it("someone without a workspace has no role and no teams", async () => {
    const actor = await wsActor({ ...user, workspaceId: null });
    expect(actor).toMatchObject({ isAdmin: false, teamIds: [], adminTeamIds: [] });
    expect(mockGetUserRole).not.toHaveBeenCalled();
  });

  it("auth-disabled dev sees everything", async () => {
    authDisabled = true;
    expect((await wsActor(user)).isAdmin).toBe(true);
  });
});

describe("wsActorIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authDisabled = false;
    mockGetWorkVisibility.mockResolvedValue("organization");
  });

  it("is who the user is in another of their workspaces", async () => {
    mockGetUserRole.mockResolvedValue("admin");
    mockTeamMembershipsOf.mockResolvedValue([{ teamId: "team-9", role: "member" }]);
    expect(await wsActorIn(user, "ws-2")).toEqual({
      userId: "user-1",
      workspaceId: "ws-2",
      isAdmin: true,
      teamIds: ["team-9"],
      adminTeamIds: [],
      workVisibility: "organization",
    });
    expect(mockGetUserRole).toHaveBeenCalledWith("ws-2", "user-1");
    expect(mockGetWorkVisibility).toHaveBeenCalledWith("ws-2");
  });

  it("is no one in a workspace the user isn't a member of", async () => {
    mockGetUserRole.mockResolvedValue(null);
    mockTeamMembershipsOf.mockResolvedValue([]);
    expect(await wsActorIn(user, "ws-2")).toBeNull();
  });

  it("auth-disabled dev sees everything there too", async () => {
    authDisabled = true;
    expect(await wsActorIn(user, "ws-2")).toEqual({
      userId: "user-1",
      workspaceId: "ws-2",
      isAdmin: true,
    });
    expect(mockGetUserRole).not.toHaveBeenCalled();
  });
});
