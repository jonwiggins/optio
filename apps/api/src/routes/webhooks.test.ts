import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListWebhooks = vi.fn();
const mockGetWebhook = vi.fn();
const mockCreateWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();
const mockGetWebhookDeliveries = vi.fn();

vi.mock("../services/webhook-service.js", () => ({
  listWebhooks: (...args: unknown[]) => mockListWebhooks(...args),
  getWebhook: (...args: unknown[]) => mockGetWebhook(...args),
  createWebhook: (...args: unknown[]) => mockCreateWebhook(...args),
  deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
  getWebhookDeliveries: (...args: unknown[]) => mockGetWebhookDeliveries(...args),
}));

import { webhookRoutes } from "./webhooks.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(webhookRoutes);
}

describe("GET /api/webhooks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists webhooks with masked secrets", async () => {
    mockListWebhooks.mockResolvedValue([
      {
        id: "wh-1",
        url: "https://example.com/hook",
        secret: "real-secret",
        events: ["task.completed"],
      },
      { id: "wh-2", url: "https://example.com/hook2", secret: null, events: ["task.failed"] },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/webhooks" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.webhooks).toHaveLength(2);
    expect(body.webhooks[0].secret).toBe("••••••");
    expect(body.webhooks[1].secret).toBeNull();
  });
});

describe("GET /api/webhooks/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns webhook with masked secret", async () => {
    mockGetWebhook.mockResolvedValue({ id: "wh-1", secret: "real-secret" });

    const res = await app.inject({ method: "GET", url: "/api/webhooks/wh-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().webhook.secret).toBe("••••••");
  });

  it("returns 404 for nonexistent webhook", async () => {
    mockGetWebhook.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/webhooks/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for webhook from another workspace", async () => {
    mockGetWebhook.mockResolvedValue({ id: "wh-1", workspaceId: "ws-other", secret: null });

    const res = await app.inject({ method: "GET", url: "/api/webhooks/wh-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/webhooks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a webhook", async () => {
    mockCreateWebhook.mockResolvedValue({
      id: "wh-1",
      url: "https://example.com/hook",
      secret: "s",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: ["task.completed"] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().webhook.secret).toBe("••••••");
  });

  it("rejects invalid event type (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: ["invalid.event"] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects empty events array (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: [] },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/webhooks/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a webhook", async () => {
    mockGetWebhook.mockResolvedValue({ id: "wh-1", workspaceId: "ws-1" });
    mockDeleteWebhook.mockResolvedValue(true);

    const res = await app.inject({ method: "DELETE", url: "/api/webhooks/wh-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent webhook", async () => {
    mockGetWebhook.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/webhooks/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when deleting webhook from another workspace", async () => {
    mockGetWebhook.mockResolvedValue({ id: "wh-1", workspaceId: "ws-other" });

    const res = await app.inject({ method: "DELETE", url: "/api/webhooks/wh-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/webhooks/:id/deliveries", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns delivery log", async () => {
    mockGetWebhook.mockResolvedValue({ id: "wh-1" });
    mockGetWebhookDeliveries.mockResolvedValue([{ id: "del-1", success: true, statusCode: 200 }]);

    const res = await app.inject({ method: "GET", url: "/api/webhooks/wh-1/deliveries" });

    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toHaveLength(1);
  });

  it("returns 404 for nonexistent webhook", async () => {
    mockGetWebhook.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/webhooks/nonexistent/deliveries" });

    expect(res.statusCode).toBe(404);
  });
});

describe("webhook mutations require member role", () => {
  async function viewerApp(): Promise<FastifyInstance> {
    return buildRouteTestApp(webhookRoutes, {
      user: { id: "user-1", workspaceId: "ws-1", workspaceRole: "viewer" },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed getWebhook so a viewer that somehow reached the handler would still
    // resolve a webhook — proving the 403 comes from the role gate, not a 404.
    mockGetWebhook.mockResolvedValue({ id: "wh-1", workspaceId: "ws-1", secret: null, events: [] });
  });

  it("403s a viewer creating a webhook", async () => {
    const app = await viewerApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.com/hook", events: ["task.completed"] },
    });
    expect(res.statusCode).toBe(403);
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it("403s a viewer updating a webhook", async () => {
    const app = await viewerApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/webhooks/wh-1",
      payload: { events: ["task.failed"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a viewer deleting a webhook", async () => {
    const app = await viewerApp();
    const res = await app.inject({ method: "DELETE", url: "/api/webhooks/wh-1" });
    expect(res.statusCode).toBe(403);
    expect(mockDeleteWebhook).not.toHaveBeenCalled();
  });

  it("403s a viewer firing a test delivery", async () => {
    const app = await viewerApp();
    const res = await app.inject({ method: "POST", url: "/api/webhooks/wh-1/test", payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
