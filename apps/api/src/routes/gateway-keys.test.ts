import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// The gateway key routes (routes/gateway-keys.ts): who may call which, and
// that a body can't widen what a key gets.

const svc = vi.hoisted(() => ({
  getKeyIssuing: vi.fn(),
  saveKeyIssuing: vi.fn(),
  myGatewayKeyStatus: vi.fn(),
  issuePersonalKey: vi.fn(),
  revokePersonalKey: vi.fn(),
  listIssuedKeys: vi.fn(),
  adminRevokeKey: vi.fn(),
}));

vi.mock("../services/gateway-keys.js", () => {
  class GatewayKeyError extends Error {
    constructor(
      message: string,
      readonly status = 400,
    ) {
      super(message);
    }
  }
  return { GatewayKeyError, ...svc };
});
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

import { gatewayKeyRoutes } from "./gateway-keys.js";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const WS_ID = "22222222-2222-4222-8222-222222222222";

async function buildApp(role: "admin" | "member" | "viewer"): Promise<FastifyInstance> {
  return buildRouteTestApp((app) => gatewayKeyRoutes(app), {
    user: { id: "u1", workspaceId: WS_ID, workspaceRole: role },
  });
}

const key = {
  id: KEY_ID,
  keyAlias: "optio-u1",
  keyHint: "abcd",
  models: [],
  maxBudget: 10,
  budgetDuration: "30d",
  expiresAt: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  spendUsd: null,
  budgetResetAt: null,
  checkedAt: null,
};

beforeEach(() => vi.clearAllMocks());

describe("gateway key routes", () => {
  it("keeps the gateway's key settings and its key list to admins", async () => {
    const member = await buildApp("member");
    for (const [method, url] of [
      ["GET", `/api/model-providers/${GATEWAY_ID}/key-issuing`],
      ["PUT", `/api/model-providers/${GATEWAY_ID}/key-issuing`],
      ["GET", `/api/model-providers/${GATEWAY_ID}/keys`],
      ["DELETE", `/api/model-providers/${GATEWAY_ID}/keys/${KEY_ID}`],
    ] as const) {
      const res = await member.inject({ method, url, payload: method === "PUT" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(svc.getKeyIssuing).not.toHaveBeenCalled();
    expect(svc.saveKeyIssuing).not.toHaveBeenCalled();
    expect(svc.listIssuedKeys).not.toHaveBeenCalled();
    expect(svc.adminRevokeKey).not.toHaveBeenCalled();
  });

  it("takes no field it doesn't know in the defaults", async () => {
    const admin = await buildApp("admin");
    const res = await admin.inject({
      method: "PUT",
      url: `/api/model-providers/${GATEWAY_ID}/key-issuing`,
      payload: { defaults: { maxBudget: 5, teamMaxBudget: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(svc.saveKeyIssuing).not.toHaveBeenCalled();
  });

  it("lets a viewer read their status but not make a key; a member makes their own", async () => {
    const viewer = await buildApp("viewer");
    svc.myGatewayKeyStatus.mockResolvedValue({
      gateway: null,
      modes: { personalPasted: true, optioIssued: false },
      canIssue: false,
      issued: null,
      defaults: { maxBudget: null, budgetDuration: null, keyDuration: null },
    });
    expect((await viewer.inject({ method: "GET", url: "/api/gateway/me/key" })).statusCode).toBe(
      200,
    );
    expect((await viewer.inject({ method: "POST", url: "/api/gateway/me/key" })).statusCode).toBe(
      403,
    );

    const member = await buildApp("member");
    svc.issuePersonalKey.mockResolvedValue({
      action: "issue",
      key,
      test: { ok: true, modelCount: 2 },
      // A value that slipped in is not serialized.
      value: "sk-secret",
    });
    const res = await member.inject({
      method: "POST",
      url: "/api/gateway/me/key",
      payload: { providerId: GATEWAY_ID, maxBudget: 1_000_000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sk-secret");
    expect(svc.issuePersonalKey).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", isAdmin: false }),
      { providerId: GATEWAY_ID },
    );
  });

  it("answers a service refusal with its status", async () => {
    const member = await buildApp("member");
    const { GatewayKeyError } = await import("../services/gateway-keys.js");
    svc.issuePersonalKey.mockRejectedValue(new GatewayKeyError("busy", 409));
    const res = await member.inject({ method: "POST", url: "/api/gateway/me/key/rotate" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "busy" });
  });
});
