/**
 * Vitest globalSetup for the integration tier (vitest.integration.config.ts).
 *
 * Runs ONCE in the main vitest process before any test worker spawns:
 *
 *   1. Ensures the throwaway Postgres + Redis containers are reachable,
 *      starting them via scripts/test-infra.sh when they aren't (CI runs the
 *      same script in a workflow step first, so this is usually a no-op
 *      there). External databases can be supplied via OPTIO_TEST_PG_URL /
 *      OPTIO_TEST_REDIS_URL with OPTIO_TEST_NO_DOCKER=1.
 *   2. Builds (or refreshes) the template database `optio_it_template` by
 *      running the real production migration runner (migrateSafe) against it.
 *      Per-file databases are cloned from this template, so every test file
 *      sees a fully-migrated schema for the cost of one CREATE DATABASE.
 *   3. Drops leftover `optio_it_run_*` databases from crashed runs.
 *
 * Worker processes inherit the env set here (forks pool spawns after
 * globalSetup completes). Per-file isolation lives in ./setup.ts.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrateSafe } from "../../db/migrate-safe.js";
import type { Database } from "../../db/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_FOLDER = join(HERE, "..", "..", "db", "migrations");

export const TEMPLATE_DB = "optio_it_template";
/** Per-file database prefixes swept at startup (integration + e2e tiers). */
const RUN_DB_PREFIXES = ["optio_it_run_", "optio_e2e_run_"];

const DEFAULT_PG_URL = "postgres://optio_test:optio_test@127.0.0.1:54329/postgres";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:63790";

function adminUrl(): string {
  return process.env.OPTIO_TEST_PG_URL || DEFAULT_PG_URL;
}

async function pgReachable(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function tcpReachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port), timeout: 2000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

async function ensureInfra(): Promise<void> {
  const pgUp = await pgReachable(adminUrl());
  const redisUp = await tcpReachable(process.env.OPTIO_TEST_REDIS_URL ?? DEFAULT_REDIS_URL);
  if (pgUp && redisUp) return;

  if (process.env.OPTIO_TEST_NO_DOCKER) {
    throw new Error(
      `Integration test infra unreachable (postgres up: ${pgUp}, redis up: ${redisUp}) and ` +
        "OPTIO_TEST_NO_DOCKER is set. Provide OPTIO_TEST_PG_URL / OPTIO_TEST_REDIS_URL.",
    );
  }

  console.warn("[integration] test infra not reachable — starting containers...");
  execFileSync("bash", [join(REPO_ROOT, "scripts", "test-infra.sh"), "start"], {
    stdio: "inherit",
  });

  for (let i = 0; i < 30; i++) {
    if (await pgReachable(adminUrl())) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Postgres test container did not become reachable within 30s");
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function buildTemplate(): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    // Round-robin allocator for per-file Redis logical DB indexes — lives in
    // the admin database so CONCURRENT vitest runs (integration + e2e at
    // once) never hand two live test files the same index.
    await admin.unsafe(`CREATE SEQUENCE IF NOT EXISTS optio_test_redis_db_seq`);

    // Clean up run databases left behind by CRASHED runs only: the database
    // name encodes the creating worker's pid, so skip databases whose owner
    // process is still alive (concurrent vitest runs are supported).
    for (const prefix of RUN_DB_PREFIXES) {
      const leftovers = await admin`
        SELECT datname FROM pg_database WHERE datname LIKE ${prefix + "%"}
      `;
      for (const row of leftovers) {
        const pid = Number(row.datname.slice(prefix.length).split("_")[0]);
        if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) continue;
        await admin.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      }
    }

    const migrateTemplate = async () => {
      const templateSql = postgres(withDatabase(adminUrl(), TEMPLATE_DB), { max: 1 });
      try {
        const db = drizzle(templateSql) as unknown as Database;
        const applied = await migrateSafe(db, MIGRATIONS_FOLDER);
        if (applied > 0) console.warn(`[integration] template migrated (+${applied})`);
      } finally {
        // The template must have zero connections while per-file databases
        // clone from it, so close eagerly.
        await templateSql.end({ timeout: 5 });
      }
    };

    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE_DB}`;
    if (exists.length === 0) {
      // A concurrent globalSetup (integration + e2e running at once) may have
      // just created it — losing that race is fine, migrateTemplate() below
      // serializes on the migration advisory lock.
      await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`).catch(() => {});
      await migrateTemplate();
      return;
    }

    try {
      // Existing template: migrateSafe is hash-based and idempotent, so this
      // only applies migrations added since the template was last built.
      await migrateTemplate();
    } catch (err) {
      // A locally-edited migration changes its hash and re-application fails.
      // Rebuild the template from scratch once before giving up.
      console.warn(
        `[integration] template migration failed (${err instanceof Error ? err.message : err}) — rebuilding template`,
      );
      await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
      await migrateTemplate();
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export default async function globalSetup(): Promise<void> {
  // Resolve defaults once so worker processes (which inherit env) agree with
  // the URLs used here.
  process.env.OPTIO_TEST_PG_URL = adminUrl();
  process.env.OPTIO_TEST_REDIS_URL = process.env.OPTIO_TEST_REDIS_URL || DEFAULT_REDIS_URL;

  await ensureInfra();
  await buildTemplate();
}
