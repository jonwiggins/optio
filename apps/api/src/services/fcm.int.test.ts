/**
 * Integration tests for Android push (FCM) against real Postgres: the
 * fcm_devices store (upsert / move / delete / cascade, the failure counter),
 * the per-user preference gate shared with APNs and web push, and the
 * glance fan-out driving BOTH providers from the same producer events.
 *
 * Both providers run on their fake transports (set before any import), so
 * the singletons the glance hooks use record instead of sending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPTIO_APNS_TRANSPORT = "fake";
  process.env.OPTIO_FCM_TRANSPORT = "fake";
});

import { eq, sql } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { fcmDevices, users } from "../db/schema.js";
import { apnsService } from "./apns-service.js";
import { registerDevice, registerLiveActivityToken } from "./apns-store.js";
import type { FakeApnsTransport } from "./apns-transport.js";
import { FcmService, fcmService, FCM_MAX_FAILURE_COUNT } from "./fcm-service.js";
import {
  drizzleFcmStore,
  listFcmDevicesForUser,
  registerFcmDevice,
  unregisterFcmDevice,
  unregisterFcmDeviceById,
} from "./fcm-store.js";
import { FakeFcmTransport } from "./fcm-transport.js";
import { onTaskTransition, resetGlanceForTests } from "./glance-service.js";
import { updatePreferences } from "./notification-service.js";
import * as relay from "./local-relay.js";
import { markHostOnline, registerHost } from "./local-host-service.js";
import { createTerminal, handleAttention, handleStarted } from "./local-terminal-service.js";

const fcmFake = (fcmService as unknown as { transport: FakeFcmTransport }).transport;
const apnsFake = (apnsService as unknown as { transport: FakeApnsTransport }).transport;

/** A realistic FCM registration token (instance id : APA91b…), unique per seed. */
const fcmToken = (seed: string) => `${seed}Xz9Qm1aT0uYp3Lr8Vw2K:APA91bH-Ek_7vQpZ${"q".repeat(120)}`;
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

beforeEach(async () => {
  relay.resetRelayForTests();
  resetGlanceForTests();
  apnsService.reset();
  fcmService.reset();
  fcmFake.sent.length = 0;
  apnsFake.sent.length = 0;
});
afterEach(() => relay.resetRelayForTests());

describe("migration", () => {
  it("built fcm_devices with a unique token and a user cascade", async () => {
    const cols = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'fcm_devices'
    `);
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      [
        "app_id",
        "app_version",
        "client_server_id",
        "created_at",
        "device_name",
        "failure_count",
        "id",
        "last_seen_at",
        "token",
        "user_id",
        "workspace_id",
      ].sort(),
    );
    const idx = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'fcm_devices'
    `);
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(["fcm_devices_token_key", "fcm_devices_user_id_idx"]),
    );
  });
});

describe("device registration", () => {
  it("upserts by token (case kept), resets failures, masks, and moves a token between users", async () => {
    const alice = await makeUser("alice");
    const bob = await makeUser("bob");
    const token = fcmToken("A");

    const first = await registerFcmDevice(alice.id, {
      token,
      appId: "dev.optio.android",
      appVersion: "0.1.0",
      deviceName: "Pixel 9",
      serverId: "srv-a",
    });
    expect(first).toMatchObject({
      platform: "android",
      appId: "dev.optio.android",
      serverId: "srv-a",
      failureCount: 0,
    });
    expect(first.token).toBe(`${token.slice(0, 6)}…${token.slice(-4)}`);

    await db.update(fcmDevices).set({ failureCount: 3 }).where(eq(fcmDevices.id, first.id));
    const again = await registerFcmDevice(alice.id, {
      token,
      appId: "dev.optio.android",
      appVersion: "0.2.0",
    });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ appVersion: "0.2.0", deviceName: null, failureCount: 0 });
    const [stored] = await db.select().from(fcmDevices).where(eq(fcmDevices.id, first.id));
    expect(stored.token).toBe(token); // FCM tokens are case-sensitive: never lower-cased

    // A token differing only in case is a different device.
    const other = await registerFcmDevice(alice.id, {
      token: token.toLowerCase(),
      appId: "dev.optio.android",
    });
    expect(other.id).not.toBe(first.id);

    const moved = await registerFcmDevice(bob.id, { token, appId: "dev.optio.android" });
    expect(moved.id).toBe(first.id);
    expect((await listFcmDevicesForUser(alice.id)).map((d) => d.id)).toEqual([other.id]);
    expect((await listFcmDevicesForUser(bob.id)).map((d) => d.id)).toEqual([first.id]);

    // Deletes are scoped to the owner, by token or by row id.
    expect(await unregisterFcmDevice(alice.id, token)).toBe(false);
    expect(await unregisterFcmDeviceById(alice.id, first.id)).toBe(false);
    expect(await unregisterFcmDevice(bob.id, token)).toBe(true);
    expect(await unregisterFcmDeviceById(alice.id, other.id)).toBe(true);
    expect(await listFcmDevicesForUser(alice.id)).toHaveLength(0);
    expect(await listFcmDevicesForUser(bob.id)).toHaveLength(0);
  });

  it("cascades on user delete", async () => {
    const u = await makeUser("cascade");
    await registerFcmDevice(u.id, { token: fcmToken("C"), appId: "dev.optio.android" });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(fcmDevices).where(eq(fcmDevices.userId, u.id))).toHaveLength(0);
  });
});

describe("drizzle store failure accounting", () => {
  it("drops UNREGISTERED at once and a flaky device after 5 consecutive failures", async () => {
    const u = await makeUser("fail");
    await registerFcmDevice(u.id, { token: fcmToken("F1"), appId: "dev.optio.android" });
    await registerFcmDevice(u.id, { token: fcmToken("F2"), appId: "dev.optio.android" });
    const transport = new FakeFcmTransport();
    const service = new FcmService({ transport, store: drizzleFcmStore });
    transport.failToken(fcmToken("F1"), { ok: false, status: 503, reason: "UNAVAILABLE" });
    transport.failToken(fcmToken("F2"), { ok: false, status: 404, reason: "UNREGISTERED" });

    const input = {
      title: "t",
      body: "b",
      category: "TEST" as const,
      threadId: "test",
      url: "optio://settings",
      kind: "test" as const,
      id: "test",
    };
    await service.sendAlert(u.id, input);
    let rows = await drizzleFcmStore.listDevices(u.id);
    expect(rows.map((r) => r.token)).toEqual([fcmToken("F1")]);
    expect(rows[0].failureCount).toBe(1);

    for (let i = 1; i < FCM_MAX_FAILURE_COUNT; i++) await service.sendAlert(u.id, input);
    rows = await drizzleFcmStore.listDevices(u.id);
    expect(rows).toHaveLength(0);
    await service.close();
  });
});

describe("fan-out through both providers", () => {
  it("sends one preference-gated alert to the user's iPhone and Android phone", async () => {
    const u = await makeUser("both");
    await registerDevice(u.id, {
      token: hex("a11ce"),
      platform: "ios",
      environment: "sandbox",
      bundleId: "dev.optio.ios",
    });
    await registerFcmDevice(u.id, {
      token: fcmToken("B"),
      appId: "dev.optio.android",
      serverId: "srv-1",
    });
    const task = {
      id: "7d3c5f1e-2b4a-4c6d-8e9f-0a1b2c3d4e5f",
      title: "Fix login",
      repoUrl: "https://github.com/acme/web",
      errorMessage: "Merge conflict",
      createdBy: u.id,
    };

    await onTaskTransition(task, TaskState.FAILED);
    expect(apnsFake.ofType("alert")).toHaveLength(1);
    expect(fcmFake.ofType("alert")).toHaveLength(1);
    const ios = apnsFake.ofType("alert")[0];
    const android = fcmFake.ofType("alert")[0];
    expect(android.token).toBe(fcmToken("B"));
    expect(android.android.priority).toBe("HIGH");
    expect(android.data).toMatchObject({
      type: "alert",
      category: "TASK_ATTENTION",
      title: "Task failed",
      body: "Fix login — Merge conflict",
      url: `optio://tasks/${task.id}`,
      kind: "task",
      id: task.id,
      threadId: `task-${task.id}`,
      timeSensitive: "1",
      serverId: "srv-1",
    });
    expect(android.data.url).toBe(ios.payload.url);
    expect(android.data.category).toBe((ios.payload.aps as { category: string }).category);

    // One opt-out silences both platforms.
    await updatePreferences(u.id, { "task.failed": { push: false } });
    await onTaskTransition(task, TaskState.FAILED);
    expect(apnsFake.ofType("alert")).toHaveLength(1);
    expect(fcmFake.ofType("alert")).toHaveLength(1);

    // Other event types still ring.
    await onTaskTransition(task, TaskState.NEEDS_ATTENTION);
    expect(apnsFake.ofType("alert")).toHaveLength(2);
    expect(fcmFake.ofType("alert")).toHaveLength(2);
    expect(fcmFake.ofType("alert")[1].data.title).toBe("Task needs you");
  });

  it("drives the Watch on Android and iOS from real terminal events", async () => {
    const u = await makeUser("watch");
    await registerFcmDevice(u.id, { token: fcmToken("W"), appId: "dev.optio.android" });
    await registerLiveActivityToken(u.id, {
      kind: "watch",
      token: hex("1a"),
      environment: "sandbox",
    });
    const host = await registerHost({
      userId: u.id,
      workspaceId: null,
      hostname: "it-watch",
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

    // The terminal starts running → the Android Watch starts, the iOS activity updates.
    await handleStarted(host.id, t.id);
    await vi.waitFor(() => expect(fcmFake.ofType("watch").length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    const start = fcmFake.ofType("watch")[0];
    expect(start.data.event).toBe("start");
    expect(start.android).toMatchObject({ collapse_key: "watch", priority: "NORMAL" });
    expect(JSON.parse(start.data.state)).toMatchObject({ phase: "working", runningCount: 1 });
    await vi.waitFor(() => expect(apnsFake.ofType("liveactivity").length).toBeGreaterThan(0));

    // It needs you → an alert on Android plus an alerting (HIGH) Watch update.
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s coalescing window
    await handleAttention(host.id, t.id, "needs_you", "notification");
    await vi.waitFor(() => expect(fcmFake.ofType("alert")).toHaveLength(1), { timeout: 5000 });
    expect(fcmFake.ofType("alert")[0].data).toMatchObject({
      category: "LOCAL_NEEDS_YOU",
      url: `optio://local/${t.id}?compose=1`,
      sound: "default",
      timeSensitive: "1",
    });
    await vi.waitFor(() => expect(fcmFake.ofType("watch")).toHaveLength(2), { timeout: 5000 });
    const update = fcmFake.ofType("watch")[1];
    expect(update.data.event).toBe("update");
    expect(update.android.priority).toBe("HIGH");
    expect(JSON.parse(update.data.state)).toMatchObject({
      phase: "waiting",
      needsYouCount: 1,
      head: { id: t.id, state: "needs_you", reason: "Waiting on a permission" },
    });
  });
});
