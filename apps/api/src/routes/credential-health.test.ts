import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// The credential-health routes: what each viewer is shown, and Check now.

const svc = vi.hoisted(() => ({
  listChecks: vi.fn(),
  checkMine: vi.fn(),
  isDeploymentAdmin: vi.fn(),
}));
vi.mock("../services/credential-health/store.js", async (orig) => ({
  ...(await orig<typeof import("../services/credential-health/store.js")>()),
  listChecks: (...a: unknown[]) => svc.listChecks(...a),
}));
vi.mock("../services/credential-health/run.js", () => ({
  checkMine: (...a: unknown[]) => svc.checkMine(...a),
  checkIntervalMs: () => 15 * 60_000,
}));
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...a: unknown[]) => svc.isDeploymentAdmin(...a),
}));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

import { credentialHealthRoutes } from "./credential-health.js";

const WS = "22222222-2222-4222-8222-222222222222";

async function buildApp(role: "admin" | "member" | "viewer"): Promise<FastifyInstance> {
  return buildRouteTestApp((app) => credentialHealthRoutes(app), {
    user: { id: "u1", workspaceId: WS, workspaceRole: role },
  });
}

const row = {
  id: "r1",
  credentialKey: "gateway:g1:user:u1",
  kind: "gateway",
  label: "Gateway token · Corp (LiteLLM)",
  scope: "person",
  workspaceId: WS,
  userId: "u1",
  status: "warning",
  reason: "Expires in 5 days",
  expiresAt: new Date("2026-10-29T12:00:00Z"),
  details: { spend: 9, maxBudget: 10, token: "must-not-show" },
  notified: { "expiry:7:2026-10-29": "x" },
  checkedAt: new Date("2026-10-24T12:00:00Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  Object.values(svc).forEach((f) => f.mockReset());
  svc.isDeploymentAdmin.mockResolvedValue(false);
});

describe("credential health routes", () => {
  it("asks for the viewer's rows by their role, and shows no detail off the allowlist", async () => {
    svc.listChecks.mockResolvedValue([row]);
    const member = await buildApp("member");
    const res = await member.inject({ method: "GET", url: "/api/credential-health" });
    expect(res.statusCode).toBe(200);
    expect(svc.listChecks).toHaveBeenCalledWith({
      userId: "u1",
      workspaceId: WS,
      isWorkspaceAdmin: false,
      deploymentAdmin: false,
    });
    const body = res.json();
    expect(body.checks[0]).toMatchObject({ status: "warning", details: { spend: 9 } });
    expect(res.body).not.toContain("must-not-show");
    expect(res.body).not.toContain("notified");

    const admin = await buildApp("admin");
    await admin.inject({ method: "GET", url: "/api/credential-health" });
    expect(svc.listChecks).toHaveBeenLastCalledWith(
      expect.objectContaining({ isWorkspaceAdmin: true }),
    );
  });

  it("checks the caller's own tokens; a viewer can't", async () => {
    svc.checkMine.mockResolvedValue([row]);
    const member = await buildApp("member");
    const res = await member.inject({ method: "POST", url: "/api/credential-health/me/check" });
    expect(res.statusCode).toBe(200);
    expect(svc.checkMine).toHaveBeenCalledWith("u1");
    const viewer = await buildApp("viewer");
    expect(
      (await viewer.inject({ method: "POST", url: "/api/credential-health/me/check" })).statusCode,
    ).toBe(403);
  });
});
