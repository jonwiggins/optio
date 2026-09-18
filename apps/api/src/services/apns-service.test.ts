import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appleSeconds, buildWatchState, type WatchItem } from "@optio/shared";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// apns-store pulls in the drizzle client; the service under test only needs its types.
vi.mock("./apns-store.js", () => ({ drizzleApnsStore: {} }));

import { ApnsService, APNS_MAX_FAILURE_COUNT, readApnsConfigFromEnv } from "./apns-service.js";
import { FakeApnsTransport } from "./apns-transport.js";
import type {
  ApnsDeviceRow,
  ApnsStore,
  LiveActivityStartTokenRow,
  LiveActivityTokenRow,
} from "./apns-store.js";

class MemoryStore implements ApnsStore {
  devices: ApnsDeviceRow[] = [];
  laTokens: LiveActivityTokenRow[] = [];
  startTokens: LiveActivityStartTokenRow[] = [];

  async listDevices(userId: string) {
    return this.devices.filter((d) => d.userId === userId);
  }
  async listLiveActivityTokens(userId: string, kind: "watch") {
    return this.laTokens.filter((t) => t.userId === userId && t.kind === kind);
  }
  async listStartTokens(userId: string, kind: "watch") {
    return this.startTokens.filter((t) => t.userId === userId && t.kind === kind);
  }
  async deleteDevice(id: string) {
    this.devices = this.devices.filter((d) => d.id !== id);
  }
  async deleteLiveActivityToken(id: string) {
    this.laTokens = this.laTokens.filter((t) => t.id !== id);
  }
  async deleteStartToken(id: string) {
    this.startTokens = this.startTokens.filter((t) => t.id !== id);
  }
  async recordDeviceResult(id: string, ok: boolean) {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return 0;
    d.failureCount = ok ? 0 : d.failureCount + 1;
    return d.failureCount;
  }
  async recordLiveActivityResult(id: string, ok: boolean) {
    const t = this.laTokens.find((x) => x.id === id);
    if (!t) return 0;
    t.failureCount = ok ? 0 : t.failureCount + 1;
    return t.failureCount;
  }
}

const NOW = new Date("2026-09-17T12:00:00Z");

function device(id: string, userId = "u1"): ApnsDeviceRow {
  return {
    id,
    userId,
    token: `tok-${id}`,
    environment: "sandbox",
    bundleId: "dev.optio.ios",
    failureCount: 0,
  };
}
function laToken(id: string, userId = "u1"): LiveActivityTokenRow {
  return {
    id,
    userId,
    kind: "watch",
    subjectId: null,
    token: `la-${id}`,
    environment: "sandbox",
    failureCount: 0,
  };
}
function item(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    kind: "local",
    id: "t1",
    title: "claude-code",
    mono: "web",
    since: appleSeconds(NOW),
    state: "needs_you",
    link: "optio://local/t1?compose=1",
    ...overrides,
  };
}
const alertInput = {
  title: "Needs you",
  body: "web",
  category: "LOCAL_NEEDS_YOU" as const,
  threadId: "t1",
  url: "optio://local/t1?compose=1",
  kind: "local" as const,
  id: "t1",
};

function build(opts: { transport?: FakeApnsTransport | null } = {}) {
  const store = new MemoryStore();
  const transport = opts.transport === undefined ? new FakeApnsTransport() : opts.transport;
  const service = new ApnsService({
    transport,
    store,
    bundleId: "dev.optio.ios",
    coalesceMs: 1000,
    now: () => NOW,
  });
  return { store, transport, service };
}

describe("ApnsService (unconfigured)", () => {
  it("is a no-op for every method", async () => {
    const { store, service } = build({ transport: null });
    store.devices.push(device("d1"));
    store.laTokens.push(laToken("l1"));
    expect(service.isConfigured()).toBe(false);
    expect(await service.sendAlert("u1", alertInput)).toBe(0);
    await service.updateWatch("u1", buildWatchState({ needsYou: [item()], running: [] }), {
      event: "update",
    });
    expect(await service.startWatch("u1", buildWatchState({ needsYou: [], running: [] }))).toBe(0);
    expect(await service.hasWatchToken("u1")).toBe(false);
    expect(store.devices).toHaveLength(1);
  });

  it("readApnsConfigFromEnv requires key id, team id and key", () => {
    expect(readApnsConfigFromEnv({})).toBeNull();
    expect(readApnsConfigFromEnv({ OPTIO_APNS_KEY_ID: "K", OPTIO_APNS_TEAM_ID: "T" })).toBeNull();
    const cfg = readApnsConfigFromEnv({
      OPTIO_APNS_KEY_ID: "K1",
      OPTIO_APNS_TEAM_ID: "T1",
      OPTIO_APNS_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    });
    expect(cfg).toMatchObject({
      keyId: "K1",
      teamId: "T1",
      bundleId: "dev.optio.ios",
      environment: "sandbox",
    });
    expect(cfg?.key).toContain("\nabc\n");
    expect(
      readApnsConfigFromEnv({
        OPTIO_APNS_KEY_ID: "K1",
        OPTIO_APNS_TEAM_ID: "T1",
        OPTIO_APNS_KEY: "x",
        OPTIO_APNS_ENVIRONMENT: "production",
        OPTIO_APNS_BUNDLE_ID: "com.example.app",
      }),
    ).toMatchObject({ environment: "production", bundleId: "com.example.app" });
  });
});

describe("ApnsService alerts", () => {
  it("fans out to every device of the user and only that user", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"), device("d2"), device("d3", "u2"));
    const sent = await service.sendAlert("u1", alertInput);
    expect(sent).toBe(2);
    expect(transport!.sent.map((s) => s.token).sort()).toEqual(["tok-d1", "tok-d2"]);
    expect(transport!.sent[0]).toMatchObject({
      pushType: "alert",
      topic: "dev.optio.ios",
      priority: 10,
      collapseId: "local-t1",
      environment: "sandbox",
    });
  });

  it("drops a device on 410 / Unregistered / BadDeviceToken", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"), device("d2"), device("d3"));
    transport!.failToken("tok-d1", { ok: false, status: 410, reason: "Unregistered" });
    transport!.failToken("tok-d2", { ok: false, status: 400, reason: "BadDeviceToken" });
    const sent = await service.sendAlert("u1", alertInput);
    expect(sent).toBe(1);
    expect(store.devices.map((d) => d.id)).toEqual(["d3"]);
  });

  it("drops a device after 5 consecutive failures and resets on success", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"));
    transport!.failToken("tok-d1", { ok: false, status: 503, reason: "ServiceUnavailable" });
    for (let i = 1; i < APNS_MAX_FAILURE_COUNT; i++) {
      await service.sendAlert("u1", alertInput);
      expect(store.devices[0].failureCount).toBe(i);
    }
    transport!.clearFailure("tok-d1");
    await service.sendAlert("u1", alertInput);
    expect(store.devices[0].failureCount).toBe(0);

    transport!.failToken("tok-d1", { ok: false, status: 500, reason: "InternalServerError" });
    for (let i = 0; i < APNS_MAX_FAILURE_COUNT; i++) await service.sendAlert("u1", alertInput);
    expect(store.devices).toHaveLength(0);
  });
});

describe("ApnsService Live Activity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const waiting = buildWatchState({ needsYou: [item()], running: [], now: NOW });
  const working = buildWatchState({
    needsYou: [],
    running: [item({ state: "working" })],
    now: NOW,
  });

  it("pushes to every LA token and dedupes identical frames", async () => {
    const { store, transport, service } = build();
    store.laTokens.push(laToken("l1"), laToken("l2"), laToken("l3", "u2"));
    await service.updateWatch("u1", waiting, { event: "update" });
    expect(
      transport!
        .ofType("liveactivity")
        .map((s) => s.token)
        .sort(),
    ).toEqual(["la-l1", "la-l2"]);
    expect(transport!.sent[0]).toMatchObject({
      topic: "dev.optio.ios.push-type.liveactivity",
      priority: 5,
    });

    await vi.advanceTimersByTimeAsync(1100);
    const again = buildWatchState({
      needsYou: [item()],
      running: [],
      now: new Date(NOW.getTime() + 5000),
    });
    await service.updateWatch("u1", again, { event: "update" });
    expect(transport!.sent).toHaveLength(2); // same content → skipped
    service.reset();
  });

  it("coalesces bursts to one trailing push per token per second, latest frame wins", async () => {
    const { store, transport, service } = build();
    store.laTokens.push(laToken("l1"));
    await service.updateWatch("u1", waiting, { event: "update" });
    expect(transport!.sent).toHaveLength(1);

    // Burst inside the window: neither goes out yet.
    await service.updateWatch("u1", working, { event: "update" });
    const two = buildWatchState({ needsYou: [item(), item({ id: "t2" })], running: [], now: NOW });
    await service.updateWatch("u1", two, { event: "update" });
    expect(transport!.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(transport!.sent).toHaveLength(2);
    const aps = transport!.sent[1].payload.aps as { "content-state": { needsYouCount: number } };
    expect(aps["content-state"].needsYouCount).toBe(2);
    service.reset();
  });

  it("keeps an alert from being downgraded by a later silent frame in the same window", async () => {
    const { store, transport, service } = build();
    store.laTokens.push(laToken("l1"));
    await service.updateWatch("u1", working, { event: "update" });
    await service.updateWatch("u1", waiting, {
      event: "update",
      alert: { title: "Needs you", body: "web" },
    });
    await service.updateWatch("u1", waiting, { event: "update" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport!.sent).toHaveLength(2);
    expect(transport!.sent[1].priority).toBe(10);
    expect((transport!.sent[1].payload.aps as { alert?: unknown }).alert).toBeDefined();
    service.reset();
  });

  it("drops an LA token on 410 and after 5 failures", async () => {
    const { store, transport, service } = build();
    store.laTokens.push(laToken("l1"), laToken("l2"));
    transport!.failToken("la-l1", { ok: false, status: 410, reason: "Unregistered" });
    transport!.failToken("la-l2", { ok: false, status: 429, reason: "TooManyRequests" });
    await service.updateWatch("u1", waiting, { event: "update" });
    expect(store.laTokens.map((t) => t.id)).toEqual(["l2"]);
    expect(store.laTokens[0].failureCount).toBe(1);

    for (let i = 1; i < APNS_MAX_FAILURE_COUNT; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      const s = buildWatchState({
        needsYou: Array.from({ length: i + 1 }, (_, n) => item({ id: `t${n}` })),
        running: [],
        now: NOW,
      });
      await service.updateWatch("u1", s, { event: "update" });
    }
    expect(store.laTokens).toHaveLength(0);
    service.reset();
  });

  it("end frames bypass dedupe and clear the window", async () => {
    const { store, transport, service } = build();
    store.laTokens.push(laToken("l1"));
    await service.updateWatch("u1", waiting, { event: "update" });
    await vi.advanceTimersByTimeAsync(1000);
    await service.updateWatch("u1", waiting, { event: "end" });
    expect(transport!.sent).toHaveLength(2);
    expect((transport!.sent[1].payload.aps as { event: string }).event).toBe("end");
    service.reset();
  });

  it("startWatch targets push-to-start tokens and drops bad ones", async () => {
    const { store, transport, service } = build();
    store.startTokens.push(
      { id: "s1", userId: "u1", kind: "watch", token: "st-1", environment: "production" },
      { id: "s2", userId: "u1", kind: "watch", token: "st-2", environment: "sandbox" },
    );
    transport!.failToken("st-2", { ok: false, status: 400, reason: "BadDeviceToken" });
    const sent = await service.startWatch("u1", working);
    expect(sent).toBe(1);
    expect(store.startTokens.map((t) => t.id)).toEqual(["s1"]);
    expect(transport!.sent[0]).toMatchObject({
      token: "st-1",
      environment: "production",
      priority: 10,
    });
    expect((transport!.sent[0].payload.aps as { event: string }).event).toBe("start");
  });
});
