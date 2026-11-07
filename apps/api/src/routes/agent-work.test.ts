import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { buildServer } from "../server.js";
import { START_ROUTES } from "../services/agent-work-pause.js";

// Avoid touching Redis during the build (as routes/openapi.test.ts).
process.env.OPTIO_SKIP_RATE_LIMIT_REDIS = "1";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("agent work pause routes", () => {
  it("every interactive start it refuses while paused is a real route", () => {
    // A renamed or moved start route must move here too, or it would start
    // work while paused (services/agent-work-pause.ts START_ROUTES).
    for (const entry of START_ROUTES) {
      const [method, url] = entry.split(" ");
      expect(app.hasRoute({ method: method as HTTPMethods, url }), entry).toBe(true);
    }
  });

  it("serves the pause state, the switch and stop everything", () => {
    expect(app.hasRoute({ method: "GET", url: "/api/agent-work/pause" })).toBe(true);
    expect(app.hasRoute({ method: "PUT", url: "/api/agent-work/pause" })).toBe(true);
    expect(app.hasRoute({ method: "POST", url: "/api/agent-work/stop" })).toBe(true);
  });
});
