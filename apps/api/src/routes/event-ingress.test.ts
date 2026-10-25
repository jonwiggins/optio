import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockPersist = vi.fn();
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/trigger-dispatch.js", () => ({ fireTrigger: vi.fn() }));
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

// The receiver waits for durable acceptance; dispatch is tested against Postgres.
vi.mock("../services/trigger-delivery.js", () => ({
  acceptTriggerEvent: async (source: string, id: string, event: unknown) => {
    if (!(await mockClaim(source, id))) return { duplicate: true };
    try {
      await mockPersist(source, event);
    } catch (err) {
      claimed.delete(`${source}:${id}`);
      throw err;
    }
    return {};
  },
}));

// What a GitLab hook means for Optio's own work (services/gitlab-hook-updates.ts).
const mockGitLabHookUpdates = vi.fn(async (_body: unknown) => {});
vi.mock("../services/gitlab-hook-updates.js", () => ({
  applyGitLabHookUpdates: (body: unknown) => mockGitLabHookUpdates(body),
}));

// The GitLab receiver falls back to the secret Optio generated for the hooks
// it creates (services/webhook-secret-service.ts), a global secret.
const mockRetrieveSecret = vi.fn();
vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
  storeSecret: vi.fn(),
}));

import {
  eventIngressRoutes,
  verifyLinearSignature,
  verifySlackSignature,
} from "./event-ingress.js";
import { resetGitlabWebhookSecretCache } from "../services/webhook-secret-service.js";

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
  mockPersist.mockReset().mockResolvedValue([]);
  mockClaim.mockClear();
  claimed.clear();
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
    expect(mockPersist).not.toHaveBeenCalled();
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

  it("persists human messages once, ignoring retries and duplicate event ids", async () => {
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
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist).toHaveBeenCalledWith(
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
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });
});

it("does not acknowledge a failed durable write and accepts a Slack retry", async () => {
  const raw = JSON.stringify({
    type: "event_callback",
    event_id: "Retry42",
    event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.0" },
  });
  mockPersist.mockRejectedValueOnce(Error("database unavailable"));
  const first = await app.inject({
    method: "POST",
    url: "/api/webhooks/slack/events",
    headers: slackHeaders(raw),
    payload: raw,
  });
  expect(first.statusCode).toBe(500);
  const retry = await app.inject({
    method: "POST",
    url: "/api/webhooks/slack/events",
    headers: { ...slackHeaders(raw), "x-slack-retry-num": "1" },
    payload: raw,
  });
  expect(retry.statusCode).toBe(200);
  expect(retry.json().duplicate).not.toBe(true);
  expect(mockPersist).toHaveBeenCalledTimes(2);
});

describe("POST /api/webhooks/linear", () => {
  it("verifies the signature and persists issue events", async () => {
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
    expect(mockPersist).toHaveBeenCalledWith(
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
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/pagerduty", () => {
  it("verifies the signature and persists the normalized incident event", async () => {
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
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist).toHaveBeenCalledWith(
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
    expect(mockClaim).toHaveBeenCalledWith("pagerduty", "wh-1");
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
    expect(mockPersist).toHaveBeenCalledWith(
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
    expect(mockPersist).not.toHaveBeenCalled();
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
    expect(mockPersist).toHaveBeenCalledTimes(1);
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
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/gitlab with the secret Optio generated", () => {
  const push = JSON.stringify({
    object_kind: "push",
    ref: "refs/heads/main",
    before: "aaaa1111",
    after: "bbbb2222",
    user_username: "alice",
    project: { path_with_namespace: "acme/optio", web_url: "https://gitlab.com/acme/optio" },
    commits: [{ id: "bbbb2222", title: "fix: x", message: "fix: x" }],
  });
  const post = (token?: string) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-gitlab-token": token } : {}),
        "x-gitlab-event-uuid": `u-${Math.random()}`,
      },
      payload: push,
    });

  beforeEach(() => {
    delete process.env.GITLAB_WEBHOOK_SECRET;
    resetGitlabWebhookSecretCache();
    mockRetrieveSecret.mockReset();
  });

  it("accepts the stored global secret when the environment has none", async () => {
    mockRetrieveSecret.mockResolvedValue("generated-token");
    const res = await post("generated-token");
    expect(res.statusCode).toBe(200);
    expect(mockRetrieveSecret).toHaveBeenCalledWith("GITLAB_WEBHOOK_SECRET", "global");
    await flush();
    expect(mockPersist).toHaveBeenCalledWith(
      "gitlab",
      expect.objectContaining({ kinds: ["push"] }),
    );
    expect((await post("other")).statusCode).toBe(401);
  });

  it("applies the hook to Optio's own work, and still acks when that fails", async () => {
    mockRetrieveSecret.mockResolvedValue("generated-token");
    mockGitLabHookUpdates.mockClear();
    expect((await post("generated-token")).statusCode).toBe(200);
    expect(mockGitLabHookUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ object_kind: "push" }),
    );
    mockGitLabHookUpdates.mockRejectedValueOnce(new Error("db down"));
    expect((await post("generated-token")).statusCode).toBe(200);
    // A refused token never reaches it
    mockGitLabHookUpdates.mockClear();
    expect((await post("wrong")).statusCode).toBe(401);
    expect(mockGitLabHookUpdates).not.toHaveBeenCalled();
  });

  it("prefers the environment's secret, and rejects everything when neither exists", async () => {
    process.env.GITLAB_WEBHOOK_SECRET = "env-token";
    mockRetrieveSecret.mockResolvedValue("generated-token");
    expect((await post("env-token")).statusCode).toBe(200);
    expect((await post("generated-token")).statusCode).toBe(401);
    expect(mockRetrieveSecret).not.toHaveBeenCalled();

    delete process.env.GITLAB_WEBHOOK_SECRET;
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    const unset = await post("generated-token");
    expect(unset.statusCode).toBe(401);
    expect(unset.json().error).toMatch(/not configured/);
  });
});

describe("receivers with OPTIO_TRIGGERS narrowed", () => {
  let restricted: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("OPTIO_TRIGGERS", "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager");
    restricted = await buildRouteTestApp(eventIngressRoutes, { user: null });
  });

  afterEach(async () => {
    await restricted.close();
    vi.unstubAllEnvs();
  });

  it("never registers the receivers of triggers it leaves out: they answer 404", async () => {
    const raw = JSON.stringify({ type: "url_verification", challenge: "abc" });
    for (const url of [
      "/api/webhooks/slack/events",
      "/api/webhooks/linear",
      "/api/webhooks/pagerduty",
    ]) {
      const res = await restricted.inject({
        method: "POST",
        url,
        headers: slackHeaders(raw),
        payload: raw,
      });
      expect(res.statusCode, url).toBe(404);
    }
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("keeps the receivers of the triggers it lists: GitLab, Jira and Sentry", async () => {
    delete process.env.GITLAB_WEBHOOK_SECRET;
    delete process.env.JIRA_WEBHOOK_SECRET;
    delete process.env.SENTRY_WEBHOOK_SECRET;
    resetGitlabWebhookSecretCache();
    mockRetrieveSecret.mockReset().mockRejectedValue(new Error("Secret not found"));
    for (const url of ["/api/webhooks/gitlab", "/api/webhooks/jira", "/api/webhooks/sentry"]) {
      const res = await restricted.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: "{}",
      });
      // Registered: it reaches the receiver, which refuses an unconfigured secret.
      expect(res.statusCode, url).toBe(401);
    }
  });
});
