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

  it("offers everything with nothing set: 8 runtimes, 3 platforms, 14 triggers, 5 sources, 13 connections", async () => {
    const res = await app.inject({ method: "GET", url: "/api/features" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      "connectionProviders",
      "gitPlatforms",
      "runtimes",
      "ticketSources",
      "triggers",
    ]);
    expect(body.runtimes).toHaveLength(8);
    expect(body.gitPlatforms).toEqual(["github", "gitlab", "codecommit"]);
    expect(body.triggers).toHaveLength(14);
    expect(body.ticketSources).toHaveLength(5);
    expect(body.connectionProviders).toHaveLength(13);
  });

  it("answers the independent lists an admin set", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    const body = (await app.inject({ method: "GET", url: "/api/features" })).json();
    expect(body.runtimes).toEqual(["claude-code", "opencode"]);
    expect(body.gitPlatforms).toEqual(["gitlab"]);
    expect(body.triggers).toHaveLength(14);
  });

  it("needs a session: it is not one of the public routes", () => {
    expect(isPublicRoute("/api/features", "GET")).toBe(false);
    expect(isPublicRoute("/api/features?x=1", "GET")).toBe(false);
  });
});
