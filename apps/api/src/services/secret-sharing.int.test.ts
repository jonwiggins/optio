/**
 * Sharing a deployment secret with other workspaces, against real Postgres.
 * Until a deployment admin shares a secret, the founding-workspace rule
 * holds (`deployment-secrets.int.test.ts`); a share reaches exactly the
 * workspaces it names (or every workspace, only while workspace creation is
 * limited to deployment admins), a workspace's own secret of the same name
 * still wins, and the share follows the secret through a new value and goes
 * with it, or with the workspace, when deleted.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { secretWorkspaceShares, users, workspaces } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { logger } from "../logger.js";
import { buildAgentEnvironment } from "./agent-environment-service.js";
import { connectionCatalog } from "./connection-catalog-service.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { WORKSPACE_CREATION_KEY, setDeploymentSetting } from "./deployment-settings.js";
import { foundingWorkspaceId } from "./founding-workspace.js";
import { createMcpServer } from "./mcp-server-service.js";
import {
  deleteSecret,
  listDeploymentSecretSharing,
  listPickableSecrets,
  listVisibleSecrets,
  mayUseDeploymentSecrets,
  podSecretsSelectionError,
  resolvePodSecrets,
  retrieveSecretWithFallback,
  setDeploymentSecretSharing,
  storeSecret,
} from "./secret-service.js";

const uniq = () => randomBytes(4).toString("hex");
const REPO = "https://github.com/acme/secret-sharing";

let founding: string;
let teamA: string;
let teamB: string;
let member: string;

async function insertUser() {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${uniq()}@secret-sharing.it`,
      displayName: "someone",
    })
    .returning();
  return u.id;
}

const unshare = (name: string) =>
  setDeploymentSecretSharing(name, { all: false, workspaceIds: [] });
const creation = (value: "admins" | "everyone" | null) =>
  setDeploymentSetting(WORKSPACE_CREATION_KEY, value, null);

beforeAll(async () => {
  await seedBuiltInProviders();
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  teamA = (await insertWorkspace()).id;
  teamB = (await insertWorkspace()).id;
  member = await insertUser();
  await storeSecret("REGISTRY_TOKEN", "deployment-registry-value", "global");
  await storeSecret("CA_BUNDLE", "deployment-ca-value", "global");
  await storeSecret("AWS_SECRET_ACCESS_KEY", "deployment-aws-value", "global");
});

afterAll(async () => {
  await creation(null);
});

describe("a deployment secret nobody shared", () => {
  it("keeps the founding-workspace rule exactly", async () => {
    expect(await mayUseDeploymentSecrets(teamA, { name: "REGISTRY_TOKEN", scope: "global" })).toBe(
      false,
    );
    expect(
      await mayUseDeploymentSecrets(founding, { name: "REGISTRY_TOKEN", scope: "global" }),
    ).toBe(true);
    expect(await listPickableSecrets(teamA, member)).not.toContainEqual(
      expect.objectContaining({ name: "REGISTRY_TOKEN" }),
    );
    const visible = await listVisibleSecrets({ userId: member, workspaceId: teamA, isAdmin: true });
    expect(visible.find((s) => s.name === "REGISTRY_TOKEN")?.shared).toBeUndefined();
    const sharing = await listDeploymentSecretSharing();
    expect(sharing.secrets).toContainEqual({
      name: "REGISTRY_TOKEN",
      all: false,
      workspaceIds: [],
    });
  });
});

describe("a deployment secret shared with chosen workspaces", () => {
  beforeAll(async () => {
    await setDeploymentSecretSharing("REGISTRY_TOKEN", { all: false, workspaceIds: [teamA] });
  });
  afterAll(async () => {
    await unshare("REGISTRY_TOKEN");
  });

  it("reaches the listed workspace's work and no other", async () => {
    expect(await mayUseDeploymentSecrets(teamA, { name: "REGISTRY_TOKEN", scope: "global" })).toBe(
      true,
    );
    expect(await mayUseDeploymentSecrets(teamB, { name: "REGISTRY_TOKEN", scope: "global" })).toBe(
      false,
    );
    // Only the one shared: the workspace check alone, and other secrets, still say no.
    expect(await mayUseDeploymentSecrets(teamA)).toBe(false);
    expect(await mayUseDeploymentSecrets(teamA, { name: "CA_BUNDLE", scope: "global" })).toBe(
      false,
    );

    expect(await listPickableSecrets(teamA, null)).toContainEqual({
      name: "REGISTRY_TOKEN",
      owner: "workspace",
    });
    expect(await listPickableSecrets(teamA, null)).not.toContainEqual(
      expect.objectContaining({ name: "CA_BUNDLE" }),
    );
    expect(
      await podSecretsSelectionError(["REGISTRY_TOKEN"], { workspaceId: teamA, ownerUserId: null }),
    ).toBeNull();
    expect(
      await podSecretsSelectionError(["REGISTRY_TOKEN"], { workspaceId: teamB, ownerUserId: null }),
    ).not.toBeNull();

    const a = await resolvePodSecrets(["REGISTRY_TOKEN", "CA_BUNDLE"], {
      repoUrl: REPO,
      workspaceId: teamA,
      ownerUserId: member,
    });
    expect(a.env).toEqual({ REGISTRY_TOKEN: "deployment-registry-value" });
    expect(a.missing).toEqual(["CA_BUNDLE"]);
    const b = await resolvePodSecrets(["REGISTRY_TOKEN"], { repoUrl: REPO, workspaceId: teamB });
    expect(b.env).toEqual({});

    await expect(
      retrieveSecretWithFallback("REGISTRY_TOKEN", "global", teamB, null, { pickedByWork: true }),
    ).rejects.toThrow(/Secret not found/);
    expect(
      await retrieveSecretWithFallback("REGISTRY_TOKEN", "global", teamA, null, {
        pickedByWork: true,
      }),
    ).toBe("deployment-registry-value");
  });

  it("shows workspace admins the name and that it is shared, never the value", async () => {
    const visible = await listVisibleSecrets({ userId: member, workspaceId: teamA, isAdmin: true });
    const row = visible.find((s) => s.name === "REGISTRY_TOKEN");
    expect(row?.shared).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("deployment-registry-value");
    const other = await listVisibleSecrets({ userId: member, workspaceId: teamB, isAdmin: true });
    expect(other.find((s) => s.name === "REGISTRY_TOKEN")?.shared).toBeUndefined();

    const catalog = await connectionCatalog({ userId: null, workspaceId: teamA, isAdmin: true });
    const entry = catalog.find((e) => e.kind === "secret" && e.name === "REGISTRY_TOKEN");
    expect(entry).toMatchObject({ shared: true, scope: "global" });
    expect(catalog.find((e) => e.kind === "secret" && e.name === "CA_BUNDLE")).toBeUndefined();
    const catalogB = await connectionCatalog({ userId: null, workspaceId: teamB, isAdmin: true });
    expect(catalogB.find((e) => e.name === "REGISTRY_TOKEN")).toBeUndefined();
  });

  it("answers a connection's and an MCP server's ${{NAME}} in that workspace only", async () => {
    const build = async (workspaceId: string) => {
      const tag = uniq();
      await createConnection(
        {
          name: `conn-${tag}`,
          providerSlug: "custom-mcp",
          ownerUserId: null,
          config: { command: "sh", args: "-c\nenv", env: "A=${{REGISTRY_TOKEN}}" },
          assignments: [{ repoId: null }],
        },
        workspaceId,
      );
      await createMcpServer(
        {
          name: `srv-${tag}`,
          command: "node",
          args: [],
          env: { B: "${{REGISTRY_TOKEN}}", C: "${{CA_BUNDLE}}" },
          repoUrl: REPO,
          ownerUserId: null,
        },
        workspaceId,
      );
      const env = await buildAgentEnvironment(
        { repoUrl: REPO, agentType: "claude-code", workspaceId, ownerUserId: null },
        logger,
      );
      // Every value, base64-decoded too (files are encoded).
      return (
        JSON.stringify(env) +
        Object.values(env)
          .map((v) => Buffer.from(v, "base64").toString("utf8"))
          .join("\n")
      );
    };

    const envA = await build(teamA);
    expect(envA).toContain("deployment-registry-value");
    expect(envA).not.toContain("deployment-ca-value");
    const envB = await build(teamB);
    expect(envB).not.toContain("deployment-registry-value");
  });

  it("lets the workspace's own secret of the same name win", async () => {
    await storeSecret("REGISTRY_TOKEN", "team-a-own-value", REPO, teamA);
    try {
      const a = await resolvePodSecrets(["REGISTRY_TOKEN"], { repoUrl: REPO, workspaceId: teamA });
      expect(a.env).toEqual({ REGISTRY_TOKEN: "team-a-own-value" });
    } finally {
      await deleteSecret("REGISTRY_TOKEN", REPO, teamA);
    }
  });

  it("keeps the share through a new value", async () => {
    await storeSecret("REGISTRY_TOKEN", "deployment-registry-rotated", "global");
    try {
      const a = await resolvePodSecrets(["REGISTRY_TOKEN"], { repoUrl: REPO, workspaceId: teamA });
      expect(a.env).toEqual({ REGISTRY_TOKEN: "deployment-registry-rotated" });
    } finally {
      await storeSecret("REGISTRY_TOKEN", "deployment-registry-value", "global");
    }
  });
});

describe("a deployment secret shared with every workspace", () => {
  afterAll(async () => {
    await unshare("CA_BUNDLE");
    await creation(null);
  });

  it("is refused while anyone may create a workspace", async () => {
    await creation("everyone");
    await expect(
      setDeploymentSecretSharing("CA_BUNDLE", { all: true, workspaceIds: [] }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await listDeploymentSecretSharing()).allApplies).toBe(false);
  });

  it("reaches every workspace while only deployment admins create them, and stops when that changes", async () => {
    await creation("admins");
    await setDeploymentSecretSharing("CA_BUNDLE", { all: true, workspaceIds: [teamA] });
    expect((await listDeploymentSecretSharing()).allApplies).toBe(true);
    const later = (await insertWorkspace()).id;
    for (const ws of [teamA, teamB, later]) {
      expect(await mayUseDeploymentSecrets(ws, { name: "CA_BUNDLE", scope: "global" })).toBe(true);
    }

    // Workspace creation opened to everyone: "every workspace" reaches none,
    // a workspace listed by name keeps it.
    await creation("everyone");
    expect(await mayUseDeploymentSecrets(teamB, { name: "CA_BUNDLE", scope: "global" })).toBe(
      false,
    );
    expect(await mayUseDeploymentSecrets(later, { name: "CA_BUNDLE", scope: "global" })).toBe(
      false,
    );
    expect(await mayUseDeploymentSecrets(teamA, { name: "CA_BUNDLE", scope: "global" })).toBe(true);
    const visible = await listVisibleSecrets({ userId: null, workspaceId: teamB, isAdmin: true });
    expect(visible.find((s) => s.name === "CA_BUNDLE")?.shared).toBeUndefined();
  });
});

describe("what can't be shared, and what ends a share", () => {
  it("refuses Optio's own settings and sign-in secrets, unknown names and workspaces", async () => {
    await expect(
      setDeploymentSecretSharing("AWS_SECRET_ACCESS_KEY", { all: false, workspaceIds: [teamA] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await mayUseDeploymentSecrets(teamA, { name: "AWS_SECRET_ACCESS_KEY", scope: "global" }),
    ).toBe(false);
    expect((await listDeploymentSecretSharing()).secrets.map((s) => s.name)).not.toContain(
      "AWS_SECRET_ACCESS_KEY",
    );
    await expect(
      setDeploymentSecretSharing("NO_SUCH_SECRET", { all: false, workspaceIds: [teamA] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      setDeploymentSecretSharing("REGISTRY_TOKEN", {
        all: false,
        workspaceIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    // A workspace's own repo secret is not the deployment's and can't be shared.
    await storeSecret("TEAM_ONLY", "team-only-value", REPO, teamA);
    await expect(
      setDeploymentSecretSharing("TEAM_ONLY", { all: false, workspaceIds: [teamB] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("stops sharing when unshared, when the secret is deleted, and drops a deleted workspace", async () => {
    await storeSecret("SHORT_LIVED", "short-lived-value", "global");
    const gone = (await insertWorkspace()).id;
    await setDeploymentSecretSharing("SHORT_LIVED", { all: false, workspaceIds: [teamA, gone] });
    expect(await mayUseDeploymentSecrets(teamA, { name: "SHORT_LIVED", scope: "global" })).toBe(
      true,
    );

    await db.delete(workspaces).where(eq(workspaces.id, gone));
    expect(
      (await listDeploymentSecretSharing()).secrets.find((s) => s.name === "SHORT_LIVED"),
    ).toEqual({ name: "SHORT_LIVED", all: false, workspaceIds: [teamA] });

    await unshare("SHORT_LIVED");
    expect(await mayUseDeploymentSecrets(teamA, { name: "SHORT_LIVED", scope: "global" })).toBe(
      false,
    );

    await setDeploymentSecretSharing("SHORT_LIVED", { all: false, workspaceIds: [teamA] });
    await deleteSecret("SHORT_LIVED", "global");
    // Every other share in this file was undone above: none is left.
    expect(await db.select().from(secretWorkspaceShares)).toEqual([]);
    // A new secret of the same name starts unshared.
    await storeSecret("SHORT_LIVED", "short-lived-again", "global");
    expect(await mayUseDeploymentSecrets(teamA, { name: "SHORT_LIVED", scope: "global" })).toBe(
      false,
    );
  });
});
