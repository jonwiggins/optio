import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleSeconds, buildWatchState, type WatchItem, type WatchState } from "@optio/shared";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// fcm-store pulls in the drizzle client; the service under test only needs its types.
vi.mock("./fcm-store.js", () => ({ drizzleFcmStore: {} }));

import { FcmService, FCM_MAX_FAILURE_COUNT, readFcmConfigFromEnv } from "./fcm-service.js";
import { FakeFcmTransport, type FcmFailure } from "./fcm-transport.js";
import type { FcmDeviceRow, FcmStore } from "./fcm-store.js";

class MemoryStore implements FcmStore {
  devices: FcmDeviceRow[] = [];
  async listDevices(userId: string) {
    return this.devices.filter((d) => d.userId === userId);
  }
  async deleteDevice(id: string) {
    this.devices = this.devices.filter((d) => d.id !== id);
  }
  async recordDeviceResult(id: string, ok: boolean) {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return 0;
    d.failureCount = ok ? 0 : d.failureCount + 1;
    return d.failureCount;
  }
}

const NOW = new Date("2026-09-17T12:00:00Z");

function device(id: string, userId = "u1", serverId: string | null = null): FcmDeviceRow {
  return {
    id,
    userId,
    token: `fcm-${id}`,
    appId: "dev.optio.android",
    clientServerId: serverId,
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
  title: "Needs you · web",
  body: "Waiting on a permission",
  category: "LOCAL_NEEDS_YOU" as const,
  threadId: "t1",
  url: "optio://local/t1?compose=1",
  kind: "local" as const,
  id: "t1",
  interruptionLevel: "time-sensitive" as const,
};
const waiting = buildWatchState({ needsYou: [item()], running: [], now: NOW });
const working = buildWatchState({ needsYou: [], running: [item({ state: "working" })], now: NOW });
const done: WatchState = {
  ...buildWatchState({ needsYou: [], running: [], now: NOW }),
  summary: "Quiet.",
};

function build(opts: { transport?: FakeFcmTransport | null } = {}) {
  const store = new MemoryStore();
  const transport = opts.transport === undefined ? new FakeFcmTransport() : opts.transport;
  const service = new FcmService({ transport, store, coalesceMs: 1000, now: () => NOW });
  return { store, transport, service };
}

const events = (t: FakeFcmTransport | null) => t!.ofType("watch").map((s) => s.data.event);

describe("FcmService (unconfigured)", () => {
  it("is a no-op for every method", async () => {
    const { store, service } = build({ transport: null });
    store.devices.push(device("d1"));
    expect(service.isConfigured()).toBe(false);
    expect(await service.sendAlert("u1", alertInput)).toBe(0);
    expect(await service.hasWatch("u1")).toBe(false);
    await service.pushWatch("u1", waiting, { alert: true });
    await service.endWatch("u1", done);
    expect(store.devices).toHaveLength(1);
  });
});

describe("readFcmConfigFromEnv", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = {
    type: "service_account",
    project_id: "optio-fcm",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "fcm@optio-fcm.iam.gserviceaccount.com",
  };

  it("needs a service account; the project defaults to the key's project_id", () => {
    expect(readFcmConfigFromEnv({})).toBeNull();
    expect(readFcmConfigFromEnv({ OPTIO_FCM_SERVICE_ACCOUNT: JSON.stringify(sa) })).toMatchObject({
      projectId: "optio-fcm",
      serviceAccount: { clientEmail: sa.client_email },
    });
    expect(
      readFcmConfigFromEnv({
        OPTIO_FCM_SERVICE_ACCOUNT: JSON.stringify(sa),
        OPTIO_FCM_PROJECT_ID: "other-project",
      })?.projectId,
    ).toBe("other-project");
  });

  it("reads OPTIO_FCM_SERVICE_ACCOUNT_FILE, and rejects bad keys or a missing project id", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcm-sa-"));
    try {
      const file = join(dir, "sa.json");
      writeFileSync(file, JSON.stringify(sa));
      expect(readFcmConfigFromEnv({ OPTIO_FCM_SERVICE_ACCOUNT_FILE: file })?.projectId).toBe(
        "optio-fcm",
      );
      expect(
        readFcmConfigFromEnv({ OPTIO_FCM_SERVICE_ACCOUNT_FILE: join(dir, "missing.json") }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(readFcmConfigFromEnv({ OPTIO_FCM_SERVICE_ACCOUNT: "{oops" })).toBeNull();
    expect(
      readFcmConfigFromEnv({
        OPTIO_FCM_SERVICE_ACCOUNT: JSON.stringify({ ...sa, project_id: undefined }),
      }),
    ).toBeNull();
  });
});

describe("FcmService alerts", () => {
  it("fans out to every Android device of the user and only that user, tagging each with its server id", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1", "u1", "srv-a"), device("d2"), device("d3", "u2"));
    expect(await service.sendAlert("u1", alertInput)).toBe(2);
    expect(transport!.sent.map((s) => s.token).sort()).toEqual(["fcm-d1", "fcm-d2"]);
    const d1 = transport!.sent.find((s) => s.token === "fcm-d1")!;
    expect(d1.android).toEqual({ priority: "HIGH", ttl: "86400s" });
    expect(d1.data).toMatchObject({
      type: "alert",
      category: "LOCAL_NEEDS_YOU",
      url: "optio://local/t1?compose=1",
      timeSensitive: "1",
      serverId: "srv-a",
    });
    expect(transport!.sent.find((s) => s.token === "fcm-d2")!.data.serverId).toBeUndefined();
  });

  it("drops a device on UNREGISTERED, 404, SENDER_ID_MISMATCH and an invalid-token INVALID_ARGUMENT", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"), device("d2"), device("d3"), device("d4"), device("d5"));
    transport!.failToken("fcm-d1", { ok: false, status: 404, reason: "UNREGISTERED" });
    transport!.failToken("fcm-d2", { ok: false, status: 404, reason: "NOT_FOUND" });
    transport!.failToken("fcm-d3", { ok: false, status: 403, reason: "SENDER_ID_MISMATCH" });
    transport!.failToken("fcm-d4", {
      ok: false,
      status: 400,
      reason: "INVALID_ARGUMENT",
      tokenInvalid: true,
    });
    // A payload INVALID_ARGUMENT is not the token's fault: counted, kept.
    transport!.failToken("fcm-d5", { ok: false, status: 400, reason: "INVALID_ARGUMENT" });
    expect(await service.sendAlert("u1", alertInput)).toBe(0);
    expect(store.devices.map((d) => d.id)).toEqual(["d5"]);
    expect(store.devices[0].failureCount).toBe(1);
  });

  it("drops a device after 5 consecutive failures and resets on success", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"));
    transport!.failToken("fcm-d1", { ok: false, status: 503, reason: "UNAVAILABLE" });
    for (let i = 1; i < FCM_MAX_FAILURE_COUNT; i++) {
      await service.sendAlert("u1", alertInput);
      expect(store.devices[0].failureCount).toBe(i);
    }
    transport!.clearFailure("fcm-d1");
    await service.sendAlert("u1", alertInput);
    expect(store.devices[0].failureCount).toBe(0);

    transport!.failToken("fcm-d1", { ok: false, status: 429, reason: "QUOTA_EXCEEDED" });
    for (let i = 0; i < FCM_MAX_FAILURE_COUNT; i++) await service.sendAlert("u1", alertInput);
    expect(store.devices).toHaveLength(0);
  });

  it("never counts the server's own credential failures against a device", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"));
    const ours: FcmFailure = { ok: false, status: 0, reason: "auth:bad key", serverSide: true };
    transport!.failToken("fcm-d1", ours);
    for (let i = 0; i < FCM_MAX_FAILURE_COUNT + 2; i++) await service.sendAlert("u1", alertInput);
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0].failureCount).toBe(0);
  });
});

describe("FcmService Watch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts, updates and ends the Watch on every device; hasWatch follows the lifecycle", async () => {
    const { store, transport, service } = build();
    expect(await service.hasWatch("u1")).toBe(false); // no devices
    store.devices.push(device("d1", "u1", "srv-a"), device("d2"), device("d3", "u2"));
    // Unknown (fresh process) with devices: a Watch may be showing.
    expect(await service.hasWatch("u1")).toBe(true);

    await service.pushWatch("u1", working, { alert: false });
    expect(transport!.sent.map((s) => s.token).sort()).toEqual(["fcm-d1", "fcm-d2"]);
    const start = transport!.sent[0];
    expect(start.data).toMatchObject({ type: "watch", event: "start" });
    expect(start.android).toEqual({ priority: "NORMAL", ttl: "3600s", collapse_key: "watch" });
    expect(JSON.parse(start.data.state)).toEqual(working);
    expect(transport!.sent.find((s) => s.token === "fcm-d1")!.data.serverId).toBe("srv-a");
    expect(await service.hasWatch("u1")).toBe(true);

    await vi.advanceTimersByTimeAsync(1100);
    await service.pushWatch("u1", waiting, { alert: true });
    const update = transport!.sent.slice(-2);
    expect(update.map((s) => s.data.event)).toEqual(["update", "update"]);
    expect(update[0].android.priority).toBe("HIGH");

    await vi.advanceTimersByTimeAsync(1100);
    await service.endWatch("u1", done);
    expect(events(transport).slice(-2)).toEqual(["end", "end"]);
    expect(JSON.parse(transport!.sent.at(-1)!.data.state)).toMatchObject({ summary: "Quiet." });
    expect(await service.hasWatch("u1")).toBe(false);

    // Activity resumes: a new Watch starts.
    await service.pushWatch("u1", working, { alert: false });
    expect(events(transport).slice(-2)).toEqual(["start", "start"]);
    service.reset();
  });

  it("coalesces bursts per device (latest frame wins, an alert is not downgraded) and dedupes", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"));
    await service.pushWatch("u1", working, { alert: false });
    expect(transport!.sent).toHaveLength(1);

    // Inside the 1 s window: folded into one trailing push.
    await service.pushWatch("u1", waiting, { alert: true });
    const two = buildWatchState({ needsYou: [item(), item({ id: "t2" })], running: [], now: NOW });
    await service.pushWatch("u1", two, { alert: false });
    expect(transport!.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport!.sent).toHaveLength(2);
    expect(transport!.sent[1].data.event).toBe("update");
    expect(transport!.sent[1].android.priority).toBe("HIGH");
    expect(JSON.parse(transport!.sent[1].data.state).needsYouCount).toBe(2);

    // The same frame again (new asOf) is dropped.
    await vi.advanceTimersByTimeAsync(1100);
    const again = buildWatchState({
      needsYou: [item(), item({ id: "t2" })],
      running: [],
      now: new Date(NOW.getTime() + 5000),
    });
    await service.pushWatch("u1", again, { alert: false });
    expect(transport!.sent).toHaveLength(2);
    service.reset();
  });

  it("an update identical to the start before it is a duplicate", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"));
    await service.pushWatch("u1", working, { alert: false });
    await vi.advanceTimersByTimeAsync(1100);
    await service.pushWatch("u1", working, { alert: false });
    expect(events(transport)).toEqual(["start"]);
    service.reset();
  });

  it("drops a device whose Watch push comes back UNREGISTERED", async () => {
    const { store, transport, service } = build();
    store.devices.push(device("d1"), device("d2"));
    transport!.failToken("fcm-d1", { ok: false, status: 404, reason: "UNREGISTERED" });
    await service.pushWatch("u1", working, { alert: false });
    expect(store.devices.map((d) => d.id)).toEqual(["d2"]);
    service.reset();
  });

  it("does not mark a Watch started for a user without devices", async () => {
    const { store, transport, service } = build();
    await service.pushWatch("u1", working, { alert: false });
    store.devices.push(device("d1"));
    await service.pushWatch("u1", working, { alert: false });
    expect(events(transport)).toEqual(["start"]);
    service.reset();
  });
});
