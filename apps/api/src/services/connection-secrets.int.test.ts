/**
 * A connection's credentials against real Postgres: sealed on the row,
 * never returned, merged on PATCH, reaching only the pod path — and moved
 * out of a pre-v2 plain config at boot.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  createConnection,
  getConnection,
  getConnectionsForTask,
  listConnections,
  sealPlaintextConnectionSecrets,
  seedBuiltInProviders,
  testConnection,
  updateConnection,
} from "./connection-service.js";
import { storeSecret } from "./secret-service.js";

beforeAll(async () => {
  await seedBuiltInProviders();
});

describe("connection credentials", () => {
  it("seals secret fields on create and never returns them", async () => {
    const ws = await insertWorkspace();
    const conn = await createConnection(
      {
        name: "Support Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "pyl_secret", PYLON_API_HOST: "api.usepylon.com" },
        assignments: [{ repoId: null }],
      },
      ws.id,
    );
    expect(conn.config).toEqual({ PYLON_API_HOST: "api.usepylon.com" });
    expect(conn.secretFields).toEqual(["PYLON_API_TOKEN"]);
    expect(conn.parts).toEqual(["credentials", "tools", "note"]);
    expect(JSON.stringify(conn)).not.toContain("pyl_secret");

    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row.config).toEqual({ PYLON_API_HOST: "api.usepylon.com" });
    expect(row.secretConfig).not.toBeNull();
    expect(JSON.stringify(row.config)).not.toContain("pyl_secret");

    const listed = (await listConnections(ws.id)).find((c) => c.id === conn.id)!;
    expect(JSON.stringify(listed)).not.toContain("pyl_secret");

    // The pod path gets the value.
    const [resolved] = await getConnectionsForTask("", "claude-code", ws.id, null);
    expect(resolved.connectionId).toBe(conn.id);
    expect(resolved.secrets).toEqual({ PYLON_API_TOKEN: "pyl_secret" });
    expect(resolved.configDefaults.PYLON_API_HOST).toBe("api.usepylon.com");
  });

  it("merges on PATCH: an empty secret keeps the value, null clears it, plain fields merge", async () => {
    const ws = await insertWorkspace();
    const conn = await createConnection(
      {
        name: "Acme AWS",
        providerSlug: "aws",
        config: {
          AWS_ACCESS_KEY_ID: "AKIA1",
          AWS_SECRET_ACCESS_KEY: "s1",
          AWS_REGION: "us-east-1",
        },
      },
      ws.id,
    );
    expect(conn.parts).toEqual(["credentials", "env", "note"]);

    const kept = await updateConnection(conn.id, {
      config: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "••••••", AWS_REGION: "eu-west-1" },
    });
    expect(kept.config).toEqual({ AWS_REGION: "eu-west-1" });
    expect(kept.secretFields.sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    let [resolved] = await getConnectionsForTask("", "claude-code", ws.id, null, {
      add: [conn.id],
    });
    expect(resolved.secrets).toEqual({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s1" });

    const replaced = await updateConnection(conn.id, {
      config: { AWS_SECRET_ACCESS_KEY: "s2", AWS_ACCESS_KEY_ID: null },
      exportShellEnv: false,
    });
    expect(replaced.secretFields).toEqual(["AWS_SECRET_ACCESS_KEY"]);
    expect(replaced.exportShellEnv).toBe(false);
    expect(replaced.parts).toEqual(["credentials", "note"]);
    [resolved] = await getConnectionsForTask("", "claude-code", ws.id, null, { add: [conn.id] });
    expect(resolved.secrets).toEqual({ AWS_SECRET_ACCESS_KEY: "s2" });
    expect(resolved.exportShellEnv).toBe(false);

    // Tools switch on with the boolean.
    const tools = await updateConnection(conn.id, { config: { AWS_TOOLS: true } });
    expect(tools.parts).toEqual(["credentials", "tools", "note"]);
  });

  it("replaces assignments on PATCH when given", async () => {
    const ws = await insertWorkspace();
    const conn = await createConnection(
      {
        name: "Notes",
        providerSlug: "notion",
        config: { NOTION_API_KEY: "n1" },
        assignments: [{ repoId: null, agentTypes: ["codex"] }],
      },
      ws.id,
    );
    expect(conn.assignments).toHaveLength(1);
    const updated = await updateConnection(conn.id, {
      assignments: [{ repoId: null, agentTypes: ["claude-code"], permission: "write" }],
    });
    expect(updated.assignments).toHaveLength(1);
    expect(updated.assignments![0].agentTypes).toEqual(["claude-code"]);
    expect(updated.assignments![0].permission).toBe("write");
    // Secrets untouched by an assignment-only PATCH.
    expect(updated.secretFields).toEqual(["NOTION_API_KEY"]);
  });

  it("keeps a ${{NAME}} reference as config and resolves it for the pod", async () => {
    const ws = await insertWorkspace();
    await storeSecret("LINEAR_TEAM_KEY", "lin_from_store", "global");
    const conn = await createConnection(
      {
        name: "Linear",
        providerSlug: "linear",
        config: { LINEAR_API_KEY: "${{LINEAR_TEAM_KEY}}" },
      },
      ws.id,
    );
    expect(conn.config).toEqual({ LINEAR_API_KEY: "${{LINEAR_TEAM_KEY}}" });
    expect(conn.secretFields).toEqual([]);
    expect(conn.parts).toContain("credentials");
  });

  it("boot heal moves a pre-v2 plaintext credential into the sealed column, once", async () => {
    const ws = await insertWorkspace();
    const conn = await createConnection(
      { name: "Legacy Notion", providerSlug: "notion", config: {} },
      ws.id,
    );
    // Put the token where v1 stored it.
    await db
      .update(connections)
      .set({ config: { NOTION_API_KEY: "legacy_plain" } })
      .where(eq(connections.id, conn.id));
    // Even unsealed, the API hides it.
    expect(JSON.stringify(await getConnection(conn.id))).not.toContain("legacy_plain");

    const sealed = await sealPlaintextConnectionSecrets();
    expect(sealed).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row.config).toEqual({});
    expect(row.secretConfig).not.toBeNull();
    const after = await getConnection(conn.id);
    expect(after!.secretFields).toEqual(["NOTION_API_KEY"]);
    const [resolved] = await getConnectionsForTask("", "claude-code", ws.id, null, {
      add: [conn.id],
    });
    expect(resolved.secrets).toEqual({ NOTION_API_KEY: "legacy_plain" });

    // Nothing left to seal for this row.
    const before = row.secretConfig;
    await sealPlaintextConnectionSecrets();
    const [again] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(again.secretConfig).toEqual(before);
  });

  it("a provider without a health check leaves the status unknown", async () => {
    const ws = await insertWorkspace();
    const conn = await createConnection(
      { name: "Files", providerSlug: "filesystem", config: { ROOT_PATH: "/data" } },
      ws.id,
    );
    const tested = await testConnection(conn.id);
    expect(tested.status).toBe("unknown");
    expect(tested.statusMessage).toMatch(/no health check/);
    expect(tested.lastCheckedAt).toBeInstanceOf(Date);
  });
});
