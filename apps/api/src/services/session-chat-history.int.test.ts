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
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { sessionRoutes } from "../routes/sessions.js";
import { insertSessionWithChatEvents } from "../test-utils/integration/fixtures.js";
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

describe("a long session's history", () => {
  const labels = (events: Array<{ content: string }>) => events.map((e) => e.content);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, k) => `event ${from + k}`);

  it("is the newest events, oldest first, not the oldest ones", async () => {
    const session = await insertSessionWithChatEvents(1200);

    // What the WebSocket replay loads (the default window).
    expect(labels(await listSessionChatEvents(session.id))).toEqual(range(201, 1200));
    expect(labels(await listSessionChatEvents(session.id, { limit: 3 }))).toEqual(
      range(1198, 1200),
    );

    // GET /api/sessions/:id/chat: the same window; the web asks for all 5000.
    const app = await buildRouteTestApp(sessionRoutes);
    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/chat` });
    expect(res.statusCode, res.body).toBe(200);
    expect(labels(res.json().events)).toEqual(range(201, 1200));
    const all = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/chat?limit=5000`,
    });
    expect(labels(all.json().events)).toEqual(range(1, 1200));
    await app.close();
  });
});
