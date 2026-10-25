/**
 * Work events → email, against real Postgres (docs/notifications.md): who
 * gets an email when work reaches pr_opened / needs_attention / failed /
 * completed, with the person's choices and the visibility rule applied,
 * through a memory transport instead of a relay. The last tests go through
 * the real hooks: `transitionTask` and `transitionWorkflowRunCas`, a
 * person's cancel, and the reconciler's own retry of a failed Job run.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { reconcileStandalone, TaskState, WorkflowRunState } from "@optio/shared";
import { db } from "../../db/client.js";
import {
  notifySmtpSettings,
  teamMembers,
  teams,
  users,
  workspaceMembers,
} from "../../db/schema.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "../reconcile-snapshot.js";
import { executeAction } from "../reconcile-executor.js";
import { transitionTask } from "../task-service.js";
import { cancelWorkflowRun, transitionWorkflowRunCas } from "../workflow-service.js";
import { createMemoryEmailTransport, setEmailTransportForTests } from "./email.js";
import { notifyWorkEvent } from "./dispatch.js";
import { updateChannelChoices } from "./preferences.js";

const uniq = () => randomBytes(4).toString("hex");
const mail = createMemoryEmailTransport();

async function person(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
    })
    .returning();
  return row;
}

/** A workspace in "teams" mode: an admin, a team (Platform) with an admin and members, an outsider. */
async function setup() {
  const ws = await insertWorkspace({ workVisibility: "teams" });
  const [admin, owner, lead, member, outsider] = await Promise.all(
    ["admin", "owner", "lead", "member", "outsider"].map(person),
  );
  await db.insert(workspaceMembers).values([
    { workspaceId: ws.id, userId: admin.id, role: "admin" },
    { workspaceId: ws.id, userId: owner.id, role: "member" },
    { workspaceId: ws.id, userId: lead.id, role: "member" },
    { workspaceId: ws.id, userId: member.id, role: "member" },
    { workspaceId: ws.id, userId: outsider.id, role: "member" },
  ]);
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${uniq()}` })
    .returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: lead.id, role: "admin" },
    { teamId: team.id, userId: owner.id, role: "member" },
    { teamId: team.id, userId: member.id, role: "member" },
  ]);
  return { ws, team, admin, owner, lead, member, outsider };
}

const to = () => mail.sent.map((m) => m.to[0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Job run's attempt: queued → running → failed through the real transitions. */
async function failAttempt(runId: string, from: WorkflowRunState, error: string) {
  if (from === WorkflowRunState.QUEUED) {
    await transitionWorkflowRunCas(runId, WorkflowRunState.QUEUED, WorkflowRunState.RUNNING, {
      startedAt: new Date(),
    });
  }
  await transitionWorkflowRunCas(runId, WorkflowRunState.RUNNING, WorkflowRunState.FAILED, {
    errorMessage: error,
    finishedAt: new Date(),
  });
}

beforeAll(() => setEmailTransportForTests(mail));
afterAll(() => setEmailTransportForTests(null));

beforeEach(async () => {
  mail.sent.length = 0;
  mail.failWith(null);
  vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.test:25");
  vi.stubEnv("OPTIO_SMTP_FROM", "Optio <optio@example.test>");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  await db.delete(notifySmtpSettings);
});

describe("work events by email", () => {
  it("tells the owner their merge request is waiting, with the links", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      title: "Add a health endpoint",
      repoUrl: "https://gitlab.example.test/platform/hello-service",
      state: "pr_opened",
      prUrl: "https://gitlab.example.test/platform/hello-service/-/merge_requests/3",
    });
    const out = await notifyWorkEvent(task.id, "pr_opened");
    expect(out.sent).toEqual([s.owner.id]);
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m.to).toEqual([s.owner.email]);
    expect(m.from).toBe("optio@example.test");
    expect(m.subject).toBe("[Optio] Merge request waiting for you: Add a health endpoint");
    expect(m.text).toContain(
      "https://gitlab.example.test/platform/hello-service/-/merge_requests/3",
    );
    expect(m.text).toContain(`https://optio.example.test/work/${task.id}`);
    expect(m.headers).toMatchObject({ "X-Optio-Event": "task.pr_opened", "X-Optio-Work": task.id });
  });

  it("tells a team's admins about the team's work, not its other members or other people", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      ownerTeamId: s.team.id,
      createdBy: s.owner.id,
      state: "failed",
      errorMessage: "tests failed",
    });
    await notifyWorkEvent(task.id, "failed");
    expect(to().sort()).toEqual([s.owner.email, s.lead.email].sort());
    const lead = mail.sent.find((m) => m.to[0] === s.lead.email)!;
    expect(lead.text).toContain("you're an admin of the team Platform");
    expect(lead.text).toContain("What went wrong:\ntests failed");
  });

  it("keeps what each person turned off", async () => {
    const s = await setup();
    await updateChannelChoices(s.lead.id, { teamWork: false });
    await updateChannelChoices(s.owner.id, { email: { "task.needs_attention": false } });
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      ownerTeamId: s.team.id,
      createdBy: s.owner.id,
      state: "needs_attention",
    });
    const out = await notifyWorkEvent(task.id, "needs_attention");
    expect(mail.sent).toHaveLength(0);
    expect(out.skipped.map((x) => x.why)).toEqual(["turned off", "turned off"]);

    // The lead still hears about their own work.
    const own = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.lead.id,
      state: "needs_attention",
    });
    await notifyWorkEvent(own.id, "needs_attention");
    expect(to()).toEqual([s.lead.email]);
  });

  it("sends 'merged' only to who asked for it, and only for a merged MR", async () => {
    const s = await setup();
    const merged = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      state: "completed",
      prUrl: "https://gitlab.example.test/a/b/-/merge_requests/1",
      prState: "merged",
    });
    await notifyWorkEvent(merged.id, "completed");
    expect(mail.sent).toHaveLength(0); // off by default

    await updateChannelChoices(s.owner.id, { email: { "task.completed": true } });
    await notifyWorkEvent(merged.id, "completed");
    expect(mail.sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^\[Optio\] Merged: /)]);

    const noMr = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      state: "completed",
    });
    await notifyWorkEvent(noMr.id, "completed");
    expect(mail.sent).toHaveLength(1);
  });

  it("emails the organization's work to whoever started it, and nothing for review subtasks", async () => {
    const s = await setup();
    const org = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: null,
      createdBy: s.member.id,
      state: "failed",
    });
    await notifyWorkEvent(org.id, "failed");
    expect(to()).toEqual([s.member.email]);

    const review = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      taskType: "review",
      state: "failed",
    });
    await notifyWorkEvent(review.id, "failed");
    expect(mail.sent).toHaveLength(1);
  });

  it("says nothing to someone who left the workspace", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.outsider.id,
      state: "failed",
    });
    await db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, s.ws.id), eq(workspaceMembers.userId, s.outsider.id)),
      );
    await notifyWorkEvent(task.id, "failed");
    expect(mail.sent).toHaveLength(0);
  });

  it("emails a failed Job run to the Job's owner, linked to the run, named after the Job", async () => {
    const s = await setup();
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      name: "Nightly report",
      maxRetries: 0,
    });
    const run = await insertWorkflowRun(job.id, { state: "failed", errorMessage: "exit status 3" });
    await notifyWorkEvent(run.id, "failed");
    expect(to()).toEqual([s.owner.email]);
    expect(mail.sent[0].subject).toBe("[Optio] Failed: Nightly report");
    expect(mail.sent[0].text).toContain(`https://optio.example.test/jobs/${job.id}/runs/${run.id}`);
    // A Job run has no merge request: completing is not news.
    await notifyWorkEvent(run.id, "completed");
    expect(mail.sent).toHaveLength(1);
  });

  it("waits for a Job run's last failure: nothing while the reconciler will retry it", async () => {
    const s = await setup();
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      maxRetries: 2,
    });
    const failed = (retryCount: number, recoveryRequired = false) =>
      insertWorkflowRun(job.id, {
        state: "failed",
        errorMessage: "exit status 1",
        retryCount,
        recoveryRequired,
      });
    for (const n of [0, 1]) {
      const run = await failed(n);
      const out = await notifyWorkEvent(run.id, "failed");
      expect(out.sent, `attempt ${n + 1} of 3`).toEqual([]);
    }
    // The budget spent: this failure stays, so it is news.
    const last = await failed(2);
    expect((await notifyWorkEvent(last.id, "failed")).sent).toEqual([s.owner.id]);
    // recoveryRequired: the reconciler waits for a person instead of retrying.
    const held = await failed(0, true);
    expect((await notifyWorkEvent(held.id, "failed")).sent).toEqual([s.owner.id]);
    expect(mail.sent).toHaveLength(2);
  });

  it("says nothing about a Job run its owner cancelled", async () => {
    const s = await setup();
    // No retries at all: only the cancel itself keeps the email back.
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      maxRetries: 0,
    });
    const run = await insertWorkflowRun(job.id, { state: "running", startedAt: new Date() });
    await cancelWorkflowRun(run.id);
    const out = await notifyWorkEvent(run.id, "failed");
    expect(out.sent).toEqual([]);
    expect(mail.sent).toHaveLength(0);
  });

  it("sends nothing without a relay, or when the app's relay is turned off", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      state: "failed",
    });
    vi.stubEnv("OPTIO_SMTP_URL", "");
    await notifyWorkEvent(task.id, "failed");
    await db.insert(notifySmtpSettings).values({
      host: "relay.example.test",
      port: 25,
      security: "none",
      fromAddress: "optio@example.test",
      enabled: false,
    });
    await notifyWorkEvent(task.id, "failed");
    expect(mail.sent).toHaveLength(0);
  });

  it("reports a relay failure without throwing", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      state: "failed",
    });
    mail.failWith("Could not reach the relay relay.example.test:25 (ECONNREFUSED)");
    const out = await notifyWorkEvent(task.id, "failed");
    expect(out.sent).toEqual([]);
    expect(out.skipped).toEqual([
      { userId: s.owner.id, why: expect.stringMatching(/ECONNREFUSED/) },
    ]);
  });
});

describe("the hooks", () => {
  it("emails when a Task's transition commits (task-service → notification-service)", async () => {
    const s = await setup();
    const task = await insertTask({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      createdBy: s.owner.id,
      state: "running",
      prUrl: "https://gitlab.example.test/a/b/-/merge_requests/9",
    });
    await transitionTask(task.id, TaskState.PR_OPENED, "pr_detected");
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1), { timeout: 5000 });
    expect(mail.sent[0].to).toEqual([s.owner.email]);
  });

  it("emails when a Job run fails (workflow-service)", async () => {
    const s = await setup();
    const job = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      maxRetries: 0,
    });
    const run = await insertWorkflowRun(job.id, { state: "running", startedAt: new Date() });
    await failAttempt(run.id, WorkflowRunState.RUNNING, "exit status 1");
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1), { timeout: 5000 });
    expect(mail.sent[0].text).toContain("exit status 1");
  });

  it("emails a Job run once, at its last failure, through the reconciler's retry", async () => {
    const s = await setup();
    // The default budget: one retry after the first failure.
    const job = await insertWorkflow({ workspaceId: s.ws.id, ownerUserId: s.owner.id });
    expect(job.maxRetries).toBe(1);
    const run = await insertWorkflowRun(job.id, { state: "running", startedAt: new Date() });

    await failAttempt(run.id, WorkflowRunState.RUNNING, "attempt 1 failed");
    await sleep(750);
    expect(mail.sent, "emailed while the run was still to be retried").toHaveLength(0);

    // The reconciler's pass: back to the queue (reconcile-standalone decideFailed).
    const snapshot = (await buildWorldSnapshot({ kind: "standalone", id: run.id }))!;
    const retry = reconcileStandalone(snapshot);
    expect(retry).toMatchObject({ kind: "transition", trigger: "auto_retry" });
    expect(await executeAction(retry, snapshot)).toMatchObject({ status: "applied" });

    await failAttempt(run.id, WorkflowRunState.QUEUED, "attempt 2 failed");
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1), { timeout: 5000 });
    await sleep(250);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual([s.owner.email]);
    expect(mail.sent[0].text).toContain("attempt 2 failed");
  });

  it("emails nothing when a person cancels a Job run (workflow-service)", async () => {
    const s = await setup();
    const job = await insertWorkflow({ workspaceId: s.ws.id, ownerUserId: s.owner.id });
    const cancelled = await insertWorkflowRun(job.id, { state: "running", startedAt: new Date() });
    await cancelWorkflowRun(cancelled.id);
    // A real last failure after it, so the hook's work is known to be done.
    const other = await insertWorkflow({
      workspaceId: s.ws.id,
      ownerUserId: s.owner.id,
      name: "Other job",
      maxRetries: 0,
    });
    const failed = await insertWorkflowRun(other.id, { state: "running", startedAt: new Date() });
    await failAttempt(failed.id, WorkflowRunState.RUNNING, "exit status 2");
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1), { timeout: 5000 });
    await sleep(250);
    expect(mail.sent.map((m) => m.headers?.["X-Optio-Work"])).toEqual([failed.id]);
  });
});
