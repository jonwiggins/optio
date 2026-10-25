import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { isPublicRoute } from "../plugins/auth.js";
import { featureRoutes } from "./features.js";

const FEATURE_ENV = [
  "OPTIO_RUNTIMES",
  "OPTIO_GIT_PLATFORMS",
  "OPTIO_TRIGGERS",
  "OPTIO_TICKET_SOURCES",
  "OPTIO_CONNECTION_PROVIDERS",
  "OPTIO_FEATURE_PRESET",
  "OPTIO_MODEL_ACCESS",
  "OPTIO_AGENT_POLICY_DEFAULTS",
];

describe("GET /api/features", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    for (const name of FEATURE_ENV) vi.stubEnv(name, "");
    app = await buildRouteTestApp(featureRoutes);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("offers everything with nothing set: 7 runtimes, 3 platforms, 14 triggers, 5 sources, 12 connections", async () => {
    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      "agentPolicyDefaults",
      "connectionProviders",
      "gitPlatforms",
      "modelAccess",
      "runtimes",
      "ticketSources",
      "triggers",
    ]);
    expect(body.runtimes).toHaveLength(7);
    expect(body.gitPlatforms).toEqual(["github", "gitlab", "codecommit"]);
    expect(body.triggers).toHaveLength(14);
    expect(body.ticketSources).toHaveLength(5);
    expect(body.connectionProviders).toHaveLength(12);
    expect(body.modelAccess).toBe("any");
    expect(body.agentPolicyDefaults).toBe(false);
  });

  it("answers the lists and switches an admin set", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "true");
    const body = (await app.inject({ method: "GET", url: "/api/features" })).json();
    expect(body.runtimes).toEqual(["claude-code", "opencode"]);
    expect(body.gitPlatforms).toEqual(["gitlab"]);
    expect(body.triggers).toHaveLength(14);
    expect(body.modelAccess).toBe("gateway");
    expect(body.agentPolicyDefaults).toBe(true);
  });

  it("needs a session: it is not one of the public routes", () => {
    expect(isPublicRoute("/api/features", "GET")).toBe(false);
    expect(isPublicRoute("/api/features?x=1", "GET")).toBe(false);
  });
});
