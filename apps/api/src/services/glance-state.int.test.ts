/**
 * The glance bookkeeping in Postgres (glance-state-service.ts) and the
 * timers it holds: a due timer is claimed exactly once however many
 * sweeps race, and a timer set through the hooks on one "instance" is
 * fired by a sweep holding the lease as another instance — the end-of-Watch
 * frame reaches both providers' fake transports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPTIO_APNS_TRANSPORT = "fake";
  process.env.OPTIO_FCM_TRANSPORT = "fake";
});

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, localHosts, localTerminals } from "../db/schema.js";
import { apnsService } from "./apns-service.js";
import { registerLiveActivityToken } from "./apns-store.js";
import type { FakeApnsTransport } from "./apns-transport.js";
import { fcmService } from "./fcm-service.js";
import { registerFcmDevice } from "./fcm-store.js";
import type { FakeFcmTransport } from "./fcm-transport.js";
import {
  deleteGlance,
  getGlance,
  joinGlanceTimer,
  listGlance,
  setGlance,
  takeDueGlance,
} from "./glance-state-service.js";
import {
  WATCH_END_GRACE_MS,
  onLocalHostChanged,
  onLocalTerminalChanged,
  resetGlanceForTests,
  scheduleSnoozeExpiry,
  sweepGlanceDue,
} from "./glance-service.js";
import { GLANCE_SWEEP_LEASE } from "../workers/glance-sweep-worker.js";
import { leaseHolder, withLease } from "./lease-service.js";
import * as relay from "./local-relay.js";
import { markHostOnline, registerHost } from "./local-host-service.js";
import {
  createTerminal,
  getTerminal,
  handleExit,
  handleStarted,
  snoozeTerminal,
  unsnoozeTerminal,
} from "./local-terminal-service.js";

const fcmFake = (fcmService as unknown as { transport: FakeFcmTransport }).transport;
const apnsFake = (apnsService as unknown as { transport: FakeApnsTransport }).transport;
const fcmToken = (seed: string) => `${seed}Xz9Qm1aT0uYp3Lr8Vw2K:APA91bH-Ek_7vQpZ${"q".repeat(120)}`;
const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  send() {}
  close() {
    this.readyState = 3;
  }
}

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

beforeEach(async () => {
  relay.resetRelayForTests();
  await resetGlanceForTests();
  apnsService.reset();
  fcmService.reset();
  fcmFake.sent.length = 0;
  apnsFake.sent.length = 0;
  await db.execute(sql`DELETE FROM "leases"`);
});
afterEach(() => relay.resetRelayForTests());

describe("glance_state rows", () => {
  it("sets, reads, keeps or clears a due time, and deletes", async () => {
    await setGlance("attention:t1", { state: "working" });
    expect((await getGlance("attention:t1"))?.value).toEqual({ state: "working" });
    const due = new Date(Date.now() + 60_000);
    await setGlance("snooze:t1", { userId: "u" }, due);
    await setGlance("snooze:t1", { userId: "v" });
    const kept = await getGlance("snooze:t1");
    expect(kept?.value).toEqual({ userId: "v" });
    expect(kept?.dueAt?.getTime()).toBe(due.getTime());
    await setGlance("snooze:t1", { userId: "v" }, null);
    expect((await getGlance("snooze:t1"))?.dueAt).toBeNull();
    expect(await deleteGlance("snooze:t1")).toBe(true);
    expect(await deleteGlance("snooze:t1")).toBe(false);
    expect(await getGlance("snooze:t1")).toBeNull();
  });

  it("a timer joined twice unions its providers and keeps the first due time", async () => {
    const first = new Date(Date.now() + 1000);
    await joinGlanceTimer("watch-end:u", ["fcm"], first);
    await joinGlanceTimer("watch-end:u", ["apns", "fcm"], new Date(Date.now() + 90_000));
    const row = await getGlance<{ providers: string[] }>("watch-end:u");
    expect([...row!.value.providers].sort()).toEqual(["apns", "fcm"]);
    expect(row!.dueAt?.getTime()).toBe(first.getTime());
  });

  it("due timers are claimed exactly once across concurrent sweeps", async () => {
    const past = new Date(Date.now() - 1000);
    for (let i = 0; i < 20; i++) await setGlance(`snooze:t${i}`, { userId: "u" }, past);
    await setGlance("snooze:later", { userId: "u" }, new Date(Date.now() + 60_000));
    await setGlance("attention:t", { state: "idle" });
    const takes = await Promise.all([takeDueGlance(), takeDueGlance(), takeDueGlance()]);
    const keys = takes.flat().map((r) => r.key);
    expect(keys).toHaveLength(20);
    expect(new Set(keys).size).toBe(20);
    const left = (await listGlance()).map((r) => r.key).sort();
    expect(left).toEqual(["attention:t", "snooze:later"]);
  });
});

describe("timers across instances", () => {
  it("an older quiet hook cannot overwrite a newer running hook", async () => {
    const u = await makeUser("ordered-watch");
    await registerLiveActivityToken(u.id, {
      kind: "watch",
      token: hex("2c"),
      environment: "sandbox",
    });
    // Seed directly to control the two hooks' interleaving without unrelated
    // fire-and-forget producer hooks.
    const [host] = await db
      .insert(localHosts)
      .values({
        userId: u.id,
        name: "ordered",
        hostname: "ordered",
        platform: "darwin",
      })
      .returning();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const quietComputed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hasWatch = apnsService.hasWatchToken.bind(apnsService);
    const spy = vi.spyOn(apnsService, "hasWatchToken").mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return hasWatch(...args);
    });
    const quiet = onLocalHostChanged({ ...host, state: "online" });
    let running: Promise<void> | undefined;
    try {
      await quietComputed;
      const [terminal] = await db
        .insert(localTerminals)
        .values({
          hostId: host.id,
          userId: u.id,
          title: "running",
          dir: "/tmp/ordered",
          spec: { kind: "agent", agent: "claude-code", prompt: "fix" },
          state: "running",
          attentionState: "working",
        })
        .returning();
      running = onLocalTerminalChanged(terminal);
      // Before the fix the newer hook finishes first; after it, the newer
      // hook waits for the older computation to release the user's lease.
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 1000))]);
    } finally {
      release();
      await Promise.all([quiet, running]);
      spy.mockRestore();
    }
    expect((await getGlance<{ count: number }>(`running:${u.id}`))?.value.count).toBe(1);
    expect(await getGlance(`watch-end:${u.id}`)).toBeNull();
  });

  it("the Watch's quiet-period end, set by the hooks, fires on a sweep held by another instance", async () => {
    const u = await makeUser("watch");
    await registerFcmDevice(u.id, { token: fcmToken("G"), appId: "dev.optio.android" });
    await registerLiveActivityToken(u.id, {
      kind: "watch",
      token: hex("2b"),
      environment: "sandbox",
    });
    const host = await registerHost({
      userId: u.id,
      workspaceId: null,
      hostname: "it-glance",
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

    // Running → the Watch starts on both providers; the last counts are rows.
    await handleStarted(host.id, t.id);
    await vi.waitFor(() => expect(fcmFake.ofType("watch").length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await vi.waitFor(async () => {
      // An earlier hook can already see the running DB row while the
      // started hook is still queued. Counts alone do not mean that hook
      // has recorded the terminal's attention transition yet.
      expect((await getGlance<{ count: number }>(`running:${u.id}`))?.value.count).toBe(1);
      expect((await getGlance(`attention:${t.id}`))?.value).toEqual({ state: "working" });
    });

    // Exited → quiet: no end yet, a due timer row naming both providers.
    await new Promise((r) => setTimeout(r, 1100)); // past the providers' 1 s coalescing window
    await handleExit(host.id, t.id, 0);
    await vi.waitFor(async () => expect(await getGlance(`watch-end:${u.id}`)).not.toBeNull());
    // The exit fires more than one fire-and-forget hook; let the later ones
    // join the timer before it is swept, or one could re-create it after.
    await new Promise((r) => setTimeout(r, 500));
    const pending = await getGlance<{ providers: string[] }>(`watch-end:${u.id}`);
    expect([...pending!.value.providers].sort()).toEqual(["apns", "fcm"]);
    expect(pending!.dueAt!.getTime()).toBeGreaterThan(Date.now() + WATCH_END_GRACE_MS - 5000);
    expect(await getGlance(`attention:${t.id}`)).toBeNull();
    expect(fcmFake.ofType("watch").some((f) => f.data.event === "end")).toBe(false);

    // Not yet due: the sweep leaves it.
    expect(await sweepGlanceDue()).toBe(0);

    // Due, swept by another instance holding the lease → the end frame on both.
    const later = new Date(Date.now() + WATCH_END_GRACE_MS + 1000);
    const fired = await withLease(GLANCE_SWEEP_LEASE, () => sweepGlanceDue(later), {
      holder: "api-2:abcdef",
    });
    expect(fired).toBe(1);
    expect(await getGlance(`watch-end:${u.id}`)).toBeNull();
    await vi.waitFor(() =>
      expect(fcmFake.ofType("watch").some((f) => f.data.event === "end")).toBe(true),
    );
    const end = fcmFake.ofType("watch").find((f) => f.data.event === "end")!;
    expect(JSON.parse(end.data.state)).toMatchObject({ phase: "done", summary: "Quiet." });
    await vi.waitFor(() =>
      expect(
        apnsFake
          .ofType("liveactivity")
          .some((f) => JSON.stringify(f.payload).includes('"event":"end"')),
      ).toBe(true),
    );
    // The lease was held by the other instance and released after the sweep.
    expect(await leaseHolder(GLANCE_SWEEP_LEASE)).toBeNull();
  });

  it("a snooze is a due row cleared by unsnoozing; the sweep recomputes the Watch when it ends", async () => {
    const u = await makeUser("snooze");
    await registerFcmDevice(u.id, { token: fcmToken("S"), appId: "dev.optio.android" });
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
    const row = (await getTerminal(t.id))!;
    const snoozed = await snoozeTerminal(row, 10);
    await vi.waitFor(async () => expect(await getGlance(`snooze:${t.id}`)).not.toBeNull());
    const timer = await getGlance<{ userId: string }>(`snooze:${t.id}`);
    expect(timer!.value.userId).toBe(u.id);
    expect(timer!.dueAt!.getTime()).toBe(snoozed.snoozedUntil!.getTime() + 250);

    await unsnoozeTerminal(snoozed);
    await vi.waitFor(async () => expect(await getGlance(`snooze:${t.id}`)).toBeNull());

    // A due snooze row (set directly, as if by another instance) refreshes the
    // Watch. The device's last frame is forgotten first: the recomputed frame
    // is the same as the one the unsnooze sent, which the FCM dedupe drops.
    await new Promise((r) => setTimeout(r, 1100));
    fcmService.reset();
    fcmFake.sent.length = 0;
    await scheduleSnoozeExpiry({ ...row, snoozedUntil: new Date(Date.now() - 10_000) });
    expect(await sweepGlanceDue()).toBe(1);
    await vi.waitFor(() => expect(fcmFake.ofType("watch").length).toBeGreaterThan(0));
    expect(await getGlance(`snooze:${t.id}`)).toBeNull();
  });

  it("an outage is alerted once however many instances see the host offline", async () => {
    const u = await makeUser("host");
    await registerFcmDevice(u.id, { token: fcmToken("H"), appId: "dev.optio.android" });
    const host = await registerHost({
      userId: u.id,
      workspaceId: null,
      hostname: "it-outage",
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
    const offline = { id: host.id, userId: u.id, state: "offline" as const, name: host.name };
    // Several instances see the outage at once: the claim is one statement.
    await Promise.all([1, 2, 3, 4, 5].map(() => onLocalHostChanged(offline)));
    await onLocalHostChanged(offline);
    expect(fcmFake.ofType("alert").filter((f) => f.data.category === "HOST_OFFLINE")).toHaveLength(
      1,
    );
    expect(await getGlance(`host-offline:${host.id}`)).not.toBeNull();
    await onLocalHostChanged({ ...offline, state: "online" });
    expect(await getGlance(`host-offline:${host.id}`)).toBeNull();
  });
});

describe("attention transitions across instances", () => {
  async function runningTerminal(name: string) {
    const u = await makeUser(name);
    await registerFcmDevice(u.id, {
      token: fcmToken(name.slice(0, 1).toUpperCase()),
      appId: "dev.optio.android",
    });
    const host = await registerHost({
      userId: u.id,
      workspaceId: null,
      hostname: `it-${name}`,
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
    await vi.waitFor(async () =>
      expect((await getGlance(`attention:${t.id}`))?.value).toEqual({ state: "working" }),
    );
    await vi.waitFor(async () =>
      expect((await getGlance<{ count: number }>(`running:${u.id}`))?.value.count).toBe(1),
    );
    // Let the start's other fire-and-forget hooks settle.
    await new Promise((r) => setTimeout(r, 500));
    return { u, t };
  }

  it("N concurrent working → needs_you changes for one terminal alert exactly once", async () => {
    const { t } = await runningTerminal("swap");
    const row = {
      ...(await getTerminal(t.id))!,
      attentionState: "needs_you" as const,
      attentionReason: "stop",
    };
    fcmFake.sent.length = 0;
    await Promise.all(Array.from({ length: 8 }, () => onLocalTerminalChanged(row)));
    await new Promise((r) => setTimeout(r, 300));
    const needsYou = fcmFake.ofType("alert").filter((f) => f.data.category === "LOCAL_NEEDS_YOU");
    expect(needsYou).toHaveLength(1);
    expect((await getGlance(`attention:${t.id}`))?.value).toEqual({ state: "needs_you" });
  });

  it("a terminal change with nothing changed writes no glance_state row", async () => {
    const { u, t } = await runningTerminal("noop");
    const keys = [`attention:${t.id}`, `needs-you:${u.id}`, `running:${u.id}`];
    const versions = async () =>
      (
        await db.execute<{ key: string; xmin: string }>(
          sql`SELECT key, xmin::text AS xmin FROM glance_state
              WHERE key = ANY(${`{${keys.join(",")}}`}::text[]) ORDER BY key`,
        )
      ).map((r) => `${r.key}@${r.xmin}`);
    const before = await versions();
    expect(before).toHaveLength(3);
    await onLocalTerminalChanged((await getTerminal(t.id))!);
    expect(await versions()).toEqual(before);
  });
});

describe("the glance sweep worker", () => {
  it("is one BullMQ job scheduler however many instances start it, and fires due rows", async () => {
    const { Queue } = await import("bullmq");
    const { getBullMQOptions } = await import("./redis-config.js");
    const { GLANCE_SWEEP_QUEUE, GLANCE_SWEEP_SCHEDULER_ID, startGlanceSweepWorker } =
      await import("../workers/glance-sweep-worker.js");
    process.env.OPTIO_GLANCE_SWEEP_INTERVAL = "300";
    const a = startGlanceSweepWorker();
    const b = startGlanceSweepWorker();
    const queue = new Queue(GLANCE_SWEEP_QUEUE, { ...getBullMQOptions() });
    try {
      await vi.waitFor(async () =>
        expect((await queue.getJobSchedulers()).map((s) => s.key)).toEqual([
          GLANCE_SWEEP_SCHEDULER_ID,
        ]),
      );
      // A due timer is claimed and fired by the scheduled sweep.
      const u = await makeUser("sweep-worker");
      await setGlance("snooze:sweep-worker", { userId: u.id }, new Date(Date.now() - 1000));
      await vi.waitFor(async () => expect(await getGlance("snooze:sweep-worker")).toBeNull(), {
        timeout: 10_000,
      });
    } finally {
      delete process.env.OPTIO_GLANCE_SWEEP_INTERVAL;
      await a.close();
      await b.close();
      await queue.removeJobScheduler(GLANCE_SWEEP_SCHEDULER_ID);
      await queue.close();
    }
  });
});
