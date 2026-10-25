import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { FEATURE_SETTINGS } from "@optio/shared";
import { db } from "../db/client.js";
import { triggerEvents, workflowRuns } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkflow, insertWorkflowTrigger } from "../test-utils/integration/fixtures.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "../services/reconcile-queue.js";
import { getRedisClient } from "../services/event-bus.js";
import { eventIngressRoutes } from "./event-ingress.js";
import { ticketRoutes } from "./tickets.js";
import { hookRoutes } from "./hooks.js";

let app: FastifyInstance;
const secret = "feature-receivers-test-secret";
const sign = (raw: string) => createHmac("sha256", secret).update(raw).digest("hex");
const register = async (a: FastifyInstance) => {
  await eventIngressRoutes(a);
  await ticketRoutes(a);
  await hookRoutes(a);
};
beforeAll(async () => {
  for (const setting of FEATURE_SETTINGS) vi.stubEnv(setting, "");
  for (const setting of [
    "GITHUB_WEBHOOK_SECRET",
    "LINEAR_WEBHOOK_SECRET",
    "PAGERDUTY_WEBHOOK_SECRET",
    "SLACK_SIGNING_SECRET",
  ])
    vi.stubEnv(setting, secret);
  app = await buildRouteTestApp(register, { user: null });
});
afterAll(async () => {
  await app?.close();
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
  vi.unstubAllEnvs();
});

describe("event receivers with feature settings unset", () => {
  it.each(["github", "linear", "pagerduty", "slack"])(
    "accepts a signed %s delivery into Postgres",
    async (source) => {
      const id = randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      const payloads: Record<string, unknown> = {
        github: {
          ref: "refs/heads/main",
          repository: { full_name: "example/app", html_url: "https://github.com/example/app" },
          commits: [],
        },
        linear: {
          type: "Issue",
          action: "create",
          webhookTimestamp: Date.now(),
          data: {
            id,
            identifier: "APP-1",
            title: "Check build",
            url: "https://linear.example.com/APP-1",
            team: { id: "team", key: "APP" },
          },
        },
        pagerduty: {
          event: {
            id,
            event_type: "incident.triggered",
            data: {
              id,
              type: "incident",
              title: "Check build",
              html_url: "https://pagerduty.example.com/incidents/1",
            },
          },
        },
        slack: {
          type: "event_callback",
          event_id: id,
          team_id: "team",
          event: {
            type: "message",
            channel: "channel",
            user: "user",
            text: "Check build",
            ts: `${timestamp}.1`,
          },
        },
      };
      const raw = JSON.stringify(payloads[source]);
      const signatures: Record<string, Record<string, string>> = {
        github: {
          "x-hub-signature-256": `sha256=${sign(raw)}`,
          "x-github-event": "push",
          "x-github-delivery": id,
        },
        linear: { "linear-signature": sign(raw) },
        pagerduty: { "x-pagerduty-signature": `v1=${sign(raw)}`, "x-webhook-id": id },
        slack: {
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": `v0=${sign(`v0:${timestamp}:${raw}`)}`,
        },
      };
      const res = await app.inject({
        method: "POST",
        url: `/api/webhooks/${source}${source === "slack" ? "/events" : ""}`,
        headers: { "content-type": "application/json", ...signatures[source] },
        payload: raw,
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = await db.select().from(triggerEvents).where(eq(triggerEvents.source, source));
      expect(rows).toHaveLength(1);
    },
  );

  it.each(["datadog", "pylon"] as const)(
    "accepts a %s shared-secret delivery and starts its Job",
    async (type) => {
      const workflow = await insertWorkflow({ agentType: null, promptTemplate: "echo event" });
      const trigger = await insertWorkflowTrigger(workflow.id, {
        targetType: "job",
        type,
        enabled: true,
        config: { secret, events: [type === "pylon" ? "issue.created" : "triggered"] },
      });
      const payload =
        type === "pylon"
          ? { event: "issue.created", issue: { id: randomUUID(), title: "Check build" } }
          : { alert_transition: "Triggered", title: "Check build", id: randomUUID() };
      const res = await app.inject({
        method: "POST",
        url: `/api/hooks/${type}/${trigger.id}`,
        headers: { "x-optio-secret": secret },
        payload,
      });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json().runId).toEqual(expect.any(String));
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, res.json().runId));
      expect(run.workflowId).toBe(workflow.id);
    },
  );

  it("omits excluded receivers when an administrator narrows the trigger list", async () => {
    vi.stubEnv("OPTIO_TRIGGERS", "manual");
    const narrowed = await buildRouteTestApp(register, { user: null });
    try {
      for (const url of [
        "/api/webhooks/github",
        "/api/webhooks/linear",
        "/api/webhooks/pagerduty",
        "/api/webhooks/slack/events",
        `/api/hooks/pylon/${randomUUID()}`,
        `/api/hooks/datadog/${randomUUID()}`,
        "/api/hooks/example",
      ]) {
        expect((await narrowed.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
      }
    } finally {
      await narrowed.close();
    }
  });
});
