/**
 * Follow-ups from Jira (ticket-follow-ups.ts) against a fake Jira Server,
 * real Postgres and the real task queue: a person's new comment resumes the
 * waiting work with the comment as its instruction, once; Optio never takes
 * its own comments, the provider's account, GitLab's integration notes or
 * comments older than the work; the mention mode, the off switch and the
 * per-work limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { jiraRoundTrip } from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { tasks, ticketProviders, ticketWritebacks, users } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { storeSecret } from "./secret-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeJira, type FakeJira } from "../test-utils/fake-jira.js";
import { onTicketWorkTransition, recordWriteback } from "./ticket-writeback.js";
import {
  MAX_TASKS_PER_SWEEP,
  followUpCandidates,
  mentionedInstruction,
  pollTicketFollowUps,
  ticketRoundTripSweep,
} from "./ticket-follow-ups.js";
import { roundTripMarks } from "./ticket-round-trip-marks.js";
import { resolveProviderConfig } from "./ticket-sync-service.js";

let jira: FakeJira;
let workspaceId: string;
let n = 0;
const PUBLIC = "https://optio.example.test";
const MR = "https://gitlab.example.test/platform/hello-service/-/merge_requests/7";

type Provider = typeof ticketProviders.$inferSelect;

async function provider(
  followUps: "any" | "mention" | "off",
  over: { initialSyncAt?: Date | null; marks?: Record<string, string> } = {},
): Promise<Provider> {
  const [row] = await db
    .insert(ticketProviders)
    .values({
      source: "jira",
      config: {
        baseUrl: jira.url,
        deployment: "server",
        authType: "pat",
        roundTrip: {
          enabled: true,
          comments: true,
          remoteLink: true,
          followUps,
          transitions: { started: "", mrOpened: "", merged: "", failed: "" },
          ...over.marks,
        },
      },
      workspaceId,
      initialSyncAt: over.initialSyncAt === undefined ? new Date() : over.initialSyncAt,
    })
    .returning();
  await storeSecret(
    `ticket-provider:${row.id}`,
    JSON.stringify({ apiToken: "pat-1" }),
    "ticket-provider",
  );
  return row;
}

/** Work from a fresh issue, waiting with its MR open, made a minute ago. */
async function waitingWork(p: Provider, over: Partial<typeof tasks.$inferInsert> = {}) {
  const key = `OPS-${++n}`;
  const issue = jira.addIssue(key);
  const task = await insertTask({
    title: "Add a /health endpoint",
    state: TaskState.PR_OPENED,
    prUrl: MR,
    prNumber: 7,
    sessionId: "sess-1",
    ticketSource: "jira",
    ticketExternalId: key,
    workspaceId,
    metadata: { ticketProviderId: p.id },
    createdAt: new Date(Date.now() - 60_000),
    ...over,
  });
  return { task, key, issue };
}

const fresh = async (p: Provider) =>
  (await db.select().from(ticketProviders).where(eq(ticketProviders.id, p.id)))[0];
const poll = async (p: Provider) => {
  const row = await fresh(p);
  return pollTicketFollowUps(row, await resolveProviderConfig(row));
};
const sweep = async (p: Provider) => {
  const row = await fresh(p);
  await ticketRoundTripSweep(row, await resolveProviderConfig(row));
};
const ago = (ms: number) => new Date(Date.now() - ms);
const DAY = 86_400_000;
const stateOf = async (id: string) =>
  (await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, id)))[0].state;
const jobsOf = async (id: string) =>
  (await taskQueue.getJobs(["waiting", "delayed", "prioritized", "active"])).filter(
    (j) => j.data?.taskId === id,
  );

beforeAll(async () => {
  vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
  vi.stubEnv("PUBLIC_URL", PUBLIC);
  jira = await startFakeJira({ pat: "pat-1" });
  workspaceId = (await insertWorkspace()).id;
});

afterAll(async () => {
  await taskQueue.obliterate({ force: true }).catch(() => {});
  await taskQueue.close();
  await jira.close();
  vi.unstubAllEnvs();
  await getRedisClient().quit();
});

beforeEach(() => vi.unstubAllEnvs());

describe("a person's comment on the ticket", () => {
  it("resumes the waiting work with the comment as its instruction, once", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    vi.stubEnv("PUBLIC_URL", PUBLIC);
    const p = await provider("any");
    const { task, key, issue } = await waitingWork(p);
    // It started, then its MR was announced when it opened. (Announcing the
    // start here as real work does: otherwise the resume's own transition posts
    // it in the background, and under load it can land after the acknowledgement.)
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.RUNNING });
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PR_OPENED });
    // Before the work existed (it was in the prompt), Optio's account, GitLab's note.
    jira.comment(key, "Old context", jira.person, new Date(Date.now() - 3_600_000));
    jira.comment(key, "Optio opened merge request !7", jira.bot);
    jira.comment(
      key,
      "[Ada|https://gitlab] mentioned this issue in [a commit of platform/hello-service|x]",
      {
        ...jira.person,
        name: "gitlab",
        key: "gitlab",
        displayName: "GitLab",
      },
    );
    const asked = jira.comment(key, "Please also return the version in /health");

    expect(await poll(p)).toBe(1);
    expect(await stateOf(task.id)).toBe(TaskState.QUEUED);
    const [job] = await jobsOf(task.id);
    expect(job.data).toMatchObject({
      taskId: task.id,
      resumeSessionId: "sess-1",
      restartFromBranch: true,
    });
    expect(job.data.resumePrompt).toContain(`A person commented on the Jira ticket ${key}`);
    expect(job.data.resumePrompt).toContain(
      "Ada Lovelace wrote:\n> Please also return the version in /health",
    );
    expect(job.data.resumePrompt).toContain(`Your merge request ${MR} is still open`);
    expect(job.data.resumePrompt).not.toContain("Old context");
    expect(job.data.resumePrompt).not.toContain("mentioned this issue");

    // Optio says it took it, with the run's link; that comment is never read back.
    const ack = issue.comments.at(-1)!;
    expect(ack.author.name).toBe("optio-bot");
    expect(ack.body).toBe(
      `Optio is working on Ada Lovelace's comment: [the run|${PUBLIC}/work/${task.id}].`,
    );
    const rows = await db
      .select()
      .from(ticketWritebacks)
      .where(and(eq(ticketWritebacks.taskId, task.id), eq(ticketWritebacks.event, "follow_up")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: `${task.id}:follow_up:${asked.id}`,
      commentId: ack.id,
      status: "done",
    });

    // Back with its MR: the comment is answered on the ticket; nothing is taken again.
    await db.update(tasks).set({ state: TaskState.PR_OPENED }).where(eq(tasks.id, task.id));
    await onTicketWorkTransition({ taskId: task.id, toState: TaskState.PR_OPENED });
    expect(issue.comments.at(-1)!.body).toBe(
      `Optio pushed changes for Ada Lovelace's comment to [merge request !7|${MR}] ([the run|${PUBLIC}/work/${task.id}]).`,
    );
    const before = issue.comments.length;
    expect(await poll(p)).toBe(0);
    expect(issue.comments).toHaveLength(before);
    expect(await stateOf(task.id)).toBe(TaskState.PR_OPENED);
  });

  it("takes several new comments together, newest acknowledged", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any");
    const { task, key } = await waitingWork(p, { state: TaskState.NEEDS_ATTENTION, prUrl: null });
    jira.comment(key, "Use port 8080");
    jira.comment(key, "And log the request id", {
      ...jira.person,
      name: "grace",
      key: "g",
      displayName: "Grace",
    });
    expect(await poll(p)).toBe(1);
    const [job] = await jobsOf(task.id);
    expect(job.data.resumePrompt).toContain("People commented");
    expect(job.data.resumePrompt).toContain("> Use port 8080");
    expect(job.data.resumePrompt).toContain("Grace wrote:\n> And log the request id");
    expect(job.data.resumePrompt).not.toContain("still open");
    expect(job.data.restartFromBranch).toBe(false);
  });

  it("waits while the work runs, and is read once it waits again", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any");
    const { task, key } = await waitingWork(p, { state: TaskState.RUNNING });
    jira.comment(key, "One more thing");
    expect(await poll(p)).toBe(0);
    await db.update(tasks).set({ state: TaskState.PR_OPENED }).where(eq(tasks.id, task.id));
    expect(await poll(p)).toBe(1);
  });

  it("doesn't resume the own work of a person whose account is disabled (owner-standing.ts)", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any");
    const owner = async (disabledAt: Date | null) =>
      (
        await db
          .insert(users)
          .values({
            provider: "oidc",
            externalId: `left-${++n}`,
            email: `left-${n}@example.test`,
            displayName: "Left",
            disabledAt,
          })
          .returning({ id: users.id })
      )[0].id;
    const gone = await waitingWork(p, { ownerUserId: await owner(new Date()) });
    const here = await waitingWork(p, { ownerUserId: await owner(null) });
    jira.comment(gone.key, "Please go on");
    jira.comment(here.key, "Please go on");
    // Only the active person's work is taken; nothing is said on the leaver's ticket.
    const before = gone.issue.comments.length;
    expect(await poll(p)).toBe(1);
    expect(await stateOf(gone.task.id)).toBe(TaskState.PR_OPENED);
    expect(await jobsOf(gone.task.id)).toHaveLength(0);
    expect(gone.issue.comments).toHaveLength(before);
    expect(await stateOf(here.task.id)).toBe(TaskState.QUEUED);
  });
});

describe("the provider's follow-up setting", () => {
  it("mention: only a comment addressed to Optio, without its /optio", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("mention");
    const { task, key } = await waitingWork(p);
    jira.comment(key, "Looks good to me");
    expect(await poll(p)).toBe(0);
    jira.comment(key, "/optio rename the endpoint to /healthz");
    expect(await poll(p)).toBe(1);
    const [job] = await jobsOf(task.id);
    expect(job.data.resumePrompt).toContain("> rename the endpoint to /healthz");
    expect(job.data.resumePrompt).not.toContain("Looks good");
  });

  it("off: comments are never read", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("off");
    const { task, key } = await waitingWork(p);
    jira.comment(key, "Please change it");
    // Its own ticket and account only: an earlier test's resume may still be writing.
    const reads = () =>
      jira.calls.filter((c) => c.path.includes(`/issue/${key}/`) || c.path.endsWith("/myself"))
        .length;
    const calls = reads();
    expect(await poll(p)).toBe(0);
    expect(reads()).toBe(calls);
    expect(await stateOf(task.id)).toBe(TaskState.PR_OPENED);
  });
});

describe("comments from before follow-ups were on", () => {
  it("an upgrade doesn't replay the conversation on waiting work: only comments after it", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    // A provider that synced long before the round trip, with work waiting for weeks.
    const p = await provider("any");
    const { task, key } = await waitingWork(p, {
      state: TaskState.NEEDS_ATTENTION,
      prUrl: null,
      createdAt: ago(30 * DAY),
    });
    jira.comment(key, "thanks!", jira.person, ago(20 * DAY));
    jira.comment(key, "deployed to staging", jira.person, ago(10 * DAY));
    await sweep(p); // the first sweep since the upgrade
    expect(await stateOf(task.id)).toBe(TaskState.NEEDS_ATTENTION);
    expect(await jobsOf(task.id)).toHaveLength(0);
    const since = roundTripMarks((await fresh(p)).config).since!;
    expect(Date.now() - since.getTime()).toBeLessThan(60_000);

    jira.comment(
      key,
      "Please add the version to /health",
      jira.person,
      new Date(Date.now() + 1000),
    );
    await sweep(p);
    expect(await stateOf(task.id)).toBe(TaskState.QUEUED);
    const [job] = await jobsOf(task.id);
    expect(job.data.resumePrompt).toContain("> Please add the version to /health");
    expect(job.data.resumePrompt).not.toContain("staging");
  });

  it("a provider made since: comments after its work count from its first sweep on", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any", { initialSyncAt: null });
    const { task, key } = await waitingWork(p);
    jira.comment(key, "One more thing");
    await sweep(p);
    expect(roundTripMarks((await fresh(p)).config).since).toEqual(p.createdAt);
    expect(await stateOf(task.id)).toBe(TaskState.QUEUED);
  });

  it("follow-ups widened (Off → Any): only comments written since", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any", {
      marks: { since: ago(DAY).toISOString(), followUpsSince: ago(1000).toISOString() },
    });
    const { task, key } = await waitingWork(p, { createdAt: ago(2 * 3_600_000) });
    jira.comment(key, "said while follow-ups were off", jira.person, ago(3_600_000));
    expect(await poll(p)).toBe(0);
    jira.comment(key, "now for Optio", jira.person, new Date(Date.now() + 1000));
    expect(await poll(p)).toBe(1);
    const [job] = await jobsOf(task.id);
    expect(job.data.resumePrompt).toContain("> now for Optio");
    expect(job.data.resumePrompt).not.toContain("while follow-ups were off");
  });
});

describe("more waiting work than one sweep reads", () => {
  it("takes turns: every piece is read within two sweeps, none starved", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any");
    const keys: string[] = [];
    // Work that waits for ever, never touched (the oldest updated_at), and then some.
    for (let i = 0; i < MAX_TASKS_PER_SWEEP + 5; i++) {
      const { key } = await waitingWork(p, {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: null,
        updatedAt: ago((100 - i) * DAY),
      });
      keys.push(key);
    }
    const readIn = async () => {
      const from = jira.calls.length;
      await poll(p);
      return new Set(
        jira.calls
          .slice(from)
          .filter((c) => c.method === "GET" && c.path.endsWith("/comment"))
          .map((c) => c.path.split("/")[5]),
      );
    };
    const first = await readIn();
    const second = await readIn();
    expect(first.size).toBe(MAX_TASKS_PER_SWEEP);
    expect(second.size).toBe(MAX_TASKS_PER_SWEEP);
    expect(new Set([...first, ...second])).toEqual(new Set(keys));
  });
});

describe("the limit", () => {
  it("stops after OPTIO_TICKET_FOLLOW_UP_LIMIT follow-ups and says so once", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    vi.stubEnv("OPTIO_TICKET_FOLLOW_UP_LIMIT", "1");
    const p = await provider("any");
    const { task, key, issue } = await waitingWork(p);
    jira.comment(key, "First");
    expect(await poll(p)).toBe(1);
    await db.update(tasks).set({ state: TaskState.PR_OPENED }).where(eq(tasks.id, task.id));
    jira.comment(key, "Second");
    expect(await poll(p)).toBe(0);
    jira.comment(key, "Third");
    expect(await poll(p)).toBe(0);
    expect(await stateOf(task.id)).toBe(TaskState.PR_OPENED);
    const limits = issue.comments.filter((c) => c.body.includes("won't take more"));
    expect(limits).toHaveLength(1);
    expect(limits[0].body).toContain("picked up 1 comments");
  });
});

describe("the sweep the ticket sync runs", () => {
  it("retries unsent writes and reads follow-ups, and never throws", async () => {
    vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
    const p = await provider("any");
    const { task, key, issue } = await waitingWork(p);
    const id = await recordWriteback({
      event: "mr_opened",
      key: `${task.id}:mr_opened:${MR}`,
      taskId: task.id,
      providerId: p.id,
      ticketSource: "jira",
      ticketExternalId: key,
      details: { prUrl: MR, prNumber: 7 },
    });
    expect(id).toBeTruthy();
    const [fresh] = await db.select().from(ticketProviders).where(eq(ticketProviders.id, p.id));
    await ticketRoundTripSweep(fresh, await resolveProviderConfig(fresh));
    expect(issue.comments.map((c) => c.body)).toEqual([
      expect.stringContaining("Optio opened [merge request !7|"),
    ]);
    // A Jira that answers nothing useful: still no throw.
    // A Jira that refuses the credential: still no throw.
    await expect(
      ticketRoundTripSweep(fresh, { baseUrl: jira.url, deployment: "server", apiToken: "wrong" }),
    ).resolves.toBeUndefined();
  });
});

describe("the rules, without Jira", () => {
  const me = { name: "optio-bot", key: "JIRAUSER1", accountId: null };
  const c = (
    id: string,
    body: string,
    author: Record<string, unknown> = { name: "ada" },
    created = "2030-01-01T00:00:00.000+0000",
  ) => ({
    id,
    author,
    body,
    created,
  });

  it("mentions: /optio, @optio, the account's [~name]", () => {
    expect(mentionedInstruction("/optio: add a test", me, jiraRoundTrip)).toBe("add a test");
    expect(mentionedInstruction("hey @optio add a test", me, jiraRoundTrip)).toBe(
      "hey @optio add a test",
    );
    expect(mentionedInstruction("[~optio-bot] add a test", me, jiraRoundTrip)).toBe(
      "[~optio-bot] add a test",
    );
    expect(mentionedInstruction("email me at x@optio.corp", me, jiraRoundTrip)).toBeNull();
    expect(mentionedInstruction("optional", me, jiraRoundTrip)).toBeNull();
  });

  it("candidates: new, not Optio's, not taken, not GitLab's notes", () => {
    const out = followUpCandidates({
      comments: [
        c("1", "old", { name: "ada" }, "2000-01-01T00:00:00.000+0000"),
        c("2", "mine", { name: "optio-bot" }),
        c("3", "posted by Optio from another account", { name: "svc" }),
        c("4", "taken already"),
        c("5", "Ada mentioned this issue in a merge request of platform/x"),
        c("6", "   "),
        c("7", "do it"),
      ],
      taskCreatedAt: new Date("2026-01-01"),
      optioIds: new Set(["3"]),
      taken: new Set(["4"]),
      account: me,
      mode: "any",
      roundTrip: jiraRoundTrip,
    });
    expect(out.map((x) => x.id)).toEqual(["7"]);
  });

  it("candidates: newer than the provider's floor too; a comment without a time is not taken", () => {
    const out = followUpCandidates({
      comments: [
        c("1", "before follow-ups were on", { name: "ada" }, "2026-05-01T00:00:00.000+0000"),
        c("2", "no time", { name: "ada" }, "yesterday-ish"),
        c("3", "after", { name: "ada" }, "2026-07-01T00:00:00.000+0000"),
      ],
      taskCreatedAt: new Date("2026-01-01"),
      since: new Date("2026-06-01"),
      optioIds: new Set(),
      taken: new Set(),
      account: me,
      mode: "any",
      roundTrip: jiraRoundTrip,
    });
    expect(out.map((x) => x.id)).toEqual(["3"]);
  });
});
