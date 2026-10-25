/**
 * Alertmanager / Grafana Alerting as a trigger with the trigger list narrowed
 * to the minimal preset's (docs/feature-lists.md, docs/observability.md): both run
 * inside the network and their receiver only accepts deliveries, so the
 * preset offers them. A Job
 * made with an Alertmanager When gets its own URL and shared secret; a
 * delivery without the secret is refused and starts nothing, one the filters
 * don't match starts nothing, and a matching one starts a run with the
 * alert's names as params. A SaaS source (Datadog) stays refused, leaving
 * nothing behind.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { users, workDefinitions, workflowRuns } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "../services/reconcile-queue.js";
import { getRedisClient } from "../services/event-bus.js";
import { hookRoutes } from "./hooks.js";
import { workRoutes } from "./work.js";

const uniq = () => randomBytes(4).toString("hex");
let app: FastifyInstance;

beforeAll(async () => {
  // The minimal preset's triggers include Alertmanager and Sentry.
  vi.stubEnv("OPTIO_FEATURE_PRESET", "minimal");
  const ws = await insertWorkspace({ slug: `alerts-${uniq()}` });
  const [person] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `oncall-${uniq()}@example.test`,
      displayName: "On-call",
    })
    .returning();
  app = await buildRouteTestApp(
    async (a) => {
      await workRoutes(a);
      await hookRoutes(a);
    },
    { user: { id: person.id, workspaceId: ws.id, workspaceRole: "member" } },
  );
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

/** An alert group as Alertmanager's webhook_config posts it. */
const group = (alertname: string) => ({
  version: "4",
  status: "firing",
  receiver: "optio",
  groupKey: `{}:{alertname="${alertname}"}`,
  groupLabels: { alertname },
  commonLabels: { alertname, severity: "critical" },
  commonAnnotations: { summary: "Checkout errors over 5%" },
  externalURL: "https://alertmanager.example.test",
  alerts: [
    {
      status: "firing",
      labels: { alertname, severity: "critical", namespace: "shop" },
      annotations: { summary: "Checkout errors over 5%" },
      startsAt: new Date().toISOString(),
      fingerprint: uniq(),
    },
  ],
});

const runsOf = (workflowId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));

describe("an Alertmanager trigger with the minimal preset", () => {
  it("is offered, refuses deliveries without its secret, and starts a run for a matching alert", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/work",
      payload: {
        name: `checkout alert ${uniq()}`,
        when: {
          type: "alertmanager",
          config: { events: ["firing"], alertnames: ["CheckoutErrorRate"] },
        },
        where: { runTarget: "cluster" },
        who: { runtime: null },
        what: { prompt: "echo ALERT={{alertnames}} STATUS={{status}}" },
        then: "exits",
        owner: "me",
        maxRetries: 0,
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const created = made.json() as { id: string; trigger?: { id: string; secret?: string } };
    const triggerId = created.trigger!.id;
    const secret = created.trigger!.secret!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // A Job started by its trigger, not now.
    expect(await runsOf(created.id)).toHaveLength(0);

    const deliver = (body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: `/api/hooks/alertmanager/${triggerId}`,
        headers: { "content-type": "application/json", ...headers },
        payload: JSON.stringify(body),
      });

    // No secret, a wrong one: 401, nothing started.
    expect((await deliver(group("CheckoutErrorRate"))).statusCode).toBe(401);
    expect(
      (await deliver(group("CheckoutErrorRate"), { authorization: "Bearer not-the-secret" }))
        .statusCode,
    ).toBe(401);
    expect(await runsOf(created.id)).toHaveLength(0);

    // Another alert: accepted, matched nothing, started nothing.
    const other = await deliver(group("DiskFull"), { authorization: `Bearer ${secret}` });
    expect(other.statusCode).toBe(202);
    expect(other.json()).toEqual({ matched: false });
    expect(await runsOf(created.id)).toHaveLength(0);

    // The alert it waits for, with the secret as Grafana's basic-auth password: a run.
    const basic = Buffer.from(`grafana:${secret}`).toString("base64");
    const fired = await deliver(group("CheckoutErrorRate"), { authorization: `Basic ${basic}` });
    expect(fired.statusCode, fired.body).toBe(202);
    const { runId } = fired.json() as { runId: string };
    expect(runId).toEqual(expect.any(String));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.workflowId).toBe(created.id);
    expect(run.params).toMatchObject({
      source: "alertmanager",
      status: "firing",
      alertnames: "CheckoutErrorRate",
      severities: "critical",
    });
  });

  it("still refuses a SaaS alerting source (Datadog) and leaves nothing behind", async () => {
    const name = `datadog alert ${uniq()}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/work",
      payload: {
        name,
        when: { type: "datadog", config: { events: ["triggered"] } },
        where: { runTarget: "cluster" },
        who: { runtime: null },
        what: { prompt: "echo hi" },
        then: "exits",
        owner: "me",
        maxRetries: 0,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("datadog isn't available in this deployment");
    const left = await db.select().from(workDefinitions).where(eq(workDefinitions.name, name));
    expect(left).toHaveLength(0);
  });
});
