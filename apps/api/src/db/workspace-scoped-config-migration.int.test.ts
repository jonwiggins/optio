/**
 * Migration 1795300000_workspace_scoped_config against populated rows: every
 * deployment row (no workspace) that exists when it runs becomes a shared
 * deployment default, so upgrading changes nothing anyone sees or runs with;
 * private secrets and workspace rows are left alone; existing ticket
 * providers become the founding (oldest) workspace's.
 */
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

const BEFORE = "1794990200_directory_emails_unverified";

describe("1795300000_workspace_scoped_config", () => {
  it("shares every existing deployment row, once, and gives ticket providers the founding workspace", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      const { sql } = db;
      const [founding] = await sql`
        SELECT id FROM workspaces ORDER BY created_at ASC, id ASC LIMIT 1`;
      const [other] = await sql`
        INSERT INTO workspaces (name, slug) VALUES ('Other', 'other-ws') RETURNING id`;
      const [person] = await sql`
        INSERT INTO users (provider, external_id, email, display_name)
        VALUES ('github', 'mig-1', 'mig@example.it', 'Mig') RETURNING id`;
      const blob = Buffer.from("x");
      const secret = (name: string, scope: string, ws: string | null, user: string | null) =>
        sql`INSERT INTO secrets (name, scope, encrypted_value, iv, auth_tag, workspace_id, user_id)
            VALUES (${name}, ${scope}, ${blob}, ${blob}, ${blob}, ${ws}, ${user})`;
      await secret("ANTHROPIC_API_KEY", "global", null, null);
      await secret("LEGACY_REPO_KEY", "https://github.com/acme/app", null, null);
      await secret("WS_REPO_KEY", "https://github.com/acme/app", other.id, null);
      await secret("MY_KEY", "user", null, person.id);
      await secret("GITHUB_USER_ACCESS_TOKEN", `user:${person.id}`, null, null);

      const [provider] = await sql`
        INSERT INTO connection_providers (slug, name) VALUES ('mig-custom', 'Custom') RETURNING id`;
      await sql`INSERT INTO connections (name, provider_id) VALUES ('legacy', ${provider.id})`;
      await sql`INSERT INTO connections (name, provider_id, workspace_id)
                VALUES ('own', ${provider.id}, ${other.id})`;
      await sql`INSERT INTO mcp_servers (name, command) VALUES ('legacy-mcp', 'node')`;
      await sql`INSERT INTO custom_skills (name, prompt) VALUES ('legacy-skill', 'do it')`;
      await sql`INSERT INTO optio_settings (model) VALUES ('opus')`;
      await sql`INSERT INTO ticket_providers (source, config) VALUES ('jira', '{}'::jsonb)`;

      await db.migrateRest();

      const shared = Object.fromEntries(
        (await sql`SELECT name, deployment_default FROM secrets`).map((r) => [
          r.name,
          r.deployment_default,
        ]),
      );
      expect(shared).toEqual({
        ANTHROPIC_API_KEY: true,
        LEGACY_REPO_KEY: true,
        WS_REPO_KEY: false,
        MY_KEY: false,
        // A person's legacy token is theirs, never the deployment's.
        GITHUB_USER_ACCESS_TOKEN: false,
      });
      expect(
        Object.fromEntries(
          (await sql`SELECT name, deployment_default FROM connections`).map((r) => [
            r.name,
            r.deployment_default,
          ]),
        ),
      ).toEqual({ legacy: true, own: false });
      expect((await sql`SELECT deployment_default FROM mcp_servers`)[0].deployment_default).toBe(
        true,
      );
      expect((await sql`SELECT deployment_default FROM custom_skills`)[0].deployment_default).toBe(
        true,
      );
      expect((await sql`SELECT deployment_default FROM optio_settings`)[0].deployment_default).toBe(
        true,
      );
      expect((await sql`SELECT workspace_id FROM ticket_providers`)[0].workspace_id).toBe(
        founding.id,
      );

      // Only a deployment row can be a deployment default; a workspace secret has its workspace.
      await expect(
        sql`UPDATE connections SET deployment_default = true WHERE name = 'own'`,
      ).rejects.toThrow(/connections_deployment_default_check/);
      await expect(
        sql`INSERT INTO secrets (name, scope, encrypted_value, iv, auth_tag)
            VALUES ('ORPHAN', 'workspace', ${blob}, ${blob}, ${blob})`,
      ).rejects.toThrow(/secrets_workspace_scope_check/);
    } finally {
      await db.drop();
    }
  });
});
