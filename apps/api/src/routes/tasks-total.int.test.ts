/**
 * The `total` of `GET /api/tasks?type=` counts the rows the viewer's list may
 * show (services/ownership.ts): the organization's and their own. Another
 * member's private work is left out, so the number does not tell anyone how
 * much private work exists in the workspace. An admin, who sees private rows
 * read-only, counts everything.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { prReviews, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertTask,
  insertTaskConfig,
  insertWorkflow,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { taskRoutes } from "./tasks.js";

const uniq = () => randomBytes(4).toString("hex");

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${displayName.toLowerCase()}-${uniq()}@example.com`,
      displayName,
    })
    .returning();
  return row;
}

describe("GET /api/tasks?type= total (integration)", () => {
  it("counts only the rows the viewer may see", async () => {
    const ws = await insertWorkspace();
    const alice = await insertUser("Alice");
    const bob = await insertUser("Bob");

    // The organization's work, one row of each kind.
    await insertTask({ workspaceId: ws.id });
    await insertTaskConfig({ workspaceId: ws.id });
    await insertWorkflow({ workspaceId: ws.id });
    const prNumber = Math.floor(Math.random() * 1_000_000);
    await db.insert(prReviews).values({
      workspaceId: ws.id,
      prUrl: `https://git.example.com/it/app/pull/${prNumber}`,
      prNumber,
      repoOwner: "it",
      repoName: "app",
      repoUrl: "https://git.example.com/it/app",
      headSha: "abc123",
    });
    // Bob's own private task.
    await insertTask({ workspaceId: ws.id, ownerUserId: bob.id });
    // Alice's private work, one row of each owned kind.
    await insertTask({ workspaceId: ws.id, ownerUserId: alice.id });
    await insertTaskConfig({ workspaceId: ws.id, ownerUserId: alice.id });
    await insertWorkflow({ workspaceId: ws.id, ownerUserId: alice.id });

    const as = (id: string, workspaceRole: "admin" | "member") =>
      buildRouteTestApp(taskRoutes, { user: { id, workspaceId: ws.id, workspaceRole } });
    const member = await as(bob.id, "member");
    const admin = await as((await insertUser("Ada")).id, "admin");

    const list = async (app: typeof member, type: string) => {
      const res = await app.inject({ method: "GET", url: `/api/tasks?type=${type}` });
      expect(res.statusCode).toBe(200);
      return res.json<{ tasks: unknown[]; total: number }>();
    };

    // Bob sees the organization's four rows and his own task, not Alice's three.
    const all = await list(member, "all");
    expect(all.tasks).toHaveLength(5);
    expect(all.total).toBe(5);
    expect((await list(member, "repo-blueprint")).total).toBe(1);
    expect((await list(member, "standalone")).total).toBe(1);

    // An admin sees private rows read-only, so the count covers the workspace.
    const adminAll = await list(admin, "all");
    expect(adminAll.tasks).toHaveLength(8);
    expect(adminAll.total).toBe(8);
  });
});
