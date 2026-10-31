import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

/** /api/teams: each route hands the caller to team-service and maps its refusals. */

const svc = vi.hoisted(() => ({
  listTeams: vi.fn(),
  createTeam: vi.fn(),
  getTeam: vi.fn(),
  updateTeam: vi.fn(),
  deleteTeam: vi.fn(),
  requestToJoin: vi.fn(),
  leaveTeam: vi.fn(),
  decideRequest: vi.fn(),
  addMember: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  setGroupMappings: vi.fn(),
}));

vi.mock("../services/team-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/team-service.js")>();
  return { TeamError: real.TeamError, requireTeamsEnabled: real.requireTeamsEnabled, ...svc };
});

const mockLogAction = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/optio-action-service.js", () => ({ logAction: mockLogAction }));

import { TeamError } from "../services/team-service.js";
import { teamRoutes } from "./teams.js";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const team = { id: TEAM_ID, name: "Platform", members: [] };

/** The actor every service call got (the route builds it from the session). */
const actorArg = expect.objectContaining({ userId: "user-1", workspaceId: "ws-1" });

describe("/api/teams while teams are off (the default)", () => {
  it("answers 404 on every route, as if they weren't there", async () => {
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "");
    const app = await buildRouteTestApp(teamRoutes);
    for (const [method, url] of [
      ["GET", "/api/teams"],
      ["POST", "/api/teams"],
      ["GET", `/api/teams/${TEAM_ID}`],
      ["POST", `/api/teams/${TEAM_ID}/join`],
    ] as const) {
      const res = await app.inject({ method, url, payload: { name: "Platform" } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/Teams are turned off/);
    }
    expect(svc.listTeams).not.toHaveBeenCalled();
    expect(svc.createTeam).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("/api/teams", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
    app = await buildRouteTestApp(teamRoutes);
  });

  it("lists the workspace's teams for the caller", async () => {
    svc.listTeams.mockResolvedValue([team]);
    const res = await app.inject({ method: "GET", url: "/api/teams" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ teams: [team] });
    expect(svc.listTeams).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", workspaceId: "ws-1", isAdmin: true }),
    );
  });

  it("creates a team (201) and logs it; a taken name is a 409", async () => {
    svc.createTeam.mockResolvedValue(team);
    const res = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "  Platform  ", joinPolicy: "open" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ team });
    expect(svc.createTeam).toHaveBeenCalledWith({ name: "Platform", joinPolicy: "open" }, actorArg);
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "team.create", params: { id: TEAM_ID, name: "Platform" } }),
    );

    svc.createTeam.mockRejectedValue(new TeamError("There's already a team called Platform", 409));
    const dup = await app.inject({ method: "POST", url: "/api/teams", payload: { name: "x" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "There's already a team called Platform" });
  });

  it("refuses a bad body before the service, and a viewer's change", async () => {
    for (const payload of [{ name: "" }, { name: "x", joinPolicy: "invite-only" }]) {
      const res = await app.inject({ method: "POST", url: "/api/teams", payload });
      expect(res.statusCode).toBe(400);
    }
    const viewer = await buildRouteTestApp(teamRoutes, {
      user: { id: "user-9", workspaceId: "ws-1", workspaceRole: "viewer" },
    });
    const res = await viewer.inject({ method: "POST", url: "/api/teams", payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
    expect(svc.createTeam).not.toHaveBeenCalled();
  });

  it("reads, renames and deletes one team, passing its refusals through", async () => {
    svc.getTeam.mockRejectedValue(new TeamError("Team not found", 404));
    expect((await app.inject({ method: "GET", url: `/api/teams/${TEAM_ID}` })).statusCode).toBe(
      404,
    );

    svc.updateTeam.mockResolvedValue({ ...team, name: "Ops" });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/teams/${TEAM_ID}`,
      payload: { name: "Ops", description: null },
    });
    expect(renamed.statusCode).toBe(200);
    expect(svc.updateTeam).toHaveBeenCalledWith(
      TEAM_ID,
      { name: "Ops", description: null },
      actorArg,
    );

    svc.deleteTeam.mockRejectedValueOnce(
      new TeamError("Only the team's admins (or a workspace admin) can do that", 403),
    );
    expect((await app.inject({ method: "DELETE", url: `/api/teams/${TEAM_ID}` })).statusCode).toBe(
      403,
    );
    svc.deleteTeam.mockResolvedValueOnce(undefined);
    expect((await app.inject({ method: "DELETE", url: `/api/teams/${TEAM_ID}` })).statusCode).toBe(
      204,
    );
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: "team.delete" }));
  });

  it("asks to join and leaves", async () => {
    svc.requestToJoin.mockResolvedValue({ ...team, myStatus: "requested" });
    const asked = await app.inject({ method: "POST", url: `/api/teams/${TEAM_ID}/join` });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().team.myStatus).toBe("requested");
    expect(svc.requestToJoin).toHaveBeenCalledWith(TEAM_ID, actorArg);

    svc.requestToJoin.mockRejectedValue(new TeamError("Your request is waiting", 409));
    expect(
      (await app.inject({ method: "POST", url: `/api/teams/${TEAM_ID}/join` })).statusCode,
    ).toBe(409);

    svc.leaveTeam.mockRejectedValueOnce(
      new TeamError("Make someone else a team admin first — a team keeps at least one", 400),
    );
    expect(
      (await app.inject({ method: "DELETE", url: `/api/teams/${TEAM_ID}/join` })).statusCode,
    ).toBe(400);
    svc.leaveTeam.mockResolvedValueOnce(undefined);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/teams/${TEAM_ID}/join` })).statusCode,
    ).toBe(204);
  });

  it("approves or denies a request", async () => {
    svc.decideRequest.mockResolvedValue(team);
    const url = `/api/teams/${TEAM_ID}/members/${USER_ID}/decide`;
    const res = await app.inject({ method: "POST", url, payload: { decision: "deny" } });
    expect(res.statusCode).toBe(200);
    expect(svc.decideRequest).toHaveBeenCalledWith(TEAM_ID, USER_ID, "deny", actorArg);
    expect(
      (await app.inject({ method: "POST", url, payload: { decision: "maybe" } })).statusCode,
    ).toBe(400);

    svc.decideRequest.mockRejectedValue(
      new TeamError("No request from that person is waiting", 404),
    );
    expect(
      (await app.inject({ method: "POST", url, payload: { decision: "approve" } })).statusCode,
    ).toBe(404);
  });

  it("adds members by email or id (member by default), sets roles and removes them", async () => {
    svc.addMember.mockResolvedValue(team);
    const added = await app.inject({
      method: "POST",
      url: `/api/teams/${TEAM_ID}/members`,
      payload: { email: "cat@acme.com" },
    });
    expect(added.statusCode).toBe(200);
    expect(svc.addMember).toHaveBeenCalledWith(
      TEAM_ID,
      { userId: undefined, email: "cat@acme.com" },
      "member",
      actorArg,
    );
    const neither = await app.inject({
      method: "POST",
      url: `/api/teams/${TEAM_ID}/members`,
      payload: { role: "admin" },
    });
    expect(neither.statusCode).toBe(400);

    svc.setMemberRole.mockResolvedValue(team);
    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/teams/${TEAM_ID}/members/${USER_ID}`,
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(svc.setMemberRole).toHaveBeenCalledWith(TEAM_ID, USER_ID, "admin", actorArg);

    svc.removeMember.mockRejectedValue(
      new TeamError("Make someone else a team admin first — a team keeps at least one", 400),
    );
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/teams/${TEAM_ID}/members/${USER_ID}`,
    });
    expect(removed.statusCode).toBe(400);
    expect(removed.json().error).toMatch(/team admin first/);
  });

  it("sets the group mappings, trimmed and bounded", async () => {
    svc.setGroupMappings.mockResolvedValue(team);
    const res = await app.inject({
      method: "PUT",
      url: `/api/teams/${TEAM_ID}/groups`,
      payload: { mappings: [{ groupName: "  sre ", role: "member" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.setGroupMappings).toHaveBeenCalledWith(
      TEAM_ID,
      [{ groupName: "sre", role: "member" }],
      actorArg,
    );
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ groupName: `g${i}`, role: "member" }));
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/teams/${TEAM_ID}/groups`,
          payload: { mappings: tooMany },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("lets an unexpected error through as a 500", async () => {
    svc.getTeam.mockRejectedValue(new Error("db down"));
    expect((await app.inject({ method: "GET", url: `/api/teams/${TEAM_ID}` })).statusCode).toBe(
      500,
    );
  });
});
