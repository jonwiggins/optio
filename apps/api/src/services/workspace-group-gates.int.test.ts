import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers, workspaces } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { workspaceRoutes } from "../routes/workspaces.js";
async function insertUser(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@gates.it`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

type Role = "admin" | "member" | "viewer";
const appAs = (
  register: Parameters<typeof buildRouteTestApp>[0],
  id: string,
  workspaceId: string,
  workspaceRole: Role,
) => buildRouteTestApp(register, { user: { id, workspaceId, workspaceRole } });

const slug = () => `gates-${randomBytes(4).toString("hex")}`;

beforeEach(() => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("creating a workspace with access groups", () => {
  it("is everyone's when the deployment says so, but groups stay a deployment admin's", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "everyone");
    const home = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(workspaceRoutes, bob.id, home.id, "member");
    const made = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's", slug: slug() },
    });
    expect(made.statusCode).toBe(201);
    const withGroups = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's other", slug: slug(), accessGroups: ["everyone-in-ad"] },
    });
    expect(withGroups.statusCode).toBe(403);
    expect(withGroups.json().error).toBe(
      "Only a deployment admin opens a workspace to directory groups",
    );
  });
});
describe("opening a workspace to directory groups", () => {
  it("403s a workspace admin who isn't a deployment admin; lets a deployment admin", async () => {
    const ws = await insertWorkspace({ accessGroups: ["devs"], accessGroupsRole: "member" });
    const bob = await insertUser("Bob");
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: bob.id, role: "admin" });
    const bobApp = await appAs(workspaceRoutes, bob.id, ws.id, "admin");
    const patch = (app: typeof bobApp, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}`, payload });

    for (const payload of [
      { accessGroups: ["devs", "all-staff"] },
      { accessGroups: [] },
      { accessGroupsRole: "viewer" },
    ]) {
      const res = await patch(bobApp, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      expect(res.json().error).toBe(
        "Only a deployment admin opens a workspace to directory groups",
      );
    }
    // Resending what is there, or changing something else, is still his.
    expect((await patch(bobApp, { accessGroups: ["DEVS"], name: "Renamed" })).statusCode).toBe(200);

    const alice = await insertUser("Alice", true);
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: alice.id, role: "admin" });
    const aliceApp = await appAs(workspaceRoutes, alice.id, ws.id, "admin");
    expect((await patch(aliceApp, { accessGroups: ["devs", "all-staff"] })).statusCode).toBe(200);
    const [row] = await db
      .select({ accessGroups: workspaces.accessGroups })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    expect(row.accessGroups).toEqual(["all-staff", "devs"]);
  });
});
