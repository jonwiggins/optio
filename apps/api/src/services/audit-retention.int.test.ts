/**
 * The audit trail's retention (docs/audit.md) against real Postgres: the
 * app's setting over OPTIO_AUDIT_RETENTION_DAYS over 365 days, and the
 * daily prune — older entries go in batches, newer ones stay, and a finished
 * pass rests for a day unless the retention changes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditSettings, optioActions } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  PRUNE_BATCH,
  envRetentionDays,
  getAuditRetention,
  pruneAuditTrail,
  setAuditRetention,
} from "./audit-retention.js";
import { getRedisClient } from "./event-bus.js";

const DAY = 86_400_000;

beforeEach(async () => {
  await db.delete(auditSettings);
  await db.delete(optioActions);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await getRedisClient().quit();
});

async function entries(workspaceId: string, daysAgo: number, n = 1) {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  await db.execute(sql`
    INSERT INTO optio_actions (workspace_id, action, success, created_at)
    SELECT ${workspaceId}::uuid, ${`it.${daysAgo}`}, true, ${at}::timestamptz
    FROM generate_series(1, ${n})`);
}

const count = async () =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(optioActions))[0].n;

describe("retention", () => {
  it("is 365 days unless the environment or the app says otherwise", async () => {
    expect(await getAuditRetention()).toMatchObject({ days: 365, source: "default" });
    vi.stubEnv("OPTIO_AUDIT_RETENTION_DAYS", "730");
    expect(await getAuditRetention()).toMatchObject({
      days: 730,
      source: "environment",
      environmentDays: 730,
    });
    await setAuditRetention(90, null);
    expect(await getAuditRetention()).toMatchObject({
      days: 90,
      source: "app",
      environmentDays: 730,
    });
    await setAuditRetention(null, null);
    expect((await getAuditRetention()).source).toBe("environment");
  });

  it("ignores an environment value that isn't a whole number of days in range", () => {
    expect(envRetentionDays({ OPTIO_AUDIT_RETENTION_DAYS: "0" })).toBeNull();
    expect(envRetentionDays({ OPTIO_AUDIT_RETENTION_DAYS: "12.5" })).toBeNull();
    expect(envRetentionDays({ OPTIO_AUDIT_RETENTION_DAYS: "99999" })).toBeNull();
    expect(envRetentionDays({ OPTIO_AUDIT_RETENTION_DAYS: " 30 " })).toBe(30);
  });

  it("refuses a retention out of range", async () => {
    await expect(setAuditRetention(0, null)).rejects.toThrow(/between 1 and 36500 days/);
  });
});

describe("pruneAuditTrail", () => {
  it("deletes entries older than the retention and keeps the rest", async () => {
    const ws = await insertWorkspace();
    await entries(ws.id, 400, 3);
    await entries(ws.id, 300, 2);
    await entries(ws.id, 1, 1);
    expect(await pruneAuditTrail()).toBe(3);
    expect(await count()).toBe(3);
    const [row] = await db.select().from(auditSettings).where(eq(auditSettings.id, 1));
    expect(row.lastPrunedAt).not.toBeNull();
  });

  it("rests for a day after a finished pass, and runs again when the retention changes", async () => {
    const ws = await insertWorkspace();
    await entries(ws.id, 400, 1);
    expect(await pruneAuditTrail()).toBe(1);
    await entries(ws.id, 100, 2);
    expect(await pruneAuditTrail()).toBe(0);
    // Next day: still nothing past 365 days.
    expect(await pruneAuditTrail(new Date(Date.now() + DAY + 1000))).toBe(0);
    await setAuditRetention(30, null);
    expect(await pruneAuditTrail()).toBe(2);
    expect(await count()).toBe(0);
  });

  it("works through a long backlog in batches before it rests", async () => {
    const ws = await insertWorkspace();
    await entries(ws.id, 500, PRUNE_BATCH + 3);
    await entries(ws.id, 10, 1);
    expect(await pruneAuditTrail()).toBe(PRUNE_BATCH);
    const [mid] = await db.select().from(auditSettings);
    expect(mid?.lastPrunedAt ?? null).toBeNull();
    expect(await pruneAuditTrail()).toBe(3);
    expect(await pruneAuditTrail()).toBe(0);
    expect(await count()).toBe(1);
  });
});
