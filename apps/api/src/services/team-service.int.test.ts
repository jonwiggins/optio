/**
 * Teams (docs/teams.md) against real Postgres: create one and run it, ask to
 * join and be approved or denied, add and remove members without ever
 * leaving a team with no admin, and fill teams from identity-provider groups
 * without touching memberships made by hand.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { teamMembers, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { qualifyGroups } from "./identity-groups.js";
import type { Actor } from "./ownership.js";
import {
  TeamError,
  addMember,
  createTeam,
  decideRequest,
  deleteTeam,
  getTeam,
  leaveTeam,
  listTeams,
  removeMember,
  requestToJoin,
  setGroupMappings,
  setMemberRole,
  syncTeamsFromGroups,
  teamMembershipsOf,
  updateTeam,
} from "./team-service.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

const uniq = () => randomBytes(4).toString("hex");
/** A group as the OIDC provider asserts it (provider-qualified, docs/teams.md). */
const groupId = (g: string) =>
  qualifyGroups("oidc", { issuerUrl: "https://idp.example.test" }, [g])[0];

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@acme.com`,
      displayName: name,
    })
    .returning();
  return row;
}

/** A workspace with an admin and two plain members, as their actors. */
async function setup() {
  const ws = await insertWorkspace();
  const [ann, bob, cat] = await Promise.all([person("ann"), person("bob"), person("cat")]);
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: ann.id, role: "admin" },
    { workspaceId: ws.id, userId: bob.id, role: "member" },
    { workspaceId: ws.id, userId: cat.id, role: "member" },
  ]);
  const as = (userId: string, isAdmin = false): Actor => ({
    userId,
    workspaceId: ws.id,
    isAdmin,
    teamIds: [],
    adminTeamIds: [],
  });
  return { ws, ann, bob, cat, admin: as(ann.id, true), asBob: as(bob.id), asCat: as(cat.id) };
}

async function failure(p: Promise<unknown>): Promise<TeamError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TeamError);
  return err as TeamError;
}

const statusOf = async (teamId: string, userId: string) =>
  (
    await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
  )[0];

describe("with teams turned off (the default)", () => {
  it("puts nobody in a team: the scope rules are the organization's and each person's", async () => {
    const { ws, bob, asBob } = await setup();
    const team = await createTeam({ name: `Off ${uniq()}` }, asBob);
    expect(await teamMembershipsOf(bob.id, ws.id)).toEqual([{ teamId: team.id, role: "admin" }]);
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "false");
    try {
      expect(await teamMembershipsOf(bob.id, ws.id)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await teamMembershipsOf(bob.id, ws.id)).toEqual([{ teamId: team.id, role: "admin" }]);
  });
});

describe("team-service", () => {
  it("creates a team whose creator is its first admin, with a slug of its own", async () => {
    const { ws, bob, asBob, asCat } = await setup();
    const team = await createTeam({ name: "Platform", description: " Infra " }, asBob);
    expect(team).toMatchObject({
      workspaceId: ws.id,
      name: "Platform",
      slug: "platform",
      description: "Infra",
      joinPolicy: "request",
      memberCount: 1,
      myRole: "admin",
      canManage: true,
    });
    expect(team.members.map((m) => [m.userId, m.role, m.status])).toEqual([
      [bob.id, "admin", "active"],
    ]);
    expect(await teamMembershipsOf(bob.id, ws.id)).toEqual([{ teamId: team.id, role: "admin" }]);

    // Names are unique per workspace (any case); a free slug is found.
    expect((await failure(createTeam({ name: "platform" }, asCat))).status).toBe(409);
    const other = await createTeam({ name: "Platform!" }, asCat);
    expect(other.slug).toBe("platform-2");

    // Someone else sees it, but doesn't run it.
    const seen = (await listTeams(asCat)).find((t) => t.id === team.id);
    expect(seen).toMatchObject({ myRole: null, canManage: false, memberCount: 1 });
  });

  it("two people creating the same team at once get one team and a 409", async () => {
    const { asBob, asCat } = await setup();
    const results = await Promise.allSettled([
      createTeam({ name: "Racers" }, asBob),
      createTeam({ name: "Racers" }, asCat),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [lost] = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost.reason).toBeInstanceOf(TeamError);
    expect(lost.reason.status).toBe(409);
  });

  it("asks to join, and the team's admin approves or denies", async () => {
    const { bob, cat, asBob, asCat } = await setup();
    const team = await createTeam({ name: `Data ${uniq()}` }, asBob);
    const bobAdmin: Actor = { ...asBob, adminTeamIds: [team.id], teamIds: [team.id] };

    const asked = await requestToJoin(team.id, asCat);
    expect(asked).toMatchObject({ myStatus: "requested", myRole: null, memberCount: 1 });
    // A requester sees only active members; the admin sees the request.
    expect(asked.members.map((m) => m.userId)).toEqual([bob.id]);
    expect(asked.groupMappings).toBeUndefined();
    const forAdmin = await getTeam(team.id, bobAdmin);
    expect(forAdmin.pendingCount).toBe(1);
    expect(forAdmin.members.find((m) => m.userId === cat.id)?.status).toBe("requested");
    expect((await failure(requestToJoin(team.id, asCat))).status).toBe(409);

    // Only someone who runs the team decides.
    expect((await failure(decideRequest(team.id, cat.id, "approve", asCat))).status).toBe(403);
    await decideRequest(team.id, cat.id, "deny", bobAdmin);
    expect(await statusOf(team.id, cat.id)).toMatchObject({
      status: "denied",
      decidedBy: bob.id,
    });
    expect((await failure(decideRequest(team.id, cat.id, "approve", bobAdmin))).status).toBe(404);

    // Asking again after a denial is a new request; this time it's approved.
    await requestToJoin(team.id, asCat);
    const approved = await decideRequest(team.id, cat.id, "approve", bobAdmin);
    expect(approved.memberCount).toBe(2);
    expect(await statusOf(team.id, cat.id)).toMatchObject({ status: "active", role: "member" });
    expect((await failure(requestToJoin(team.id, asCat))).status).toBe(409);
  });

  it("open teams admit at once; closed ones only by their admins", async () => {
    const { cat, asBob, asCat, admin } = await setup();
    const open = await createTeam({ name: `Open ${uniq()}`, joinPolicy: "open" }, asBob);
    expect(await requestToJoin(open.id, asCat)).toMatchObject({
      myStatus: "active",
      myRole: "member",
    });

    const closed = await createTeam({ name: `Closed ${uniq()}`, joinPolicy: "closed" }, asBob);
    expect((await failure(requestToJoin(closed.id, asCat))).status).toBe(403);
    // A workspace admin runs every team.
    await addMember(closed.id, { email: cat.email.toUpperCase() }, "member", admin);
    expect(await statusOf(closed.id, cat.id)).toMatchObject({ status: "active", source: "manual" });
    expect(
      (await failure(addMember(closed.id, { email: "nobody@acme.com" }, "member", admin))).status,
    ).toBe(404);
  });

  it("adds only people of the team's own workspace", async () => {
    const { asBob, admin } = await setup();
    const team = await createTeam({ name: `Core ${uniq()}`, joinPolicy: "closed" }, asBob);
    const elsewhere = await setup();
    const err = await failure(addMember(team.id, { userId: elsewhere.cat.id }, "member", admin));
    expect(err.status).toBe(404);
    expect(await statusOf(team.id, elsewhere.cat.id)).toBeUndefined();
  });

  it("never leaves a team without an admin", async () => {
    const { bob, cat, asBob, asCat } = await setup();
    const team = await createTeam({ name: `Core ${uniq()}`, joinPolicy: "open" }, asBob);
    const bobAdmin: Actor = { ...asBob, adminTeamIds: [team.id], teamIds: [team.id] };
    await requestToJoin(team.id, asCat);

    expect((await failure(leaveTeam(team.id, asBob))).status).toBe(400);
    expect((await failure(setMemberRole(team.id, bob.id, "member", bobAdmin))).status).toBe(400);
    expect((await failure(removeMember(team.id, bob.id, bobAdmin))).status).toBe(400);
    // A member can't change roles; an admin can, and then step down.
    expect((await failure(setMemberRole(team.id, cat.id, "admin", asCat))).status).toBe(403);
    await setMemberRole(team.id, cat.id, "admin", bobAdmin);
    await setMemberRole(team.id, bob.id, "member", bobAdmin);
    await leaveTeam(team.id, asBob);
    const left = await getTeam(team.id, asCat);
    expect(left.members.map((m) => [m.userId, m.role])).toEqual([[cat.id, "admin"]]);
    expect(
      (await failure(setMemberRole(team.id, bob.id, "admin", asWorkspaceAdmin(asCat)))).status,
    ).toBe(404);
  });

  it("is only visible, changeable and deletable inside its workspace, by those who run it", async () => {
    const { asBob, asCat } = await setup();
    const team = await createTeam({ name: `Ops ${uniq()}` }, asBob);
    const bobAdmin: Actor = { ...asBob, adminTeamIds: [team.id], teamIds: [team.id] };
    const elsewhere: Actor = { ...bobAdmin, workspaceId: (await insertWorkspace()).id };
    expect((await failure(getTeam(team.id, elsewhere))).status).toBe(404);
    expect((await failure(updateTeam(team.id, { name: "X" }, asCat))).status).toBe(403);

    const renamed = await updateTeam(
      team.id,
      { name: "Operations", description: "", joinPolicy: "open" },
      bobAdmin,
    );
    expect(renamed).toMatchObject({
      name: "Operations",
      slug: "operations",
      description: null,
      joinPolicy: "open",
    });
    expect((await failure(deleteTeam(team.id, asCat))).status).toBe(403);
    await deleteTeam(team.id, bobAdmin);
    expect((await failure(getTeam(team.id, bobAdmin))).status).toBe(404);
  });

  it("fills teams from groups, never touching what was added by hand", async () => {
    const { ws, bob, cat, asBob } = await setup();
    const team = await createTeam({ name: `Sre ${uniq()}` }, asBob);
    const bobAdmin: Actor = { ...asBob, adminTeamIds: [team.id], teamIds: [team.id] };
    const mapped = await setGroupMappings(
      team.id,
      [
        { groupName: groupId(" SRE "), role: "member" },
        { groupName: groupId("sre-leads"), role: "admin" },
        { groupName: groupId("sre"), role: "member" },
      ],
      bobAdmin,
    );
    expect(mapped.groupMappings).toEqual([
      { groupName: groupId("sre"), role: "member" },
      { groupName: groupId("sre-leads"), role: "admin" },
    ]);

    // Cat signs in with a mapped group: she joins, as the strongest role mapped.
    expect(await syncTeamsFromGroups(cat.id, ws.id, ["SRE", "SRE-Leads"].map(groupId))).toEqual({
      joined: [team.id],
      left: [],
    });
    expect(await statusOf(team.id, cat.id)).toMatchObject({ role: "admin", source: "sso" });
    expect(await syncTeamsFromGroups(cat.id, ws.id, ["sre"].map(groupId))).toEqual({
      joined: [],
      left: [],
    });
    expect((await statusOf(team.id, cat.id))?.role).toBe("member");
    // Out of the groups: out of the team.
    expect(await syncTeamsFromGroups(cat.id, ws.id, ["developers"].map(groupId))).toEqual({
      joined: [],
      left: [team.id],
    });
    expect(await statusOf(team.id, cat.id)).toBeUndefined();

    // Bob was added by hand (he made it): groups never move him.
    await syncTeamsFromGroups(bob.id, ws.id, []);
    await syncTeamsFromGroups(bob.id, ws.id, ["sre"].map(groupId));
    expect(await statusOf(team.id, bob.id)).toMatchObject({ role: "admin", source: "manual" });

    // Only those who run the team map groups.
    expect(
      (await failure(setGroupMappings(team.id, [], { ...asBob, adminTeamIds: [] }))).status,
    ).toBe(403);
  });
});

/** The same person as a workspace admin. */
function asWorkspaceAdmin(actor: Actor): Actor {
  return { ...actor, isAdmin: true };
}
