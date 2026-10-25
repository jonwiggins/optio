/**
 * Outbound webhooks against a real database: a hook receives events for work
 * in its own workspace only, and there only for work its creator may see
 * (services/webhook-audience.ts). Upstream sent every event to every hook.
 */
import { randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { teamMembers, teams, users, webhooks, workspaceMembers } from "../db/schema.js";
import { insertTask, insertWorkflow, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { getBullMQOptions } from "./redis-config.js";
import { getWebhooksForEvent } from "./webhook-service.js";
import { webhookScopeOf } from "./webhook-scope.js";
import { forgetWorkVisibility } from "./work-visibility.js";
import * as taskService from "./task-service.js";
import { webhookRoutes } from "../routes/webhooks.js";

async function insertUser(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@hooks.it`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

async function member(workspaceId: string, userId: string, role: "admin" | "member" | "viewer") {
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
}

async function insertHook(workspaceId: string | null, createdBy: string | null, url?: string) {
  const [row] = await db
    .insert(webhooks)
    .values({
      url: url ?? `https://hooks.example.com/${randomBytes(4).toString("hex")}`,
      events: ["task.completed", "task.failed", "workflow_run.queued"],
      workspaceId,
      createdBy,
    })
    .returning();
  return row;
}

const ids = (hooks: Array<{ id: string }>) => hooks.map((h) => h.id).sort();

describe("outbound webhooks: workspace and team visibility", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    forgetWorkVisibility();
  });
  afterAll(() => vi.unstubAllEnvs());

  it("a hook in workspace A never receives workspace B's events", async () => {
    const [a, b] = await Promise.all([insertWorkspace(), insertWorkspace()]);
    const alice = await insertUser("Alice");
    const bea = await insertUser("Bea");
    await member(a.id, alice.id, "admin");
    await member(b.id, bea.id, "admin");
    const hookA = await insertHook(a.id, alice.id);
    const hookB = await insertHook(b.id, bea.id);

    const taskA = await insertTask({ workspaceId: a.id, createdBy: alice.id });
    const taskB = await insertTask({ workspaceId: b.id, createdBy: bea.id });

    const forA = await getWebhooksForEvent("task.completed", webhookScopeOf(taskA));
    const forB = await getWebhooksForEvent("task.completed", webhookScopeOf(taskB));
    expect(ids(forA)).toContain(hookA.id);
    expect(ids(forA)).not.toContain(hookB.id);
    expect(ids(forB)).toContain(hookB.id);
    expect(ids(forB)).not.toContain(hookA.id);

    // A Job's run is seen as its Job is: workspace B's Job never reaches A.
    const jobB = await insertWorkflow({ workspaceId: b.id, createdBy: bea.id });
    const forJob = await getWebhooksForEvent("workflow_run.queued", webhookScopeOf(jobB));
    expect(ids(forJob)).toContain(hookB.id);
    expect(ids(forJob)).not.toContain(hookA.id);

    // An event that doesn't say whose it is reaches neither.
    const unscoped = await getWebhooksForEvent("task.completed");
    expect(ids(unscoped)).not.toContain(hookA.id);
    expect(ids(unscoped)).not.toContain(hookB.id);
  });

  it("under `teams` visibility a creator's hook only gets work they may see", async () => {
    const ws = await insertWorkspace({ workVisibility: "teams" });
    const [alice, bob, carol] = await Promise.all([
      insertUser("Alice"),
      insertUser("Bob"),
      insertUser("Carol"),
    ]);
    await member(ws.id, alice.id, "admin");
    await member(ws.id, bob.id, "member");
    await member(ws.id, carol.id, "member");
    const [platform] = await db
      .insert(teams)
      .values({
        workspaceId: ws.id,
        name: "Platform",
        slug: `platform-${randomBytes(2).toString("hex")}`,
      })
      .returning();
    await db.insert(teamMembers).values({ teamId: platform.id, userId: bob.id, role: "member" });

    const adminHook = await insertHook(ws.id, alice.id);
    const carolHook = await insertHook(ws.id, carol.id);
    const bobHook = await insertHook(ws.id, bob.id);

    // Bob runs work for the Platform team; Carol isn't in it.
    const teamWork = await insertTask({
      workspaceId: ws.id,
      createdBy: bob.id,
      ownerUserId: bob.id,
      ownerTeamId: platform.id,
    });
    const teamEvent = ids(await getWebhooksForEvent("task.failed", webhookScopeOf(teamWork)));
    expect(teamEvent).toContain(adminHook.id);
    expect(teamEvent).toContain(bobHook.id);
    expect(teamEvent).not.toContain(carolHook.id);

    // Organization work Bob started: under `teams` only he and admins see it.
    const orgWork = await insertTask({ workspaceId: ws.id, createdBy: bob.id });
    const orgEvent = ids(await getWebhooksForEvent("task.failed", webhookScopeOf(orgWork)));
    expect(orgEvent).toContain(adminHook.id);
    expect(orgEvent).toContain(bobHook.id);
    expect(orgEvent).not.toContain(carolHook.id);

    // Carol's own work reaches her hook.
    const carols = await insertTask({
      workspaceId: ws.id,
      createdBy: carol.id,
      ownerUserId: carol.id,
    });
    const carolEvent = ids(await getWebhooksForEvent("task.failed", webhookScopeOf(carols)));
    expect(carolEvent).toContain(carolHook.id);
    expect(carolEvent).toContain(adminHook.id);
    expect(carolEvent).not.toContain(bobHook.id);
  });

  it("under `organization` visibility the organization's work is everyone's, private work its owner's", async () => {
    const ws = await insertWorkspace({ workVisibility: "organization" });
    const [bob, carol] = await Promise.all([insertUser("Bob"), insertUser("Carol")]);
    await member(ws.id, bob.id, "member");
    await member(ws.id, carol.id, "member");
    const carolHook = await insertHook(ws.id, carol.id);

    const orgWork = await insertTask({ workspaceId: ws.id, createdBy: bob.id });
    expect(ids(await getWebhooksForEvent("task.failed", webhookScopeOf(orgWork)))).toContain(
      carolHook.id,
    );
    const bobsOwn = await insertTask({
      workspaceId: ws.id,
      createdBy: bob.id,
      ownerUserId: bob.id,
    });
    expect(ids(await getWebhooksForEvent("task.failed", webhookScopeOf(bobsOwn)))).not.toContain(
      carolHook.id,
    );
  });

  it("a creator who left the workspace gets nothing", async () => {
    const ws = await insertWorkspace();
    const gone = await insertUser("Gone");
    const hook = await insertHook(ws.id, gone.id);
    const work = await insertTask({ workspaceId: ws.id });
    expect(ids(await getWebhooksForEvent("task.failed", webhookScopeOf(work)))).not.toContain(
      hook.id,
    );
  });

  it("a hook with no workspace speaks for the deployment: only a deployment admin's receives", async () => {
    const ws = await insertWorkspace();
    const ops = await insertUser("Ops", true);
    const someone = await insertUser("Someone");
    const opsHook = await insertHook(null, ops.id);
    const otherHook = await insertHook(null, someone.id);
    const work = await insertTask({ workspaceId: ws.id });
    const got = ids(await getWebhooksForEvent("task.failed", webhookScopeOf(work)));
    expect(got).toContain(opsHook.id);
    expect(got).not.toContain(otherHook.id);
  });

  it("a task transition enqueues deliveries for its own workspace's hooks only", async () => {
    const [a, b] = await Promise.all([insertWorkspace(), insertWorkspace()]);
    const alice = await insertUser("Alice");
    const bea = await insertUser("Bea");
    await member(a.id, alice.id, "admin");
    await member(b.id, bea.id, "admin");
    const hookA = await insertHook(a.id, alice.id);
    const hookB = await insertHook(b.id, bea.id);
    const taskB = await insertTask({ workspaceId: b.id, createdBy: bea.id, state: "running" });

    await taskService.transitionTask(taskB.id, TaskState.FAILED, "it_webhook_scope", "boom");

    const queue = new Queue("webhooks", { ...getBullMQOptions() });
    let hookIds: string[] = [];
    for (let i = 0; i < 50 && !hookIds.includes(hookB.id); i++) {
      const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized"]);
      hookIds = jobs
        .filter((j) => j.data?.data?.taskId === taskB.id)
        .map((j) => j.data.webhookId as string);
      if (!hookIds.includes(hookB.id)) await new Promise((r) => setTimeout(r, 100));
    }
    expect(hookIds).toContain(hookB.id);
    expect(hookIds).not.toContain(hookA.id);
    // The scope never reaches a payload.
    const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized"]);
    const payload = jobs.find((j) => j.data?.data?.taskId === taskB.id)?.data.data;
    expect(payload).toMatchObject({ taskId: taskB.id, toState: "failed" });
    expect(payload).not.toHaveProperty("ownerUserId");
    await queue.close();
  });
});

describe("webhook routes: only its creator or an admin changes a hook or reads its deliveries", () => {
  it("403s another member, lets the creator and a workspace admin through", async () => {
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
    const ws = await insertWorkspace();
    const [alice, carol] = await Promise.all([insertUser("Alice"), insertUser("Carol")]);
    const alicesHook = await insertHook(ws.id, alice.id);
    const carolsHook = await insertHook(ws.id, carol.id);
    const as = (id: string, workspaceRole: "admin" | "member") =>
      buildRouteTestApp(webhookRoutes, { user: { id, workspaceId: ws.id, workspaceRole } });
    const carolApp = await as(carol.id, "member");
    const aliceApp = await as(alice.id, "admin");

    for (const req of [
      {
        method: "PATCH" as const,
        url: `/api/webhooks/${alicesHook.id}`,
        payload: { active: false },
      },
      { method: "GET" as const, url: `/api/webhooks/${alicesHook.id}/deliveries` },
      { method: "POST" as const, url: `/api/webhooks/${alicesHook.id}/test`, payload: {} },
      { method: "DELETE" as const, url: `/api/webhooks/${alicesHook.id}` },
    ]) {
      const res = await carolApp.inject(req);
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(403);
      expect(res.json().error).toMatch(/creator or a workspace admin/);
    }

    // Her own hook is hers to change; an admin may change anyone's.
    expect(
      (await carolApp.inject({ method: "GET", url: `/api/webhooks/${carolsHook.id}/deliveries` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await carolApp.inject({
          method: "PATCH",
          url: `/api/webhooks/${carolsHook.id}`,
          payload: { description: "mine" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await aliceApp.inject({ method: "GET", url: `/api/webhooks/${carolsHook.id}/deliveries` }))
        .statusCode,
    ).toBe(200);
    expect(
      (await aliceApp.inject({ method: "DELETE", url: `/api/webhooks/${carolsHook.id}` }))
        .statusCode,
    ).toBe(204);
  });

  it("leaves a hook with no workspace to deployment admins", async () => {
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
    const ws = await insertWorkspace();
    const [ops, admin] = await Promise.all([insertUser("Ops", true), insertUser("Admin")]);
    const legacy = await insertHook(null, ops.id);
    const adminApp = await buildRouteTestApp(webhookRoutes, {
      user: { id: admin.id, workspaceId: ws.id, workspaceRole: "admin" },
    });
    const opsApp = await buildRouteTestApp(webhookRoutes, {
      user: { id: ops.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    const patch = {
      method: "PATCH" as const,
      url: `/api/webhooks/${legacy.id}`,
      payload: { active: false },
    };
    const refused = await adminApp.inject(patch);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/deployment admin/);
    expect((await opsApp.inject(patch)).statusCode).toBe(200);
  });
});
