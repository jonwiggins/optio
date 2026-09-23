/**
 * Which connections apply to a repo, against real Postgres.
 *
 * `GET /api/repos/:id/connections` used to ask the per-task resolver with an
 * empty agent type, which matched no assignment limited to specific agents —
 * a repo's "Status page API" connection for claude-code simply wasn't listed.
 * The resolver also judged a connection by its first covering assignment
 * only, so a global assignment limited to another agent could hide the
 * repo's own assignment for this one.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { connectionAssignments, connectionProviders, connections } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { connectionRoutes } from "../routes/connections.js";
import { getConnectionsForTask, listConnectionsForRepo } from "./connection-service.js";

async function seed() {
  const ws = await insertWorkspace();
  const repo = await insertRepo({ workspaceId: ws.id });
  const otherRepo = await insertRepo({ workspaceId: ws.id });
  const [provider] = await db
    .insert(connectionProviders)
    .values({ slug: `it-http-${randomBytes(3).toString("hex")}`, name: "IT HTTP", type: "http" })
    .returning();

  const connection = async (
    name: string,
    assignments: Array<{ repoId?: string; agentTypes?: string[]; permission?: string }>,
    enabled = true,
  ) => {
    const [conn] = await db
      .insert(connections)
      .values({ name, providerId: provider.id, workspaceId: ws.id, enabled })
      .returning();
    // Inserted one by one, in order: the order the old resolver saw them.
    for (const a of assignments) {
      await db.insert(connectionAssignments).values({ connectionId: conn.id, ...a });
    }
    return conn;
  };

  await connection("Notion", [{}]);
  await connection("Status page API", [{ repoId: repo.id, agentTypes: ["claude-code"] }]);
  await connection("Other repo only", [{ repoId: otherRepo.id }]);
  await connection("Codex everywhere, all agents here", [
    { agentTypes: ["codex"], permission: "read" },
    { repoId: repo.id, permission: "write" },
  ]);
  await connection("Disabled", [{}], false);
  return { ws, repo };
}

describe("connections for a repo", () => {
  it("lists every connection that applies to the repo, with its agent-type scope", async () => {
    const { ws, repo } = await seed();

    const listed = await listConnectionsForRepo(repo.repoUrl, ws.id);
    const byName = Object.fromEntries(listed.map((c) => [c.name, c.agentTypes]));
    expect(byName).toEqual({
      Notion: [],
      "Status page API": ["claude-code"],
      "Codex everywhere, all agents here": [],
    });
    const statusPage = listed.find((c) => c.name === "Status page API")!;
    expect(statusPage.provider?.name).toBe("IT HTTP");
    expect(statusPage.assignments).toHaveLength(1);

    // The route returns exactly that.
    const app = await buildRouteTestApp(connectionRoutes, {
      user: { id: "u-it", workspaceId: ws.id, workspaceRole: "admin" },
    });
    const res = await app.inject({ method: "GET", url: `/api/repos/${repo.id}/connections` });
    expect(res.statusCode, res.body).toBe(200);
    const routed = res.json().connections as Array<{ name: string; agentTypes: string[] }>;
    expect(routed.map((c) => [c.name, c.agentTypes]).sort()).toEqual(Object.entries(byName).sort());
    await app.close();
  });

  it("injects a connection when any of its covering assignments allows the agent", async () => {
    const { ws, repo } = await seed();

    const forClaude = await getConnectionsForTask(repo.repoUrl, "claude-code", ws.id);
    const claude = Object.fromEntries(forClaude.map((c) => [c.connectionName, c.permission]));
    expect(claude).toEqual({
      Notion: "read",
      "Status page API": "read",
      // The global codex-only assignment no longer hides the repo's own one,
      // whose permission applies.
      "Codex everywhere, all agents here": "write",
    });

    const forCodex = await getConnectionsForTask(repo.repoUrl, "codex", ws.id);
    const codex = Object.fromEntries(forCodex.map((c) => [c.connectionName, c.permission]));
    expect(codex).toEqual({
      Notion: "read",
      // Both assignments cover codex here; the repo's own wins.
      "Codex everywhere, all agents here": "write",
    });
  });
});
