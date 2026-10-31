/**
 * A team's work acts through its controller token as the team, never as the
 * person who made it (docs/teams.md): two people, two teams, one creator's
 * private work. Real Postgres and Redis.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { teamMembers, teams, users, workRuns, workspaceMembers } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { issueControllerToken, validateControllerToken } from "./controller-auth.js";
import * as controller from "./controller-service.js";
import { createControllerPrompt } from "./controller-library.js";
import { forgetSwitches } from "./deployment-settings.js";

vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
  forgetSwitches();
});
afterEach(() => {
  vi.unstubAllEnvs();
  forgetSwitches();
});

async function world() {
  const ws = await insertWorkspace();
  const [alice, bob] = await db
    .insert(users)
    .values(
      ["alice", "bob"].map((name) => ({
        provider: "github",
        externalId: randomUUID(),
        email: `${randomUUID()}@test.invalid`,
        displayName: name,
        defaultWorkspaceId: ws.id,
      })),
    )
    .returning();
  await db
    .insert(workspaceMembers)
    .values(
      [alice, bob].map((u) => ({ workspaceId: ws.id, userId: u.id, role: "member" as const })),
    );
  const [a, b] = await db
    .insert(teams)
    .values([
      { workspaceId: ws.id, name: `A ${randomUUID()}`, slug: `a-${randomUUID()}` },
      { workspaceId: ws.id, name: `B ${randomUUID()}`, slug: `b-${randomUUID()}` },
    ])
    .returning();
  // Alice is in both teams; Bob only in A.
  await db.insert(teamMembers).values([
    { teamId: a.id, userId: alice.id, role: "admin" },
    { teamId: b.id, userId: alice.id, role: "admin" },
    { teamId: a.id, userId: bob.id, role: "member" },
  ]);
  return { ws, alice, bob, a, b };
}

async function teamRunToken(ws: string, creator: string, team: string) {
  const run = await insertTask({
    workspaceId: ws,
    ownerUserId: creator,
    ownerTeamId: team,
    state: "running",
    settings: { controllerAccess: "manage" },
  });
  const token = await issueControllerToken({
    kind: "work-run",
    id: run.id,
    workspaceId: ws,
    ownerUserId: creator,
    ownerTeamId: team,
    access: "manage",
  });
  return { run, token };
}

describe("a team's controller token", () => {
  it("acts for its team alone: never its creator's private work or other teams", async () => {
    const { ws, alice, bob, a, b } = await world();
    const { token } = await teamRunToken(ws.id, alice.id, a.id);
    const p = (await validateControllerToken(token))!;
    expect(p.actor).toMatchObject({
      userId: alice.id,
      executionTeamId: a.id,
      teamIds: [a.id],
      isAdmin: false,
    });
    // Bob's work for Team A: reachable.
    const sameTeam = await insertTask({
      workspaceId: ws.id,
      ownerUserId: bob.id,
      ownerTeamId: a.id,
    });
    expect((await controller.getControllerWork(p, sameTeam.id)).data.id).toBe(sameTeam.id);
    // Alice's private work, Bob's private work, Alice's Team B work: not.
    for (const owner of [
      { ownerUserId: alice.id },
      { ownerUserId: bob.id },
      { ownerUserId: alice.id, ownerTeamId: b.id },
    ]) {
      const hidden = await insertTask({ workspaceId: ws.id, ...owner });
      await expect(controller.getControllerWork(p, hidden.id)).rejects.toMatchObject({
        status: 404,
      });
    }
    // What it makes is the team's, whatever owner it asks for.
    const made = await controller.createControllerWork(p, {
      name: `Team job ${randomUUID()}`,
      when: { type: "schedule", config: { cronExpression: "0 9 * * *", timezone: "UTC" } },
      where: { runTarget: "cluster" },
      who: { runtime: "claude-code" },
      what: { prompt: "Summarize" },
      then: "exits",
      owner: "me",
    } as never);
    expect((await controller.getControllerWork(p, made.id)).data).toMatchObject({
      ownerTeamId: a.id,
    });
    // It can't write into its creator's own prompts.
    await expect(
      createControllerPrompt(p, { name: "x", template: "y" } as never),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("stops working when the run moves to another team, its creator leaves, or teams go off", async () => {
    const { ws, alice, a, b } = await world();
    const { run, token } = await teamRunToken(ws.id, alice.id, a.id);
    expect(await validateControllerToken(token)).not.toBeNull();

    await db.update(workRuns).set({ ownerTeamId: b.id }).where(eq(workRuns.id, run.id));
    expect(await validateControllerToken(token)).toBeNull();
    await db.update(workRuns).set({ ownerTeamId: a.id }).where(eq(workRuns.id, run.id));

    vi.stubEnv("OPTIO_TEAMS_ENABLED", "false");
    forgetSwitches();
    expect(await validateControllerToken(token)).toBeNull();
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
    forgetSwitches();

    await db.delete(teamMembers).where(eq(teamMembers.userId, alice.id));
    expect(await validateControllerToken(token)).toBeNull();
  });
});
