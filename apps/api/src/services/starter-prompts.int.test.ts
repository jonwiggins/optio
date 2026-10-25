/**
 * The starter prompts against the migrated schema: the seed is idempotent
 * under the (scope, name) unique index, even when two replicas seed at once.
 */
import { describe, expect, it, vi } from "vitest";
import { and, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { promptTemplates } from "../db/schema.js";
import { STARTER_PROMPTS, seedStarterPrompts } from "./starter-prompts.js";

// The deployment asks for the starters at boot (off by default).
vi.hoisted(() => {
  process.env.OPTIO_STARTER_PROMPTS = "true";
});

const names = STARTER_PROMPTS.map((p) => p.name);

async function starterRows() {
  return db
    .select()
    .from(promptTemplates)
    .where(and(isNull(promptTemplates.workspaceId), inArray(promptTemplates.name, names)));
}

describe("starter prompts seed by default", () => {
  it("adds none at boot until the deployment asks for them", async () => {
    await db
      .delete(promptTemplates)
      .where(and(isNull(promptTemplates.workspaceId), inArray(promptTemplates.name, names)));
    vi.stubEnv("OPTIO_STARTER_PROMPTS", "");
    try {
      expect((await seedStarterPrompts()).created).toBe(0);
      expect(await starterRows()).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("starter prompts seed", () => {
  it("adds each starter once, whoever seeds and however often", async () => {
    await db
      .delete(promptTemplates)
      .where(and(isNull(promptTemplates.workspaceId), inArray(promptTemplates.name, names)));

    // Two replicas booting together, then a restore.
    await Promise.all([seedStarterPrompts(), seedStarterPrompts()]);
    await seedStarterPrompts({ restore: true });

    const rows = await starterRows();
    expect(rows).toHaveLength(STARTER_PROMPTS.length);
    expect(new Set(rows.map((r) => r.name)).size).toBe(STARTER_PROMPTS.length);
    for (const r of rows) {
      expect(r.ownerUserId).toBeNull();
      expect(r.paramsSchema).toMatchObject({ starter: true, type: "object" });
    }
  });

  it("a second boot adds nothing, and a starter an admin deleted stays deleted", async () => {
    await db
      .delete(promptTemplates)
      .where(and(isNull(promptTemplates.workspaceId), inArray(promptTemplates.name, names)));
    const first = await seedStarterPrompts();
    expect(first.created).toBe(STARTER_PROMPTS.length);
    const second = await seedStarterPrompts();
    expect(second).toEqual({ created: 0, restored: 0, unchanged: STARTER_PROMPTS.length });

    await db
      .delete(promptTemplates)
      .where(and(isNull(promptTemplates.workspaceId), inArray(promptTemplates.name, [names[0]])));
    expect((await seedStarterPrompts()).created).toBe(0);
    expect(await starterRows()).toHaveLength(STARTER_PROMPTS.length - 1);
    // "Restore starter prompts" brings it back.
    expect((await seedStarterPrompts({ restore: true })).created).toBe(1);
    expect(await starterRows()).toHaveLength(STARTER_PROMPTS.length);
  });
});
