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
// `claimDelivery` also claims the id in Redis (SET NX); every claim is first here.
const mockRedisSet = vi.fn();
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({ set: (...args: unknown[]) => mockRedisSet(...args) }),
}));

import {
  eventIngressRoutes,
  resetSlackEventDedupe,
  verifyLinearSignature,
  verifySlackSignature,
} from "./event-ingress.js";

const SLACK_SECRET = "slack-signing";
const LINEAR_SECRET = "linear-secret";
const PAGERDUTY_SECRET = "pd-secret";

function pagerDutyHeaders(raw: string, id = "wh-1", secret = PAGERDUTY_SECRET) {
  return {
    "content-type": "application/json",
    "x-webhook-id": id,
    "x-pagerduty-signature": `v1=${createHmac("sha256", secret).update(raw).digest("hex")}`,
  };
}

const pagerDutyIncident = (eventType = "incident.triggered", id = "PINC1") =>
  JSON.stringify({
    event: {
      id: `ev-${id}`,
      event_type: eventType,
      data: {
        id,
        type: "incident",
        incident_number: 42,
        title: "Checkout latency",
        html_url: `https://acme.pagerduty.com/incidents/${id}`,
        urgency: "high",
        status: "triggered",
        service: { id: "PSVC1", summary: "Checkout" },
        assignees: [{ summary: "Alice" }],
      },
    },
  });

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
  process.env.PAGERDUTY_WEBHOOK_SECRET = PAGERDUTY_SECRET;
  mockFire.mockReset().mockResolvedValue([]);
  mockRedisSet.mockReset().mockResolvedValue("OK");
  resetSlackEventDedupe();
  app = await buildRouteTestApp(eventIngressRoutes, { user: null });
});

afterEach(async () => {
  await app.close();
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRET;
  delete process.env.PAGERDUTY_WEBHOOK_SECRET;
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

describe("POST /api/webhooks/pagerduty", () => {
  it("verifies the signature and dispatches the normalized incident event", async () => {
    const raw = pagerDutyIncident();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw),
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(mockFire).toHaveBeenCalledWith(
      "pagerduty",
      expect.objectContaining({
        kind: "incident.triggered",
        id: "PINC1",
        incidentNumber: 42,
        title: "Checkout latency",
        service: "Checkout",
        serviceId: "PSVC1",
        urgency: "high",
        assignees: ["Alice"],
        eventId: "ev-PINC1",
      }),
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      "optio:webhook-delivery:pagerduty:wh-1",
      "1",
      "EX",
      expect.any(Number),
      "NX",
    );
  });

  it("accepts a header carrying several signatures when one matches", async () => {
    const raw = pagerDutyIncident("incident.resolved", "PINC2");
    const stale = createHmac("sha256", "rotated-out").update(raw).digest("hex");
    const good = createHmac("sha256", PAGERDUTY_SECRET).update(raw).digest("hex");
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: {
        "content-type": "application/json",
        "x-webhook-id": "wh-multi",
        "x-pagerduty-signature": `v1=${stale},v1=${good}`,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(mockFire).toHaveBeenCalledWith(
      "pagerduty",
      expect.objectContaining({ kind: "incident.resolved", id: "PINC2" }),
    );
  });

  it("rejects a bad or absent signature, and everything when the secret is unset", async () => {
    const raw = pagerDutyIncident();
    const forged = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw, "wh-forged", "not-the-secret"),
      payload: raw,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe("Invalid PagerDuty signature");

    const unsigned = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(unsigned.statusCode).toBe(401);

    delete process.env.PAGERDUTY_WEBHOOK_SECRET;
    const unset = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw, "wh-unset"),
      payload: raw,
    });
    expect(unset.statusCode).toBe(401);
    expect(unset.json().error).toMatch(/not configured/);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it("drops a redelivery with the same X-Webhook-Id", async () => {
    const raw = pagerDutyIncident();
    const first = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw, "wh-dup"),
      payload: raw,
    });
    expect(first.json()).toEqual({ ok: true });
    const again = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw, "wh-dup"),
      payload: raw,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    await flush();
    expect(mockFire).toHaveBeenCalledTimes(1);
  });

  it("acks events it doesn't act on (pings, unknown types) without dispatching", async () => {
    const raw = JSON.stringify({ event: { id: "ping-1", event_type: "pagey.ping", data: {} } });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/pagerduty",
      headers: pagerDutyHeaders(raw, "wh-ping"),
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(mockFire).not.toHaveBeenCalled();
  });
});
