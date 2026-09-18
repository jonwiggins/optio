/**
 * Integration tests for the iOS push surface against real Postgres:
 * device / Live Activity token upserts + idempotency, ownership scoping,
 * cascade on user delete, the 5-failure drop via the drizzle store, and the
 * terminal snooze that keeps a "Later"-ed terminal out of the Watch queue.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apnsDevices, liveActivityStartTokens, liveActivityTokens, users } from "../db/schema.js";
import { ApnsService, APNS_MAX_FAILURE_COUNT } from "./apns-service.js";
import {
  drizzleApnsStore,
  listDevicesForUser,
  registerDevice,
  registerLiveActivityStartToken,
  registerLiveActivityToken,
  unregisterDevice,
  unregisterLiveActivityToken,
} from "./apns-store.js";
import { FakeApnsTransport } from "./apns-transport.js";
import { buildWatchState } from "@optio/shared";
import * as relay from "./local-relay.js";
import { markHostOnline, registerHost } from "./local-host-service.js";
import {
  createTerminal,
  getTerminal,
  handleAttention,
  handleStarted,
  isTerminalSnoozed,
  snoozeTerminal,
  unsnoozeTerminal,
} from "./local-terminal-service.js";
import { computeWatchState, resetGlanceForTests } from "./glance-service.js";

const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

async function makeUser(name: string) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${name}-${Math.random()}`,
      email: `${name}@example.com`,
      displayName: name,
    })
    .returning();
  return u;
}

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  send() {}
  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  relay.resetRelayForTests();
  resetGlanceForTests();
});
afterEach(() => relay.resetRelayForTests());

describe("migration", () => {
  it("built the three APNs tables and the snooze column", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const names = rows.map((r) => r.table_name);
    for (const t of ["apns_devices", "live_activity_tokens", "live_activity_start_tokens"]) {
      expect(names).toContain(t);
    }
    const cols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'local_terminals' AND column_name = 'snoozed_until'
    `);
    expect(cols).toHaveLength(1);
  });
});

describe("device registration", () => {
  it("upserts by token, masks the token, and moves a token between users", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const token = hex("deadbeef");

    const first = await registerDevice(alice.id, {
      token,
      platform: "ios",
      environment: "sandbox",
      bundleId: "dev.optio.ios",
      appVersion: "1.0",
      deviceName: "iPhone",
    });
    expect(first.token).toBe("deadbe…0000");
    expect(first.token).not.toContain(token.slice(6, -4));

    await db.update(apnsDevices).set({ failureCount: 3 }).where(eq(apnsDevices.id, first.id));
    const again = await registerDevice(alice.id, {
      token,
      platform: "ios",
      environment: "production",
      bundleId: "dev.optio.ios",
      appVersion: "1.1",
    });
    expect(again.id).toBe(first.id);
    expect(again.environment).toBe("production");
    expect(again.appVersion).toBe("1.1");
    expect(again.deviceName).toBeNull();
    expect(again.failureCount).toBe(0);

    const moved = await registerDevice(bob.id, {
      token,
      platform: "ios",
      environment: "sandbox",
      bundleId: "dev.optio.ios",
    });
    expect(moved.id).toBe(first.id);
    expect(await listDevicesForUser(alice.id)).toHaveLength(0);
    expect((await listDevicesForUser(bob.id)).map((d) => d.id)).toEqual([first.id]);

    // Alice can't delete Bob's device; Bob can.
    expect(await unregisterDevice(alice.id, token)).toBe(false);
    expect(await unregisterDevice(bob.id, token)).toBe(true);
    expect(await listDevicesForUser(bob.id)).toHaveLength(0);
  });

  it("cascades on user delete", async () => {
    const u = await makeUser("cascade");
    await registerDevice(u.id, {
      token: hex("cafe"),
      platform: "ios",
      environment: "sandbox",
      bundleId: "dev.optio.ios",
    });
    await registerLiveActivityToken(u.id, {
      kind: "watch",
      token: hex("la"),
      environment: "sandbox",
    });
    await registerLiveActivityStartToken(u.id, {
      kind: "watch",
      token: hex("start"),
      environment: "sandbox",
    });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(apnsDevices).where(eq(apnsDevices.userId, u.id))).toHaveLength(0);
    expect(
      await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.userId, u.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(liveActivityStartTokens)
        .where(eq(liveActivityStartTokens.userId, u.id)),
    ).toHaveLength(0);
  });
});

describe("Live Activity tokens", () => {
  it("upserts update + start tokens idempotently and scopes deletes to the owner", async () => {
    const u = await makeUser("la");
    const other = await makeUser("other");
    const token = hex("1a1a");
    await registerLiveActivityToken(u.id, { kind: "watch", token, environment: "sandbox" });
    await registerLiveActivityToken(u.id, {
      kind: "watch",
      token,
      environment: "production",
      subjectId: "s1",
    });
    const rows = await drizzleApnsStore.listLiveActivityTokens(u.id, "watch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ environment: "production", subjectId: "s1", failureCount: 0 });

    await registerLiveActivityStartToken(u.id, {
      kind: "watch",
      token: hex("5a"),
      environment: "sandbox",
    });
    await registerLiveActivityStartToken(u.id, {
      kind: "watch",
      token: hex("5a"),
      environment: "sandbox",
    });
    expect(await drizzleApnsStore.listStartTokens(u.id, "watch")).toHaveLength(1);

    expect(await unregisterLiveActivityToken(other.id, "watch", token)).toBe(false);
    expect(await unregisterLiveActivityToken(u.id, "watch", token)).toBe(true);
    expect(await drizzleApnsStore.listLiveActivityTokens(u.id, "watch")).toHaveLength(0);
  });

  it("drizzle store: 5 consecutive failures drop the device, 410 drops it at once", async () => {
    const u = await makeUser("fail");
    await registerDevice(u.id, {
      token: hex("f1"),
      platform: "ios",
      environment: "sandbox",
      bundleId: "b",
    });
    await registerDevice(u.id, {
      token: hex("f2"),
      platform: "ios",
      environment: "sandbox",
      bundleId: "b",
    });
    const transport = new FakeApnsTransport();
    const service = new ApnsService({ transport, store: drizzleApnsStore, bundleId: "b" });
    transport.failToken(hex("f1"), { ok: false, status: 503, reason: "ServiceUnavailable" });
    transport.failToken(hex("f2"), { ok: false, status: 410, reason: "Unregistered" });

    const input = {
      title: "t",
      body: "b",
      category: "TEST" as const,
      threadId: "t",
      url: "optio://",
      kind: "test" as const,
      id: "t",
    };
    await service.sendAlert(u.id, input);
    let rows = await drizzleApnsStore.listDevices(u.id);
    expect(rows.map((r) => r.token)).toEqual([hex("f1")]);
    expect(rows[0].failureCount).toBe(1);

    for (let i = 1; i < APNS_MAX_FAILURE_COUNT; i++) await service.sendAlert(u.id, input);
    rows = await drizzleApnsStore.listDevices(u.id);
    expect(rows).toHaveLength(0);
  });
});

describe("terminal snooze → Watch queue", () => {
  it("a snoozed needs_you terminal leaves the queue until the window closes", async () => {
    const u = await makeUser("snooze");
    const host = await registerHost({
      userId: u.id,
      workspaceId: null,
      hostname: "it-snooze",
      platform: "darwin",
      dirs: [{ path: "/home/dev/optio" }],
    });
    relay.registerDaemon(host.id, u.id, new FakeDaemonSocket());
    await markHostOnline(host.id, {});
    const t = await createTerminal({
      host,
      userId: u.id,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "agent", agent: "claude-code", prompt: "fix" },
    });
    await handleStarted(host.id, t.id);
    await handleAttention(host.id, t.id, "needs_you", "stop");

    let state = await computeWatchState(u.id);
    expect(state.phase).toBe("waiting");
    expect(state.head?.id).toBe(t.id);

    const snoozed = await snoozeTerminal((await getTerminal(t.id))!, 15);
    expect(isTerminalSnoozed(snoozed)).toBe(true);
    expect(snoozed.snoozedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(snoozed.attentionState).toBe("needs_you"); // daemon still owns attention
    state = await computeWatchState(u.id);
    expect(state.phase).toBe("working");
    expect(state.needsYouCount).toBe(0);
    expect(state.runningCount).toBe(1);
    expect(state.head?.snoozedUntil).toBeTypeOf("number");

    const cleared = await unsnoozeTerminal(snoozed);
    expect(cleared.snoozedUntil).toBeNull();
    state = await computeWatchState(u.id);
    expect(state.phase).toBe("waiting");

    // An expired window counts as unsnoozed without an explicit clear.
    const expired = { ...cleared, snoozedUntil: new Date(Date.now() - 1000) };
    expect(isTerminalSnoozed(expired)).toBe(false);
    expect(buildWatchState({ needsYou: [], running: [] }).phase).toBe("done");
  });
});
