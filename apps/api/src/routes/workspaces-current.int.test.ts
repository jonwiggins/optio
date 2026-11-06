/**
 * The web app picks the workspace to show from `GET /api/workspaces` when
 * the browser has none stored. It has to be the one the server served the
 * page in, not simply the first listed, or the name on screen and the lists
 * under it come from different workspaces.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { workspaceRoutes } from "./workspaces.js";

describe("GET /api/workspaces (integration)", () => {
  it("says which workspace the request was served in", async () => {
    const a = await insertWorkspace();
    const b = await insertWorkspace();
    const [user] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `it-${randomBytes(4).toString("hex")}`,
        email: `${randomBytes(4).toString("hex")}@workspaces.it`,
        displayName: "Two",
      })
      .returning();
    await db.insert(workspaceMembers).values([
      { workspaceId: a.id, userId: user.id, role: "member" as const },
      { workspaceId: b.id, userId: user.id, role: "member" as const },
    ]);
    const app = await buildRouteTestApp(workspaceRoutes, {
      user: { id: user.id, workspaceId: b.id, workspaceRole: "member" },
    });
    const res = await app.inject({ url: "/api/workspaces" });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentWorkspaceId).toBe(b.id);
    expect(
      res
        .json()
        .workspaces.map((w: { id: string }) => w.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });
});
