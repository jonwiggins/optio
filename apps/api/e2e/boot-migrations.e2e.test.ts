/**
 * E2E: the boot path itself — migrations from an EMPTY database.
 *
 * The per-file setup already provisioned a template-cloned (pre-migrated)
 * database, but this file deliberately ignores it: it creates an additional
 * EMPTY database via the admin connection and points the spawned API server
 * at it, so the server's own migrateSafe() run (index.ts main(), before
 * listen) has to build the entire schema from zero.
 *
 * Covers: server becomes healthy against the empty DB (migrations applied
 * from zero, key tables exist), built-in connection providers seeded,
 * /api/health response shape with the fake runtime, and boot idempotency
 * (second server against the SAME DB applies 0 migrations).
 *
 * Also asserts seedBuiltInProviders idempotency across boots: its upsert
 * targets the partial (slug WHERE workspace_id IS NULL) unique index, so
 * re-seeding updates the existing built-in rows instead of duplicating them
 * (it used to insert a fresh copy every boot — the composite
 * UNIQUE("slug","workspace_id") treats NULLs as distinct).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "src", "db", "migrations");

// Admin URL is set by the integration globalSetup (inherited via process.env).
const ADMIN_URL = process.env.OPTIO_TEST_PG_URL!;

// Same naming scheme as provision.ts (prefix + pid + random) so the next
// globalSetup run sweeps this database if we crash before afterAll.
const EMPTY_DB_NAME = `optio_e2e_run_${process.pid}_${randomBytes(4).toString("hex")}`;

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const EMPTY_DB_URL = withDatabase(ADMIN_URL, EMPTY_DB_NAME);

/** Run `fn` against `url` on a short-lived single connection. */
async function withDb<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1 });
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Rows migrateSafe writes into drizzle.__drizzle_migrations when starting
 * from zero: one per DISTINCT sha256 of the journal's .sql files (it dedupes
 * by content hash, not by journal entry).
 */
function expectedMigrationRowCount(): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ tag: string }> };
  const hashes = new Set<string>();
  for (const entry of journal.entries) {
    const content = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf-8");
    hashes.add(createHash("sha256").update(content).digest("hex"));
  }
  return hashes.size;
}

async function countMigrationRows(): Promise<number> {
  const rows = await withDb(
    EMPTY_DB_URL,
    (sql) =>
      sql<{ count: string }[]>`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
  );
  return Number(rows[0].count);
}

async function listPublicTables(): Promise<string[]> {
  const rows = await withDb(
    EMPTY_DB_URL,
    (sql) =>
      sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `,
  );
  return rows.map((r) => r.table_name);
}

interface HealthBody {
  healthy: boolean;
  checks: Record<string, boolean>;
  maxConcurrent: number;
  otelEnabled: boolean;
}

let server: ApiServerHandle | undefined;
let secondServer: ApiServerHandle | undefined;
let preBootPublicTableCount = -1;

beforeAll(async () => {
  // CREATE DATABASE without TEMPLATE → a genuinely empty database (default
  // template1: no public tables, no drizzle schema).
  await withDb(ADMIN_URL, (sql) => sql.unsafe(`CREATE DATABASE "${EMPTY_DB_NAME}"`));
  preBootPublicTableCount = (await listPublicTables()).length;

  // startApiServer only resolves once /api/health reports healthy — and the
  // real boot path (index.ts) runs migrateSafe BEFORE listen and exits the
  // process on migration failure, so resolving proves migrations succeeded.
  server = await startApiServer({ env: { DATABASE_URL: EMPTY_DB_URL } });
}, 150_000);

afterAll(async () => {
  await server?.stop();
  await secondServer?.stop();
  // FORCE terminates any connection a lingering server pool still holds.
  await withDb(ADMIN_URL, (sql) =>
    sql.unsafe(`DROP DATABASE IF EXISTS "${EMPTY_DB_NAME}" WITH (FORCE)`),
  );
}, 30_000);

describe("boot from an empty database", () => {
  it("becomes healthy after applying every migration from zero", async () => {
    // The database really was empty before boot.
    expect(preBootPublicTableCount).toBe(0);

    // Key tables from across the schema's lifetime now exist.
    const tables = await listPublicTables();
    for (const expected of ["tasks", "workflows", "persistent_agents", "connection_providers"]) {
      expect(tables).toContain(expected);
    }

    // migrateSafe recorded exactly one row per distinct migration file hash.
    const expected = expectedMigrationRowCount();
    expect(expected).toBeGreaterThan(0);
    expect(await countMigrationRows()).toBe(expected);
  });

  it("seeds the built-in connection providers", async () => {
    const rows = await withDb(
      EMPTY_DB_URL,
      (sql) =>
        sql<{ slug: string; built_in: boolean; workspace_id: string | null }[]>`
        SELECT slug, built_in, workspace_id FROM connection_providers
      `,
    );
    expect(rows.length).toBeGreaterThan(0);

    const slugs = rows.map((r) => r.slug);
    for (const expected of ["notion", "github-enhanced", "slack", "filesystem", "custom-mcp"]) {
      expect(slugs).toContain(expected);
    }
    // Seeded providers are built-in and global (NULL workspace).
    for (const row of rows) {
      expect(row.built_in).toBe(true);
      expect(row.workspace_id).toBeNull();
    }
  });

  it("reports the full /api/health shape (fake runtime pings ok)", async () => {
    const res = await fetch(`${server!.baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
    expect(body.checks.containerRuntime).toBe(true);
    expect(Number.isInteger(body.maxConcurrent)).toBe(true);
    expect(body.maxConcurrent).toBeGreaterThan(0);
    expect(body.otelEnabled).toBe(false);
  });

  it("boots idempotently: a second server on the same DB applies 0 migrations", async () => {
    const migrationsBefore = await countMigrationRows();
    const providersBefore = await withDb(
      EMPTY_DB_URL,
      (sql) => sql<{ slug: string }[]>`SELECT slug FROM connection_providers`,
    );

    await server!.stop();
    server = undefined;

    // Same DATABASE_URL: migrateSafe finds every hash already applied.
    // Resolving = healthy again, no boot error.
    secondServer = await startApiServer({ env: { DATABASE_URL: EMPTY_DB_URL } });

    expect(await countMigrationRows()).toBe(migrationsBefore);

    // seedBuiltInProviders re-ran and is idempotent: the upsert targets the
    // partial (slug WHERE workspace_id IS NULL) unique index, so the second
    // boot updates the existing rows instead of inserting duplicates.
    const providersAfter = await withDb(
      EMPTY_DB_URL,
      (sql) => sql<{ slug: string }[]>`SELECT slug FROM connection_providers`,
    );
    expect(providersAfter.length).toBe(providersBefore.length);
    expect(new Set(providersAfter.map((r) => r.slug))).toEqual(
      new Set(providersBefore.map((r) => r.slug)),
    );

    const res = await fetch(`${secondServer.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.healthy).toBe(true);
    expect(body.checks.database).toBe(true);
  }, 150_000);
});
