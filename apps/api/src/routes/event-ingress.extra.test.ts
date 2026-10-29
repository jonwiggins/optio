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
