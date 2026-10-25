import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({}),
  publishEvent: vi.fn(),
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

import { verifyGitHubSignature } from "./tickets.js";

describe("verifyGitHubSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ action: "labeled" }));

  function sign(payload: Buffer, key: string): string {
    return "sha256=" + createHmac("sha256", key).update(payload).digest("hex");
  }

  it("accepts a valid signature", async () => {
    const signature = sign(body, secret);
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const signature = sign(body, "wrong-secret");
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a completely invalid signature string", async () => {
    expect(await verifyGitHubSignature(body, "sha256=invalid", secret)).toBe(false);
  });

  it("rejects when body differs from what was signed", async () => {
    const signature = sign(Buffer.from("different body"), secret);
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a signature with wrong length", async () => {
    expect(await verifyGitHubSignature(body, "sha256=abc", secret)).toBe(false);
  });
});

// The receiver is public (plugins/auth.ts PUBLIC_WEBHOOK_RECEIVERS), so its
// own signature check is the only thing between the internet and it.
describe("POST /api/webhooks/github (signature enforcement)", () => {
  const secret = "route-webhook-secret";
  const url = "/api/webhooks/github";
  const raw = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const sign = (body: string, key = secret) =>
    "sha256=" + createHmac("sha256", key).update(body).digest("hex");

  let app: import("fastify").FastifyInstance;

  beforeEach(async () => {
    claimed.clear();
    mockClaim.mockClear();
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    const { buildRouteTestApp } = await import("../test-utils/build-route-test-app.js");
    const { ticketRoutes } = await import("./tickets.js");
    app = await buildRouteTestApp(ticketRoutes, { user: null });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  const deliver = (headers: Record<string, string>, body = raw) =>
    app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", "x-github-event": "ping", ...headers },
      payload: body,
    });

  it("accepts a correctly signed delivery", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects an unsigned delivery", async () => {
    const res = await deliver({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Missing signature");
  });

  it("rejects a delivery signed with another secret", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw, "attacker-secret") });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  it("rejects a body that differs from the one signed", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw) }, raw.replace("awesome", "evil"));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  it("drops a replayed delivery id without re-processing it", async () => {
    const headers = { "x-hub-signature-256": sign(raw), "x-github-delivery": "guid-1" };
    expect((await deliver(headers)).statusCode).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0]).toEqual(["github", "guid-1"]);
    // Replay: answered 200 but the claim is a conflict.
    expect((await deliver(headers)).json()).toEqual({ ok: true });
    expect(mockClaim).toHaveBeenCalledTimes(2);
  });

  it("drops a delivery another replica (or a previous process) already claimed", async () => {
    claimed.add("github:guid-2");
    const res = await deliver({ "x-hub-signature-256": sign(raw), "x-github-delivery": "guid-2" });
    expect(res.statusCode).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
  });

  it("rejects every delivery when GITHUB_WEBHOOK_SECRET is unset", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const res = await deliver({ "x-hub-signature-256": sign(raw) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Webhook secret not configured");
  });
});

describe("POST /api/tickets/providers/:id/test", () => {
  const row = {
    id: "p1",
    source: "jira",
    config: { baseUrl: "https://jira.example.com/jira", deployment: "server" },
    enabled: true,
  };

  let app: import("fastify").FastifyInstance;

  type TestUser = {
    id: string;
    workspaceId: string | null;
    workspaceRole: "admin" | "member" | "viewer";
  };

  async function build(user?: TestUser) {
    const { buildRouteTestApp } = await import("../test-utils/build-route-test-app.js");
    const { ticketRoutes } = await import("./tickets.js");
    app = await buildRouteTestApp(ticketRoutes, user === undefined ? {} : { user });
  }

  beforeEach(() => {
    providerTest.rows = [row];
    providerTest.resolveProviderConfig.mockReset();
    providerTest.getTicketProvider.mockReset();
    providerTest.resolveProviderConfig.mockImplementation(async (r: { config: object }) => ({
      ...r.config,
      apiToken: "pat-from-secret",
    }));
  });

  afterEach(async () => {
    await app?.close();
  });

  it("tests the provider with the row's config and its encrypted credentials", async () => {
    const testConnection = vi.fn().mockResolvedValue({
      ok: true,
      serverTitle: "Corp Jira",
      version: "9.12.4",
      deploymentType: "Server",
      user: "Optio Bot",
    });
    providerTest.getTicketProvider.mockReturnValue({ testConnection });
    await build();

    const res = await app.inject({ method: "POST", url: "/api/tickets/providers/p1/test" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      serverTitle: "Corp Jira",
      version: "9.12.4",
      deploymentType: "Server",
      user: "Optio Bot",
    });
    expect(providerTest.getTicketProvider).toHaveBeenCalledWith("jira");
    expect(providerTest.resolveProviderConfig).toHaveBeenCalledWith(row);
    expect(testConnection).toHaveBeenCalledWith({
      baseUrl: "https://jira.example.com/jira",
      deployment: "server",
      apiToken: "pat-from-secret",
    });
  });

  it("answers 200 with ok: false and the reason when the test fails", async () => {
    providerTest.getTicketProvider.mockReturnValue({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        error: "Authentication failed (401): check the token, or the username and password",
      }),
    });
    await build();

    const res = await app.inject({ method: "POST", url: "/api/tickets/providers/p1/test" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: expect.stringContaining("401") });
  });

  it("says so for a provider without a connection test", async () => {
    providerTest.rows = [{ ...row, source: "linear" }];
    providerTest.getTicketProvider.mockReturnValue({});
    await build();

    const res = await app.inject({ method: "POST", url: "/api/tickets/providers/p1/test" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, error: "linear providers have no connection test" });
    expect(providerTest.resolveProviderConfig).not.toHaveBeenCalled();
  });

  it("404s for an unknown provider", async () => {
    providerTest.rows = [];
    await build();

    const res = await app.inject({ method: "POST", url: "/api/tickets/providers/nope/test" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Provider not found" });
    expect(providerTest.getTicketProvider).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    providerTest.getTicketProvider.mockReturnValue({ testConnection: vi.fn() });
    await build({ id: "user-2", workspaceId: "ws-1", workspaceRole: "member" });

    const res = await app.inject({ method: "POST", url: "/api/tickets/providers/p1/test" });

    expect(res.statusCode).toBe(403);
    expect(providerTest.resolveProviderConfig).not.toHaveBeenCalled();
  });
});

describe("ticket routes with the feature lists narrowed (the minimal preset)", () => {
  let app: import("fastify").FastifyInstance;

  async function build(preset: "minimal" | "", user?: null) {
    vi.stubEnv("OPTIO_FEATURE_PRESET", preset);
    const { buildRouteTestApp } = await import("../test-utils/build-route-test-app.js");
    const { ticketRoutes } = await import("./tickets.js");
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
