/**
 * Integration test for seedBuiltInProviders() idempotency.
 *
 * Regression test: the seeder's upsert used to target the composite
 * (slug, workspace_id) unique constraint with a NULL workspace_id — NULLs
 * are distinct there, so the conflict never fired and every API restart
 * inserted a duplicate copy of each built-in provider.
 */
import { describe, expect, it } from "vitest";
import { isNull, eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { connectionProviders } from "../db/schema.js";
import { seedBuiltInProviders } from "./connection-service.js";

describe("seedBuiltInProviders", () => {
  it("is idempotent across repeated runs (no duplicate built-in providers)", async () => {
    await seedBuiltInProviders();
    const first = await db
      .select({ id: connectionProviders.id, slug: connectionProviders.slug })
      .from(connectionProviders)
      .where(isNull(connectionProviders.workspaceId));
    expect(first.length).toBeGreaterThan(0);

    await seedBuiltInProviders();
    await seedBuiltInProviders();
    const after = await db
      .select({ id: connectionProviders.id, slug: connectionProviders.slug })
      .from(connectionProviders)
      .where(isNull(connectionProviders.workspaceId));

    expect(after.length).toBe(first.length);
    const slugs = after.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // Rows are updated in place, not replaced
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(first.map((r) => r.id)));
  });

  it("updates existing built-in rows on re-seed instead of inserting", async () => {
    await seedBuiltInProviders();
    const [row] = await db
      .select()
      .from(connectionProviders)
      .where(and(isNull(connectionProviders.workspaceId), eq(connectionProviders.slug, "notion")));
    expect(row).toBeDefined();

    // Drift a field, then re-seed: the upsert should restore it on the SAME row
    await db
      .update(connectionProviders)
      .set({ name: "drifted-name" })
      .where(eq(connectionProviders.id, row.id));
    await seedBuiltInProviders();

    const [restored] = await db
      .select()
      .from(connectionProviders)
      .where(eq(connectionProviders.id, row.id));
    expect(restored.name).not.toBe("drifted-name");
  });
});
