/**
 * Session chat history replays in the order it was written, even when events
 * share a timestamp. Events carry a millisecond clock and one agent output
 * chunk yields several (Session started, reply, cost) in the same
 * millisecond; ordering by timestamp alone left their order to wherever the
 * rows sit in the table, so a replay could read cost → reply → "Session
 * started". Real Postgres: tie order is storage-dependent.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { interactiveSessions, sessionChatEvents } from "../db/schema.js";
import { appendSessionChatEvent, listSessionChatEvents } from "./interactive-session-service.js";

describe("session chat history order", () => {
  it("replays same-millisecond events in the order they were written", async () => {
    const [session] = await db
      .insert(interactiveSessions)
      .values({ repoUrl: "https://github.com/it-org/order", branch: "session/it/order" })
      .returning();
    const at = new Date("2026-09-23T01:22:37.388Z");
    // ~1.9 KB of incompressible padding: four rows fill one 8 KB page.
    const pad = () => randomBytes(1400).toString("base64");
    const written = ["Session started", "Here is the change", "Ran the tests", "Cost $0.0123"];
    const ids: string[] = [];
    for (const label of written) {
      const row = await appendSessionChatEvent({
        sessionId: session.id,
        content: `${label}\n${pad()}`,
        logType: "text",
        timestamp: at,
      });
      ids.push(row.id);
    }

    // Move the first-written row to the end of the table: its page is full,
    // so the new version can't stay on it (a non-HOT update, like any row
    // rewritten after pruning or vacuuming reshuffles free space). Storage
    // order is now 2, 3, 4, 1 — with the same timestamp on all four.
    await db
      .update(sessionChatEvents)
      .set({ metadata: { edited: true } })
      .where(eq(sessionChatEvents.id, ids[0]));

    const replay = await listSessionChatEvents(session.id);
    expect(replay.map((e) => e.content.split("\n")[0])).toEqual(written);
  });
});
