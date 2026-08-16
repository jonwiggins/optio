/**
 * Exemplar integration test — proves the integration harness itself works:
 * a per-file database cloned from the migrated template, the real drizzle
 * client bound to it, migration idempotency, and Redis isolation.
 *
 * Use this file as the pattern for new *.int.test.ts files: import services
 * normally (the setup file has already pointed DATABASE_URL/REDIS_URL at
 * this file's private infra) and talk to the real database.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { tasks, workspaces } from "./schema.js";
import { migrateSafe } from "./migrate-safe.js";
import { testDatabaseUrl } from "../test-utils/integration/setup.js";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "migrations");

describe("integration harness", () => {
  it("binds the app db client to this file's private database", async () => {
    expect(process.env.DATABASE_URL).toBe(testDatabaseUrl);
    const rows = await db.execute<{ db: string }>(sql`SELECT current_database() AS db`);
    expect(rows[0].db).toMatch(/^optio_it_run_/);
  });

  it("cloned a fully-migrated schema from the template", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const names = rows.map((r) => r.table_name);
    for (const expected of [
      "tasks",
      "repos",
      "workspaces",
      "workflows",
      "workflow_runs",
      "workflow_triggers",
      "persistent_agents",
      "task_configs",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("re-running the migration runner is a no-op (hash idempotency)", async () => {
    const applied = await migrateSafe(db, MIGRATIONS_FOLDER);
    expect(applied).toBe(0);
  });

  it("supports real inserts with schema defaults and enums", async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: "it-ws", slug: `it-ws-${process.pid}` })
      .returning();

    const [task] = await db
      .insert(tasks)
      .values({
        title: "harness exemplar",
        prompt: "noop",
        repoUrl: "https://github.com/example/repo",
        agentType: "claude-code",
        workspaceId: ws.id,
      })
      .returning();

    expect(task.state).toBe("pending");
    expect(task.priority).toBe(100);
    expect(task.retryCount).toBe(0);

    await expect(
      db.insert(tasks).values({
        title: "bad state",
        prompt: "noop",
        repoUrl: "https://github.com/example/repo",
        agentType: "claude-code",
        state: "not-a-state" as never, // invalid enum value must be rejected by PG
      }),
    ).rejects.toThrow();
  });

  it("gets an isolated, flushed Redis logical database", async () => {
    const { Redis } = await import("ioredis");
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      // Leased DB is private to this file and flushed on lease; nothing in
      // this file has written to Redis yet, so it must be EMPTY — this fails
      // loudly if the lease allocator ever hands out a shared/dirty index.
      expect(await redis.keys("*")).toEqual([]);
      const marker = `it-marker-${process.pid}`;
      await redis.set(marker, "1");
      expect(await redis.get(marker)).toBe("1");
    } finally {
      await redis.quit();
    }
  });
});
