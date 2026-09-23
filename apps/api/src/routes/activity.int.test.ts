/**
 * GET /api/activity against real Postgres. The feed is one raw UNION ALL over
 * four sources, so type mistakes (e.g. COALESCE of the `task_state` enum with
 * a text literal) only show up on a real database — a mocked db happily
 * returned rows while every real call 500'd.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { authEvents, optioActions, podHealthEvents, taskEvents, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { activityRoutes } from "./activity.js";

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${displayName.toLowerCase()}@activity.it`,
      displayName,
    })
    .returning();
  return row;
}

type Item = {
  id: string;
  type: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  summary: string;
  actor: { id: string; displayName: string } | null;
  details: Record<string, unknown> | null;
};

async function seedFeed() {
  // auth / infra events are deployment-wide (no workspace column): start each
  // test from none so the counts below are this test's rows only.
  await db.delete(authEvents);
  await db.delete(podHealthEvents);
  const ws = await insertWorkspace();
  const other = await insertWorkspace();
  const user = await insertUser("Ada");
  const task = await insertTask({ workspaceId: ws.id, title: "feed task", state: "running" });
  const foreignTask = await insertTask({ workspaceId: other.id, title: "other ws task" });

  // The first transition has no from_state (task creation) — the row that
  // used to break the query — then an ordinary one with a user attached.
  await db.insert(taskEvents).values([
    { taskId: task.id, fromState: null, toState: "pending", trigger: "created" },
    {
      taskId: task.id,
      fromState: "pending",
      toState: "queued",
      trigger: "submit",
      userId: user.id,
    },
    { taskId: foreignTask.id, fromState: null, toState: "pending", trigger: "created" },
  ]);
  await db.insert(optioActions).values({
    workspaceId: ws.id,
    userId: user.id,
    action: "task.retry",
    params: { taskId: task.id, apiKey: "must-not-leak" },
    success: true,
  });
  await db.insert(authEvents).values({
    tokenType: "claude",
    source: "it",
    errorMessage: "token expired",
  });
  await db.insert(podHealthEvents).values({
    repoPodId: task.id,
    repoUrl: task.repoUrl,
    eventType: "oom_killed",
    podName: null,
    message: "OOMKilled",
  });
  return { ws, user, task, foreignTask };
}

describe("GET /api/activity (integration)", () => {
  it("returns every source, including task events with no from_state", async () => {
    const { ws, user, task } = await seedFeed();
    const app = await buildRouteTestApp(activityRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "admin" },
    });

    const res = await app.inject({ method: "GET", url: "/api/activity?days=1&limit=200" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Item[]; total: number; stats: Record<string, number> };

    // Admin: own workspace's task events and actions plus the deployment-wide
    // auth / infra events; never another workspace's task events.
    expect(body.stats).toEqual({ actions: 1, taskEvents: 2, authEvents: 1, infraEvents: 1 });
    expect(body.total).toBe(5);

    const taskItems = body.items.filter((i) => i.type === "task_event");
    const created = taskItems.find((i) => i.action === "task:new→pending");
    expect(created).toMatchObject({
      resourceType: "task",
      resourceId: task.id,
      summary: "Task transitioned to pending via created",
      actor: null,
      details: { fromState: null, toState: "pending", trigger: "created" },
    });
    const queued = taskItems.find((i) => i.action === "task:pending→queued");
    expect(queued).toMatchObject({
      summary: "Task transitioned to queued via submit",
      actor: { id: user.id, displayName: "Ada" },
      details: { fromState: "pending", toState: "queued", trigger: "submit" },
    });

    const action = body.items.find((i) => i.type === "action");
    expect(action).toMatchObject({
      action: "task.retry",
      resourceType: "task",
      resourceId: task.id,
      summary: "task.retry succeeded",
    });
    expect(action?.details).not.toHaveProperty("apiKey");

    expect(body.items.find((i) => i.type === "auth_event")).toMatchObject({
      action: "auth:claude_failed",
      summary: "claude auth failed: token expired",
    });
    expect(body.items.find((i) => i.type === "infra_event")).toMatchObject({
      action: "pod:oom_killed",
      summary: "Pod unknown oom_killed",
      details: { eventType: "oom_killed", podName: null, message: "OOMKilled" },
    });
    await app.close();
  });

  it("filters to task events for a member, scoped to their workspace", async () => {
    const { ws, user, foreignTask } = await seedFeed();
    const app = await buildRouteTestApp(activityRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "member" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?type=task_event&resourceType=task",
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Item[]; stats: Record<string, number> };
    expect(body.items.map((i) => i.action).sort()).toEqual([
      "task:new→pending",
      "task:pending→queued",
    ]);
    expect(body.items.some((i) => i.resourceId === foreignTask.id)).toBe(false);
    expect(body.stats).toEqual({ actions: 0, taskEvents: 2, authEvents: 0, infraEvents: 0 });
    await app.close();
  });

  it("filters by actor across actions and task events", async () => {
    const { ws, user } = await seedFeed();
    const app = await buildRouteTestApp(activityRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "admin" },
    });

    const res = await app.inject({ method: "GET", url: `/api/activity?userId=${user.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Item[] };
    expect(body.items.map((i) => i.type).sort()).toEqual(["action", "task_event"]);
    expect(body.items.every((i) => i.actor?.id === user.id)).toBe(true);
    await app.close();
  });

  it("paginates the merged feed newest first", async () => {
    const { ws, user } = await seedFeed();
    const app = await buildRouteTestApp(activityRoutes, {
      user: { id: user.id, workspaceId: ws.id, workspaceRole: "admin" },
    });

    const page1 = (await app.inject({ method: "GET", url: "/api/activity?limit=2" })).json();
    const page2 = (
      await app.inject({ method: "GET", url: "/api/activity?limit=2&offset=2" })
    ).json();
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    const ids = [...page1.items, ...page2.items].map((i: Item) => i.id);
    expect(new Set(ids).size).toBe(4);
    const stamps = [...page1.items, ...page2.items].map((i: { timestamp: string }) =>
      Date.parse(i.timestamp),
    );
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    await app.close();
  });
});
