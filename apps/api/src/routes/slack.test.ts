import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockHandleSlackAction = vi.fn();
const mockSendSlackNotification = vi.fn();
const mockGetGlobalSlackWebhookUrl = vi.fn();

vi.mock("../services/slack-service.js", () => ({
  handleSlackAction: (...args: unknown[]) => mockHandleSlackAction(...args),
  sendSlackNotification: (...args: unknown[]) => mockSendSlackNotification(...args),
  getGlobalSlackWebhookUrl: (...args: unknown[]) => mockGetGlobalSlackWebhookUrl(...args),
}));

vi.mock("../logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import { slackRoutes } from "./slack.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(slackRoutes);
}

const SLACK_SECRET = "slack-signing-secret";

/** Sign a raw body the way Slack does: v0=HMAC-SHA256("v0:<ts>:<body>"). */
function slackHeaders(
  raw: string,
  contentType: string,
  opts: { ts?: number; secret?: string } = {},
): Record<string, string> {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", opts.secret ?? SLACK_SECRET)
    .update(`v0:${ts}:${raw}`)
    .digest("hex");
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${sig}`,
  };
}

/** A signed JSON delivery. */
function signedJson(body: unknown, opts: { ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: slackHeaders(raw, "application/json", opts) };
}

/** A signed form-encoded delivery — what Slack actually sends. */
function signedForm(payload: unknown) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  return { payload: raw, headers: slackHeaders(raw, "application/x-www-form-urlencoded") };
}

describe("POST /api/webhooks/slack/actions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
    app = await buildRouteTestApp(
      async (a) => {
        // Slack posts form-encoded bodies; mirror server.ts's formbody plugin.
        await a.register((await import("@fastify/formbody")).default);
        await slackRoutes(a);
      },
      { user: null },
    );
  });

  afterEach(async () => {
    await app.close();
    delete process.env.SLACK_SIGNING_SECRET;
  });

  const url = "/api/webhooks/slack/actions";

  it("handles a valid, signed Slack action", async () => {
    mockHandleSlackAction.mockResolvedValue({ text: "Task retried successfully" });

    const res = await app.inject({
      method: "POST",
      url,
      ...signedJson({ actions: [{ action_id: "retry_task", value: "task-1" }] }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe("Task retried successfully");
    expect(res.json().response_type).toBe("ephemeral");
  });

  it("handles Slack's signed form-encoded payload", async () => {
    mockHandleSlackAction.mockResolvedValue({ text: "Done" });

    const res = await app.inject({
      method: "POST",
      url,
      ...signedForm({ actions: [{ action_id: "cancel_task", value: "task-2" }] }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockHandleSlackAction).toHaveBeenCalledWith("cancel_task", "task-2");
  });

  it("rejects an unsigned request without touching tasks", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      payload: { actions: [{ action_id: "cancel_task", value: "task-1" }] },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid Slack signature");
    expect(mockHandleSlackAction).not.toHaveBeenCalled();
  });

  it("rejects a signature made with another secret", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      ...signedJson(
        { actions: [{ action_id: "cancel_task", value: "task-1" }] },
        { secret: "not-the-secret" },
      ),
    });

    expect(res.statusCode).toBe(401);
    expect(mockHandleSlackAction).not.toHaveBeenCalled();
  });

  it("rejects a body that differs from the one signed", async () => {
    const signed = signedJson({ actions: [{ action_id: "retry_task", value: "task-1" }] });
    const res = await app.inject({
      method: "POST",
      url,
      headers: signed.headers,
      payload: JSON.stringify({ actions: [{ action_id: "cancel_task", value: "task-1" }] }),
    });

    expect(res.statusCode).toBe(401);
    expect(mockHandleSlackAction).not.toHaveBeenCalled();
  });

  it("rejects a replay outside Slack's 5 minute window", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      ...signedJson(
        { actions: [{ action_id: "cancel_task", value: "task-1" }] },
        { ts: Math.floor(Date.now() / 1000) - 10 * 60 },
      ),
    });

    expect(res.statusCode).toBe(401);
    expect(mockHandleSlackAction).not.toHaveBeenCalled();
  });

  it("rejects every request when SLACK_SIGNING_SECRET is unset", async () => {
    const signed = signedJson({ actions: [{ action_id: "cancel_task", value: "task-1" }] });
    delete process.env.SLACK_SIGNING_SECRET;

    const res = await app.inject({ method: "POST", url, ...signed });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Slack signing secret not configured");
    expect(mockHandleSlackAction).not.toHaveBeenCalled();
  });

  it("returns 400 when no actions in payload", async () => {
    const res = await app.inject({ method: "POST", url, ...signedJson({ data: "no actions" }) });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("No actions in payload");
  });

  it("returns 400 when action format is invalid", async () => {
    const res = await app.inject({
      method: "POST",
      url,
      ...signedJson({ actions: [{ invalid: true }] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid action format");
  });

  it("returns 200 with error message on handler failure", async () => {
    mockHandleSlackAction.mockRejectedValue(new Error("Internal error"));

    const res = await app.inject({
      method: "POST",
      url,
      ...signedJson({ actions: [{ action_id: "retry_task", value: "task-1" }] }),
    });

    // Slack expects 200 even on error
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("error");
  });
});

describe("POST /api/slack/test", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("sends a test notification", async () => {
    mockSendSlackNotification.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/slack/test",
      payload: { webhookUrl: "https://hooks.slack.com/services/xxx" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("returns 400 on notification failure", async () => {
    mockSendSlackNotification.mockRejectedValue(new Error("Invalid webhook URL"));

    const res = await app.inject({
      method: "POST",
      url: "/api/slack/test",
      payload: { webhookUrl: "https://hooks.slack.com/services/xxx" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
  });
});

describe("GET /api/slack/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns Slack configuration status", async () => {
    mockGetGlobalSlackWebhookUrl.mockResolvedValue("https://hooks.slack.com/services/xxx");

    const res = await app.inject({ method: "GET", url: "/api/slack/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().globalWebhookConfigured).toBe(true);
  });

  it("returns false when no global webhook is configured", async () => {
    mockGetGlobalSlackWebhookUrl.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/slack/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().globalWebhookConfigured).toBe(false);
  });
});
