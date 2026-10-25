/**
 * The Optio assistant's model defaults, against the migrated schema: a fresh
 * install (no row) runs "opus" — the newest Opus — and so does the row that
 * saving some other setting creates, down to the column default.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { getSettings, upsertSettings } from "./optio-settings-service.js";

describe("optio settings model default", () => {
  it("is opus before anything is saved", async () => {
    expect((await getSettings(null)).model).toBe("opus");
  });

  it("stays opus when another setting creates the row", async () => {
    const saved = await upsertSettings({ defaultReviewAgentType: "claude-code" }, null);
    expect(saved.model).toBe("opus");
    expect((await getSettings(null)).model).toBe("opus");
  });

  it("is opus in the column default too", async () => {
    const rows = await db.execute<{ column_default: string | null }>(sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'optio_settings' AND column_name = 'model'
    `);
    expect(rows[0].column_default).toMatch(/^'opus'/);
  });

  it("keeps a pinned model id someone picks", async () => {
    await upsertSettings({ model: "claude-opus-5-5" }, null);
    expect((await getSettings(null)).model).toBe("claude-opus-5-5");
  });
});

describe("the workspace's code-review defaults", () => {
  const ws = "00000000-0000-4000-8000-00000000c0de";

  it("are after CI, thorough, no test command before anything is saved", async () => {
    const s = await getSettings(ws);
    expect(s).toMatchObject({
      reviewTrigger: "on_ci_pass",
      reviewDepth: "thorough",
      reviewTestCommand: null,
    });
  });

  it("are stored, read back, and cleared", async () => {
    await upsertSettings(
      { reviewTrigger: "on_pr", reviewDepth: "light", reviewTestCommand: "  make test  " },
      ws,
    );
    expect(await getSettings(ws)).toMatchObject({
      reviewTrigger: "on_pr",
      reviewDepth: "light",
      reviewTestCommand: "make test",
    });
    await upsertSettings({ reviewDepth: "thorough", reviewTestCommand: null }, ws);
    expect(await getSettings(ws)).toMatchObject({
      reviewTrigger: "on_pr",
      reviewDepth: "thorough",
      reviewTestCommand: null,
    });
  });

  it("have column defaults for rows saved before them", async () => {
    const rows = await db.execute<{ column_name: string; column_default: string | null }>(sql`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'optio_settings' AND column_name IN ('review_trigger', 'review_depth')
      ORDER BY column_name
    `);
    expect(rows.map((r) => [r.column_name, r.column_default?.split("::")[0]])).toEqual([
      ["review_depth", "'thorough'"],
      ["review_trigger", "'on_ci_pass'"],
    ]);
  });
});
