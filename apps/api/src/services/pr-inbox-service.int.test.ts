/**
 * The pull-request panel against a real database: the viewer's handles, the
 * join with Optio tasks (task_prs and tasks.pr_url) and reviews, private
 * tasks staying private, the per-repo cache, and "Send to agent" creating a
 * task that tracks the PR before it is queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { parseRepoUrl, type PrFacts } from "@optio/shared";
import { db } from "../db/client.js";
import { prReviews, taskPrs, tasks, users } from "../db/schema.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";

const fetchFacts = vi.fn<(...a: unknown[]) => Promise<PrFacts[]>>();
vi.mock("./git-platform/github-pr-facts.js", () => ({
  fetchGitHubPrFacts: (...a: unknown[]) => fetchFacts(...a),
}));
vi.mock("./git-token-service.js", async (orig) => ({
  ...(await orig<typeof import("./git-token-service.js")>()),
  getGitPlatformForRepo: async (repoUrl: string) => ({
    platform: {
      getPullRequest: async () => {
        throw new Error("offline");
      },
    },
    ri: parseRepoUrl(repoUrl),
    token: "tok",
  }),
}));

const inbox = await import("./pr-inbox-service.js");

function facts(url: string, over: Partial<PrFacts> = {}): PrFacts {
  return {
    url,
    number: Number(url.split("/").pop()),
    title: "A change",
    platform: "github",
    repoFullName: "acme/app",
    author: "jon",
    draft: false,
    createdAt: "2026-10-30T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z",
    headBranch: "feature",
    baseBranch: "main",
    headSha: "abc",
    isFork: false,
    lastPushAt: "2026-10-30T10:00:00Z",
    checks: "failing",
    failingChecks: ["lint"],
    mergeState: "clean",
    reviewDecision: "review_required",
    reviews: [],
    requestedReviewers: ["kim"],
    requestedTeams: [],
    assignees: [],
    threads: [],
    comments: [],
    bodyMentions: [],
    ...over,
  };
}

async function insertUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: `ext-${Math.random()}`,
      email: "p@example.com",
      displayName: "P",
      ...over,
    })
    .returning();
  return u;
}

describe("pr-inbox-service", () => {
  beforeEach(() => {
    inbox.clearPrInboxCache();
    fetchFacts.mockReset();
  });

  it("handles: sign-in username for GitHub accounts, linked handles over it, cleared again", async () => {
    const gh = await insertUser({ provider: "github", username: "jonw" });
    expect(await inbox.viewerHandles(gh.id)).toEqual({ handles: ["jonw"], source: "sign-in" });
    const google = await insertUser();
    expect(await inbox.viewerHandles(google.id)).toEqual({ handles: [], source: "none" });
    expect(await inbox.setViewerHandles(google.id, { github: "@Kim" })).toEqual({
      handles: ["Kim"],
      source: "linked",
    });
    await expect(inbox.setViewerHandles(google.id, { github: "no spaces" })).rejects.toThrow(
      /valid handle/,
    );
    expect(await inbox.setViewerHandles(google.id, { github: null })).toEqual({
      handles: [],
      source: "none",
    });
  });

  it("joins tasks and reviews, hides others' private tasks, and derives per viewer", async () => {
    const ws = await insertWorkspace();
    const me = await insertUser({ provider: "github", username: "kim" });
    const other = await insertUser({ provider: "github", username: "lee" });
    const repo = await insertRepo({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/app",
      fullName: "acme/app",
    });
    const base = "https://github.com/acme/app/pull";
    fetchFacts.mockResolvedValue([
      facts(`${base}/1`, { checks: "passing" }),
      facts(`${base}/2`, { author: "optio[bot]" }),
      facts(`${base}/3`),
      facts(`${base}/4`, { checks: "passing" }),
    ]);
    // #2: my agent, running; tracked through task_prs
    const mine = await insertTask({
      workspaceId: ws.id,
      repoUrl: repo.repoUrl,
      state: "running",
      createdBy: me.id,
      title: "Fix lint",
    });
    await db.insert(taskPrs).values({
      taskId: mine.id,
      repoUrl: repo.repoUrl,
      number: 2,
      url: `${base}/2`,
      source: "attached",
    });
    // #3: someone else's private task — not shown
    await insertTask({
      workspaceId: ws.id,
      repoUrl: repo.repoUrl,
      state: "running",
      createdBy: other.id,
      ownerUserId: other.id,
      prUrl: `${base}/3`,
    });
    // #4: a finished task doesn't count; an Optio review does
    await insertTask({
      workspaceId: ws.id,
      repoUrl: repo.repoUrl,
      state: "completed",
      prUrl: `${base}/4`,
    });
    await db.insert(prReviews).values({
      workspaceId: ws.id,
      prUrl: `${base}/4`,
      prNumber: 4,
      repoOwner: "acme",
      repoName: "app",
      repoUrl: repo.repoUrl,
      headSha: "abc",
      state: "ready",
    });

    const res = await inbox.getPrInbox({ workspaceId: ws.id, userId: me.id });
    expect(res.viewer).toEqual({ handles: ["kim"], source: "sign-in", suggestedHandle: null });
    expect(res.errors).toEqual([]);
    const by = Object.fromEntries(res.items.map((i) => [i.facts.number, i]));
    expect(by[2].agent).toMatchObject({ taskId: mine.id, startedByViewer: true, state: "running" });
    expect(by[2].status).toMatchObject({ action: "agent_working", owner: "agent", role: "author" });
    expect(by[3].agent).toBeNull();
    expect(by[4].agent).toBeNull();
    expect(by[4].optioReview).toMatchObject({ state: "ready" });
    expect(by[4].status.action).toBe("optio_review_ready");
    expect(by[1].status.action).toBe("review");
    // Sorted: the viewer's moves first.
    expect(res.items[0].status.owner).toBe("you");

    // Cached: a second read doesn't go to the platform; refresh within 10s doesn't either.
    await inbox.getPrInbox({ workspaceId: ws.id, userId: me.id });
    await inbox.getPrInbox({ workspaceId: ws.id, userId: me.id, refresh: true });
    expect(fetchFacts).toHaveBeenCalledTimes(1);
    inbox.invalidatePrInboxRepo("https://github.com/acme/app.git");
    await inbox.getPrInbox({ workspaceId: ws.id, userId: me.id });
    expect(fetchFacts).toHaveBeenCalledTimes(2);
  });

  it("reports a repository it can't read and keeps the rest", async () => {
    const ws = await insertWorkspace();
    await insertRepo({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/ok",
      fullName: "acme/ok",
    });
    await insertRepo({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/no",
      fullName: "acme/no",
    });
    fetchFacts.mockImplementation(async (ri: any) => {
      if (ri.repo === "no") throw new Error("GitHub API error 401: Bad credentials");
      return [facts("https://github.com/acme/ok/pull/1")];
    });
    const res = await inbox.getPrInbox({ workspaceId: ws.id, userId: null });
    expect(res.items).toHaveLength(1);
    expect(res.errors).toEqual([
      { repo: "acme/no", message: "Optio's token for this repository was rejected" },
    ]);
  });

  it("send to agent: a new task on the PR's branch, tracking the PR before it runs", async () => {
    const ws = await insertWorkspace();
    const me = await insertUser({ provider: "github", username: "jon" });
    const repo = await insertRepo({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/web",
      fullName: "acme/web",
    });
    const url = "https://github.com/acme/web/pull/9";
    fetchFacts.mockResolvedValue([facts(url, { repoFullName: "acme/web", headBranch: "fix-it" })]);
    const actor = { userId: me.id, workspaceId: ws.id, isAdmin: false };

    const res = await inbox.sendPrToAgent({
      prUrl: url,
      action: "fix_ci",
      actor,
      agentType: "claude-code",
    });
    expect(res.mode).toBe("created");
    const [task] = await db.select().from(tasks).where(eq(tasks.id, res.taskId));
    expect(task).toMatchObject({
      repoUrl: repo.repoUrl,
      repoBranch: "fix-it",
      prUrl: url,
      createdBy: me.id,
      state: "queued",
    });
    expect(task.title).toBe("Fix CI on #9: A change");
    expect(task.prompt).toContain("git checkout -B fix-it origin/fix-it");
    expect(task.prompt).toContain("Do not create another branch or open a new pull request");
    expect(task.prompt).toContain("(lint)");

    // Now the task owns the PR: asking again while it's queued is a 409.
    await expect(
      inbox.sendPrToAgent({ prUrl: url, action: "fix_ci", actor, agentType: "claude-code" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("send to agent: refuses forks and PRs outside the workspace", async () => {
    const ws = await insertWorkspace();
    await insertRepo({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/f",
      fullName: "acme/f",
    });
    fetchFacts.mockResolvedValue([facts("https://github.com/acme/f/pull/1", { isFork: true })]);
    const actor = { userId: null, workspaceId: ws.id, isAdmin: true };
    await expect(
      inbox.sendPrToAgent({ prUrl: "https://github.com/acme/f/pull/1", action: "fix_ci", actor }),
    ).rejects.toThrow(/fork/);
    await expect(
      inbox.sendPrToAgent({ prUrl: "https://github.com/other/f/pull/1", action: "fix_ci", actor }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
