/**
 * 1792600000_sso_providers adds the OIDC / LDAP settings column beside the
 * saved sign-in providers and never deletes one: a Google, GitHub or GitLab
 * row saved before it is still there after it — on a fresh upgrade, and on a
 * database that ran an earlier version of the file (migrate-safe.ts applies a
 * file again when its hash changes, so every statement must be idempotent).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

const BEFORE = "1792500000_local_terminal_queue_priority";
const TAG = "1792600000_sso_providers";
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations", `${TAG}.sql`);

async function seedProviders(sql: Awaited<ReturnType<typeof stageDatabase>>["sql"]) {
  for (const provider of ["google", "github", "gitlab"]) {
    await sql`
      INSERT INTO auth_provider_configs
        (provider, client_id, encrypted_client_secret, client_secret_iv, client_secret_auth_tag,
         allowed_domains, display_name, enabled)
      VALUES
        (${provider}, ${`${provider}-client`}, ${Buffer.from("sealed")}, ${Buffer.from("iv")},
         ${Buffer.from("tag")}, ${JSON.stringify(["acme.com"])}::jsonb, ${`${provider} SSO`}, true)`;
  }
}

async function providerRows(sql: Awaited<ReturnType<typeof stageDatabase>>["sql"]) {
  return sql<
    Array<{ provider: string; client_id: string; allowed_domains: string[]; settings: unknown }>
  >`SELECT provider, client_id, allowed_domains, settings FROM auth_provider_configs ORDER BY provider`;
}

describe(TAG, () => {
  it("deletes nothing, drops nothing", () => {
    const text = fs
      .readFileSync(FILE, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(text).not.toMatch(/\b(DELETE|TRUNCATE|DROP\s+(TABLE|COLUMN))\b/i);
  });

  it("keeps the Google, GitHub and GitLab sign-in settings saved before it", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      await seedProviders(db.sql);
      await db.migrateRest(TAG);
      const rows = await providerRows(db.sql);
      expect(rows).toEqual([
        {
          provider: "github",
          client_id: "github-client",
          allowed_domains: ["acme.com"],
          settings: {},
        },
        {
          provider: "gitlab",
          client_id: "gitlab-client",
          allowed_domains: ["acme.com"],
          settings: {},
        },
        {
          provider: "google",
          client_id: "google-client",
          allowed_domains: ["acme.com"],
          settings: {},
        },
      ]);
      // The rest of the migrations keep them too.
      await db.migrateRest();
      expect((await providerRows(db.sql)).map((r) => r.provider)).toEqual([
        "github",
        "gitlab",
        "google",
      ]);
    } finally {
      await db.drop();
    }
  });

  it("runs again harmlessly on a database that applied an earlier version of the file", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      // What an earlier version left: the columns and index exist and its
      // hash is recorded, so the current file (a different hash) runs again.
      const current = fs.readFileSync(FILE, "utf8");
      await db.sql.unsafe(current);
      await db.sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES ('an-earlier-version-of-1792600000', 1792600000000)`;
      await db.sql`INSERT INTO workspaces (name, slug, organization) VALUES ('Org', 'org', true)`;
      await seedProviders(db.sql);

      await db.migrateRest();

      expect((await providerRows(db.sql)).map((r) => r.provider)).toEqual([
        "github",
        "gitlab",
        "google",
      ]);
      const [{ organization }] = await db.sql<Array<{ organization: boolean }>>`
        SELECT organization FROM workspaces WHERE slug = 'org'`;
      expect(organization).toBe(true);
    } finally {
      await db.drop();
    }
  });
});
