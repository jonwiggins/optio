/**
 * `GET /api/tasks?type=`'s total against real Postgres: it counts what the
 * viewer's list may show (work-visibility.ts), not every row of the
 * workspace.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { prReviews, users } from "../db/schema.js";
import {
  insertTask,
  insertTaskConfig,
  insertWorkflow,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import type { Actor } from "./ownership.js";
import { countVisibleUnifiedTasks } from "./unified-task-count.js";

const uniq = () => randomBytes(4).toString("hex");

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `it-${uniq()}`,
      email: `it-${uniq()}@example.com`,
      displayName: "IT",
    })
    .returning();
  return row;
}

describe("countVisibleUnifiedTasks", () => {
  it("counts the viewer's own and the organization's work, not someone's private", async () => {
    const ws = await insertWorkspace();
    const [me, other] = [await insertUser(), await insertUser()];
    await insertTask({ workspaceId: ws.id, ownerUserId: me.id });
    await insertTask({ workspaceId: ws.id, ownerUserId: other.id });
    await insertTask({ workspaceId: ws.id, createdBy: other.id });
    await insertTaskConfig({ workspaceId: ws.id, ownerUserId: other.id });
    await insertWorkflow({ workspaceId: ws.id, createdBy: me.id });
    await db.insert(prReviews).values({
      workspaceId: ws.id,
      prUrl: `https://gitlab.example.com/it/app/-/merge_requests/${uniq()}`,
      prNumber: 1,
      repoOwner: "it",
      repoName: "app",
      repoUrl: "https://gitlab.example.com/it/app",
      headSha: "abc",
    });
    const viewer = (over: Partial<Actor> = {}): Actor => ({
      userId: me.id,
      workspaceId: ws.id,
      isAdmin: false,
      teamIds: [],
      adminTeamIds: [],
      workVisibility: "organization",
      ...over,
    });
    const count = (v?: Actor, type?: "repo-task" | "repo-blueprint") =>
      countVisibleUnifiedTasks({ workspaceId: ws.id, viewer: v, type });

    expect(await count()).toBe(6);
    expect(await count(viewer({ isAdmin: true }))).toBe(6);
    // Mine, the org's task, the org's Job, the review.
    expect(await count(viewer())).toBe(4);
    expect(await count(viewer(), "repo-task")).toBe(2);
    expect(await count(viewer(), "repo-blueprint")).toBe(0);
    // "teams" mode: the org's task is its creator's; the Job is mine (I made it).
    expect(await count(viewer({ workVisibility: "teams" }))).toBe(3);
  });
});
