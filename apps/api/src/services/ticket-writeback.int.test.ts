/**
 * The Jira round trip's writing half (ticket-writeback.ts) against a fake
 * Jira Server and real Postgres: what a ticket hears at each step of its
 * work, once per event however often it is announced, and how a failed
 * write is retried without repeating what went through.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks, ticketProviders, ticketWritebacks } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { storeSecret } from "./secret-service.js";
import * as taskService from "./task-service.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeJira, type FakeJira } from "../test-utils/fake-jira.js";
import {
  deliverWriteback,
  noteTicketSkipped,
  onTicketWorkTransition,
  publicReason,
  recordWriteback,
  retryTicketWritebacks,
} from "./ticket-writeback.js";
import { ensureRoundTripSince, roundTripMarks } from "./ticket-round-trip-marks.js";

let jira: FakeJira;
let workspaceId: string;
let providerId: string;
let n = 0;

const PUBLIC = "https://optio.example.test";

async function provider(roundTrip: Record<string, unknown> | undefined, over = {}) {
  const [row] = await db
    .insert(ticketProviders)
    .values({
      source: "jira",
      config: {
        baseUrl: jira.url,
        deployment: "server",
        authType: "pat",
        ...(roundTrip ? { roundTrip } : {}),
      },
      workspaceId,
      initialSyncAt: new Date(),
      ...over,
    })
    .returning();
  await storeSecret(
    `ticket-provider:${row.id}`,
    JSON.stringify({ apiToken: "pat-1" }),
    "ticket-provider",
  );
  return row;
}

/** A task from a fresh Jira issue, as the sync makes it. */
async function jiraWork(over: Partial<typeof tasks.$inferInsert> = {}, pid = providerId) {
  const key = `PLAT-${++n}`;
  jira.addIssue(key);
  const task = await insertTask({
    title: "Add a /health endpoint",
    ticketSource: "jira",
    ticketExternalId: key,
    workspaceId,
    metadata: { ticketUrl: `${jira.url}/browse/${key}`, ticketProviderId: pid },
    ...over,
  });
  return { task, key, issue: jira.issues.get(key)! };
}

const MAPPING = {
  enabled: true,
  comments: true,
  remoteLink: true,
  followUps: "any",
  transitions: { started: "In Progress", mrOpened: "In Review", merged: "Done", failed: "" },
};

beforeAll(async () => {
  vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
  vi.stubEnv("PUBLIC_URL", PUBLIC);
  jira = await startFakeJira({ pat: "pat-1" });
  workspaceId = (await insertWorkspace()).id;
  providerId = (await provider(MAPPING)).id;
});

afterAll(async () => {
  await jira.close();
  vi.unstubAllEnvs();
  await getRedisClient().quit();
});

beforeEach(() => {
  jira.calls.length = 0;
});

/** Waits for a background write (the transition hook doesn't block its caller). */
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the ticket hears how its work goes", () => {
  it("at start: a link to the run, In Progress, and the remote link — once", async () => {
    const { task, issue } = await jiraWork();
    // Through the real transition: task-service.ts's hook calls the round trip.
    await taskService.transitionTask(task.id, TaskState.QUEUED, "ticket_sync");
    await until(() => issue.remoteLinks.length === 1);

    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].author.name).toBe("optio-bot");
    expect(issue.comments[0].body).toBe(
      `Optio started work on this ticket. Follow [the run|${PUBLIC}/work/${task.id}].`,
    );
    expect(issue.status).toBe("In Progress");
    expect(issue.remoteLinks[0]).toMatchObject({
      globalId: `optio:${task.id}`,
      object: {
        url: `${PUBLIC}/work/${task.id}`,
        title: "Optio: Add a /health endpoint",
        summary: "In progress",
        status: { resolved: false },
      },
    });

    // Provisioning and running are the same start: nothing more.
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PROVISIONING });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.RUNNING });
    expect(issue.comments).toHaveLength(1);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    expect(row).toMatchObject({
      status: "done",
      doneSteps: ["comment", "transition", "link"],
      commentId: issue.comments[0].id,
    });
  });

  it("MR opened: its link, In Review, and the same remote link now pointing at the MR", async () => {
    const { task, issue } = await jiraWork();
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    const mr = "https://gitlab.example.test/platform/hello-service/-/merge_requests/3";
    await db.update(tasks).set({ prUrl: mr, prNumber: 3 }).where(eq(tasks.id, task.id));
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PR_OPENED });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PR_OPENED });

    expect(issue.comments.map((c) => c.body)).toEqual([
      expect.stringContaining("started work"),
      `Optio opened [merge request !3|${mr}] for this ticket ([the run|${PUBLIC}/work/${task.id}]).`,
    ]);
    expect(issue.status).toBe("In Review");
    expect(issue.remoteLinks).toHaveLength(1);
    expect(issue.remoteLinks[0].object).toMatchObject({
      url: mr,
      title: "Merge request !3: Add a /health endpoint",
      summary: "Waiting for review",
    });

    // Merged: said once, Done, the link struck through.
    await db.update(tasks).set({ prState: "merged" }).where(eq(tasks.id, task.id));
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.COMPLETED });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.COMPLETED });
    expect(issue.comments.at(-1)!.body).toBe(`Optio's [merge request !3|${mr}] was merged.`);
    expect(issue.comments).toHaveLength(3);
    expect(issue.status).toBe("Done");
    expect(issue.remoteLinks[0].object).toMatchObject({
      summary: "Merged",
      status: { resolved: true },
    });
  });

  it("completed without a merged MR says nothing", async () => {
    const { task, issue } = await jiraWork();
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.COMPLETED });
    expect(issue.comments).toHaveLength(0);
  });

  it("failed: the kind of failure, never the error itself; each failure once", async () => {
    const { task, issue } = await jiraWork({
      errorMessage:
        "Agent failed (exit code: 1)\n\nAgent stderr (last 4 KB):\nat load (/repo/.env) DB_PASSWORD=hunter2",
    });
    await onTicketWorkTransition({
      taskId: task.id,
      toState: TaskState.FAILED,
      at: "2026-10-24T10:00:00Z",
    });
    await onTicketWorkTransition({
      taskId: task.id,
      toState: TaskState.FAILED,
      at: "2026-10-24T10:00:00Z",
    });
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].body).toBe(
      `Optio's run failed: Agent exited with code 1. Details: [the run|${PUBLIC}/work/${task.id}].`,
    );
    // No mapping for failed: the status stays.
    expect(issue.status).toBe("To Do");
    expect(issue.remoteLinks[0].object.summary).toBe("Failed: Agent exited with code 1");
    // Jira's readers aren't the work's: the agent's stderr stays behind the run link.
    expect(JSON.stringify(jira.calls)).not.toContain("hunter2");
    // A later failure (after a retry) is news again.
    await onTicketWorkTransition({
      taskId: task.id,
      toState: TaskState.FAILED,
      at: "2026-10-24T11:00:00Z",
    });
    expect(issue.comments).toHaveLength(2);
  });

  it("needs a person: sent only if the work still waits after the grace", async () => {
    const { task, issue } = await jiraWork({
      state: TaskState.NEEDS_ATTENTION,
      errorMessage: "Agent completed successfully but did not open a pull request.",
    });
    await onTicketWorkTransition({
      taskId: task.id,
      toState: TaskState.NEEDS_ATTENTION,
      trigger: "completed_without_pr",
    });
    expect(issue.comments).toHaveLength(0);
    await retryTicketWritebacks(providerId);
    expect(issue.comments).toHaveLength(0); // still in its grace
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(ticketWritebacks.taskId, task.id));
    await retryTicketWritebacks(providerId);
    expect(issue.comments.map((c) => c.body)).toEqual([
      `Optio is waiting for a person: the agent finished without opening a merge request. See [the run|${PUBLIC}/work/${task.id}].`,
    ]);

    // An automatic resume passes through needs_attention: by the sweep the work moved on.
    const other = await jiraWork({ state: TaskState.QUEUED, errorMessage: "CI failed" });
    await onTicketWorkTransition({ taskId: other.task.id, toState: TaskState.NEEDS_ATTENTION });
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(ticketWritebacks.taskId, other.task.id));
    await retryTicketWritebacks(providerId);
    expect(other.issue.comments).toHaveLength(0);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.taskId, other.task.id));
    expect(row.status).toBe("skipped");
  });

  it("an error nobody classified: no reason on the ticket, the run link has it", async () => {
    const { task, issue } = await jiraWork({
      state: TaskState.NEEDS_ATTENTION,
      errorMessage: "Customer ACME's invoice 4411 has a negative total",
    });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.NEEDS_ATTENTION });
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(ticketWritebacks.taskId, task.id));
    await retryTicketWritebacks(providerId);
    expect(issue.comments.map((c) => c.body)).toEqual([
      `Optio is waiting for a person. See [the run|${PUBLIC}/work/${task.id}].`,
    ]);
    expect(issue.remoteLinks[0].object.summary).toBe("Waiting for a person");
    expect(JSON.stringify(jira.calls)).not.toContain("ACME");
  });
});

describe("the reason a ticket may read", () => {
  it("is the trigger's words, else the error's class, else nothing", () => {
    expect(publicReason("ci_failing", "Pipeline 99 failed: secret=1")).toBe(
      "its merge request's pipeline fails",
    );
    expect(publicReason("review_changes_requested", null)).toBe("a review asked for changes");
    expect(publicReason("plan_review", null)).toBe("its plan is ready for review");
    expect(publicReason(null, "OOMKilled")).toBe("Out of memory");
    expect(publicReason("agent_failed", "something only the run's viewers should read")).toBe("");
    expect(publicReason(undefined, "  ")).toBe("");
  });
});

describe("a write that fails", () => {
  it("is retried later without repeating the steps that went through", async () => {
    const { task, key, issue } = await jiraWork();
    jira.failNext(`POST /rest/api/2/issue/${key}/transitions`, 503);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    const read = async () =>
      (
        await db
          .select()
          .from(ticketWritebacks)
          .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`))
      )[0];
    let row = await read();
    expect(row.status).toBe("failed");
    expect(row.doneSteps).toEqual(["comment"]);
    expect(row.lastError).toContain("503");
    expect(issue.comments).toHaveLength(1);

    // Too soon for the sweep (attempts² minutes): untouched.
    await retryTicketWritebacks(providerId);
    expect((await read()).attempts).toBe(1);

    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(ticketWritebacks.id, row.id));
    await retryTicketWritebacks(providerId);
    row = await read();
    expect(row).toMatchObject({ status: "done", attempts: 2, lastError: null });
    expect(row.doneSteps).toEqual(["comment", "transition", "link"]);
    expect(issue.comments).toHaveLength(1); // not posted again
    expect(issue.status).toBe("In Progress");
  });

  it("an older event retried after a newer one went through doesn't move the ticket back", async () => {
    const { task, key, issue } = await jiraWork();
    const startedRow = async () =>
      (
        await db
          .select()
          .from(ticketWritebacks)
          .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`))
      )[0];
    // Jira is down when the work starts: the start fails, twice.
    jira.failNext(`POST /rest/api/2/issue/${key}/comment`, 503);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect((await startedRow()).status).toBe("failed");
    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    jira.failNext(`POST /rest/api/2/issue/${key}/comment`, 503);
    await retryTicketWritebacks(providerId);
    expect(await startedRow()).toMatchObject({ status: "failed", attempts: 2 });

    // Jira is back by the time the MR opens: that goes through at once.
    const mr = "https://gitlab.example.test/platform/hello-service/-/merge_requests/5";
    await db.update(tasks).set({ prUrl: mr, prNumber: 5 }).where(eq(tasks.id, task.id));
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PR_OPENED });
    expect(issue.status).toBe("In Review");

    // The start's retry comes due afterwards: it is out of date, nothing is sent.
    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    await retryTicketWritebacks(providerId);
    expect(issue.status).toBe("In Review");
    expect(issue.comments.map((c) => c.body)).toEqual([expect.stringContaining("Optio opened")]);
    expect(issue.remoteLinks).toHaveLength(1);
    expect(issue.remoteLinks[0].object).toMatchObject({ url: mr, summary: "Waiting for review" });
    const row = await startedRow();
    expect(row.status).toBe("skipped");
    expect(row.lastError).toContain('left out comment, transition, link: the newer "mr_opened"');

    // Likewise a late MR-opened after the merge: the ticket stays Done, the link resolved.
    const late = await jiraWork({ prUrl: mr, prNumber: 5 });
    jira.failNext(`POST /rest/api/2/issue/${late.key}/comment`, 503);
    await onTicketWorkTransition({ taskId: late.task.id, toState: TaskState.PR_OPENED });
    await db.update(tasks).set({ prState: "merged" }).where(eq(tasks.id, late.task.id));
    await onTicketWorkTransition({ taskId: late.task.id, toState: TaskState.COMPLETED });
    expect(late.issue.status).toBe("Done");
    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(ticketWritebacks.taskId, late.task.id));
    await retryTicketWritebacks(providerId);
    expect(late.issue.status).toBe("Done");
    expect(late.issue.remoteLinks[0].object.status).toEqual({ resolved: true });
  });

  it("a late start after a newer note still moves the ticket, but leaves the newer comment and link be", async () => {
    const { task, key, issue } = await jiraWork({
      state: TaskState.NEEDS_ATTENTION,
      errorMessage: "OOMKilled",
    });
    jira.failNext(`POST /rest/api/2/issue/${key}/comment`, 503);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    // Started ten minutes ago (the note below is backdated past its grace, but is newer).
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    // The work waits for a person; its note goes out after the grace (the start isn't due yet).
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.NEEDS_ATTENTION });
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(
        and(eq(ticketWritebacks.taskId, task.id), eq(ticketWritebacks.event, "needs_attention")),
      );
    await retryTicketWritebacks(providerId);
    expect(issue.comments.map((c) => c.body)).toEqual([
      expect.stringContaining("Optio is waiting for a person: Out of memory"),
    ]);
    // The start's retry: a "waiting" note moves nothing, so the start's move still applies.
    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    await retryTicketWritebacks(providerId);
    expect(issue.status).toBe("In Progress");
    expect(issue.comments).toHaveLength(1);
    expect(issue.remoteLinks[0].object.summary).toBe("Waiting for a person: Out of memory");
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.dedupeKey, `${task.id}:started`));
    expect(row).toMatchObject({ status: "done", doneSteps: ["transition"] });
    expect(row.lastError).toContain('left out comment, link: the newer "needs_attention"');
  });

  it("a needs-a-person note that failed is dropped once the work moved on", async () => {
    const { task, key, issue } = await jiraWork({
      state: TaskState.NEEDS_ATTENTION,
      errorMessage: "OOMKilled",
    });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.NEEDS_ATTENTION });
    await db
      .update(ticketWritebacks)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(ticketWritebacks.taskId, task.id));
    jira.failNext(`POST /rest/api/2/issue/${key}/comment`, 503);
    await retryTicketWritebacks(providerId);
    const [failed] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.taskId, task.id));
    expect(failed.status).toBe("failed");
    // A person resumed it; the retry comes due while it runs.
    await db.update(tasks).set({ state: TaskState.RUNNING }).where(eq(tasks.id, task.id));
    await db
      .update(ticketWritebacks)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(ticketWritebacks.id, failed.id));
    await retryTicketWritebacks(providerId);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.id, failed.id));
    expect(row.status).toBe("skipped");
    expect(issue.comments).toHaveLength(0);
  });

  it("is sent by one sender at a time", async () => {
    const { task, issue } = await jiraWork();
    await db.insert(ticketWritebacks).values({
      dedupeKey: `${task.id}:started`,
      taskId: task.id,
      providerId,
      ticketSource: "jira",
      ticketExternalId: issue.key,
      event: "started",
      status: "sending",
      claimedAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.taskId, task.id));
    expect(await deliverWriteback(row.id)).toBe("busy");
    expect(issue.comments).toHaveLength(0);
  });

  it("notes a status no transition reaches, without failing or retrying", async () => {
    const p = await provider({
      ...MAPPING,
      transitions: { ...MAPPING.transitions, started: "Nowhere" },
    });
    const { task, issue } = await jiraWork({}, p.id);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.taskId, task.id));
    expect(row.status).toBe("done");
    expect(row.lastError).toContain('no transition leads to "Nowhere"');
    expect(issue.status).toBe("To Do");
    expect(
      jira.calls.filter((c) => c.method === "POST" && c.path.endsWith("/transitions")),
    ).toHaveLength(0);
  });
});

describe("the provider's settings", () => {
  it("off: nothing is written to Jira at all", async () => {
    const p = await provider({
      enabled: true,
      comments: false,
      remoteLink: false,
      followUps: "off",
      transitions: { started: "", mrOpened: "", merged: "", failed: "" },
    });
    const { task } = await jiraWork({}, p.id);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect(jira.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("a provider without round-trip settings: the round trip is off, nothing is recorded", async () => {
    const p = await provider(undefined);
    const { task, issue } = await jiraWork({}, p.id);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect(issue.comments).toHaveLength(0);
    expect(issue.remoteLinks).toHaveLength(0);
    expect(
      await db.select().from(ticketWritebacks).where(eq(ticketWritebacks.taskId, task.id)),
    ).toHaveLength(0);
  });

  it("switched on with nothing else set: comments and the link, no status moves", async () => {
    const p = await provider({ enabled: true });
    const { task, issue } = await jiraWork({}, p.id);
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect(issue.comments).toHaveLength(1);
    expect(issue.remoteLinks).toHaveLength(1);
    expect(issue.status).toBe("To Do");
  });

  it("switched off after an event was recorded: the event is dropped, not sent", async () => {
    const p = await provider(MAPPING);
    const { task, issue } = await jiraWork({}, p.id);
    await recordWriteback({
      event: "started",
      key: `${task.id}:started`,
      taskId: task.id,
      providerId: p.id,
      ticketSource: "jira",
      ticketExternalId: task.ticketExternalId!,
    });
    await db
      .update(ticketProviders)
      .set({ config: { ...p.config, roundTrip: { ...MAPPING, enabled: false } } })
      .where(eq(ticketProviders.id, p.id));
    expect(await retryTicketWritebacks(p.id)).toBe(0);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.taskId, task.id));
    expect(row).toMatchObject({
      status: "skipped",
      lastError: "The round trip is off for this provider",
    });
    expect(issue.comments).toHaveLength(0);
  });

  it("older work without the provider noted finds its owner's Jira provider", async () => {
    const { task, issue } = await jiraWork({ metadata: {} });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect(issue.comments).toHaveLength(1);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(and(eq(ticketWritebacks.taskId, task.id), eq(ticketWritebacks.event, "started")));
    // The workspace's first Jira provider for the organization.
    expect(row.providerId).toBe(providerId);
  });

  it("work not from Jira is none of its business", async () => {
    const task = await insertTask({ ticketSource: "gitlab", ticketExternalId: "12", workspaceId });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.QUEUED });
    expect(jira.calls).toHaveLength(0);
  });
});

describe("a ticket no repository matches", () => {
  const skipped = (key: string) => {
    jira.addIssue(key);
    return { externalId: key, source: "jira" as any, repo: "nowhere/repo" };
  };

  it("is told why, once — but never the backlog a new provider's first sweep finds", async () => {
    const p = await provider(MAPPING, { initialSyncAt: null });
    // The first sweep: backlog, quietly noted.
    const backlog = skipped("PLAT-900");
    await noteTicketSkipped({ provider: p, ticket: backlog, firstSync: true });
    const swept = await ensureRoundTripSince(p); // what the sweep does after its tickets
    expect(roundTripMarks(swept.config).since).toEqual(p.createdAt);
    // Later sweeps keep quiet about the backlog too (Jira's search has no "since").
    await noteTicketSkipped({ provider: swept, ticket: backlog, firstSync: false });
    expect(jira.issues.get("PLAT-900")!.comments).toHaveLength(0);
    const [row] = await db
      .select()
      .from(ticketWritebacks)
      .where(eq(ticketWritebacks.dedupeKey, `skip:${p.id}:PLAT-900`));
    expect(row).toMatchObject({ status: "skipped", details: { backlog: true } });

    // A ticket filed since: told, once.
    const fresh = skipped("PLAT-901");
    await noteTicketSkipped({ provider: swept, ticket: fresh, firstSync: false });
    await noteTicketSkipped({ provider: swept, ticket: fresh, firstSync: false });
    const comments = jira.issues.get("PLAT-901")!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(
      'no repository it knows matches the label "repo:nowhere/repo"',
    );
  });

  it("after the upgrade: a provider that synced before keeps quiet about its backlog", async () => {
    const p = await provider(MAPPING); // synced before; no round-trip mark yet
    const backlog = skipped("PLAT-902");
    await noteTicketSkipped({ provider: p, ticket: backlog, firstSync: false });
    const before = Date.now();
    const swept = await ensureRoundTripSince(p);
    expect(roundTripMarks(swept.config).since!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The rest of its config is untouched; a second sweep keeps the mark.
    expect(swept.config).toMatchObject({ baseUrl: jira.url, roundTrip: MAPPING });
    expect((await ensureRoundTripSince(swept)).config).toEqual(swept.config);
    await noteTicketSkipped({ provider: swept, ticket: backlog, firstSync: false });
    expect(jira.issues.get("PLAT-902")!.comments).toHaveLength(0);
  });
});
