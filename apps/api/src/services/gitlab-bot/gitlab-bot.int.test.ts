/**
 * @-mentions of Optio's GitLab user (docs/gitlab-bot.md), end to end through
 * the signed GitLab receiver (routes/event-ingress.ts) against real Postgres
 * and Redis and a fake GitLab API (test-utils/fake-gitlab-bot.ts): who is mapped
 * to whom and refused why, the work an issue / someone's merge request / a
 * merge request Optio opened starts or resumes and whose it is, the
 * acknowledgement and the result in the thread, the bot's own notes,
 * redeliveries, the rate limit, the settings route (deployment admins) and
 * the action log.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { TaskState } from "@optio/shared";
import { db } from "../../db/client.js";
import {
  gitlabMentions,
  optioActions,
  taskEvents,
  tasks,
  users,
  workspaceMembers,
} from "../../db/schema.js";
import authPlugin from "../../plugins/auth.js";
import { eventIngressRoutes } from "../../routes/event-ingress.js";
import { gitlabBotRoutes } from "../../routes/gitlab-bot.js";
import { createSession, linkIdentity } from "../session-service.js";
import { storeSecret } from "../secret-service.js";
import * as taskService from "../task-service.js";
import { transitionTask } from "../task-service.js";
import { findPerson } from "../person-lookup.js";
import { getRedisClient } from "../event-bus.js";
import { insertRepo, insertTask, insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { fakeGitLab, type FakeGitLab } from "../../test-utils/fake-gitlab-bot.js";
import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { mentionWorkSettled } from "./ingress.js";
import { forgetBotIdentities, saveGitLabBotSettings } from "./settings.js";

const HOST = "gitlab.example.test";
const PROJECT_URL = `https://${HOST}/platform/hello-service`;
const PROJECT_ID = 42;
const SECRET = "hook-secret-it";
const ORG_TOKEN = "glpat-organization-token";
const PUBLIC = "https://optio.example.test";

let app: FastifyInstance;
let gl: FakeGitLab;
let workspaceId: string;

type Person = {
  userId: string;
  headers: Record<string, string>;
  gitlabId: number;
  username: string;
};
let alice: Person, bob: Person, vic: Person, rita: Person, dana: Person;
const mallory = { gitlabId: 505, username: "mallory" };

async function person(
  name: string,
  opts: {
    role: "admin" | "member" | "viewer";
    gitlabId: number;
    gitlabUsername?: string;
    directoryUsername?: string;
    access?: number;
    token?: boolean;
  },
): Promise<Person> {
  const { token, user } = await createSession("oidc", {
    externalId: `kc-${name}-${randomBytes(3).toString("hex")}`,
    email: `${name}@example.test`,
    displayName: name[0].toUpperCase() + name.slice(1),
    username: opts.directoryUsername ?? name,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: opts.role });
  await linkIdentity(user.id, "gitlab", { externalId: String(opts.gitlabId), email: user.email });
  if (opts.access !== undefined) gl.members.set(opts.gitlabId, opts.access);
  if (opts.token)
    await storeSecret("ANTHROPIC_AUTH_TOKEN", `sk-${name}`, "user", undefined, user.id);
  return {
    userId: user.id,
    headers: { authorization: `Bearer ${token}`, "x-workspace-id": workspaceId },
    gitlabId: opts.gitlabId,
    username: opts.gitlabUsername ?? name,
  };
}

let noteSeq = 7000;

function issueNote(author: { gitlabId: number; username: string }, note: string, iid = 3) {
  return {
    object_kind: "note",
    event_type: "note",
    user: { id: author.gitlabId, username: author.username, email: "[REDACTED]" },
    project: {
      id: PROJECT_ID,
      path_with_namespace: "platform/hello-service",
      web_url: PROJECT_URL,
    },
    object_attributes: {
      id: ++noteSeq,
      note,
      noteable_type: "Issue",
      author_id: author.gitlabId,
      discussion_id: `d-${noteSeq}`,
      url: `${PROJECT_URL}/-/issues/${iid}#note_${noteSeq}`,
      system: false,
      action: "create",
    },
    issue: {
      iid,
      title: "README is missing a line",
      description: "The README should say how to run the tests.",
      state: "opened",
      url: `${PROJECT_URL}/-/issues/${iid}`,
    },
  };
}

function mrNote(
  author: { gitlabId: number; username: string },
  note: string,
  mr: {
    iid: number;
    state?: string;
    sourceBranch?: string;
    sourceProjectId?: number;
    sha?: string;
  },
) {
  return {
    object_kind: "note",
    event_type: "note",
    user: { id: author.gitlabId, username: author.username, email: "[REDACTED]" },
    project: {
      id: PROJECT_ID,
      path_with_namespace: "platform/hello-service",
      web_url: PROJECT_URL,
    },
    object_attributes: {
      id: ++noteSeq,
      note,
      noteable_type: "MergeRequest",
      author_id: author.gitlabId,
      discussion_id: `d-${noteSeq}`,
      url: `${PROJECT_URL}/-/merge_requests/${mr.iid}#note_${noteSeq}`,
      system: false,
    },
    merge_request: {
      iid: mr.iid,
      title: "Add a greeting",
      description: "Says hello.",
      state: mr.state ?? "opened",
      url: `${PROJECT_URL}/-/merge_requests/${mr.iid}`,
      source_branch: mr.sourceBranch ?? "feature/greeting",
      target_branch: "main",
      source_project_id: mr.sourceProjectId ?? PROJECT_ID,
      target_project_id: PROJECT_ID,
      last_commit: { id: mr.sha ?? "0000000" },
    },
  };
}

async function deliver(payload: object, uuid: string = randomUUID()) {
  const res = await app.inject({
    method: "POST",
    url: "/api/webhooks/gitlab",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": SECRET,
      "x-gitlab-event-uuid": uuid,
    },
    payload: JSON.stringify(payload),
  });
  expect(res.statusCode, res.body).toBe(200);
  await mentionWorkSettled();
}

const lastNote = () => gl.notes[gl.notes.length - 1];

async function mentionRow(noteId: number) {
  const [row] = await db
    .select()
    .from(gitlabMentions)
    .where(and(eq(gitlabMentions.host, HOST), eq(gitlabMentions.noteId, noteId)));
  return row;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

/** The newest audit entry of `action` (they are written after the reply), waiting for one with `taskId`. */
async function auditOf(action: string, taskId?: string) {
  let row: typeof optioActions.$inferSelect | undefined;
  await waitFor(async () => {
    [row] = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, action))
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    return !!row && (!taskId || (row.params as { taskId?: string })?.taskId === taskId);
  });
  return row!;
}

async function queuedJob(taskId: string) {
  const { taskQueue } = await import("../../workers/task-worker.js");
  const jobs = await taskQueue.getJobs(["waiting", "delayed", "prioritized"]);
  return jobs
    .filter((j) => j.data?.taskId === taskId)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}

beforeAll(async () => {
  await import("../../workers/task-worker.js");
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
  vi.stubEnv("GITLAB_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("GITLAB_TOKEN", ORG_TOKEN);
  vi.stubEnv("GITLAB_HOSTS", HOST);
  vi.stubEnv("GITLAB_OAUTH_BASE_URL", `https://${HOST}`);
  vi.stubEnv("PUBLIC_URL", PUBLIC);
  vi.stubEnv("OPTIO_GITLAB_BOT_USERNAME", "");
  vi.stubEnv("OPTIO_GITLAB_BOT_ENABLED", "true");
  gl = fakeGitLab({
    host: HOST,
    bot: { id: 99, username: "optio-bot", bot: true },
    token: ORG_TOKEN,
  });
  vi.stubGlobal("fetch", gl.fetch);
  // The bot's calls go through the outbound guard: to the fake, with a fixed
  // public DNS answer (no real lookups).
  setOutboundDefaults({
    fetchImpl: (url, init) => globalThis.fetch(url, init),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });

  workspaceId = (await insertWorkspace()).id;
  await insertRepo({
    repoUrl: PROJECT_URL,
    fullName: "platform/hello-service",
    workspaceId,
    gitPlatform: "gitlab",
    defaultBranch: "main",
  });

  alice = await person("alice", { role: "member", gitlabId: 501, access: 30, token: true });
  // bob's directory name differs: his linked GitLab identity still decides.
  bob = await person("bob", {
    role: "member",
    gitlabId: 502,
    directoryUsername: "bob.smith",
    access: 30,
  });
  gl.users.set(502, { public_email: "bob@example.test" });
  vic = await person("vic", { role: "viewer", gitlabId: 503, access: 30, token: true });
  rita = await person("rita", { role: "member", gitlabId: 504, access: 20, token: true });
  dana = await person("dana", { role: "admin", gitlabId: 506, access: 40, token: true });
  await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, dana.userId));
  gl.members.set(mallory.gitlabId, 30);

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(eventIngressRoutes);
  await app.register(gitlabBotRoutes);
  await app.ready();
});

afterAll(async () => {
  await mentionWorkSettled();
  await app?.close();
  const { taskQueue } = await import("../../workers/task-worker.js");
  await taskQueue.close();
  await getRedisClient().quit();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  gl.notes.length = 0;
  gl.awards.length = 0;
  gl.calls.length = 0;
});

describe("a comment on an issue", () => {
  it("starts alice's own work from the issue, with an eyes award and the run's link", async () => {
    const payload = issueNote(alice, "@optio-bot add a line to README");
    await deliver(payload);

    expect(gl.awards).toEqual([
      expect.objectContaining({
        noteable: "issues",
        iid: 3,
        noteId: payload.object_attributes.id,
        name: "eyes",
      }),
    ]);
    const row = await mentionRow(payload.object_attributes.id);
    expect(row).toMatchObject({
      status: "started",
      command: "work",
      userId: alice.userId,
      workspaceId,
    });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId!));
    expect(task).toMatchObject({
      ownerUserId: alice.userId,
      createdBy: alice.userId,
      workspaceId,
      repoBranch: "main",
      state: "queued",
      title: "#3: add a line to README",
      maxRetries: 0,
    });
    expect(task.prompt).toContain("> add a line to README");
    expect(task.prompt).toContain("README is missing a line");
    expect(task.prompt).toContain("Closes #3");

    expect(gl.notes).toHaveLength(1);
    expect(lastNote()).toMatchObject({
      noteable: "issues",
      iid: 3,
      discussionId: payload.object_attributes.discussion_id,
      auth: ORG_TOKEN,
    });
    expect(lastNote().body).toContain("@alice On it");
    expect(lastNote().body).toContain(`${PUBLIC}/work/${task.id}`);
    expect(lastNote().body).not.toContain("@optio-bot");

    const audit = await auditOf("gitlab_mention.start", task.id);
    expect(audit).toMatchObject({ userId: alice.userId, workspaceId, success: true });
    expect(audit.params).toMatchObject({ taskId: task.id, kind: "work", type: "gitlab" });

    // The run ends: its result goes to the same thread, once.
    await transitionTask(task.id, TaskState.PROVISIONING, "test");
    await transitionTask(task.id, TaskState.RUNNING, "test");
    await db
      .update(tasks)
      .set({ prUrl: `${PROJECT_URL}/-/merge_requests/77`, prNumber: 77 })
      .where(eq(tasks.id, task.id));
    await transitionTask(task.id, TaskState.PR_OPENED, "pr_detected");
    await waitFor(() => gl.notes.length === 2);
    expect(lastNote().body).toBe(
      `@alice Done: ${PROJECT_URL}/-/merge_requests/77 is ready for your review (${PUBLIC}/work/${task.id}).`,
    );
    expect(lastNote().discussionId).toBe(payload.object_attributes.discussion_id);
    expect((await mentionRow(payload.object_attributes.id)).status).toBe("done");
    await transitionTask(task.id, TaskState.COMPLETED, "pr_merged");
    await new Promise((r) => setTimeout(r, 300));
    expect(gl.notes).toHaveLength(2);
  });

  it("tells the thread a failed run's error class, never the error itself", async () => {
    const payload = issueNote(alice, "@optio-bot add a line to README", 41);
    await deliver(payload);
    const row = await mentionRow(payload.object_attributes.id);
    await transitionTask(row.taskId!, TaskState.PROVISIONING, "test");
    await transitionTask(row.taskId!, TaskState.RUNNING, "test");
    await db
      .update(tasks)
      .set({
        errorMessage: "OOMKilled: /home/runner/work/internal.corp.lan/build.sh: DB_PASSWORD unset",
      })
      .where(eq(tasks.id, row.taskId!));
    await transitionTask(row.taskId!, TaskState.FAILED, "agent_failed");
    await waitFor(() => gl.notes.length === 2);
    expect(lastNote().body).toBe(
      `@alice The run failed: Out of memory (${PUBLIC}/work/${row.taskId}).`,
    );
  });

  it("handles a comment once, however many times GitLab delivers it", async () => {
    const payload = issueNote(alice, "@optio-bot help", 4);
    await deliver(payload, "uuid-1");
    await deliver(payload, "uuid-1");
    await deliver(payload, "uuid-2");
    expect(gl.notes).toHaveLength(1);
    expect(lastNote().body).toContain("Mention me with what to do");
  });

  it("finds bob by his linked GitLab identity, whatever his directory name", async () => {
    const payload = issueNote(bob, "@optio-bot add a line", 5);
    await deliver(payload);
    const row = await mentionRow(payload.object_attributes.id);
    expect(row).toMatchObject({ status: "started", userId: bob.userId });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId!));
    expect(task).toMatchObject({ ownerUserId: bob.userId, createdBy: bob.userId });
  });

  it("refuses someone with no Optio account, a viewer and a Reporter", async () => {
    await deliver(issueNote(mallory, "@optio-bot add a line", 6));
    expect(lastNote().body).toContain("@mallory I can't tell which Optio account is yours");
    expect(lastNote().body).toContain(PUBLIC);

    await deliver(issueNote(vic, "@optio-bot add a line", 6));
    expect(lastNote().body).toContain("@vic You can look but not start work");

    await deliver(issueNote(rita, "@optio-bot add a line", 6));
    expect(lastNote().body).toContain("Developer role on `platform/hello-service`");

    // Audit entries are written after the reply (never awaited).
    const refusedNow = () =>
      db.select().from(optioActions).where(eq(optioActions.action, "gitlab_mention.refuse"));
    await waitFor(async () => (await refusedNow()).length >= 3);
    const refused = await refusedNow();
    const reasons = refused.map((r) => (r.params as { status?: string }).status);
    expect(reasons).toEqual(expect.arrayContaining(["no_account", "viewer", "gitlab_access"]));
    // No account: no workspace to put it in — a deployment admin's entry.
    expect(
      refused.find((r) => (r.params as { status?: string }).status === "no_account"),
    ).toMatchObject({ workspaceId: null, success: false });
  });

  it("never takes a directory name, and takes an email only when verified and unlinked", async () => {
    // carol signed in to Optio and linked GitLab user 520.
    const carol = await person("carol", { role: "member", gitlabId: 520, token: true });
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, carol.userId));
    // A GitLab local account that took the name carol and shows carol's address.
    const impostor = { gitlabId: 521, username: "carol" };
    gl.members.set(impostor.gitlabId, 30);
    gl.users.set(impostor.gitlabId, { public_email: "carol@example.test" });
    // erin never linked GitLab; her Optio email is verified and is her public GitLab email.
    const { user: erin } = await createSession("oidc", {
      externalId: `kc-erin-${randomBytes(3).toString("hex")}`,
      email: "erin@example.test",
      displayName: "Erin",
      username: "erin",
    });
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, erin.id));
    await db.insert(workspaceMembers).values({ workspaceId, userId: erin.id, role: "member" });
    gl.members.set(522, 30);
    gl.users.set(522, { public_email: "Erin@example.test" });
    // frank's email isn't verified in Optio.
    const { user: frank } = await createSession("oidc", {
      externalId: `kc-frank-${randomBytes(3).toString("hex")}`,
      email: "frank@example.test",
      displayName: "Frank",
      username: "frank",
    });
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, frank.id));
    gl.members.set(523, 30);
    gl.users.set(523, { public_email: "frank@example.test" });
    try {
      // carol already signs in with another GitLab user: her email doesn't make 521 her.
      const payload = issueNote(impostor, "@optio-bot add a line", 30);
      await deliver(payload);
      const row = await mentionRow(payload.object_attributes.id);
      expect(row).toMatchObject({ status: "refused", reason: "no_account", userId: null });
      const carolsWork = await db.select().from(tasks).where(eq(tasks.createdBy, carol.userId));
      expect(carolsWork).toHaveLength(0);

      // erin: no linked identity, one verified match: her own work.
      const erinNote = issueNote(
        { gitlabId: 522, username: "erin-gl" },
        "@optio-bot add a line",
        30,
      );
      await deliver(erinNote);
      expect(await mentionRow(erinNote.object_attributes.id)).toMatchObject({
        status: "started",
        userId: erin.id,
      });

      // frank: an unverified Optio email never matches.
      const frankNote = issueNote({ gitlabId: 523, username: "frank" }, "@optio-bot add", 30);
      await deliver(frankNote);
      expect(await mentionRow(frankNote.object_attributes.id)).toMatchObject({
        reason: "no_account",
        userId: null,
      });

      // The lookup itself: never a name, never a placeholder email.
      const email = (v: string | null) => async () => v;
      expect(await findPerson({ email: email("[REDACTED]") })).toEqual({
        found: false,
        reason: "none",
      });
      expect(await findPerson({ email: email(null) })).toEqual({ found: false, reason: "none" });
      expect(
        await findPerson({
          linked: { provider: "gitlab", externalId: "521" },
          email: email("carol@example.test"),
        }),
      ).toEqual({ found: false, reason: "none" });
      expect(await findPerson({ linked: { provider: "gitlab", externalId: "520" } })).toMatchObject(
        { found: true, userId: carol.userId, by: "identity" },
      );
      expect(await findPerson({ email: email("erin@example.test") })).toMatchObject({
        found: true,
        userId: erin.id,
        by: "email",
      });
    } finally {
      for (const id of [impostor.gitlabId, 522, 523]) gl.users.delete(id);
    }
  });

  it("refuses someone only in another workspace, and two verified accounts with one email", async () => {
    // olga works in another workspace, which doesn't have this repo.
    const { user: olga } = await createSession("oidc", {
      externalId: `kc-olga-${randomBytes(3).toString("hex")}`,
      email: "olga@example.test",
      displayName: "Olga",
      username: "olga",
    });
    const elsewhere = await insertWorkspace();
    await linkIdentity(olga.id, "gitlab", { externalId: "531", email: olga.email });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: elsewhere.id, userId: olga.id, role: "admin" });
    gl.members.set(531, 40);
    const olgaNote = issueNote({ gitlabId: 531, username: "olga" }, "@optio-bot add a line", 31);
    await deliver(olgaNote);
    expect(lastNote().body).toContain(
      "@olga You aren't a member of the Optio workspace that has `platform/hello-service`",
    );
    expect(await mentionRow(olgaNote.object_attributes.id)).toMatchObject({
      reason: "not_member",
      userId: olga.id,
      taskId: null,
    });

    // Two accounts verified twin@example.test: Optio won't guess whose work it is.
    await db.insert(users).values([
      {
        provider: "oidc",
        externalId: "kc-twin-1",
        email: "twin@example.test",
        emailVerified: true,
        displayName: "Twin 1",
        username: "twin1",
      },
      {
        provider: "google",
        externalId: "g-twin",
        email: "Twin@example.test",
        emailVerified: true,
        displayName: "Twin 2",
        username: "twin2",
      },
    ]);
    gl.members.set(532, 30);
    gl.users.set(532, { public_email: "twin@example.test" });
    const twinNote = issueNote({ gitlabId: 532, username: "twin1" }, "@optio-bot add a line", 31);
    await deliver(twinNote);
    expect(await mentionRow(twinNote.object_attributes.id)).toMatchObject({
      reason: "ambiguous_account",
      userId: null,
      taskId: null,
    });
    expect(lastNote().body).toContain("More than one Optio account has your GitLab email");
  });

  it("answers an unexpected error with a reference, never the error itself", async () => {
    const spy = vi
      .spyOn(taskService, "submitTask")
      .mockRejectedValueOnce(
        new Error(
          'Failed query: insert into "tasks" ... params: sk-alice,add a line,internal-db:5432',
        ),
      );
    try {
      const payload = issueNote(alice, "@optio-bot add a line", 32);
      await deliver(payload);
      expect(spy).toHaveBeenCalledTimes(1);
      const row = await mentionRow(payload.object_attributes.id);
      expect(row).toMatchObject({ status: "failed", reason: "error", taskId: null });
      expect(lastNote().body).toBe(
        `@alice Something went wrong on my side and I couldn't start the work. An Optio admin can look it up with the reference \`${row.id}\`.`,
      );
      for (const leak of ["Failed query", "sk-alice", "internal-db"]) {
        expect(lastNote().body).not.toContain(leak);
      }
      let audit: typeof optioActions.$inferSelect | undefined;
      await waitFor(async () => {
        const rows = await db
          .select()
          .from(optioActions)
          .where(eq(optioActions.action, "gitlab_mention.refuse"));
        audit = rows.find((r) => (r.params as { id?: string }).id === row.id);
        return !!audit;
      });
      expect(audit!.params).toMatchObject({ status: "error", id: row.id });
      expect(JSON.stringify(audit)).not.toContain("Failed query");
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores the bot's own notes, notes that don't mention it, and projects Optio doesn't have", async () => {
    await deliver(issueNote({ gitlabId: 99, username: "optio-bot" }, "@alice On it", 9));
    await deliver(issueNote(alice, "@bob have a look", 9));
    const elsewhere = issueNote(alice, "@optio-bot add a line", 9);
    elsewhere.project = {
      id: 77,
      path_with_namespace: "other/thing",
      web_url: `https://${HOST}/other/thing`,
    };
    await deliver(elsewhere);
    // A repo on a GitLab host nobody named: the organization's token doesn't go there.
    await insertRepo({
      repoUrl: "https://gitlab.unnamed.test/platform/hello-service",
      fullName: "platform/hello-service",
      workspaceId,
      gitPlatform: "gitlab",
    });
    const unnamed = issueNote(alice, "@optio-bot add a line", 9);
    unnamed.project = {
      id: 88,
      path_with_namespace: "platform/hello-service",
      web_url: "https://gitlab.unnamed.test/platform/hello-service",
    };
    await deliver(unnamed);
    expect(gl.notes).toHaveLength(0);
    expect(gl.awards).toHaveLength(0);
    expect((await mentionRow(elsewhere.object_attributes.id))?.reason).toBe("unknown_project");
    const [unnamedRow] = await db
      .select()
      .from(gitlabMentions)
      .where(eq(gitlabMentions.noteId, unnamed.object_attributes.id));
    expect(unnamedRow).toMatchObject({ host: "gitlab.unnamed.test", reason: "host_not_named" });
  });
});

describe("a comment on a merge request Optio opened", () => {
  it("resumes alice's task with the comment, then posts the result", async () => {
    const task = await insertTask({
      workspaceId,
      repoUrl: PROJECT_URL,
      state: "pr_opened",
      prUrl: `${PROJECT_URL}/-/merge_requests/12`,
      prNumber: 12,
      ownerUserId: alice.userId,
      createdBy: alice.userId,
      sessionId: "sess-1",
    });
    const payload = mrNote(alice, "@optio-bot please rename `greet` to `hello`", { iid: 12 });
    await deliver(payload);

    expect(gl.awards[0]).toMatchObject({ noteable: "merge_requests", iid: 12, name: "eyes" });
    const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(fresh.state).toBe("queued");
    const [ev] = await db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, task.id))
      .orderBy(desc(taskEvents.createdAt))
      .limit(1);
    expect(ev).toMatchObject({
      trigger: "gitlab_mention",
      userId: alice.userId,
      toState: "queued",
    });
    const job = await queuedJob(task.id);
    expect(job?.data).toMatchObject({ resumeSessionId: "sess-1", restartFromBranch: true });
    expect(job?.data.resumePrompt).toContain("> please rename `greet` to `hello`");
    expect(job?.data.resumePrompt).toContain("Don't open another merge request");
    expect(lastNote().body).toContain("I'm making the change on this merge request");
    expect((await mentionRow(payload.object_attributes.id)).command).toBe("work");
    expect((await auditOf("gitlab_mention.resume", task.id)).userId).toBe(alice.userId);

    await transitionTask(task.id, TaskState.PROVISIONING, "test");
    await transitionTask(task.id, TaskState.RUNNING, "test");
    await transitionTask(task.id, TaskState.PR_OPENED, "pr_detected");
    await waitFor(() => gl.notes.length === 2);
    expect(lastNote().body).toBe(
      `@alice Done: I pushed the changes to this merge request (${PUBLIC}/work/${task.id}).`,
    );
  });

  it("resumes once when two comments arrive together", async () => {
    const task = await insertTask({
      workspaceId,
      repoUrl: PROJECT_URL,
      state: "pr_opened",
      prUrl: `${PROJECT_URL}/-/merge_requests/17`,
      prNumber: 17,
      ownerUserId: alice.userId,
      createdBy: alice.userId,
    });
    await Promise.all([
      deliver(mrNote(alice, "@optio-bot first change", { iid: 17 })),
      deliver(mrNote(alice, "@optio-bot second change", { iid: 17 })),
    ]);
    const bodies = gl.notes.map((n) => n.body);
    expect(bodies.filter((b) => b.includes("I'm making the change"))).toHaveLength(1);
    expect(
      bodies.filter((b) => b.includes("I'm still working on this merge request")),
    ).toHaveLength(1);
    const resumes = (
      await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id))
    ).filter((e) => e.trigger === "gitlab_mention");
    expect(resumes).toHaveLength(1);
  });

  it("is busy while the run goes on, and refuses a closed merge request", async () => {
    const task = await insertTask({
      workspaceId,
      repoUrl: PROJECT_URL,
      state: "running",
      prUrl: `${PROJECT_URL}/-/merge_requests/13`,
      prNumber: 13,
      ownerUserId: alice.userId,
      createdBy: alice.userId,
    });
    await deliver(mrNote(alice, "@optio-bot more", { iid: 13 }));
    expect(lastNote().body).toContain(
      `I'm still working on this merge request (${PUBLIC}/work/${task.id})`,
    );
    await deliver(mrNote(alice, "@optio-bot more", { iid: 13, state: "merged" }));
    expect(lastNote().body).toContain("This merge request is merged");
  });

  it("won't let an admin steer alice's own work", async () => {
    await insertTask({
      workspaceId,
      repoUrl: PROJECT_URL,
      state: "pr_opened",
      prUrl: `${PROJECT_URL}/-/merge_requests/14`,
      prNumber: 14,
      ownerUserId: alice.userId,
      createdBy: alice.userId,
    });
    await deliver(mrNote(dana, "@optio-bot rename it", { iid: 14 }));
    expect(lastNote().body).toContain("@dana This merge request is someone else's work in Optio");
    // workChangeError's words name the owner; the public thread doesn't get them.
    expect(lastNote().body).not.toContain("Alice");
    // bob can't even see it.
    await deliver(mrNote(bob, "@optio-bot rename it", { iid: 14 }));
    expect(lastNote().body).toContain("isn't yours to see");
  });
});

describe("a comment on someone else's merge request", () => {
  it("starts alice's own work from its source branch, into that branch", async () => {
    const payload = mrNote(alice, "@optio-bot add a CHANGELOG entry", {
      iid: 20,
      sourceBranch: "feature/x",
    });
    await deliver(payload);
    const row = await mentionRow(payload.object_attributes.id);
    expect(row.status).toBe("started");
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId!));
    expect(task).toMatchObject({
      repoBranch: "feature/x",
      ownerUserId: alice.userId,
      createdBy: alice.userId,
      title: "!20: add a CHANGELOG entry",
    });
    expect(task.prompt).toContain("your merge request goes into `feature/x`");
    expect(lastNote().body).toContain("merge request into `feature/x`");
    const audit = await auditOf("gitlab_mention.start", task.id);
    expect(audit.params).toMatchObject({ taskId: task.id });
  });

  it("refuses a merge request from a fork", async () => {
    await deliver(mrNote(alice, "@optio-bot add it", { iid: 21, sourceProjectId: 999 }));
    expect(lastNote().body).toContain("comes from a fork");
  });
});

describe("the rate limit", () => {
  it("answers a few commands per issue in ten minutes, and says so once", async () => {
    await saveGitLabBotSettings({ rateLimit: 2 }, null);
    try {
      for (let i = 0; i < 4; i++) await deliver(issueNote(alice, "@optio-bot help", 50));
      expect(gl.notes.map((n) => n.body.split(" ").slice(0, 3).join(" "))).toEqual([
        "@alice Mention me",
        "@alice Mention me",
        "@alice That's a",
      ]);
      // Another issue has its own budget.
      await deliver(issueNote(alice, "@optio-bot help", 51));
      expect(gl.notes).toHaveLength(4);
    } finally {
      await saveGitLabBotSettings({ rateLimit: null }, null);
    }
  });

  it("is each person's own: mallory's refusals don't use up alice's budget", async () => {
    await saveGitLabBotSettings({ rateLimit: 2 }, null);
    try {
      for (let i = 0; i < 4; i++) await deliver(issueNote(mallory, "@optio-bot add a line", 52));
      expect(gl.notes.map((n) => n.body.split(" ").slice(0, 4).join(" "))).toEqual([
        "@mallory I can't tell",
        "@mallory I can't tell",
        "@mallory That's a lot",
      ]);
      await deliver(issueNote(alice, "@optio-bot help", 52));
      await deliver(issueNote(alice, "@optio-bot help", 52));
      expect(gl.notes.slice(3).map((n) => n.body.split(" ").slice(0, 3).join(" "))).toEqual([
        "@alice Mention me",
        "@alice Mention me",
      ]);
      // alice's own third one is over her budget, and she is told once.
      await deliver(issueNote(alice, "@optio-bot help", 52));
      expect(lastNote().body).toContain("@alice That's a lot of requests");
      expect(lastNote().body).toContain("at most 2 from one person");
    } finally {
      await saveGitLabBotSettings({ rateLimit: null }, null);
    }
  });
});

describe("Settings → Integrations → GitLab bot", () => {
  const call = (who: Person, method: "GET" | "PUT", payload?: object) =>
    app.inject({
      method,
      url: "/api/gitlab-bot",
      headers: who.headers,
      ...(payload ? { payload } : {}),
    });

  it("shows everyone whom to mention; only a deployment admin changes it", async () => {
    forgetBotIdentities();
    const read = await call(alice, "GET");
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      enabled: true,
      username: null,
      canEdit: false,
      source: { username: "token" },
      hosts: [{ host: HOST, username: "optio-bot", error: null }],
    });
    expect(read.body).not.toContain(ORG_TOKEN);
    expect((await call(alice, "PUT", { username: "svc-optio" })).statusCode).toBe(403);
    // A workspace admin isn't a deployment admin: the bot is deployment-wide.
    const wanda = await person("wanda", { role: "admin", gitlabId: 540 });
    expect((await call(wanda, "GET")).json()).toMatchObject({ canEdit: false });
    const wandaPut = await call(wanda, "PUT", { enabled: false });
    expect(wandaPut.statusCode, wandaPut.body).toBe(403);
    expect((await call(alice, "GET")).json()).toMatchObject({ enabled: true, username: null });

    const named = await call(dana, "PUT", { username: "@svc-optio" });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json()).toMatchObject({
      username: "svc-optio",
      canEdit: true,
      hosts: [{ host: HOST, username: "svc-optio" }],
    });
    expect((await call(dana, "PUT", { username: "not a name" })).statusCode).toBe(400);
    try {
      await deliver(issueNote(alice, "@optio-bot help", 60));
      expect(gl.notes).toHaveLength(0);
      await deliver(issueNote(alice, "@svc-optio help", 60));
      expect(lastNote().body).toContain("`@svc-optio add a health check`");
    } finally {
      await call(dana, "PUT", { username: null });
    }

    const off = await call(dana, "PUT", { enabled: false });
    expect(off.json().enabled).toBe(false);
    try {
      await deliver(issueNote(alice, "@optio-bot help", 61));
      expect(gl.notes).toHaveLength(1);
    } finally {
      await call(dana, "PUT", { enabled: null });
    }
    const audit = await auditOf("gitlab_bot.settings");
    expect(audit).toMatchObject({ userId: dana.userId, workspaceId: null });
  });
});

describe("the GitLab receiver", () => {
  it("stores no comment from a delivery with a wrong or missing X-Gitlab-Token", async () => {
    for (const token of ["not-the-secret", undefined]) {
      const payload = issueNote(alice, "@optio-bot add a line", 70);
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/gitlab",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-gitlab-token": token } : {}),
          "x-gitlab-event-uuid": randomUUID(),
        },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode, String(token)).toBe(401);
      await mentionWorkSettled();
      expect(await mentionRow(payload.object_attributes.id)).toBeUndefined();
    }
    expect(gl.notes).toHaveLength(0);
    expect(gl.awards).toHaveLength(0);
  });
});
