/**
 * @-mentions on GitHub (docs/gitlab-bot.md): the same decisions as GitLab's
 * (process.ts), fed by GitHub's `issue_comment` events (ingress.ts
 * `acceptGitHubMention`, which routes/tickets.ts calls once the signature
 * checks out), against real Postgres and Redis and a fake GitHub API. Off
 * by default; on, the person is found by the GitHub account they sign in
 * with before their verified email (never their username), needs write
 * access, and gets a reply in the conversation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { gitlabMentions, tasks, users, workspaceMembers } from "../../db/schema.js";
import { createSession, linkIdentity } from "../session-service.js";
import { storeSecret } from "../secret-service.js";
import { getRedisClient } from "../event-bus.js";
import { insertRepo, insertWorkspace } from "../../test-utils/integration/fixtures.js";
import { acceptGitHubMention, mentionWorkSettled } from "./ingress.js";
import { forgetBotIdentities } from "./settings.js";
import { setOutboundDefaults } from "../../utils/outbound-url.js";

const REPO_URL = `https://github.com/acme/widgets-${Date.now().toString(36)}`;
const [OWNER, REPO] = new URL(REPO_URL).pathname.slice(1).split("/");
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const REPO_ID = 4242;

let workspaceId: string;
let aliceId: string;
const BOB_EMAIL = `bob-${Date.now()}@example.test`;

/** What the fake GitHub was asked and posted. */
const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
const permissions = new Map<string, string>([
  ["alice-gh", "write"],
  ["bob", "read"],
  ["bob-alt", "write"],
]);
const realFetch = globalThis.fetch;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const fakeGitHub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
  const method = init?.method ?? "GET";
  if (method === "POST") {
    posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return json({ id: posted.length }, 201);
  }
  const perm = url.match(/\/collaborators\/([^/]+)\/permission$/);
  if (perm) {
    const p = permissions.get(decodeURIComponent(perm[1]));
    return p ? json({ permission: p }) : json({ message: "Not Found" }, 404);
  }
  // alice's public GitHub email is one bob's Optio account has: her linked
  // GitHub account must win over it.
  if (url.endsWith("/users/alice-gh")) return json({ email: BOB_EMAIL });
  // Another GitHub user showing bob's address: bob already links 7002.
  if (url.endsWith("/users/bob-alt")) return json({ email: BOB_EMAIL });
  if (/\/users\/[^/]+$/.test(url)) return json({ email: null });
  if (url === `${API}/pulls/5`) {
    return json({
      state: "open",
      merged: false,
      title: "Add a greeting",
      body: "Says hello.",
      html_url: `${REPO_URL}/pull/5`,
      head: { ref: "feature/greeting", sha: "abc123", repo: { id: REPO_ID } },
      base: { ref: "main", repo: { id: REPO_ID } },
    });
  }
  return json({ message: "Not Found" }, 404);
}) as typeof fetch;

let commentSeq = 91_000;

function comment(login: string, userId: number, body: string, opts: { pr?: boolean } = {}) {
  const number = opts.pr ? 5 : 3;
  return {
    action: "created",
    issue: {
      number,
      title: opts.pr ? "Add a greeting" : "README is missing a line",
      body: opts.pr ? "Says hello." : "The README should say how to run the tests.",
      state: "open",
      html_url: `${REPO_URL}/${opts.pr ? "pull" : "issues"}/${number}`,
      ...(opts.pr ? { pull_request: { html_url: `${REPO_URL}/pull/${number}` } } : {}),
    },
    comment: {
      id: ++commentSeq,
      body,
      html_url: `${REPO_URL}/issues/${number}#issuecomment-${commentSeq}`,
      user: { login, id: userId, type: login.endsWith("[bot]") ? "Bot" : "User" },
    },
    repository: { id: REPO_ID, full_name: `${OWNER}/${REPO}`, html_url: REPO_URL },
  };
}

async function deliver(payload: ReturnType<typeof comment>) {
  await acceptGitHubMention(payload, `delivery-${payload.comment.id}`);
  await mentionWorkSettled();
  const [row] = await db
    .select()
    .from(gitlabMentions)
    .where(
      and(eq(gitlabMentions.host, "github.com"), eq(gitlabMentions.noteId, payload.comment.id)),
    );
  return row;
}

beforeAll(async () => {
  await import("../../workers/task-worker.js");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
  vi.stubEnv("GITHUB_APP_ID", "");
  vi.stubEnv("OPTIO_GITHUB_BOT_USERNAME", "optio-bot");
  vi.stubGlobal("fetch", fakeGitHub);
  // The bot's calls go through the outbound guard: to the fake, with a fixed
  // public DNS answer (no real lookups).
  setOutboundDefaults({
    fetchImpl: (url, init) => globalThis.fetch(url, init),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });

  workspaceId = (await insertWorkspace()).id;
  await insertRepo({
    repoUrl: REPO_URL,
    fullName: `${OWNER}/${REPO}`,
    workspaceId,
    gitPlatform: "github",
    defaultBranch: "main",
  });
  await storeSecret("GITHUB_TOKEN", "ghp-organization", "global");

  // alice signs in with GitHub (id 7001).
  const alice = await createSession("github", {
    externalId: "7001",
    email: `alice-${Date.now()}@example.test`,
    displayName: "Alice",
    username: "alice-gh",
  });
  aliceId = alice.user.id;
  await db.insert(workspaceMembers).values({ workspaceId, userId: aliceId, role: "member" });
  await storeSecret("ANTHROPIC_AUTH_TOKEN", "sk-alice", "user", undefined, aliceId);
  // bob signs in through the directory as `bob`, his GitHub login too.
  const bob = await createSession("oidc", {
    externalId: `kc-bob-${Date.now()}`,
    email: BOB_EMAIL,
    displayName: "Bob",
    username: "bob",
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId: bob.user.id, role: "member" });
  await linkIdentity(bob.user.id, "github", { externalId: "7002", email: bob.user.email });

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, bob.user.id));
});

afterAll(async () => {
  await mentionWorkSettled();
  const { taskQueue } = await import("../../workers/task-worker.js");
  await taskQueue.close();
  await getRedisClient().quit();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  posted.length = 0;
  forgetBotIdentities();
  vi.stubEnv("OPTIO_GITHUB_BOT_ENABLED", "true");
});

describe("@-mentions on GitHub", () => {
  it("are off by default: a mention is not even stored", async () => {
    vi.stubEnv("OPTIO_GITHUB_BOT_ENABLED", "");
    const row = await deliver(comment("alice-gh", 7001, "@optio-bot add a line to README"));
    expect(row).toBeUndefined();
    expect(posted).toEqual([]);
  });

  it("are off where the deployment doesn't offer GitHub (OPTIO_GIT_PLATFORMS)", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    try {
      const row = await deliver(comment("alice-gh", 7001, "@optio-bot add a line to README"));
      expect(row).toBeUndefined();
      expect(posted).toEqual([]);
    } finally {
      vi.stubEnv("OPTIO_GIT_PLATFORMS", "");
    }
  });

  it("start the work of the person who signs in with that GitHub account, with eyes and a reply", async () => {
    const payload = comment("alice-gh", 7001, "@optio-bot add a line to README");
    const row = await deliver(payload);

    expect(row).toMatchObject({ status: "started", userId: aliceId, workspaceId });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId!));
    expect(task).toMatchObject({ repoUrl: REPO_URL, ownerUserId: aliceId });
    expect(task.title).toMatch(/^#3: add a line to README/);
    expect(task.prompt).toContain("pull request's description");
    expect(posted[0]).toEqual({
      url: `${API}/issues/comments/${payload.comment.id}/reactions`,
      body: { content: "eyes" },
    });
    const reply = posted.find((p) => p.url === `${API}/issues/3/comments`);
    expect(String(reply?.body.body)).toMatch(/^@alice-gh On it/);
    expect(String(reply?.body.body)).toContain("pull request");
  });

  it("on someone's pull request, start from its branch", async () => {
    const row = await deliver(
      comment("alice-gh", 7001, "@optio-bot rename greet to hello", { pr: true }),
    );
    expect(row.status).toBe("started");
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId!));
    expect(task.repoBranch).toBe("feature/greeting");
    expect(task.title).toMatch(/^#5: rename greet to hello/);
    expect(task.prompt).toContain("pull request #5");
    const reply = posted.find((p) => p.url === `${API}/issues/5/comments`);
    expect(String(reply?.body.body)).toContain("pull request into `feature/greeting`");
  });

  it("refuse someone without write access, in GitHub's words", async () => {
    const row = await deliver(comment("bob", 7002, "@optio-bot add a line to README"));
    expect(row).toMatchObject({ status: "refused", reason: "gitlab_access" });
    const reply = posted.find((p) => p.url === `${API}/issues/3/comments`);
    expect(String(reply?.body.body)).toContain("You need write access");
  });

  it("refuses an unlinked writer with a directory user's name and hidden public email", async () => {
    permissions.set("bob", "write");
    try {
      const row = await deliver(comment("bob", 7999, "@optio-bot add a line to README"));
      expect(row).toMatchObject({
        status: "refused",
        reason: "no_account",
        userId: null,
        taskId: null,
      });
      expect(posted.some((p) => String(p.body.body).includes("On it"))).toBe(false);
    } finally {
      permissions.set("bob", "read");
    }
  });

  it("refuses a writer showing a linked person's verified email", async () => {
    const row = await deliver(comment("bob-alt", 7998, "@optio-bot add a line to README"));
    expect(row).toMatchObject({ status: "refused", reason: "no_account", userId: null });
  });

  it("ignore the bot's own comments and other bots'", async () => {
    const own = await deliver(comment("optio-bot", 9000, "@alice-gh done, @optio-bot"));
    expect(own).toMatchObject({ status: "ignored", reason: "own_note" });
    const other = await deliver(comment("dependabot[bot]", 9001, "@optio-bot rebase"));
    expect(other).toBeUndefined();
    expect(posted).toEqual([]);
  });

  it("answer only to a named bot or a GitHub App: never as a token's user", async () => {
    vi.stubEnv("OPTIO_GITHUB_BOT_USERNAME", "");
    try {
      const row = await deliver(comment("alice-gh", 7001, "@optio-bot add a line"));
      expect(row).toMatchObject({ status: "ignored", reason: "bot_unknown" });
      expect(posted).toEqual([]);
    } finally {
      vi.stubEnv("OPTIO_GITHUB_BOT_USERNAME", "optio-bot");
    }
  });
});
