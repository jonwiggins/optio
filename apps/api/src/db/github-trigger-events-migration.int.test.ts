/**
 * Migration 1793230000_github_trigger_events_pinned against populated rows:
 * a GitHub trigger saved with no `events` meant "every kind" when there were
 * eleven; it must keep listening for those eleven, not the thirty-one.
 */
import { describe, expect, it } from "vitest";
import { stageDatabase } from "../test-utils/integration/staged-migration.js";

const BEFORE = "1793227512_local_terminal_resume_lineage";
const ORIGINAL_KINDS = [
  "review_requested",
  "mentioned",
  "assigned",
  "pr_opened",
  "issue_opened",
  "pr_merged",
  "labeled",
  "push",
  "release_published",
  "workflow_succeeded",
  "workflow_failed",
];

describe("1793230000_github_trigger_events_pinned", () => {
  it("pins GitHub triggers with no events to the original kinds and leaves every other row alone", async () => {
    const db = await stageDatabase(BEFORE);
    try {
      const { sql } = db;
      const [job] = await sql`
        INSERT INTO work_definitions (kind, name, prompt) VALUES ('standalone', 'Triage', 'go') RETURNING id`;
      const insert = (type: string, config: unknown) =>
        sql`INSERT INTO workflow_triggers (target_type, target_id, type, config)
            VALUES ('job', ${job.id}, ${type}, ${config === null ? null : JSON.stringify(config)}::jsonb)
            RETURNING id`;
      const [noEvents] = await insert("github", { login: "jon", repos: ["acme/app"] });
      const [emptyEvents] = await insert("github", { events: [], login: "jon" });
      const [nullConfig] = await insert("github", null);
      const [explicit] = await insert("github", { events: ["issue_opened"], labels: ["bug"] });
      const [gitlab] = await insert("gitlab", { username: "jon" });

      await db.migrateRest();

      const rows = Object.fromEntries(
        (await sql`SELECT id, config FROM workflow_triggers`).map((r) => [r.id, r.config]),
      );
      expect(rows[noEvents.id]).toEqual({
        login: "jon",
        repos: ["acme/app"],
        events: ORIGINAL_KINDS,
      });
      expect(rows[emptyEvents.id]).toEqual({ login: "jon", events: ORIGINAL_KINDS });
      expect(rows[nullConfig.id]).toEqual({ events: ORIGINAL_KINDS });
      expect(rows[explicit.id]).toEqual({ events: ["issue_opened"], labels: ["bug"] });
      expect(rows[gitlab.id]).toEqual({ username: "jon" });
    } finally {
      await db.drop();
    }
  });
});
