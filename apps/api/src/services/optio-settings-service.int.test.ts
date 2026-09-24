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
