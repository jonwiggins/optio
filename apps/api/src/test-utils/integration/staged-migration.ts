/**
 * Migration tests on populated data. `stageDatabase(tag)` creates an empty
 * database migrated up to and including `tag` — the schema as a deployment
 * on that release has it — so a test can seed rows in the old shape with raw
 * SQL, call `migrateRest()`, and assert where every row landed.
 *
 *     const db = await stageDatabase("1791800000_task_prs");
 *     await db.sql`INSERT INTO tasks ...`;
 *     await db.migrateRest();
 *     expect(await db.sql`SELECT work_id FROM tasks`).toEqual(...);
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
  /** Apply the migrations after the staged one: all of them, or up to and including `untilTag`. */
  migrateRest(untilTag?: string): Promise<void>;
  /** Apply every migration, then `extra` ones as if a later release had added them. */
  migrateWith(extra: Array<{ tag: string; sql: string }>): Promise<void>;
  drop(): Promise<void>;
}

export async function stageDatabase(untilTag: string): Promise<StagedDatabase> {
  const adminUrl = process.env.OPTIO_TEST_PG_URL;
  if (!adminUrl) throw new Error("stageDatabase needs OPTIO_TEST_PG_URL (integration globalSetup)");

  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ tag: string }> };

  // Copies of the migrations folder whose journal stops at a tag, or runs on
  // past the last one with extra migrations.
  const partials: string[] = [];
  const copyWith = (
    entries: Array<{ tag: string }>,
    extra: Array<{ tag: string; sql: string }> = [],
  ): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optio-staged-"));
    partials.push(dir);
    fs.mkdirSync(path.join(dir, "meta"));
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (f.endsWith(".sql")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    }
    for (const m of extra) fs.writeFileSync(path.join(dir, `${m.tag}.sql`), m.sql);
    const extraEntries = extra.map((m, i) => ({
      idx: entries.length + i,
      version: "7",
      when: Date.now() + i,
      tag: m.tag,
      breakpoints: true,
    }));
    fs.writeFileSync(
      path.join(dir, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: [...entries, ...extraEntries] }),
    );
    return dir;
  };
  const partialUntil = (tag: string): string => {
    const at = journal.entries.findIndex((e) => e.tag === tag);
    if (at < 0) throw new Error(`No migration tagged ${tag}`);
    return copyWith(journal.entries.slice(0, at + 1));
  };
  const partial = partialUntil(untilTag);

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
    async migrateRest(tag?: string) {
      await migrateSafe(db, tag ? partialUntil(tag) : MIGRATIONS);
    },
    async migrateWith(extra) {
      await migrateSafe(db, copyWith(journal.entries, extra));
    },
    async drop() {
      await sql.end({ timeout: 5 });
      for (const dir of partials) fs.rmSync(dir, { recursive: true, force: true });
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
