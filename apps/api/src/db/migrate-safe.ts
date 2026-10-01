/**
 * Safe migration runner that replaces Drizzle's built-in `migrate()`.
 *
 * Drizzle uses a watermark approach: it only applies migrations with a
 * `folderMillis` (from the journal `when` field) greater than the highest
 * `created_at` in `__drizzle_migrations`. This silently skips migrations
 * whose timestamps are lower than an already-applied migration — which
 * happens when switching from sequential prefixes (0001_, 0002_) to
 * unix-timestamp prefixes, because Drizzle assigned artificially high
 * `when` values to the old sequential entries.
 *
 * This module fixes two problems:
 *  1. **Out-of-order timestamps**: checks by hash, not watermark.
 *  2. **Multi-replica races**: uses a PostgreSQL advisory lock so only
 *     one pod runs migrations at a time.
 *
 * It also keeps the views over the runs table (`run-views.ts`) in step with
 * it: they are dropped before each migration and made again after, inside
 * the migration's transaction, so a migration can alter `tasks` freely and
 * the views always carry its columns.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HAS_RUN_KINDS, RUN_VIEWS_CURRENT, RUN_VIEWS_SQL } from "./run-views.js";

interface MigrationEntry {
  sql: string[];
  folderMillis: number;
  hash: string;
}

const ADVISORY_LOCK_ID = 8_675_309; // arbitrary, unique to optio migrations

/** Drop the run views if they are views (before the runs table, `workflow_runs` was a table). */
const DROP_RUN_VIEWS = sql.raw(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'workflow_runs') THEN
    DROP VIEW "workflow_runs";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'repo_tasks') THEN
    DROP VIEW "repo_tasks";
  END IF;
END $$`);

function readMigrations(migrationsFolder: string): MigrationEntry[] {
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  const migrations: MigrationEntry[] = [];

  for (const entry of journal.entries) {
    const filePath = `${migrationsFolder}/${entry.tag}.sql`;
    const query = fs.readFileSync(filePath, "utf-8");
    migrations.push({
      sql: query.split("--> statement-breakpoint"),
      folderMillis: entry.when,
      hash: crypto.createHash("sha256").update(query).digest("hex"),
    });
  }

  return migrations;
}

export async function migrateSafe(db: Database, migrationsFolder: string): Promise<number> {
  const migrations = readMigrations(migrationsFolder);

  // Ensure schema and table exist (same DDL as Drizzle)
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Advisory lock: blocks other pods until we release (session-level, auto-released on disconnect)
  await db.execute(sql`SELECT pg_advisory_lock(${sql.raw(String(ADVISORY_LOCK_ID))})`);

  let applied = 0;
  try {
    // Get ALL applied hashes — not just the last one
    const rows = await db.execute<{ hash: string }>(
      sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`,
    );
    const appliedHashes = new Set(rows.map((r) => r.hash));

    for (const migration of migrations) {
      if (appliedHashes.has(migration.hash)) continue;

      // Apply each missing migration in its own transaction
      await db.transaction(async (tx) => {
        await tx.execute(DROP_RUN_VIEWS);
        for (const stmt of migration.sql) {
          const trimmed = stmt.trim();
          if (trimmed) await tx.execute(sql.raw(trimmed));
        }
        const [{ has }] = await tx.execute<{ has: boolean }>(HAS_RUN_KINDS);
        if (has) {
          await tx.execute(DROP_RUN_VIEWS);
          for (const stmt of RUN_VIEWS_SQL) await tx.execute(sql.raw(stmt));
        }
        await tx.execute(
          sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`,
        );
      });

      applied++;
    }

    // The views' definition can change without a migration (run-views.ts).
    const [{ has }] = await db.execute<{ has: boolean }>(HAS_RUN_KINDS);
    const [{ current }] = has
      ? await db.execute<{ current: boolean }>(RUN_VIEWS_CURRENT)
      : [{ current: true }];
    if (!current) {
      await db.transaction(async (tx) => {
        await tx.execute(DROP_RUN_VIEWS);
        for (const stmt of RUN_VIEWS_SQL) await tx.execute(sql.raw(stmt));
      });
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${sql.raw(String(ADVISORY_LOCK_ID))})`);
  }

  return applied;
}
