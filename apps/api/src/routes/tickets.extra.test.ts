import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({}),
  publishEvent: vi.fn(),
}));
// This feature-list test acts as an authorized deployment administrator;
// deployment-wide credential authorization is covered by the upstream route tests.
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: vi.fn(async () => true),
  hasDeploymentAdmin: vi.fn(async () => true),
  isFoundingWorkspaceAdmin: vi.fn(async () => false),
}));
// Every receiver claims the delivery id in the database first
// (services/inbound-delivery-service.ts); the claim is a set here.
const claimed = new Set<string>();
const mockClaim = vi.fn(async (source: string, id: string) => {
  const key = `${source}:${id}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
});
vi.mock("../services/inbound-delivery-service.js", () => ({
  claimInboundDelivery: (...args: unknown[]) => mockClaim(...(args as [string, string])),
}));

// The connection test reads one provider row, resolves its credentials the
// way the sync does, and asks the provider.
const providerTest = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  resolveProviderConfig: vi.fn(),
  getTicketProvider: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: { select: () => ({ from: () => ({ where: async () => providerTest.rows }) }) },
}));
vi.mock("../services/ticket-sync-service.js", () => ({
  syncAllTickets: vi.fn(),
  resolveProviderConfig: (...args: unknown[]) => providerTest.resolveProviderConfig(...args),
}));
vi.mock("@optio/ticket-providers", () => ({
  getTicketProvider: (...args: unknown[]) => providerTest.getTicketProvider(...args),
  jiraConfigProblem: () => null,
}));

import { ticketRoutes } from "./tickets.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

describe("ticket routes with the independent feature lists narrowed", () => {
  let app: import("fastify").FastifyInstance;

  async function build(preset: "minimal" | "", user?: null) {
    vi.stubEnv("OPTIO_TRIGGERS", preset ? "manual,gitlab" : "");
    vi.stubEnv("OPTIO_TICKET_SOURCES", preset ? "gitlab,jira" : "");
    app = await buildRouteTestApp(ticketRoutes, user === null ? { user: null } : {});
  }

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  it("never registers the GitHub receiver: a delivery answers 404", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "s";
    await build("minimal", null);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);

    await app.close();
    await build("", null);
    const full = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(full.statusCode).toBe(401); // there, and asking for a signature
  });

  it("refuses a ticket source outside the list; the default offers it", async () => {
    const linear = { source: "linear", config: { apiKey: "lin_api_x" } };
    await build("minimal");
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: linear,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("linear isn't available in this deployment");

    await app.close();
    await build("");
    const full = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: linear,
    });
    expect(full.json().error ?? "").not.toMatch(/isn't available/);
  });
});
