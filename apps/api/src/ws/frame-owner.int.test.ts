/**
 * frame-owner.ts against real Postgres: whose a frame's work is, and where,
 * for each kind of subject /ws/events looks up.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db/client.js";
import { persistentAgents, prReviews, teams, users } from "../db/schema.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { forgetFrameOwners, frameOwner } from "./frame-owner.js";

async function insertUser() {
  const suffix = Math.random().toString(16).slice(2, 10);
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `it-${suffix}`,
      email: `it-${suffix}@example.com`,
      displayName: `IT ${suffix}`,
    })
    .returning();
  return row;
}

describe("frameOwner (integration)", () => {
  beforeEach(() => forgetFrameOwners());

  it("reads a Repo Task's, a Job run's, a review's and an agent's owner and workspace", async () => {
    const ws = await insertWorkspace();
    const me = await insertUser();
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${me.id.slice(0, 8)}` })
      .returning();

    const task = await insertTask({
      workspaceId: ws.id,
      ownerUserId: me.id,
      ownerTeamId: team.id,
      createdBy: me.id,
    });
    expect(await frameOwner({ kind: "run", id: task.id })).toEqual({
      workspaceId: ws.id,
      ownerUserId: me.id,
      ownerTeamId: team.id,
      createdBy: me.id,
    });

    const job = await insertWorkflow({ workspaceId: ws.id, ownerUserId: me.id });
    const run = await insertWorkflowRun(job.id);
    expect(await frameOwner({ kind: "run", id: run.id })).toEqual({
      workspaceId: ws.id,
      ownerUserId: me.id,
      ownerTeamId: null,
      createdBy: null,
    });

    const [review] = await db
      .insert(prReviews)
      .values({
        workspaceId: ws.id,
        prUrl: "https://github.com/acme/app/pull/9",
        prNumber: 9,
        repoOwner: "acme",
        repoName: "app",
        repoUrl: "https://github.com/acme/app",
        headSha: "abc",
        createdBy: me.id,
      })
      .returning();
    expect(await frameOwner({ kind: "pr-review", id: review.id })).toEqual({
      workspaceId: ws.id,
      ownerUserId: null,
      ownerTeamId: null,
      createdBy: me.id,
    });

    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId: ws.id,
        slug: `forge-${me.id.slice(0, 8)}`,
        name: "Forge",
        initialPrompt: "hi",
        ownerUserId: me.id,
        ownerTeamId: team.id,
      })
      .returning();
    expect(await frameOwner({ kind: "agent", id: agent.id })).toEqual({
      workspaceId: ws.id,
      ownerUserId: me.id,
      ownerTeamId: team.id,
      createdBy: null,
    });
  });

  it("is null for a row that isn't there, and rejects an id that isn't a uuid", async () => {
    expect(
      await frameOwner({ kind: "run", id: "00000000-0000-4000-8000-000000000000" }),
    ).toBeNull();
    await expect(frameOwner({ kind: "agent", id: "not-a-uuid" })).rejects.toThrow();
  });
});
