import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

vi.mock("../services/notification-service.js", () => ({
  getVapidPublicKey: vi.fn(() => null),
  isVapidConfigured: vi.fn(() => false),
}));

const { store, apns } = vi.hoisted(() => ({
  store: {
    registerDevice: vi.fn(),
    unregisterDevice: vi.fn(),
    listDevicesForUser: vi.fn(),
    registerLiveActivityToken: vi.fn(),
    unregisterLiveActivityToken: vi.fn(),
    registerLiveActivityStartToken: vi.fn(),
  },
  apns: { configured: false, sendAlert: vi.fn(async () => 2) },
}));
vi.mock("../services/apns-store.js", () => store);

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
    store.registerDevice.mockResolvedValue(deviceView);
    store.listDevicesForUser.mockResolvedValue([deviceView]);
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
