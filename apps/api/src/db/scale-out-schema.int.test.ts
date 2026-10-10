/**
 * The scale-out migration (1792010000_scale_out) against the real, migrated
 * database: every column and table the plan's phases build on is there, the
 * run views carry the new run columns, and the constraints behave.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
} from "../test-utils/integration/fixtures.js";

async function columns(table: string): Promise<Set<string>> {
  const rows = await db.execute<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}`);
  return new Set(rows.map((r) => r.column_name));
}

const ATTACH_COLUMNS = [
  "exec_state",
  "exec_pid",
  "consumed_bytes",
  "attached_by",
  "attach_lease_until",
];

describe("scale-out schema", () => {
  it("every run table and view has the attachment columns", async () => {
    for (const table of [
      "tasks",
      "repo_tasks",
      "workflow_runs",
      "pr_review_runs",
      "persistent_agent_turns",
    ]) {
      const cols = await columns(table);
      for (const c of ATTACH_COLUMNS) expect(cols.has(c), `${table}.${c}`).toBe(true);
    }
  });

  it("the new tables exist with their keys", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      "leases",
      "ws_upgrade_tokens",
      "inbound_webhook_deliveries",
      "glance_state",
      "installed_skill_files",
      "ticket_sync_claims",
    ]) {
      expect(names.has(t), t).toBe(true);
    }
    // The outbound webhook log is untouched.
    expect((await columns("webhook_deliveries")).has("webhook_id")).toBe(true);
    const idx = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    const indexes = new Set(idx.map((r) => r.indexname));
    for (const i of [
      "pr_reviews_active_pr_url_key",
      "tasks_attach_lease_idx",
      "ws_upgrade_tokens_expires_idx",
      "inbound_webhook_deliveries_received_idx",
      "glance_state_due_idx",
    ]) {
      expect(indexes.has(i), i).toBe(true);
    }
  });

  it("consumed_bytes defaults to 0 and the columns round-trip through the views", async () => {
    const task = await insertTask();
    expect(task.consumedBytes).toBe(0);
    expect(task.execState).toBeNull();
    await db.execute(sql`
      UPDATE "repo_tasks" SET "exec_state" = 'started', "exec_pid" = 42, "consumed_bytes" = 1234,
        "attached_by" = 'api-0:abc', "attach_lease_until" = now() + interval '1 minute'
      WHERE "id" = ${task.id}`);
    const [row] = await db.execute<{
      exec_state: string;
      consumed_bytes: string;
      attached_by: string;
    }>(sql`
      SELECT "exec_state", "consumed_bytes", "attached_by" FROM "tasks" WHERE "id" = ${task.id}`);
    expect(row).toMatchObject({
      exec_state: "started",
      consumed_bytes: "1234",
      attached_by: "api-0:abc",
    });

    const wf = await insertWorkflow();
    const run = await insertWorkflowRun(wf.id);
    await db.execute(sql`
      UPDATE "workflow_runs" SET "exec_state" = 'started', "consumed_bytes" = 7 WHERE "id" = ${run.id}`);
    const [viewRow] = await db.execute<{ exec_state: string; consumed_bytes: string }>(sql`
      SELECT "exec_state", "consumed_bytes" FROM "workflow_runs" WHERE "id" = ${run.id}`);
    expect(viewRow).toMatchObject({ exec_state: "started", consumed_bytes: "7" });
  });

  it("only one active PR review per PR URL; finished ones may repeat", async () => {
    const insert = (state: string) =>
      db.execute(sql`
        INSERT INTO "pr_reviews" ("pr_url", "pr_number", "repo_owner", "repo_name", "repo_url", "head_sha", "state")
        VALUES ('https://github.com/o/r/pull/7', 7, 'o', 'r', 'https://github.com/o/r', 'abc', ${state}::pr_review_state)`);
    await insert("submitted");
    await insert("cancelled");
    await insert("reviewing");
    const violates = (err: unknown) => {
      const cause = (err as { cause?: { message?: string } }).cause;
      return /pr_reviews_active_pr_url_key/.test(cause?.message ?? (err as Error).message);
    };
    await expect(insert("queued")).rejects.toSatisfy(violates);
    await expect(insert("ready")).rejects.toSatisfy(violates);
  });

  it("a ticket sync claim is taken once; the second insert returns no row", async () => {
    const claim = () =>
      db.execute<{ repo_url: string }>(sql`
        INSERT INTO "ticket_sync_claims" ("ticket_source", "ticket_external_id", "repo_url")
        VALUES ('github', '12', 'https://github.com/o/r')
        ON CONFLICT DO NOTHING RETURNING "repo_url"`);
    expect((await claim()).length).toBe(1);
    expect((await claim()).length).toBe(0);
  });

  it("inbound webhook deliveries dedupe by (source, delivery id)", async () => {
    const claim = () =>
      db.execute<{ source: string }>(sql`
        INSERT INTO "inbound_webhook_deliveries" ("source", "delivery_id") VALUES ('slack', 'Ev123')
        ON CONFLICT DO NOTHING RETURNING "source"`);
    expect((await claim()).length).toBe(1);
    expect((await claim()).length).toBe(0);
    const other = await db.execute<{ source: string }>(sql`
      INSERT INTO "inbound_webhook_deliveries" ("source", "delivery_id") VALUES ('linear', 'Ev123')
      ON CONFLICT DO NOTHING RETURNING "source"`);
    expect(other.length).toBe(1);
  });

  it("glance state upserts by key and keeps a due time", async () => {
    await db.execute(sql`
      INSERT INTO "glance_state" ("key", "value", "due_at") VALUES ('watch-end:u1', '{"providers":["apns"]}', now() + interval '2 minutes')
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "due_at" = EXCLUDED."due_at"`);
    await db.execute(sql`
      INSERT INTO "glance_state" ("key", "value", "due_at") VALUES ('watch-end:u1', '{"providers":["fcm"]}', NULL)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "due_at" = EXCLUDED."due_at"`);
    const [row] = await db.execute<{ value: { providers: string[] }; due_at: string | null }>(sql`
      SELECT "value", "due_at" FROM "glance_state" WHERE "key" = 'watch-end:u1'`);
    expect(row.value.providers).toEqual(["fcm"]);
    expect(row.due_at).toBeNull();
  });

  it("installed skill files cascade with their skill", async () => {
    const [skill] = await db.execute<{ id: string }>(sql`
      INSERT INTO "installed_skills" ("name", "source_url") VALUES ('it-skill', 'https://github.com/o/skills.git') RETURNING "id"`);
    await db.execute(sql`
      INSERT INTO "installed_skill_files" ("skill_id", "path", "content", "executable")
      VALUES (${skill.id}, 'SKILL.md', ${Buffer.from("# hi")}, false)`);
    await db.execute(sql`DELETE FROM "installed_skills" WHERE "id" = ${skill.id}`);
    const left = await db.execute(
      sql`SELECT 1 FROM "installed_skill_files" WHERE "skill_id" = ${skill.id}`,
    );
    expect(left.length).toBe(0);
  });
});
