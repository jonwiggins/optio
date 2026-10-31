/**
 * Team-owned work after teams are switched off (Settings → Access → Teams),
 * against a real database: the list (`visibleWork`, the SQL rule) and
 * opening one (`canSeeWork`, the row rule) agree. A team's task reads as its
 * creator's — its creator lists and opens it, the team's other members do
 * neither — and switching teams back on gives the team its work again.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { teamMembers, teams, users, workspaceMembers } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { forgetSwitches } from "./deployment-settings.js";
import type { Actor } from "./ownership.js";
import { listTasks } from "./task-service.js";
import { actorTeamFields } from "./team-service.js";
import { canSeeWork } from "./work-visibility.js";

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@example.com`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("team-owned work with teams switched off", () => {
  let ws: string;
  let creatorId: string;
  let memberId: string;
  let taskId: string;

  /** The Actor the auth plugin would build for a workspace member. */
  const actorFor = async (userId: string): Promise<Actor> => ({
    userId,
    workspaceId: ws,
    isAdmin: false,
    ...(await actorTeamFields(userId, ws)),
  });

  /** What the person sees: in the list, and when opening the task. */
  const sees = async (actor: Actor) => {
    const listed = (await listTasks({ workspaceId: ws, visibleTo: actor })).some(
      (t) => t.id === taskId,
    );
    const task = (await listTasks({ workspaceId: ws })).find((t) => t.id === taskId)!;
    return { listed, opens: canSeeWork(task, actor) };
  };

  beforeEach(async () => {
    forgetSwitches();
    ws = (await insertWorkspace()).id;
    const [creator, member] = await Promise.all([insertUser("Cara"), insertUser("Mo")]);
    creatorId = creator.id;
    memberId = member.id;
    await db.insert(workspaceMembers).values([
      { workspaceId: ws, userId: creatorId, role: "member" },
      { workspaceId: ws, userId: memberId, role: "member" },
    ]);
    const [team] = await db
      .insert(teams)
      .values({
        workspaceId: ws,
        name: "Platform",
        slug: `platform-${randomBytes(3).toString("hex")}`,
      })
      .returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, userId: creatorId, role: "admin" },
      { teamId: team.id, userId: memberId, role: "member" },
    ]);
    // A team's task keeps its creator in owner_user_id.
    taskId = (
      await insertTask({
        workspaceId: ws,
        ownerUserId: creatorId,
        ownerTeamId: team.id,
        createdBy: creatorId,
      })
    ).id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    forgetSwitches();
  });

  it("is its creator's: listed and opened by them, by the team's other members neither", async () => {
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "");
    const creator = await actorFor(creatorId);
    const member = await actorFor(memberId);
    // Teams off: the Actor is upstream's shape.
    expect(creator).toEqual({ userId: creatorId, workspaceId: ws, isAdmin: false });
    expect(await sees(creator)).toEqual({ listed: true, opens: true });
    expect(await sees(member)).toEqual({ listed: false, opens: false });
  });

  it("is the team's again once teams are back on", async () => {
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
    expect(await sees(await actorFor(creatorId))).toEqual({ listed: true, opens: true });
    expect(await sees(await actorFor(memberId))).toEqual({ listed: true, opens: true });
  });
});
