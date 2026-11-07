import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// Sharing a deployment secret: a deployment admin's choice, logged, with the
// service's refusals passed through. The rules themselves are in
// services/secret-sharing.int.test.ts.

const mockIsDeploymentAdmin = vi.fn().mockResolvedValue(true);
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...args: unknown[]) => mockIsDeploymentAdmin(...args),
  hasDeploymentAdmin: vi.fn().mockResolvedValue(true),
  isFoundingWorkspaceAdmin: vi.fn().mockResolvedValue(false),
}));

const mockList = vi.fn();
const mockSet = vi.fn();
vi.mock("../services/secret-service.js", () => {
  class SecretSharingError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    SecretSharingError,
    listDeploymentSecretSharing: (...args: unknown[]) => mockList(...args),
    setDeploymentSecretSharing: (...args: unknown[]) => mockSet(...args),
  };
});

const mockLogAction = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/optio-action-service.js", () => ({
  logAction: (...args: unknown[]) => mockLogAction(...args),
}));
vi.mock("../services/event-bus.js", () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));

import { secretRoutes } from "./secrets.js";
import { SecretSharingError } from "../services/secret-service.js";

const WS = "11111111-1111-4111-8111-111111111111";

describe("deployment secret sharing routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsDeploymentAdmin.mockResolvedValue(true);
    app = await buildRouteTestApp(secretRoutes);
  });

  it("lists who each secret is shared with, for a deployment admin", async () => {
    const body = {
      secrets: [{ name: "REGISTRY_TOKEN", all: false, workspaceIds: [WS] }],
      allApplies: false,
      workspaces: [{ id: WS, name: "Team A", slug: "team-a" }],
    };
    mockList.mockResolvedValue(body);
    const res = await app.inject({ method: "GET", url: "/api/secrets/sharing" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it("shares a secret and logs who it went to", async () => {
    mockSet.mockResolvedValue({ name: "REGISTRY_TOKEN", all: false, workspaceIds: [WS] });
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets/REGISTRY_TOKEN/sharing",
      payload: { all: false, workspaceIds: [WS] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "REGISTRY_TOKEN", all: false, workspaceIds: [WS] });
    expect(mockSet).toHaveBeenCalledWith("REGISTRY_TOKEN", { all: false, workspaceIds: [WS] });
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "secret.share",
        userId: "user-1",
        params: { name: "REGISTRY_TOKEN", scope: "global" },
        result: { name: "REGISTRY_TOKEN", all: false, workspaceIds: [WS] },
        success: true,
      }),
    );
  });

  it("refuses anyone but a deployment admin, workspace admins included", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(false);
    const list = await app.inject({ method: "GET", url: "/api/secrets/sharing" });
    expect(list.statusCode).toBe(403);
    const put = await app.inject({
      method: "PUT",
      url: "/api/secrets/REGISTRY_TOKEN/sharing",
      payload: { all: true, workspaceIds: [] },
    });
    expect(put.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  it("passes the service's refusals through, unlogged", async () => {
    for (const status of [400, 404, 409] as const) {
      mockSet.mockRejectedValueOnce(new SecretSharingError(`refused ${status}`, status));
      const res = await app.inject({
        method: "PUT",
        url: "/api/secrets/REGISTRY_TOKEN/sharing",
        payload: { all: true },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json().error).toBe(`refused ${status}`);
    }
    expect(mockLogAction).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/secrets/REGISTRY_TOKEN/sharing",
      payload: { all: "yes", workspaceIds: ["not-a-uuid"] },
    });
    expect(res.statusCode).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
