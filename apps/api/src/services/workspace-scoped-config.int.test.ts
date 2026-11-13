/**
 * Workspace-scoped configuration against real Postgres (docs/scope.md, "The
 * deployment's own"). Two ordinary workspaces, A and B, and the founding one:
 *
 * - A's rows never appear in B's lists or B's pods, legacy or not;
 * - a deployment row (no workspace) serves the founding workspace, and any
 *   other only once a deployment admin shares it as a deployment default;
 * - a workspace's own organization secret comes before the deployment's;
 * - a connection is assigned only to its own workspace's repos;
 * - over HTTP, a workspace admin can't change a deployment row; a deployment
 *   admin can, and shares it.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { mcpServers, optioSettings, users } from "../db/schema.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mcpServerRoutes } from "../routes/mcp-servers.js";
import {
  AssignmentRepoError,
  createAssignment,
  createConnection,
  getConnectionsForTask,
  listConnections,
  seedBuiltInProviders,
} from "./connection-service.js";
import { setRowDeploymentDefault } from "./deployment-defaults.js";
import { foundingWorkspaceId } from "./founding-workspace.js";
import { createInstalledSkill, listInstalledSkills } from "./installed-skill-service.js";
import { createMcpServer, getMcpServersForTask, listMcpServers } from "./mcp-server-service.js";
import { getSettings } from "./optio-settings-service.js";
import {
  listPickableSecrets,
  listVisibleSecrets,
  resolveSecretsForSetup,
  retrieveSecretWithFallback,
  setSecretDeploymentDefault,
  storeSecret,
} from "./secret-service.js";
import { createSkill, getSkillsForTask, listSkills } from "./skill-service.js";

const uniq = () => randomBytes(4).toString("hex");
const REPO = `https://github.com/acme/ws-config-${uniq()}`;

let founding: string;
let a: string;
let b: string;
const tag = uniq();
const names = {
  unshared: `dep-unshared-${tag}`,
  shared: `dep-shared-${tag}`,
  ofA: `of-a-${tag}`,
  ofB: `of-b-${tag}`,
};

beforeAll(async () => {
  await seedBuiltInProviders();
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  a = (await insertWorkspace()).id;
  b = (await insertWorkspace()).id;

  // One of each kind: two deployment rows (one shared), one per workspace.
  for (const [name, ws] of [
    [names.unshared, null],
    [names.shared, null],
    [names.ofA, a],
    [names.ofB, b],
  ] as const) {
    const server = await createMcpServer({ name, command: "node" }, ws);
    const skill = await createSkill({ name, prompt: "do it" }, ws);
    const installed = await createInstalledSkill(
      { name, sourceUrl: "https://github.com/acme/skills" },
      ws,
    );
    const conn = await createConnection(
      { name, providerSlug: "custom-mcp", config: { command: "node" }, assignments: [{}] },
      ws,
    );
    if (name === names.shared) {
      await setRowDeploymentDefault("mcp_servers", server.id, true);
      await setRowDeploymentDefault("custom_skills", skill.id, true);
      await setRowDeploymentDefault("installed_skills", installed.id, true);
      await setRowDeploymentDefault("connections", conn.id, true);
    }
  }
});

/** Of the four rows, the ones a list returns (others in the database are ignored). */
const ours = (rows: Array<{ name: string }>) =>
  rows
    .map((r) => r.name)
    .filter((n) => Object.values(names).includes(n))
    .sort();

describe("lists and pods resolve inside the workspace first", () => {
  it("another workspace sees its own rows and the shared deployment ones only", async () => {
    const expected = [names.shared, names.ofA].sort();
    expect(ours(await listMcpServers(undefined, a))).toEqual(expected);
    expect(ours(await listSkills(undefined, a))).toEqual(expected);
    expect(ours(await listInstalledSkills(undefined, a))).toEqual(expected);
    expect(ours(await listConnections(a))).toEqual(expected);
    // What its pods get, not only what its lists show.
    expect(ours(await getMcpServersForTask(REPO, a))).toEqual(expected);
    expect(ours(await getSkillsForTask(REPO, a))).toEqual(expected);
    expect(
      ours(
        (await getConnectionsForTask(REPO, "claude-code", a)).map((c) => ({
          name: c.connectionName,
        })),
      ),
    ).toEqual(expected);
  });

  it("the founding workspace keeps every deployment row, shared or not", async () => {
    const expected = [names.shared, names.unshared].sort();
    expect(ours(await listMcpServers(undefined, founding))).toEqual(expected);
    expect(ours(await listSkills(undefined, founding))).toEqual(expected);
    expect(ours(await listConnections(founding))).toEqual(expected);
    expect(ours(await getMcpServersForTask(REPO, founding))).toEqual(expected);
  });

  it("agent settings: the workspace's row, else the deployment's only when shared", async () => {
    const [row] = await db
      .insert(optioSettings)
      .values({ model: `deployment-${tag}`, workspaceId: null })
      .returning();
    try {
      expect((await getSettings(founding)).model).toBe(`deployment-${tag}`);
      expect((await getSettings(a)).id).toBe(""); // built-in defaults
      await db
        .update(optioSettings)
        .set({ deploymentDefault: true })
        .where(eq(optioSettings.id, row.id));
      expect((await getSettings(a)).model).toBe(`deployment-${tag}`);
      await db.insert(optioSettings).values({ model: `own-${tag}`, workspaceId: a });
      expect((await getSettings(a)).model).toBe(`own-${tag}`);
    } finally {
      await db.delete(optioSettings).where(eq(optioSettings.id, row.id));
    }
  });
});

describe("secrets: the workspace's own, then the deployment's default", () => {
  it("a workspace's own key wins, other workspaces never see it, and the deployment's is opt-in", async () => {
    const name = `IT_KEY_${tag}`;
    await storeSecret(name, "deployment-value", "global");
    await storeSecret(name, "a-value", "workspace", a);

    expect(await retrieveSecretWithFallback(name, "global", a)).toBe("a-value");
    expect(await retrieveSecretWithFallback(name, "global", founding)).toBe("deployment-value");
    await expect(retrieveSecretWithFallback(name, "global", b)).rejects.toThrow(/not found/);
    await setSecretDeploymentDefault(name, "global", true);
    expect(await retrieveSecretWithFallback(name, "global", b)).toBe("deployment-value");
    expect(await retrieveSecretWithFallback(name, "global", a)).toBe("a-value");

    // Lists: B sees the shared deployment row, never A's own.
    const visibleToB = (await listVisibleSecrets({ userId: null, workspaceId: b, isAdmin: true }))
      .filter((s) => s.name === name)
      .map((s) => s.scope);
    expect(visibleToB).toEqual(["global"]);
    const visibleToA = (await listVisibleSecrets({ userId: null, workspaceId: a, isAdmin: true }))
      .filter((s) => s.name === name)
      .map((s) => s.scope)
      .sort();
    expect(visibleToA).toEqual(["global", "workspace"]);

    // A's own is pickable by A's work and goes with the organization's into setup.
    expect(await listPickableSecrets(a, null)).toContainEqual({ name, owner: "workspace" });
    expect(await listPickableSecrets(b, null)).not.toContainEqual({ name, owner: "workspace" });
    expect((await resolveSecretsForSetup(REPO, a))[name]).toBe("a-value");
    expect((await resolveSecretsForSetup(REPO, a, { orgSecrets: false }))[name]).toBeUndefined();
  });
});

describe("connection assignments stay inside the workspace", () => {
  it("refuses another workspace's repo, at create and when assigning later", async () => {
    const repoOfA = await insertRepo({ workspaceId: a });
    const repoOfB = await insertRepo({ workspaceId: b });
    await expect(
      createConnection(
        {
          name: `cross-${tag}`,
          providerSlug: "custom-mcp",
          config: { command: "node" },
          assignments: [{ repoId: repoOfB.id }],
        },
        a,
      ),
    ).rejects.toBeInstanceOf(AssignmentRepoError);

    const conn = await createConnection(
      {
        name: `own-${tag}`,
        providerSlug: "custom-mcp",
        config: { command: "node" },
        assignments: [{ repoId: repoOfA.id }],
      },
      a,
    );
    await expect(createAssignment(conn.id, { repoId: repoOfB.id })).rejects.toBeInstanceOf(
      AssignmentRepoError,
    );
  });

  it("resolves the repo the workspace added, when two workspaces added the same URL", async () => {
    const url = `https://github.com/acme/same-url-${uniq()}`;
    const repoOfA = await insertRepo({ repoUrl: url, workspaceId: a });
    await insertRepo({ repoUrl: url, workspaceId: b });
    const conn = await createConnection(
      {
        name: `same-url-${tag}`,
        providerSlug: "custom-mcp",
        config: { command: "node" },
        assignments: [{ repoId: repoOfA.id }],
      },
      a,
    );
    const got = await getConnectionsForTask(url, "claude-code", a);
    expect(got.map((c) => c.connectionId)).toContain(conn.id);
  });
});

describe("over HTTP: deployment rows are a deployment admin's to change and share", () => {
  async function userRow(deploymentAdmin: boolean) {
    const [u] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `it-${uniq()}`,
        email: `${uniq()}@ws-config.it`,
        displayName: "it",
        deploymentAdmin,
      })
      .returning();
    return u.id;
  }

  it("a workspace admin gets 404 for an unshared one and 403 changing a shared one", async () => {
    const [unshared] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, names.unshared));
    const [shared] = await db.select().from(mcpServers).where(eq(mcpServers.name, names.shared));
    const app = await buildRouteTestApp(mcpServerRoutes, {
      user: { id: await userRow(false), workspaceId: a, workspaceRole: "admin" },
    });
    expect(
      (await app.inject({ method: "GET", url: `/api/mcp-servers/${unshared.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: `/api/mcp-servers/${shared.id}` })).statusCode,
    ).toBe(200);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/mcp-servers/${shared.id}`,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: `/api/mcp-servers/${shared.id}` });
    expect(del.statusCode).toBe(403);
    const [after] = await db.select().from(mcpServers).where(eq(mcpServers.id, shared.id));
    expect(after.enabled).toBe(true);
    await app.close();
  });

  it("a deployment admin shares and un-shares one; a workspace row can't be shared", async () => {
    const [unshared] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, names.unshared));
    const app = await buildRouteTestApp(mcpServerRoutes, {
      user: { id: await userRow(true), workspaceId: founding, workspaceRole: "admin" },
    });
    const shared = await app.inject({
      method: "PATCH",
      url: `/api/mcp-servers/${unshared.id}`,
      payload: { deploymentDefault: true },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.json().server.deploymentDefault).toBe(true);
    expect(ours(await listMcpServers(undefined, b))).toContain(names.unshared);

    await app.inject({
      method: "PATCH",
      url: `/api/mcp-servers/${unshared.id}`,
      payload: { deploymentDefault: false },
    });
    expect(ours(await listMcpServers(undefined, b))).not.toContain(names.unshared);
    await app.close();

    const [own] = await db.select().from(mcpServers).where(eq(mcpServers.name, names.ofA));
    const asA = await buildRouteTestApp(mcpServerRoutes, {
      user: { id: await userRow(true), workspaceId: a, workspaceRole: "admin" },
    });
    const refused = await asA.inject({
      method: "PATCH",
      url: `/api/mcp-servers/${own.id}`,
      payload: { deploymentDefault: true },
    });
    expect(refused.statusCode).toBe(400);
    await asA.close();
  });
});
