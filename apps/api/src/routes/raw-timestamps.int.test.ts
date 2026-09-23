/**
 * Response timestamps built from raw SQL are ISO-8601, like every other date
 * the API returns. Raw SQL (db.execute, or a `sql` aggregate without
 * `.mapWith`) hands timestamps back as Postgres text — "2026-09-23
 * 01:22:37.388801+00" — which strict ISO decoders (the iOS app) reject, so an
 * agent with a pending message would not load. Only a real database shows
 * this, so these run against Postgres.
 */
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { persistentAgentMessages, persistentAgents, podHealthEvents } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "../services/reconcile-snapshot.js";
import { persistentAgentRoutes } from "./persistent-agents.js";
import { workflowRoutes } from "./workflows.js";
import { optioRoutes } from "./optio.js";
import { analyticsRoutes } from "./analytics.js";

/** What Date#toJSON produces — and what strict ISO-8601 decoders accept. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const admin = (workspaceId: string) => ({
  user: { id: "u-it", workspaceId, workspaceRole: "admin" as const },
});

describe("timestamps from raw SQL reach responses as ISO-8601", () => {
  it("GET /api/persistent-agents/:id — inbox.oldest", async () => {
    const ws = await insertWorkspace();
    const [agent] = await db
      .insert(persistentAgents)
      .values({ workspaceId: ws.id, slug: "iso-bot", name: "iso bot", initialPrompt: "wait" })
      .returning();
    const [first] = await db
      .insert(persistentAgentMessages)
      .values({ agentId: agent.id, senderType: "user", body: "first" })
      .returning();
    await db
      .insert(persistentAgentMessages)
      .values({ agentId: agent.id, senderType: "user", body: "second" });

    const app = await buildRouteTestApp(persistentAgentRoutes, admin(ws.id));
    const res = await app.inject({ method: "GET", url: `/api/persistent-agents/${agent.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const { inbox } = res.json();
    expect(inbox.pending).toBe(2);
    expect(inbox.oldest).toMatch(ISO);
    expect(inbox.oldest).toBe(first.receivedAt.toISOString());
    await app.close();

    // The reconciler reads the same aggregate; its snapshot promises a Date.
    const snapshot = await buildWorldSnapshot({ kind: "persistent-agent", id: agent.id });
    const status = snapshot?.run.status as { oldestPendingAt: unknown };
    expect(status.oldestPendingAt).toBeInstanceOf(Date);
    expect((status.oldestPendingAt as Date).toISOString()).toBe(first.receivedAt.toISOString());
  });

  it("GET /api/jobs and /api/jobs/:id — createdAt, updatedAt, lastRunAt", async () => {
    const ws = await insertWorkspace();
    const wf = await insertWorkflow({ workspaceId: ws.id, name: "iso job" });
    await insertWorkflowRun(wf.id, { state: "completed" });
    const latest = await insertWorkflowRun(wf.id, { state: "completed" });

    const app = await buildRouteTestApp(workflowRoutes, admin(ws.id));
    const list = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json().workflows.find((w: { id: string }) => w.id === wf.id);
    expect(listed.createdAt).toMatch(ISO);
    expect(listed.updatedAt).toMatch(ISO);
    expect(listed.lastRunAt).toBe(latest.createdAt.toISOString());
    expect(listed.createdAt).toBe(wf.createdAt.toISOString());

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${wf.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().workflow.lastRunAt).toBe(latest.createdAt.toISOString());
    expect(detail.json().workflow.createdAt).toMatch(ISO);

    // A job that never ran has no lastRunAt, not an empty string.
    const idle = await insertWorkflow({ workspaceId: ws.id, name: "never ran" });
    const idleRes = await app.inject({ method: "GET", url: `/api/jobs/${idle.id}` });
    expect(idleRes.json().workflow.lastRunAt).toBeNull();
    await app.close();
  });

  it("GET /api/optio/system-status — alerts[].timestamp", async () => {
    const ws = await insertWorkspace();
    const [event] = await db
      .insert(podHealthEvents)
      .values({
        repoPodId: ws.id,
        repoUrl: "https://github.com/it-org/iso",
        eventType: "oom_killed",
        podName: "iso-pod",
        message: "OOMKilled",
      })
      .returning();

    const app = await buildRouteTestApp(optioRoutes, admin(ws.id));
    const res = await app.inject({ method: "GET", url: "/api/optio/system-status" });
    expect(res.statusCode, res.body).toBe(200);
    const alert = res.json().alerts.find((a: { message: string }) => a.message === "OOMKilled");
    expect(alert.timestamp).toBe(event.createdAt.toISOString());
    await app.close();
  });

  it("GET /api/analytics/costs — anomalies[] and topTasks[] createdAt", async () => {
    const ws = await insertWorkspace();
    const repoUrl = "https://github.com/it-org/iso-costs";
    // Three ordinary runs and one ≥3× the repo average: an anomaly.
    for (const cost of ["0.10", "0.10", "0.10"]) {
      await insertTask({ workspaceId: ws.id, repoUrl, costUsd: cost, state: "completed" });
    }
    const pricey = await insertTask({
      workspaceId: ws.id,
      repoUrl,
      costUsd: "5.00",
      state: "completed",
    });

    const app = await buildRouteTestApp(analyticsRoutes, admin(ws.id));
    const res = await app.inject({ method: "GET", url: "/api/analytics/costs" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const anomaly = body.anomalies.find((a: { id: string }) => a.id === pricey.id);
    expect(anomaly.createdAt).toBe(pricey.createdAt.toISOString());
    expect(body.topTasks.length).toBeGreaterThan(0);
    for (const t of body.topTasks) expect(t.createdAt).toMatch(ISO);
    await app.close();
  });
});
