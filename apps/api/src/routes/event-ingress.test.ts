import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockFire = vi.fn();
vi.mock("../services/event-trigger-service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/event-trigger-service.js")>(
    "../services/event-trigger-service.js",
  );
  return { ...actual, fireEventTriggers: (...args: unknown[]) => mockFire(...args) };
});
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));

import {
  eventIngressRoutes,
  resetSlackEventDedupe,
  verifyLinearSignature,
  verifySlackSignature,
} from "./event-ingress.js";

const SLACK_SECRET = "slack-signing";
const LINEAR_SECRET = "linear-secret";

function slackHeaders(raw: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": `v0=${sig}`,
  };
}

function linearHeaders(raw: string) {
  return {
    "content-type": "application/json",
    "linear-signature": createHmac("sha256", LINEAR_SECRET).update(raw).digest("hex"),
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
  process.env.LINEAR_WEBHOOK_SECRET = LINEAR_SECRET;
  mockFire.mockReset().mockResolvedValue([]);
  resetSlackEventDedupe();
  app = await buildRouteTestApp(eventIngressRoutes, { user: null });
});

afterEach(async () => {
  await app.close();
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRET;
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("signature helpers", () => {
  it("verifies Slack v0 signatures and rejects stale timestamps", () => {
    const raw = Buffer.from('{"a":1}');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:{"a":1}`).digest("hex")}`;
    expect(verifySlackSignature(raw, ts, sig, SLACK_SECRET)).toBe(true);
    expect(verifySlackSignature(raw, ts, sig, "other")).toBe(false);
    expect(verifySlackSignature(raw, ts, sig, SLACK_SECRET, Date.now() + 10 * 60 * 1000)).toBe(
      false,
    );
    expect(verifySlackSignature(raw, undefined, sig, SLACK_SECRET)).toBe(false);
  });

  it("verifies Linear signatures and the 60 s timestamp window", () => {
    const raw = Buffer.from('{"webhookTimestamp":1}');
    const sig = createHmac("sha256", LINEAR_SECRET).update(raw).digest("hex");
    expect(verifyLinearSignature(raw, sig, LINEAR_SECRET, Date.now())).toBe(true);
    expect(verifyLinearSignature(raw, sig, LINEAR_SECRET, Date.now() - 5 * 60 * 1000)).toBe(false);
    expect(verifyLinearSignature(raw, "00", LINEAR_SECRET, Date.now())).toBe(false);
  });
});

describe("POST /api/webhooks/slack/events", () => {
  it("answers the url_verification challenge", async () => {
    const raw = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: slackHeaders(raw),
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: "abc" });
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("rejects bad signatures and a missing secret", async () => {
    const raw = JSON.stringify({ type: "event_callback" });
    const bad = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: { ...slackHeaders(raw), "x-slack-signature": "v0=00" },
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);

    delete process.env.SLACK_SIGNING_SECRET;
    const unset = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: slackHeaders(raw),
      payload: raw,
    });
    expect(unset.statusCode).toBe(401);
  });

  it("dispatches human messages once, ignoring retries and duplicate event ids", async () => {
    const raw = JSON.stringify({
      type: "event_callback",
      event_id: "Ev42",
      event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.0" },
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: slackHeaders(raw),
      payload: raw,
    });
    expect(first.statusCode).toBe(200);
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire).toHaveBeenCalledWith(
      "slack",
      expect.objectContaining({ channelId: "C1", text: "hi", eventId: "Ev42" }),
    );

    await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: slackHeaders(raw),
      payload: raw,
    });
    await app.inject({
      method: "POST",
      url: "/api/webhooks/slack/events",
      headers: { ...slackHeaders(raw), "x-slack-retry-num": "1" },
      payload: raw,
    });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/linear", () => {
  it("verifies the signature and dispatches issue events", async () => {
    const raw = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        identifier: "ENG-1",
        title: "t",
        url: "https://linear.app/x",
        assignee: { id: "u1" },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/linear",
      headers: linearHeaders(raw),
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(mockFire).toHaveBeenCalledWith(
      "linear",
      expect.objectContaining({ identifier: "ENG-1", kinds: expect.arrayContaining(["created"]) }),
    );
  });

  it("rejects a tampered body", async () => {
    const raw = JSON.stringify({ action: "create", type: "Issue", webhookTimestamp: Date.now() });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/linear",
      headers: linearHeaders(raw),
      payload: raw.replace("create", "update"),
    });
    expect(res.statusCode).toBe(401);
    expect(mockFire).not.toHaveBeenCalled();
  });
});
