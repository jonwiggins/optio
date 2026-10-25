/**
 * 1792834100_ticket_round_trip_providers.sql on a database that already has
 * providers: the round trip stays on where it already had settings or
 * writebacks, and is off everywhere else. Running it again changes nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { ticketProviders, ticketWritebacks } from "../schema.js";
import { getRedisClient } from "../../services/event-bus.js";

const MIGRATION = readFileSync(
  join(import.meta.dirname, "1792834100_ticket_round_trip_providers.sql"),
  "utf-8",
);

async function insert(source: string, config: Record<string, unknown>) {
  const [row] = await db.insert(ticketProviders).values({ source, config }).returning();
  return row.id;
}

const configOf = async (id: string) =>
  (await db.select().from(ticketProviders).where(eq(ticketProviders.id, id)))[0].config;

afterAll(async () => {
  await getRedisClient().quit();
});

describe("the round trip's upgrade migration", () => {
  it("keeps it on where it ran, leaves it off elsewhere, and is idempotent", async () => {
    const settings = await insert("jira", {
      baseUrl: "https://jira.example.com",
      roundTrip: { comments: false, followUps: "mention" },
    });
    const marked = await insert("jira", { roundTrip: { since: "2026-10-01T00:00:00.000Z" } });
    const wrote = await insert("jira", { baseUrl: "https://jira.example.com" });
    await db.insert(ticketWritebacks).values({
      dedupeKey: `upgrade-test:${wrote}`,
      providerId: wrote,
      ticketSource: "jira",
      ticketExternalId: "PLAT-1",
      event: "skipped",
      status: "skipped",
    });
    const untouched = await insert("github", { owner: "acme", repo: "app" });
    const off = await insert("linear", { roundTrip: { enabled: false, comments: true } });

    await db.execute(sql.raw(MIGRATION));
    await db.execute(sql.raw(MIGRATION));

    expect(await configOf(settings)).toEqual({
      baseUrl: "https://jira.example.com",
      roundTrip: { comments: false, followUps: "mention", enabled: true },
    });
    expect(await configOf(marked)).toEqual({
      roundTrip: { since: "2026-10-01T00:00:00.000Z", enabled: true },
    });
    expect(await configOf(wrote)).toEqual({
      baseUrl: "https://jira.example.com",
      roundTrip: { enabled: true },
    });
    expect(await configOf(untouched)).toEqual({ owner: "acme", repo: "app" });
    expect(await configOf(off)).toEqual({ roundTrip: { enabled: false, comments: true } });
  });
});
