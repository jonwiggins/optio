/**
 * Migration tests on populated data. `stageDatabase(tag)` creates an empty
 * database migrated up to and including `tag` — the schema as a deployment
 * on that release has it — so a test can seed rows in the old shape with raw
 * SQL, call `migrateRest()`, and assert where every row landed.
 *
 *     const db = await stageDatabase("1791600000_task_pr_follow_through");
 *     await db.sql`INSERT INTO workflows ...`;
 *     await db.migrateRest();
 *     expect(await db.sql`SELECT ... FROM work_definitions`).toEqual(...);
 *     await db.drop();
 *
 * Databases are named like the per-file ones (`optio_it_run_<pid>_<hex>`), so
 * a crashed run's leftovers are swept by the next globalSetup.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema.js";
import { migrateSafe } from "../../db/migrate-safe.js";
import { RUN_DB_PREFIX } from "./setup.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

export interface StagedDatabase {
  /** Raw client on the staged database, for seeding and assertions. */
  sql: postgres.Sql;
  /** Apply every migration after the staged one. */
  migrateRest(): Promise<void>;
  drop(): Promise<void>;
}

export async function stageDatabase(untilTag: string): Promise<StagedDatabase> {
  const adminUrl = process.env.OPTIO_TEST_PG_URL;
  if (!adminUrl) throw new Error("stageDatabase needs OPTIO_TEST_PG_URL (integration globalSetup)");

  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ tag: string }> };
  const until = journal.entries.findIndex((e) => e.tag === untilTag);
  if (until < 0) throw new Error(`No migration tagged ${untilTag}`);

  // A copy of the migrations folder whose journal stops at `untilTag`.
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), "optio-staged-"));
  fs.mkdirSync(path.join(partial, "meta"));
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (f.endsWith(".sql")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(partial, f));
  }
  fs.writeFileSync(
    path.join(partial, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, until + 1) }),
  );

  const name = `${RUN_DB_PREFIX}${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  await migrateSafe(db, partial);

  return {
    sql,
    async migrateRest() {
      await migrateSafe(db, MIGRATIONS);
    },
    async drop() {
      await sql.end({ timeout: 5 });
      fs.rmSync(partial, { recursive: true, force: true });
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
