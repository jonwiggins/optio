/**
 * 1792834000_remote_workspaces against a database that already has Coder
 * connections, Coder machines and runs started in Coder workspaces (the
 * shape 1792600700_coder.sql made): every row is kept, under the
 * provider-neutral names, as Coder's (docs/remote-workspaces.md).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

/** The last migration before the remote-workspace one. */
const BEFORE = "1792820000_notify_delivery";

describe("1792834000_remote_workspaces", () => {
  it("keeps every Coder connection, machine, launch and health check as Coder's", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      const { sql } = db;
      const [user] = await sql`
        INSERT INTO users (provider, external_id, email, display_name)
        VALUES ('oidc', ${`it-${randomUUID()}`}, 'dev@example.com', 'Dev') RETURNING id`;
      const workspaceId = randomUUID();
      const [conn] = await sql`
        INSERT INTO coder_connections (workspace_id, name, url, encrypted_token, token_iv,
          token_auth_tag, token_hint, template_id, default_parameters, ttl_ms, delete_when_done)
        VALUES (${workspaceId}, 'Org', 'https://coder.example.com', '\\x01'::bytea, '\\x02'::bytea,
          '\\x03'::bytea, '1234', 'tpl-1', '{"cpu":"4"}'::jsonb, 3600000, true)
        RETURNING id`;
      const [key] = await sql`
        INSERT INTO api_keys (user_id, name, prefix, hashed_key)
        VALUES (${user.id}, 'coder:optio-fix-1', 'optio_pat_it', ${`hash-${randomUUID()}`})
        RETURNING id`;
      const [host] = await sql`
        INSERT INTO local_hosts (user_id, name, hostname, platform, origin,
          coder_workspace_id, coder_workspace_name, coder_connection_id, pairing_token_id)
        VALUES (${user.id}, 'optio-fix-1', ${`coder:${randomUUID()}`}, 'linux', 'coder',
          'w-1', 'optio-fix-1', ${conn.id}, ${key.id})
        RETURNING id`;
      const launch = { connectionId: conn.id, templateId: "tpl-1" };
      const [task] = await sql`
        INSERT INTO tasks (title, prompt, repo_url, agent_type, run_target, local_host_id, coder_launch)
        VALUES ('t', 'p', 'https://git.example.com/acme/app', 'claude-code', 'local', ${host.id},
          ${JSON.stringify(launch)}::jsonb)
        RETURNING id`;
      await sql`
        INSERT INTO credential_checks (credential_key, kind, label, scope, workspace_id, status)
        VALUES (${`coder:${conn.id}`}, 'coder', 'Coder · Org', 'organization', NULL, 'ok')`;

      await db.migrateRest();

      const [{ old }] = await sql`SELECT to_regclass('coder_connections') IS NOT NULL AS old`;
      expect(old).toBe(false);
      const [moved] = await sql`
        SELECT id, provider, name, url, token_hint, template_id, default_parameters, ttl_ms,
          delete_when_done, encrypted_token
        FROM remote_workspace_connections WHERE id = ${conn.id}`;
      expect(moved).toMatchObject({
        provider: "coder",
        name: "Org",
        url: "https://coder.example.com",
        token_hint: "1234",
        template_id: "tpl-1",
        default_parameters: { cpu: "4" },
        delete_when_done: true,
      });
      expect(Number(moved.ttl_ms)).toBe(3_600_000);
      expect(Buffer.from(moved.encrypted_token).toString("hex")).toBe("01");

      const [machine] = await sql`
        SELECT origin, remote_workspace_id, remote_workspace_name, remote_workspace_connection_id,
          pairing_token_id
        FROM local_hosts WHERE id = ${host.id}`;
      expect(machine).toEqual({
        origin: "coder",
        remote_workspace_id: "w-1",
        remote_workspace_name: "optio-fix-1",
        remote_workspace_connection_id: conn.id,
        pairing_token_id: key.id,
      });

      const [run] = await sql`SELECT remote_workspace_launch FROM tasks WHERE id = ${task.id}`;
      expect(run.remote_workspace_launch).toEqual(launch);
      const columns = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'work_definitions'
          AND column_name IN ('coder_launch', 'remote_workspace_launch')`;
      expect(columns.map((c) => c.column_name)).toEqual(["remote_workspace_launch"]);

      const [check] = await sql`
        SELECT credential_key, kind FROM credential_checks WHERE label = 'Coder · Org'`;
      expect(check).toEqual({
        credential_key: `remote_workspace:${conn.id}`,
        kind: "remote_workspace",
      });

      // One connection per provider per scope: another provider's organization
      // connection sits next to Coder's; a second Coder one doesn't.
      await sql`
        INSERT INTO remote_workspace_connections (workspace_id, provider, name, url)
        VALUES (${workspaceId}, 'daytona', 'Sandboxes', '')`;
      await expect(sql`
        INSERT INTO remote_workspace_connections (workspace_id, provider, name, url)
        VALUES (${workspaceId}, 'coder', 'Org 2', 'https://coder.example.com')`).rejects.toThrow(
        /remote_workspace_connections_org_key/,
      );
      // A new row names its provider, and only a known one.
      await expect(sql`
        INSERT INTO remote_workspace_connections (workspace_id, name, url)
        VALUES (${randomUUID()}, 'No provider', 'https://x.example.com')`).rejects.toThrow(
        /provider/,
      );
      await expect(sql`
        INSERT INTO remote_workspace_connections (workspace_id, provider, name, url)
        VALUES (${randomUUID()}, 'other', 'Other', 'https://x.example.com')`).rejects.toThrow(
        /remote_workspace_connections_provider_check/,
      );
      // A machine may be any provider's workspace.
      await sql`UPDATE local_hosts SET origin = 'e2b' WHERE id = ${host.id}`;
      await expect(
        sql`UPDATE local_hosts SET origin = 'other' WHERE id = ${host.id}`,
      ).rejects.toThrow(/local_hosts_origin_check/);
    } finally {
      await db.drop();
    }
  });
});
