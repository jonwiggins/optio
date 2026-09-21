/**
 * Integration test — polymorphic schedule-trigger dispatch against the real
 * database and Redis.
 *
 * Covers the workflow-trigger-worker's due-trigger check (started as a real
 * BullMQ worker; each test enqueues a one-off check job and waits for it to
 * complete, which guarantees all dispatch side effects are committed):
 *   - target_type="job"        → workflow_runs row + nextFireAt advanced
 *   - target_type="task_config" → instantiateTask → queued tasks row with
 *     rendered prompt/title
 *   - disabled / not-yet-due triggers are never selected
 * plus the trigger-service CRUD round-trip — including that its create/update
 * stamp nextFireAt for schedule triggers so they actually fire (regression:
 * an earlier service left nextFireAt null and they never fired) — and the
 * ticket / event fan-outs of trigger-dispatch across target types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, workflowRuns, workflowTriggers } from "../db/schema.js";
import * as triggerService from "./trigger-service.js";
import {
  startWorkflowTriggerWorker,
  workflowTriggerQueue,
} from "../workers/workflow-trigger-worker.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { getRedisClient } from "./event-bus.js";
import {
  insertTaskConfig,
  insertWorkflow,
  insertWorkflowTrigger,
} from "../test-utils/integration/fixtures.js";

// A cron that fires once a day, anchored ~12h from NOW — a fixed time of day
// would recompute a nextFireAt only seconds away when the suite happens to
// run just before it, letting an already-fired trigger become due again
// mid-test. With the 12h anchor the recomputed value is always hours out.
const cronAnchor = new Date(Date.now() + 12 * 60 * 60 * 1000);
const DAILY_CRON = `${cronAnchor.getUTCMinutes()} ${cronAnchor.getUTCHours()} * * *`;

let worker: ReturnType<typeof startWorkflowTriggerWorker>;

async function waitUntil(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Enqueue one due-trigger check and wait for the worker to finish it. The
 * worker awaits every dispatch + markTriggerFired before completing the job,
 * so once the job is "completed" all DB effects are visible.
 */
async function runTriggerCheck(): Promise<void> {
  const job = await workflowTriggerQueue.add("check-workflow-triggers", {});
  await waitUntil(async () => {
    const state = await job.getState();
    return state === "completed" || state === "failed";
  }, "trigger check job to finish");
  expect(await job.getState()).toBe("completed");
}

const runsFor = (workflowId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));

const tasksForRepo = (repoUrl: string) => db.select().from(tasks).where(eq(tasks.repoUrl, repoUrl));

beforeAll(async () => {
  // Keep the worker's own repeat schedule out of the way so every check that
  // runs during the test is one we enqueued explicitly.
  process.env.OPTIO_WORKFLOW_TRIGGER_INTERVAL = "3600000";
  worker = startWorkflowTriggerWorker();
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await workflowTriggerQueue.close();
  // Queues loaded as dispatch side effects — close so teardown doesn't stall.
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

describe("schedule trigger dispatch (workflow-trigger-worker)", () => {
  it("fires a due job trigger: creates a queued workflow_run and advances nextFireAt", async () => {
    const workflow = await insertWorkflow();
    const past = new Date(Date.now() - 60_000);
    const trigger = await insertWorkflowTrigger(workflow.id, {
      workflowId: workflow.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      paramMapping: { PARAM: "from-trigger" },
      enabled: true,
      nextFireAt: past,
    });

    await runTriggerCheck();

    const runs = await runsFor(workflow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("queued");
    expect(runs[0].triggerId).toBe(trigger.id);
    expect(runs[0].params).toEqual({ PARAM: "from-trigger" });

    const after = await triggerService.getTrigger(trigger.id);
    expect(after).not.toBeNull();
    expect(after!.lastFiredAt).not.toBeNull();
    expect(after!.nextFireAt).not.toBeNull();
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(past.getTime());
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(after!.lastFiredAt!.getTime());

    // The advanced trigger must not re-fire on the next check.
    await runTriggerCheck();
    expect(await runsFor(workflow.id)).toHaveLength(1);
  });

  it("fires a due task_config trigger: instantiates a queued task with rendered prompt/title", async () => {
    const config = await insertTaskConfig({
      title: "Nightly sweep of {{TARGET}}",
      prompt: "Sweep the {{TARGET}} environment and report anomalies.",
    });
    const past = new Date(Date.now() - 60_000);
    const trigger = await insertWorkflowTrigger(config.id, {
      targetType: "task_config",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      paramMapping: { TARGET: "staging" },
      enabled: true,
      nextFireAt: past,
    });

    await runTriggerCheck();

    const spawned = await tasksForRepo(config.repoUrl);
    expect(spawned).toHaveLength(1);
    const task = spawned[0];
    expect(task.state).toBe("queued");
    expect(task.title).toBe("Nightly sweep of staging");
    expect(task.prompt).toBe("Sweep the staging environment and report anomalies.");
    expect(task.repoBranch).toBe(config.repoBranch);
    expect(task.metadata).toMatchObject({
      taskConfigId: config.id,
      taskConfigName: config.name,
      triggerId: trigger.id,
      triggerParams: { TARGET: "staging" },
    });

    // instantiateTask also enqueues the BullMQ job for the task-worker.
    const queued = await taskQueue.getJob(task.id);
    expect(queued).toBeTruthy();
    expect(queued!.data).toEqual({ taskId: task.id });

    const after = await triggerService.getTrigger(trigger.id);
    expect(after!.lastFiredAt).not.toBeNull();
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it("skips a disabled trigger while firing an enabled due one in the same check", async () => {
    const disabledWf = await insertWorkflow();
    const controlWf = await insertWorkflow();
    const past = new Date(Date.now() - 60_000);
    const disabledTrigger = await insertWorkflowTrigger(disabledWf.id, {
      workflowId: disabledWf.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      enabled: false,
      nextFireAt: past,
    });
    await insertWorkflowTrigger(controlWf.id, {
      workflowId: controlWf.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      enabled: true,
      nextFireAt: past,
    });

    await runTriggerCheck();

    // Positive control proves the check actually dispatched…
    expect(await runsFor(controlWf.id)).toHaveLength(1);
    // …while the disabled trigger was never selected.
    expect(await runsFor(disabledWf.id)).toHaveLength(0);
    const after = await triggerService.getTrigger(disabledTrigger.id);
    expect(after!.lastFiredAt).toBeNull();
    expect(after!.nextFireAt!.getTime()).toBe(past.getTime());
  });

  it("skips a not-yet-due trigger and one with no nextFireAt at all", async () => {
    const futureWf = await insertWorkflow();
    const nullWf = await insertWorkflow();
    const future = new Date(Date.now() + 60 * 60_000);
    const futureTrigger = await insertWorkflowTrigger(futureWf.id, {
      workflowId: futureWf.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      enabled: true,
      nextFireAt: future,
    });
    const nullTrigger = await insertWorkflowTrigger(nullWf.id, {
      workflowId: nullWf.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      enabled: true,
      nextFireAt: null,
    });

    await runTriggerCheck();

    expect(await runsFor(futureWf.id)).toHaveLength(0);
    expect(await runsFor(nullWf.id)).toHaveLength(0);
    const afterFuture = await triggerService.getTrigger(futureTrigger.id);
    expect(afterFuture!.lastFiredAt).toBeNull();
    expect(afterFuture!.nextFireAt!.getTime()).toBe(future.getTime());
    const afterNull = await triggerService.getTrigger(nullTrigger.id);
    expect(afterNull!.lastFiredAt).toBeNull();
    expect(afterNull!.nextFireAt).toBeNull();
  });

  it("advances nextFireAt without creating a run when the target workflow is disabled", async () => {
    const workflow = await insertWorkflow({ enabled: false });
    const past = new Date(Date.now() - 60_000);
    const trigger = await insertWorkflowTrigger(workflow.id, {
      workflowId: workflow.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
      enabled: true,
      nextFireAt: past,
    });

    await runTriggerCheck();

    expect(await runsFor(workflow.id)).toHaveLength(0);
    // dispatch skipped the disabled target, but the tick was still consumed
    const after = await triggerService.getTrigger(trigger.id);
    expect(after!.lastFiredAt).not.toBeNull();
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(past.getTime());
  });

  it("skips a due trigger missing cronExpression without consuming its tick", async () => {
    const workflow = await insertWorkflow();
    const past = new Date(Date.now() - 60_000);
    const trigger = await insertWorkflowTrigger(workflow.id, {
      workflowId: workflow.id,
      targetType: "job",
      type: "schedule",
      config: {},
      enabled: true,
      nextFireAt: past,
    });

    await runTriggerCheck();

    expect(await runsFor(workflow.id)).toHaveLength(0);
    const after = await triggerService.getTrigger(trigger.id);
    expect(after!.lastFiredAt).toBeNull();
    expect(after!.nextFireAt!.getTime()).toBe(past.getTime());

    // Remove it so it doesn't stay perpetually due for later checks.
    expect(await triggerService.deleteTrigger(trigger.id)).toBe(true);
  });
});

describe("trigger CRUD (trigger-service)", () => {
  it("create → list → get → update → delete round-trip", async () => {
    const workflow = await insertWorkflow();

    const created = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "manual",
      config: { note: "kick it off" },
      paramMapping: { PARAM: "x" },
    });
    // The service stamps the polymorphic columns for job targets.
    expect(created.targetType).toBe("job");
    expect(created.targetId).toBe(workflow.id);
    expect(created.workflowId).toBe(workflow.id);
    expect(created.enabled).toBe(true);
    expect(created.config).toEqual({ note: "kick it off" });
    expect(created.paramMapping).toEqual({ PARAM: "x" });

    const webhook = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "webhook",
      config: { path: `it-hook-${workflow.id}` },
    });

    const listed = await triggerService.listTriggers("job", workflow.id);
    expect(listed.map((t) => t.id).sort()).toEqual([created.id, webhook.id].sort());

    const fetched = await triggerService.getTrigger(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.type).toBe("manual");

    const updated = await triggerService.updateTrigger(created.id, {
      enabled: false,
      config: { note: "paused" },
      paramMapping: { PARAM: "y" },
    });
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(updated!.config).toEqual({ note: "paused" });
    expect(updated!.paramMapping).toEqual({ PARAM: "y" });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    expect(await triggerService.deleteTrigger(created.id)).toBe(true);
    expect(await triggerService.getTrigger(created.id)).toBeNull();
    expect(await triggerService.deleteTrigger(created.id)).toBe(false);
    // The other trigger is untouched.
    expect((await triggerService.listTriggers("job", workflow.id)).map((t) => t.id)).toEqual([
      webhook.id,
    ]);
  });

  it("allows several triggers of one type per target (two schedules), and refuses types the target can't take", async () => {
    const workflow = await insertWorkflow();
    const nine = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "schedule",
      config: { cronExpression: "0 9 * * *" },
    });
    const five = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "schedule",
      config: { cronExpression: "0 17 * * *" },
    });
    expect((await triggerService.listTriggers("job", workflow.id)).map((t) => t.id).sort()).toEqual(
      [nine.id, five.id].sort(),
    );
    await expect(
      triggerService.createTrigger({
        targetType: "pr_review",
        targetId: workflow.id,
        type: "github",
      }),
    ).rejects.toThrow("unsupported_type");
  });

  it("rejects duplicate webhook paths across workflows, on create and update", async () => {
    const wfA = await insertWorkflow();
    const wfB = await insertWorkflow();
    const path = `it-shared-hook-${wfA.id}`;
    await triggerService.createTrigger({
      targetType: "job",
      targetId: wfA.id,
      type: "webhook",
      config: { path },
    });

    await expect(
      triggerService.createTrigger({
        targetType: "job",
        targetId: wfB.id,
        type: "webhook",
        config: { path },
      }),
    ).rejects.toThrow("duplicate_webhook_path");

    const bTrigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: wfB.id,
      type: "webhook",
      config: { path: `it-other-hook-${wfB.id}` },
    });
    await expect(triggerService.updateTrigger(bTrigger.id, { config: { path } })).rejects.toThrow(
      "duplicate_webhook_path",
    );
  });

  it("updateTrigger on a missing id returns null", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(await triggerService.updateTrigger(ghost, { enabled: false })).toBeNull();
    expect(await triggerService.getTrigger(ghost)).toBeNull();
  });

  it("createTrigger computes nextFireAt for schedule triggers, and the trigger fires once due", async () => {
    // Regression: this service used to leave nextFireAt null, so a schedule
    // trigger created through it (and through POST /api/jobs/:id/triggers,
    // which calls it) was never selected by getDueScheduleTriggersAll and
    // never fired. It must behave like workflowService.createWorkflowTrigger.
    const workflow = await insertWorkflow();
    const beforeCreate = Date.now();
    // Every-second cron (cron-parser 6-field): nextFireAt lands within ~1s,
    // so the trigger becomes due without waiting out a minute boundary.
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "schedule",
      config: { cronExpression: "* * * * * *" },
    });
    expect(trigger.nextFireAt).not.toBeNull();
    expect(trigger.nextFireAt!.getTime()).toBeGreaterThan(beforeCreate);
    expect(trigger.nextFireAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // Once the computed nextFireAt passes, the worker check fires it.
    await waitUntil(async () => Date.now() > trigger.nextFireAt!.getTime(), "trigger to be due");
    await runTriggerCheck();

    const runs = await runsFor(workflow.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("queued");
    expect(runs[0].triggerId).toBe(trigger.id);

    const after = await triggerService.getTrigger(trigger.id);
    expect(after!.lastFiredAt).not.toBeNull();
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(trigger.nextFireAt!.getTime());

    // An every-second cron is perpetually due again — disable it so later
    // checks can't re-fire it. Disabling a schedule trigger clears nextFireAt.
    const disabled = await triggerService.updateTrigger(trigger.id, { enabled: false });
    expect(disabled!.enabled).toBe(false);
    expect(disabled!.nextFireAt).toBeNull();
  });

  it("updateTrigger recomputes nextFireAt on re-enable and cron change, clears it on disable", async () => {
    const workflow = await insertWorkflow();
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: workflow.id,
      type: "schedule",
      config: { cronExpression: DAILY_CRON },
    });
    expect(trigger.nextFireAt).not.toBeNull();

    // Disabling clears nextFireAt → the poller can never select it.
    const disabled = await triggerService.updateTrigger(trigger.id, { enabled: false });
    expect(disabled!.nextFireAt).toBeNull();

    // Re-enabling recomputes it from the stored cron config.
    const reenabled = await triggerService.updateTrigger(trigger.id, { enabled: true });
    expect(reenabled!.nextFireAt).not.toBeNull();
    expect(reenabled!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());

    // Changing the cron reschedules: an hourly cron lands within the next
    // hour, always sooner than the ~12h-out DAILY_CRON anchor.
    const hourly = await triggerService.updateTrigger(trigger.id, {
      config: { cronExpression: "0 * * * *" },
    });
    expect(hourly!.nextFireAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(hourly!.nextFireAt!.getTime()).toBeLessThan(reenabled!.nextFireAt!.getTime());

    // Remove it so it can't become due for any later check in this file.
    expect(await triggerService.deleteTrigger(trigger.id)).toBe(true);
  });
});

describe("ticket triggers on Jobs (trigger-dispatch.fireTicketTriggers)", () => {
  it("spawns a run with the ticket's fields as params for each matching enabled trigger", async () => {
    const { fireTicketTriggers } = await import("./trigger-dispatch.js");
    const job = await insertWorkflow({ promptTemplate: "Triage {{ticketUrl}}: {{ticketTitle}}" });
    const matching = await insertWorkflowTrigger(job.id, {
      workflowId: job.id,
      targetType: "job",
      type: "ticket",
      config: { source: "linear", labels: ["triage"] },
    });
    const otherSource = await insertWorkflow();
    await insertWorkflowTrigger(otherSource.id, {
      workflowId: otherSource.id,
      targetType: "job",
      type: "ticket",
      config: { source: "github" },
    });
    const disabledJob = await insertWorkflow({ enabled: false });
    await insertWorkflowTrigger(disabledJob.id, {
      workflowId: disabledJob.id,
      targetType: "job",
      type: "ticket",
      config: { source: "linear" },
    });

    const fired = await fireTicketTriggers({
      source: "linear",
      externalId: "ENG-42",
      title: "Login is broken",
      body: "Steps to reproduce…",
      labels: ["triage", "bug"],
      url: "https://linear.app/acme/issue/ENG-42",
    });

    // Other tests in this file leave enabled ticket triggers behind on other
    // sources; only this ticket's matches are under test.
    const mine = fired.filter((f) => f.triggerId === matching.id);
    expect(mine).toEqual([
      { triggerId: matching.id, kind: "workflow_run", id: expect.any(String) },
    ]);
    expect(fired.map((f) => f.triggerId)).not.toContain(
      (await triggerService.listTriggers("job", disabledJob.id))[0].id,
    );
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, mine[0].id));
    expect(run.workflowId).toBe(job.id);
    expect(run.triggerId).toBe(matching.id);
    expect(run.params).toMatchObject({
      ticketSource: "linear",
      ticketExternalId: "ENG-42",
      ticketTitle: "Login is broken",
      ticketUrl: "https://linear.app/acme/issue/ENG-42",
      ticketLabels: "triage,bug",
    });
    const [after] = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.id, matching.id));
    expect(after.lastFiredAt).not.toBeNull();
    // The run the worker picks up is removed so it can't run in a later test.
    await db.delete(workflowRuns).where(eq(workflowRuns.id, run.id));
  });

  it("does not fire when none of the trigger's labels are on the ticket", async () => {
    const { fireTicketTriggers } = await import("./trigger-dispatch.js");
    const job = await insertWorkflow();
    const labeled = await insertWorkflowTrigger(job.id, {
      workflowId: job.id,
      targetType: "job",
      type: "ticket",
      config: { source: "github", labels: ["cve"] },
    });
    const fired = await fireTicketTriggers({
      source: "github",
      externalId: "acme/app#7",
      title: "Typo",
      labels: ["docs"],
    });
    // Other tests in this file leave unlabeled triggers behind that do match;
    // only the labeled one is under test here.
    expect(fired.map((f) => f.triggerId)).not.toContain(labeled.id);
    for (const f of fired) {
      if (f.kind === "workflow_run") await db.delete(workflowRuns).where(eq(workflowRuns.id, f.id));
    }
  });
});

describe("ticket triggers on persistent agents (trigger-dispatch)", () => {
  it("wakes a matching enabled agent with the ticket as a system message and structured payload", async () => {
    const { createPersistentAgent } = await import("./persistent-agent-service.js");
    const { fireTicketTriggers } = await import("./trigger-dispatch.js");
    const { persistentAgentMessages } = await import("../db/schema.js");
    const agent = await createPersistentAgent({
      slug: `it-ticket-agent-${Date.now().toString(36)}`,
      name: "Ticket agent",
      initialPrompt: "You triage tickets.",
    });
    const trigger = await insertWorkflowTrigger(agent.id, {
      targetType: "persistent_agent",
      type: "ticket",
      config: { source: "jira" },
    });

    const fired = await fireTicketTriggers({
      source: "jira",
      externalId: "OPS-9",
      title: "Disk full",
      body: "The box is out of space.",
      labels: [],
      url: "https://acme.atlassian.net/browse/OPS-9",
    });
    expect(fired.filter((f) => f.triggerId === trigger.id)).toEqual([
      { triggerId: trigger.id, kind: "persistent_agent", id: agent.id },
    ]);

    const messages = await db
      .select()
      .from(persistentAgentMessages)
      .where(eq(persistentAgentMessages.agentId, agent.id));
    const ticketMsg = messages.find((m) => m.body.includes("OPS-9"));
    expect(ticketMsg).toBeTruthy();
    expect(ticketMsg!.senderType).toBe("system");
    expect(ticketMsg!.structuredPayload).toMatchObject({
      ticketSource: "jira",
      ticketExternalId: "OPS-9",
      ticketUrl: "https://acme.atlassian.net/browse/OPS-9",
    });
    const [after] = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.id, trigger.id));
    expect(after.lastFiredAt).not.toBeNull();

    // Another source leaves this agent alone.
    const none = await fireTicketTriggers({ source: "github", externalId: "x#1", title: "t" });
    expect(none.map((f) => f.triggerId)).not.toContain(trigger.id);
    for (const f of none) {
      if (f.kind === "workflow_run") await db.delete(workflowRuns).where(eq(workflowRuns.id, f.id));
    }
  });
});

describe("event triggers on every target (event-trigger-service.fireEventTriggers)", () => {
  const prOpened = (repo: string, number = 1) => ({
    action: "opened",
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
    pull_request: {
      number,
      title: "feat: widgets",
      body: "Adds widgets.",
      html_url: `https://github.com/${repo}/pull/${number}`,
      user: { login: "alice" },
      head: { ref: "feat/widgets" },
      base: { ref: "main" },
    },
  });

  it("a GitHub PR event starts a Job run with the PR's fields as params", async () => {
    const { fireEventTriggers, normalizeGitHubEvent } = await import("./event-trigger-service.js");
    const job = await insertWorkflow({
      promptTemplate: "Summarize {{url}} ({{repo}} #{{number}})",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "job",
      targetId: job.id,
      type: "github",
      config: { events: ["pr_opened"], repos: ["acme/widgets"] },
    });

    const miss = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", prOpened("acme/other"))!,
    );
    expect(miss.map((f) => f.triggerId)).not.toContain(trigger.id);

    const hit = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", prOpened("acme/widgets", 12))!,
    );
    const mine = hit.filter((f) => f.triggerId === trigger.id);
    expect(mine).toEqual([
      { triggerId: trigger.id, matched: "pr_opened", kind: "workflow_run", id: expect.any(String) },
    ]);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, mine[0].id));
    expect(run.workflowId).toBe(job.id);
    expect(run.params).toMatchObject({
      source: "github",
      event: "pr_opened",
      repo: "acme/widgets",
      number: "12",
      url: "https://github.com/acme/widgets/pull/12",
      headBranch: "feat/widgets",
    });
    for (const f of hit) {
      if (f.kind === "workflow_run") await db.delete(workflowRuns).where(eq(workflowRuns.id, f.id));
    }
  });

  it("a scheduled Task listens to its own repo by default and spawns a task without a ticket link", async () => {
    const { fireEventTriggers, normalizeGitHubEvent } = await import("./event-trigger-service.js");
    const config = await insertTaskConfig({
      title: "Review PR #{{number}}",
      prompt: "Review {{url}} and summarize it.",
      repoUrl: "https://github.com/acme/reviewed",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "task_config",
      targetId: config.id,
      type: "github",
      config: { events: ["pr_opened"] },
    });

    // A PR in some other repo: no filter named it, so the config's own repo wins.
    const miss = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", prOpened("acme/elsewhere"))!,
    );
    expect(miss.map((f) => f.triggerId)).not.toContain(trigger.id);
    expect(await tasksForRepo(config.repoUrl)).toHaveLength(0);

    const hit = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", prOpened("acme/reviewed", 3))!,
    );
    expect(hit.filter((f) => f.triggerId === trigger.id)).toHaveLength(1);
    const spawned = await tasksForRepo(config.repoUrl);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].state).toBe("queued");
    expect(spawned[0].title).toBe("Review PR #3");
    expect(spawned[0].prompt).toBe(
      "Review https://github.com/acme/reviewed/pull/3 and summarize it.",
    );
    // Reacting to a PR must not link the task to it as a ticket (that would
    // close the PR when the task completes).
    expect(spawned[0].ticketExternalId).toBeNull();
    expect(spawned[0].metadata).toMatchObject({ triggerId: trigger.id });
    for (const f of hit) {
      if (f.kind === "workflow_run") await db.delete(workflowRuns).where(eq(workflowRuns.id, f.id));
    }
  });

  it("a Slack message wakes a persistent agent with the message and its fields", async () => {
    const { fireEventTriggers, normalizeSlackEvent } = await import("./event-trigger-service.js");
    const { createPersistentAgent } = await import("./persistent-agent-service.js");
    const { persistentAgentMessages } = await import("../db/schema.js");
    const agent = await createPersistentAgent({
      slug: `it-slack-agent-${Date.now().toString(36)}`,
      name: "Slack agent",
      initialPrompt: "You answer the team.",
    });
    const trigger = await triggerService.createTrigger({
      targetType: "persistent_agent",
      targetId: agent.id,
      type: "slack",
      config: { channelId: "C0IT12345", keyword: "deploy" },
    });

    const event = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "message",
        channel: "C0IT12345",
        user: "U42",
        text: "can someone deploy staging?",
        ts: "1700000000.000100",
      },
    })!;
    const fired = await fireEventTriggers("slack", event);
    expect(fired.filter((f) => f.triggerId === trigger.id)).toEqual([
      { triggerId: trigger.id, matched: "message", kind: "persistent_agent", id: agent.id },
    ]);

    const messages = await db
      .select()
      .from(persistentAgentMessages)
      .where(eq(persistentAgentMessages.agentId, agent.id));
    const msg = messages.find((m) => m.body.includes("deploy staging"));
    expect(msg).toBeTruthy();
    expect(msg!.senderType).toBe("system");
    expect(msg!.structuredPayload).toMatchObject({
      source: "slack",
      channelId: "C0IT12345",
      userId: "U42",
      text: "can someone deploy staging?",
    });
    const [after] = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.id, trigger.id));
    expect(after.lastFiredAt).not.toBeNull();
  });
});
