import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  optioActions,
  persistentAgents,
  prReviewRuns,
  prReviews,
  tasks,
  triggerOccurrences,
  users,
  workflowRuns,
  workflowTriggers,
  workspaceMembers,
} from "../db/schema.js";
import {
  insertSessionWithChatEvents,
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { agentWorkRoutes, refuseStartsWhilePaused } from "../routes/agent-work.js";
import {
  AGENT_WORK_PAUSE_KEY,
  PAUSE_MESSAGE_PREFIX,
  getAgentWorkPause,
  pauseAgentWork,
  resumeAgentWork,
} from "./agent-work-pause.js";
import { setDeploymentSetting } from "./deployment-settings.js";
import { runBudgetHold, usageBudgetHold } from "./usage-budget-service.js";
import {
  DeliveryPendingError,
  deliverOccurrence,
  enqueueOccurrence,
  fireTriggerDurably,
} from "./trigger-delivery.js";
import { checkDueScheduleTriggers } from "../workers/workflow-trigger-worker.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { prReviewRunQueue } from "../workers/pr-review-worker.js";
import { persistentAgentTurnQueue } from "../workers/persistent-agent-worker.js";

beforeEach(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  await setDeploymentSetting(AGENT_WORK_PAUSE_KEY, null, null);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await Promise.all(
    [taskQueue, workflowRunQueue, prReviewRunQueue, persistentAgentTurnQueue].map((q) => q.close()),
  );
});

async function person(deploymentAdmin: boolean, workspaceRole: "admin" | "member" = "admin") {
  const ws = await insertWorkspace();
  const [user] = await db
    .insert(users)
    .values({
      email: randomUUID() + "@pause.example.test",
      provider: "github",
      externalId: randomUUID(),
      displayName: deploymentAdmin ? "Deployment Admin" : "Workspace Admin",
      deploymentAdmin,
    })
    .returning();
  await db
    .insert(workspaceMembers)
    .values({ userId: user.id, workspaceId: ws.id, role: workspaceRole });
  return { ws, user };
}

/** The pause routes, the start-refusal hook, and two stand-in routes: a start and not a start. */
async function appFor(p: Awaited<ReturnType<typeof person>>) {
  return buildRouteTestApp(
    async (app) => {
      refuseStartsWhilePaused(app);
      await agentWorkRoutes(app);
      app.post("/api/tasks/:id/retry", async () => ({ started: true }));
      app.post("/api/tasks/:id/cancel", async () => ({ cancelled: true }));
    },
    { user: { id: p.user.id, workspaceId: p.ws.id, workspaceRole: "admin" } },
  );
}

async function insertAgent(workspaceId: string, state: string) {
  const [row] = await db
    .insert(persistentAgents)
    .values({
      workspaceId,
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "Pause test agent",
      initialPrompt: "hi",
      state: state as never,
    })
    .returning();
  return row;
}

async function insertReviewRun(workspaceId: string, state: string) {
  const n = Math.floor(Math.random() * 100000);
  const [review] = await db
    .insert(prReviews)
    .values({
      workspaceId,
      prUrl: `https://github.com/acme/app/pull/${n}`,
      prNumber: n,
      repoOwner: "acme",
      repoName: "app",
      repoUrl: "https://github.com/acme/app",
      headSha: "abc",
      state: "reviewing" as never,
    })
    .returning();
  const [run] = await db
    .insert(prReviewRuns)
    .values({ prReviewId: review.id, kind: "initial", state: state as never })
    .returning();
  return { review, run };
}

async function jobWithWebhook(workspaceId: string) {
  const wf = await insertWorkflow({ workspaceId });
  const trigger = await insertWorkflowTrigger(wf.id, {
    targetType: "job",
    type: "webhook",
    config: { webhookPath: randomUUID() },
  });
  return { wf, trigger };
}

describe("pausing agent work", () => {
  it("is off by default: nothing is held or refused", async () => {
    const admin = await person(true);
    const app = await appFor(admin);
    try {
      expect(await getAgentWorkPause()).toBeNull();
      const res = await app.inject({ method: "GET", url: "/api/agent-work/pause" });
      expect(res.json()).toMatchObject({ paused: false, reason: null, canEdit: true });

      const task = await insertTask({ workspaceId: admin.ws.id, state: "queued" });
      expect(await runBudgetHold("task", task.id)).toBeNull();
      expect(await usageBudgetHold({ workspaceId: admin.ws.id })).toBeNull();
      const start = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(start.statusCode).toBe(200);

      const { trigger } = await jobWithWebhook(admin.ws.id);
      const occurrence = await enqueueOccurrence(trigger, { source: "webhook" }, randomUUID());
      expect(await deliverOccurrence(occurrence.id)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("holds or refuses every start path while paused, with the reason", async () => {
    const admin = await person(true);
    const app = await appFor(admin);
    try {
      const paused = await app.inject({
        method: "PUT",
        url: "/api/agent-work/pause",
        payload: { paused: true, reason: "Upgrading the cluster" },
      });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({
        paused: true,
        reason: "Upgrading the cluster",
        stopped: false,
        pausedBy: { id: admin.user.id, name: "Deployment Admin" },
      });
      const message = `${PAUSE_MESSAGE_PREFIX}: Upgrading the cluster`;

      // Worker admission (Tasks, Job runs, agent turns, review runs): held.
      const ws = admin.ws.id;
      const task = await insertTask({ workspaceId: ws, state: "queued" });
      const wf = await insertWorkflow({ workspaceId: ws });
      const run = await insertWorkflowRun(wf.id);
      const agent = await insertAgent(ws, "queued");
      const { run: reviewRun } = await insertReviewRun(ws, "queued");
      expect(await runBudgetHold("task", task.id)).toBe(message);
      expect(await runBudgetHold("job", run.id)).toBe(message);
      expect(await runBudgetHold("agent", agent.id)).toBe(message);
      expect(await runBudgetHold("review", reviewRun.id)).toBe(message);
      // Session turns and Local terminals, in any workspace or none.
      expect(await usageBudgetHold({ workspaceId: ws })).toBe(message);
      expect(await usageBudgetHold({ workspaceId: null })).toBe(message);

      // Interactive starts: refused; everything else (a cancel) still works.
      const start = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(start.statusCode).toBe(409);
      expect(start.json().error).toBe(message);
      const cancel = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel` });
      expect(cancel.statusCode).toBe(200);

      // Triggers: the occurrence waits, pending, with no attempt spent; a
      // webhook caller hears it was saved.
      const { trigger } = await jobWithWebhook(ws);
      const occurrence = await enqueueOccurrence(trigger, { source: "webhook" }, randomUUID());
      expect(await deliverOccurrence(occurrence.id)).toBeNull();
      const [waiting] = await db
        .select()
        .from(triggerOccurrences)
        .where(eq(triggerOccurrences.id, occurrence.id));
      expect(waiting).toMatchObject({ state: "pending", attempts: 0 });
      await expect(fireTriggerDurably(trigger, { source: "webhook" })).rejects.toBeInstanceOf(
        DeliveryPendingError,
      );

      // Schedules: not advanced, so each fires once on resume.
      const due = new Date(Date.now() - 60_000);
      const schedule = await insertWorkflowTrigger(wf.id, {
        targetType: "job",
        type: "schedule",
        config: { cronExpression: "*/5 * * * *" },
        nextFireAt: due,
      });
      expect(await checkDueScheduleTriggers()).toBe(0);
      const [still] = await db
        .select({ nextFireAt: workflowTriggers.nextFireAt })
        .from(workflowTriggers)
        .where(eq(workflowTriggers.id, schedule.id));
      expect(still.nextFireAt?.getTime()).toBe(due.getTime());
    } finally {
      await app.close();
    }
  });

  it("lifting the pause resumes held work: retries wake, occurrences deliver, schedules fire once", async () => {
    const admin = await person(true);
    const app = await appFor(admin);
    try {
      await pauseAgentWork("Rotating a credential", admin.user.id);
      const task = await insertTask({ workspaceId: admin.ws.id, state: "queued" });
      // What the task worker does with held work: a delayed retry job.
      await taskQueue.add(
        "process-task",
        { taskId: task.id },
        { jobId: `${task.id}-budget-${Date.now()}`, delay: 60_000 },
      );
      const { wf, trigger } = await jobWithWebhook(admin.ws.id);
      const occurrence = await enqueueOccurrence(trigger, { source: "webhook" }, randomUUID());
      expect(await deliverOccurrence(occurrence.id)).toBeNull();
      const schedule = await insertWorkflowTrigger(wf.id, {
        targetType: "job",
        type: "schedule",
        config: { cronExpression: "*/5 * * * *" },
        nextFireAt: new Date(Date.now() - 60_000),
      });
      expect(await checkDueScheduleTriggers()).toBe(0);

      const res = await app.inject({
        method: "PUT",
        url: "/api/agent-work/pause",
        payload: { paused: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ paused: false, reason: null });
      expect(await runBudgetHold("task", task.id)).toBeNull();

      const held = (await taskQueue.getJobs(["waiting", "prioritized", "delayed"])).find(
        (j) => j.data?.taskId === task.id,
      );
      expect(held && (await held.getState())).not.toBe("delayed");
      const [delivered] = await db
        .select()
        .from(triggerOccurrences)
        .where(eq(triggerOccurrences.id, occurrence.id));
      expect(delivered.state).toBe("started");
      const [created] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, occurrence.id));
      expect(created?.workflowId).toBe(wf.id);

      expect(await checkDueScheduleTriggers()).toBeGreaterThanOrEqual(1);
      const scheduled = await db
        .select()
        .from(triggerOccurrences)
        .where(eq(triggerOccurrences.triggerId, schedule.id));
      expect(scheduled).toHaveLength(1);
      // Resuming twice is harmless.
      expect(await resumeAgentWork(admin.user.id)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("stop everything cancels queued and running work of every kind in two workspaces and logs who and why", async () => {
    const admin = await person(true);
    const other = await insertWorkspace();
    const app = await appFor(admin);
    try {
      const rows = [];
      for (const ws of [admin.ws.id, other.id]) {
        const queued = await insertTask({ workspaceId: ws, state: "queued" });
        const running = await insertTask({ workspaceId: ws, state: "running" });
        const done = await insertTask({ workspaceId: ws, state: "completed" });
        const wf = await insertWorkflow({ workspaceId: ws });
        const run = await insertWorkflowRun(wf.id, { state: "running" });
        const agent = await insertAgent(ws, "running");
        const idleAgent = await insertAgent(ws, "idle");
        const review = await insertReviewRun(ws, "queued");
        const session = await insertSessionWithChatEvents(0, { workspaceId: ws });
        rows.push({ queued, running, done, run, agent, idleAgent, review, session });
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/agent-work/stop",
        payload: { reason: "An agent is misbehaving" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        paused: true,
        stopped: true,
        reason: "An agent is misbehaving",
      });
      expect(body.cancelled.tasks).toBeGreaterThanOrEqual(4);
      expect(body.cancelled.jobRuns).toBeGreaterThanOrEqual(2);
      expect(body.cancelled.reviews).toBeGreaterThanOrEqual(2);
      expect(body.cancelled.agents).toBeGreaterThanOrEqual(2);
      expect(body.cancelled.sessions).toBeGreaterThanOrEqual(2);

      for (const r of rows) {
        const state = async (id: string) =>
          (await db.select({ s: tasks.state }).from(tasks).where(eq(tasks.id, id)))[0].s;
        expect(await state(r.queued.id)).toBe("cancelled");
        expect(await state(r.running.id)).toBe("cancelled");
        expect(await state(r.done.id)).toBe("completed");
        const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.run.id));
        expect(run.state).toBe("failed");
        const [agent] = await db
          .select()
          .from(persistentAgents)
          .where(eq(persistentAgents.id, r.agent.id));
        expect(agent.controlIntent).toBe("pause");
        const [idle] = await db
          .select()
          .from(persistentAgents)
          .where(eq(persistentAgents.id, r.idleAgent.id));
        expect(idle.controlIntent).toBeNull();
        const [review] = await db
          .select()
          .from(prReviews)
          .where(eq(prReviews.id, r.review.review.id));
        expect(review.state).toBe("cancelled");
        const [reviewRun] = await db
          .select()
          .from(prReviewRuns)
          .where(eq(prReviewRuns.id, r.review.run.id));
        expect(reviewRun.state).toBe("cancelled");
        const [session] = await db
          .select()
          .from(interactiveSessions)
          .where(eq(interactiveSessions.id, r.session.id));
        expect(session.state).toBe("ended");
      }

      // Nothing new starts afterwards.
      expect(await usageBudgetHold({ workspaceId: other.id })).toContain("An agent is misbehaving");
      const [logged] = await db
        .select()
        .from(optioActions)
        .where(
          and(eq(optioActions.action, "agent_work.stop"), eq(optioActions.userId, admin.user.id)),
        );
      expect(logged.workspaceId).toBeNull();
      expect(logged.result).toMatchObject({ reason: "An agent is misbehaving" });
    } finally {
      await app.close();
    }
  });

  it("refuses everyone but a deployment admin, and requires a reason", async () => {
    const workspaceAdmin = await person(false, "admin");
    const member = await person(false, "member");
    const admin = await person(true);
    const apps = await Promise.all([appFor(workspaceAdmin), appFor(member), appFor(admin)]);
    const [wsApp, memberApp, adminApp] = apps;
    try {
      for (const app of [wsApp, memberApp]) {
        const read = await app.inject({ method: "GET", url: "/api/agent-work/pause" });
        expect(read.statusCode).toBe(200);
        expect(read.json().canEdit).toBe(false);
        const pause = await app.inject({
          method: "PUT",
          url: "/api/agent-work/pause",
          payload: { paused: true, reason: "no" },
        });
        expect(pause.statusCode).toBe(403);
        const stop = await app.inject({
          method: "POST",
          url: "/api/agent-work/stop",
          payload: { reason: "no" },
        });
        expect(stop.statusCode).toBe(403);
      }
      expect(await getAgentWorkPause()).toBeNull();

      const noReason = await adminApp.inject({
        method: "PUT",
        url: "/api/agent-work/pause",
        payload: { paused: true },
      });
      expect(noReason.statusCode).toBe(400);
      const blank = await adminApp.inject({
        method: "POST",
        url: "/api/agent-work/stop",
        payload: { reason: "   " },
      });
      expect(blank.statusCode).toBe(400);
      expect(await getAgentWorkPause()).toBeNull();

      // Paused by a deployment admin, a workspace admin can't lift it either.
      await pauseAgentWork("Incident", admin.user.id);
      const lift = await wsApp.inject({
        method: "PUT",
        url: "/api/agent-work/pause",
        payload: { paused: false },
      });
      expect(lift.statusCode).toBe(403);
      expect((await getAgentWorkPause())?.reason).toBe("Incident");
      const seen = await memberApp.inject({ method: "GET", url: "/api/agent-work/pause" });
      expect(seen.json()).toMatchObject({ paused: true, reason: "Incident" });
    } finally {
      await Promise.all(apps.map((a) => a.close()));
    }
  });
});
