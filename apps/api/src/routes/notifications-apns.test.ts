import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

vi.mock("../services/notification-service.js", () => ({
  getVapidPublicKey: vi.fn(() => null),
  isVapidConfigured: vi.fn(() => false),
}));

const { store, apns, fcmStore, fcm } = vi.hoisted(() => ({
  store: {
    registerDevice: vi.fn(),
    unregisterDevice: vi.fn(),
    unregisterDeviceById: vi.fn(),
    listDevicesForUser: vi.fn(),
    registerLiveActivityToken: vi.fn(),
    unregisterLiveActivityToken: vi.fn(),
    registerLiveActivityStartToken: vi.fn(),
  },
  apns: { configured: false, sendAlert: vi.fn(async () => 2) },
  fcmStore: {
    registerFcmDevice: vi.fn(),
    unregisterFcmDevice: vi.fn(),
    unregisterFcmDeviceById: vi.fn(),
    listFcmDevicesForUser: vi.fn(async () => [] as unknown[]),
  },
  fcm: { configured: false, sendAlert: vi.fn(async () => 1) },
}));
vi.mock("../services/apns-store.js", () => store);
vi.mock("../services/fcm-store.js", () => fcmStore);
vi.mock("../services/fcm-service.js", () => ({
  fcmService: {
    isConfigured: () => fcm.configured,
    sendAlert: (...args: unknown[]) => fcm.sendAlert(...(args as [])),
  },
}));

const glance = vi.hoisted(() => ({ computeWatchState: vi.fn() }));
vi.mock("../services/glance-service.js", () => ({
  computeWatchState: (...args: unknown[]) => glance.computeWatchState(...(args as [])),
}));

vi.mock("../services/apns-service.js", () => ({
  apnsService: {
    isConfigured: () => apns.configured,
    sendAlert: (...args: unknown[]) => apns.sendAlert(...(args as [])),
    bundleId: "dev.optio.ios",
  },
  defaultApnsEnvironment: () => "sandbox",
}));

vi.mock("../plugins/auth.js", () => ({
  requireRole:
    (role: string) =>
    async (
      req: { user?: { workspaceRole?: string } },
      reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const rank = { viewer: 0, member: 1, admin: 2 } as Record<string, number>;
      const have = rank[req.user?.workspaceRole ?? "viewer"] ?? 0;
      if (have < (rank[role] ?? 0)) return reply.status(403).send({ error: "Forbidden" });
    },
}));

import { notificationRoutes } from "./notifications.js";

const TOKEN = "a".repeat(64);
const deviceView = {
  id: "dev-1",
  token: "aaaaaa…aaaa",
  platform: "ios",
  environment: "sandbox",
  bundleId: "dev.optio.ios",
  appVersion: "1.0",
  deviceName: "iPhone",
  failureCount: 0,
  lastSeenAt: new Date("2026-09-17T12:00:00Z"),
  createdAt: new Date("2026-09-17T12:00:00Z"),
};

async function build(user?: Record<string, unknown> | null) {
  return buildRouteTestApp(notificationRoutes, {
    user:
      user === null
        ? null
        : ({ id: "user-1", workspaceId: "ws-1", workspaceRole: "member", ...user } as never),
  });
}

describe("APNs device routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    apns.configured = false;
    fcm.configured = false;
    store.registerDevice.mockResolvedValue(deviceView);
    store.listDevicesForUser.mockResolvedValue([deviceView]);
    fcmStore.listFcmDevicesForUser.mockResolvedValue([]);
    app = await build();
  });

  it("POST /api/notifications/devices upserts and returns the masked device", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: {
        token: TOKEN.toUpperCase(),
        bundleId: "dev.optio.ios",
        appVersion: "1.0",
        deviceName: "iPhone",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().device.token).toBe("aaaaaa…aaaa");
    expect(store.registerDevice).toHaveBeenCalledWith("user-1", {
      token: TOKEN, // lower-cased
      platform: "ios",
      environment: "sandbox", // server default
      bundleId: "dev.optio.ios",
      appVersion: "1.0",
      deviceName: "iPhone",
      workspaceId: "ws-1",
    });
  });

  it("rejects a non-hex token and an unknown environment", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: { token: "not-hex!", bundleId: "dev.optio.ios" },
    });
    expect(bad.statusCode).toBe(400);
    const env = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: { token: TOKEN, bundleId: "dev.optio.ios", environment: "staging" },
    });
    expect(env.statusCode).toBe(400);
    expect(store.registerDevice).not.toHaveBeenCalled();
  });

  it("GET /api/notifications/devices lists the caller's devices", async () => {
    const res = await app.inject({ method: "GET", url: "/api/notifications/devices" });
    expect(res.statusCode).toBe(200);
    expect(res.json().devices).toHaveLength(1);
    expect(store.listDevicesForUser).toHaveBeenCalledWith("user-1");
  });

  it("DELETE /api/notifications/devices/:token removes it (204)", async () => {
    store.unregisterDevice.mockResolvedValue(true);
    const res = await app.inject({ method: "DELETE", url: `/api/notifications/devices/${TOKEN}` });
    expect(res.statusCode).toBe(204);
    expect(store.unregisterDevice).toHaveBeenCalledWith("user-1", TOKEN);
  });

  it("viewers cannot register devices; unauthenticated callers get 401", async () => {
    const viewer = await build({ workspaceRole: "viewer" });
    const res = await viewer.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: { token: TOKEN, bundleId: "dev.optio.ios" },
    });
    expect(res.statusCode).toBe(403);

    const anon = await build(null);
    const list = await anon.inject({ method: "GET", url: "/api/notifications/devices" });
    expect(list.statusCode).toBe(401);
  });

  it("POST /api/notifications/devices/test is 503 until APNs is configured", async () => {
    const off = await app.inject({ method: "POST", url: "/api/notifications/devices/test" });
    expect(off.statusCode).toBe(503);
    apns.configured = true;
    const on = await app.inject({ method: "POST", url: "/api/notifications/devices/test" });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ sent: 2 });
    expect(apns.sendAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ category: "TEST" }),
    );
  });
});

const FCM_TOKEN = "cXz9Qm1aT0uYp3Lr8Vw2Kd:APA91bH-Ek_7vQpZ" + "x".repeat(120);
const androidView = {
  id: "0b5f3d9e-8a1c-4c7b-9f2e-6d4a1b3c5e7f",
  token: "cXz9Qm…xxxx",
  platform: "android",
  appId: "dev.optio.android",
  serverId: "srv-1",
  appVersion: "0.1.0 (1)",
  deviceName: "Pixel 9",
  failureCount: 0,
  lastSeenAt: new Date("2026-09-17T12:00:00Z"),
  createdAt: new Date("2026-09-17T12:00:00Z"),
};

describe("Android (FCM) device routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    apns.configured = false;
    fcm.configured = false;
    store.listDevicesForUser.mockResolvedValue([deviceView]);
    fcmStore.registerFcmDevice.mockResolvedValue(androidView);
    fcmStore.listFcmDevicesForUser.mockResolvedValue([androidView]);
    app = await build();
  });

  it("POST /api/notifications/devices registers an FCM token (case kept) with the app's server id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: {
        platform: "android",
        token: FCM_TOKEN,
        appId: "dev.optio.android",
        appVersion: "0.1.0 (1)",
        deviceName: "Pixel 9",
        serverId: "srv-1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().device).toMatchObject({
      platform: "android",
      appId: "dev.optio.android",
      serverId: "srv-1",
      token: "cXz9Qm…xxxx",
    });
    expect(res.json().device.environment).toBeUndefined();
    expect(fcmStore.registerFcmDevice).toHaveBeenCalledWith("user-1", {
      token: FCM_TOKEN,
      appId: "dev.optio.android",
      appVersion: "0.1.0 (1)",
      deviceName: "Pixel 9",
      serverId: "srv-1",
      workspaceId: "ws-1",
    });
    expect(store.registerDevice).not.toHaveBeenCalled();
  });

  it("validates the Android body: token shape, appId, and the platform discriminator", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/notifications/devices", payload });
    expect((await post({ platform: "android", token: FCM_TOKEN })).statusCode).toBe(400);
    expect(
      (await post({ platform: "android", token: "short:tok", appId: "dev.optio.android" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          platform: "android",
          token: "has spaces and / slashes ".repeat(4),
          appId: "dev.optio.android",
        })
      ).statusCode,
    ).toBe(400);
    expect((await post({ platform: "windows", token: TOKEN, bundleId: "x" })).statusCode).toBe(400);
    // An FCM token sent as iOS fails the APNs hex check rather than landing in the wrong table.
    expect((await post({ token: FCM_TOKEN, bundleId: "dev.optio.ios" })).statusCode).toBe(400);
    expect(fcmStore.registerFcmDevice).not.toHaveBeenCalled();
    expect(store.registerDevice).not.toHaveBeenCalled();
  });

  it("viewers cannot register an Android device", async () => {
    const viewer = await build({ workspaceRole: "viewer" });
    const res = await viewer.inject({
      method: "POST",
      url: "/api/notifications/devices",
      payload: { platform: "android", token: FCM_TOKEN, appId: "dev.optio.android" },
    });
    expect(res.statusCode).toBe(403);
    expect(fcmStore.registerFcmDevice).not.toHaveBeenCalled();
  });

  it("GET /api/notifications/devices lists both platforms plus the provider flags", async () => {
    fcm.configured = true;
    const res = await app.inject({ method: "GET", url: "/api/notifications/devices" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.push).toEqual({ apns: false, fcm: true });
    expect(body.devices.map((d: { platform: string }) => d.platform)).toEqual(["ios", "android"]);
    // The iOS row is exactly what it was before Android existed (additive change).
    expect(body.devices[0]).toEqual(JSON.parse(JSON.stringify(deviceView)));
    expect(body.devices[1]).toMatchObject({ platform: "android", appId: "dev.optio.android" });
    expect(fcmStore.listFcmDevicesForUser).toHaveBeenCalledWith("user-1");
  });

  it("DELETE /api/notifications/devices/:token routes by token shape, and accepts a device id", async () => {
    const del = (ref: string) =>
      app.inject({ method: "DELETE", url: `/api/notifications/devices/${ref}` });

    expect((await del(FCM_TOKEN)).statusCode).toBe(204);
    expect(fcmStore.unregisterFcmDevice).toHaveBeenCalledWith("user-1", FCM_TOKEN);
    expect(store.unregisterDevice).not.toHaveBeenCalled();

    expect((await del(TOKEN.toUpperCase())).statusCode).toBe(204);
    expect(store.unregisterDevice).toHaveBeenCalledWith("user-1", TOKEN);
    expect(fcmStore.unregisterFcmDevice).toHaveBeenCalledTimes(1);

    expect((await del(androidView.id)).statusCode).toBe(204);
    expect(store.unregisterDeviceById).toHaveBeenCalledWith("user-1", androidView.id);
    expect(fcmStore.unregisterFcmDeviceById).toHaveBeenCalledWith("user-1", androidView.id);

    // The masked token from the list is not a reference.
    expect((await del(encodeURIComponent("cXz9Qm…xxxx"))).statusCode).toBe(400);
  });

  it("POST /api/notifications/devices/test sends to both platforms and 503s only when neither is configured", async () => {
    const off = await app.inject({ method: "POST", url: "/api/notifications/devices/test" });
    expect(off.statusCode).toBe(503);

    fcm.configured = true;
    const androidOnly = await app.inject({
      method: "POST",
      url: "/api/notifications/devices/test",
    });
    expect(androidOnly.statusCode).toBe(200);
    expect(androidOnly.json()).toEqual({ sent: 1 });
    expect(fcm.sendAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        category: "TEST",
        body: "If you see this, Android push is working.",
      }),
    );
    expect(apns.sendAlert).not.toHaveBeenCalled();

    apns.configured = true;
    const both = await app.inject({ method: "POST", url: "/api/notifications/devices/test" });
    expect(both.json()).toEqual({ sent: 3 });
    expect(apns.sendAlert).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ body: "If you see this, iOS push is working." }),
    );
  });
});

describe("Live Activity token routes", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await build();
  });

  it("POST /live-activities/watch/token upserts with the server default environment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/live-activities/watch/token",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(store.registerLiveActivityToken).toHaveBeenCalledWith("user-1", {
      kind: "watch",
      token: TOKEN,
      environment: "sandbox",
      subjectId: undefined,
    });
  });

  it("rejects unknown activity kinds", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/live-activities/task/token",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(400);
    expect(store.registerLiveActivityToken).not.toHaveBeenCalled();
  });

  it("DELETE /live-activities/watch/token removes the token (204)", async () => {
    store.unregisterLiveActivityToken.mockResolvedValue(true);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/notifications/live-activities/watch/token",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(204);
    expect(store.unregisterLiveActivityToken).toHaveBeenCalledWith("user-1", "watch", TOKEN);
  });

  it("POST /live-activities/watch/push-to-start upserts the start token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/live-activities/watch/push-to-start",
      payload: { token: TOKEN, environment: "production" },
    });
    expect(res.statusCode).toBe(201);
    expect(store.registerLiveActivityStartToken).toHaveBeenCalledWith("user-1", {
      kind: "watch",
      token: TOKEN,
      environment: "production",
    });
  });
});

describe("GET /api/glance/watch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the caller's Watch frame with the session tiles", async () => {
    glance.computeWatchState.mockResolvedValue({
      phase: "working",
      head: null,
      others: [],
      needsYouCount: 0,
      runningCount: 2,
      waitingCount: 1,
      recurringCount: 4,
      agentCount: 2,
      offlineSince: null,
      summary: null,
      asOf: 811397839,
    });
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/glance/watch" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ phase: "working", recurringCount: 4, agentCount: 2 });
    expect(glance.computeWatchState).toHaveBeenCalledWith("user-1");
  });

  it("is readable by viewers and 401 without a user", async () => {
    glance.computeWatchState.mockResolvedValue({
      phase: "done",
      others: [],
      needsYouCount: 0,
      runningCount: 0,
      asOf: 1,
    });
    const viewer = await build({ workspaceRole: "viewer" });
    expect((await viewer.inject({ method: "GET", url: "/api/glance/watch" })).statusCode).toBe(200);
    const anon = await build(null);
    expect((await anon.inject({ method: "GET", url: "/api/glance/watch" })).statusCode).toBe(401);
  });
});
