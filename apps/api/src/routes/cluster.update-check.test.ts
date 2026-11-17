import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// The in-app update and the version route with OPTIO_UPDATE_CHECK on and off.

const mockPatchNamespacedDeployment = vi.fn();

vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: vi.fn().mockResolvedValue(true),
  hasDeploymentAdmin: vi.fn().mockResolvedValue(true),
  isFoundingWorkspaceAdmin: vi.fn().mockResolvedValue(false),
}));

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn().mockImplementation(function () {
    return {
      loadFromDefault: vi.fn(),
      makeApiClient: vi.fn().mockReturnValue({
        patchNamespacedDeployment: mockPatchNamespacedDeployment,
      }),
    };
  }),
  CoreV1Api: vi.fn(),
  AppsV1Api: vi.fn(),
  CustomObjectsApi: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/agent-pod-pool.js", () => ({
  getPod: vi.fn(),
  listPods: vi.fn(),
  deletePod: vi.fn(),
}));

import { clusterRoutes } from "./cluster.js";
import { resetVersionCache } from "../services/version-service.js";

const fetchMock = vi.fn();
let app: FastifyInstance;

beforeEach(async () => {
  resetVersionCache();
  fetchMock.mockReset().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPTIO_VERSION", "1.0.0");
  mockPatchNamespacedDeployment.mockReset().mockResolvedValue({});
  app = await buildRouteTestApp(clusterRoutes, {
    user: { id: "u1", workspaceId: null, workspaceRole: "admin" },
  });
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OPTIO_UPDATE_CHECK=false", () => {
  beforeEach(() => {
    vi.stubEnv("OPTIO_UPDATE_CHECK", "false");
  });

  it("refuses the in-app update without touching the Deployment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cluster/update",
      payload: { targetVersion: "1.2.0" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("managed by the deployment");
    expect(mockPatchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("serves the version with the check off and no outbound request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cluster/version" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      current: "1.0.0",
      latest: null,
      updateAvailable: false,
      updateCheck: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("update check on (the default)", () => {
  it("still rolls the Deployment on request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cluster/update",
      payload: { targetVersion: "1.2.0" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockPatchNamespacedDeployment).toHaveBeenCalledTimes(1);
  });
});
