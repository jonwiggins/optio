/**
 * Every merge reaches the audit trail (docs/audit.md), against real Postgres
 * and Redis with only the git host mocked: the reconciler's automatic merge
 * (with who confirmed it and when), the Merge button (and a merge the host
 * refused), the controller's merge_pr tool for a person, and an agent's
 * merge_pr, which is refused and recorded as such.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { reconcileRepo, type PullRequest } from "@optio/shared";
import { db } from "../db/client.js";
import { optioActions, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getRedisClient } from "./event-bus.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { mergeControllerPr } from "./controller-reviews.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError } from "./controller-access.js";

const git = vi.hoisted(() => ({
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  mergePullRequest: vi.fn(),
}));
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: { type: "github", ...git },
    ri: {
      platform: "github",
      host: "github.com",
      owner: "it-org",
      repo: "merge",
      apiBaseUrl: "https://api.github.com",
    },
  }),
}));

const PR_URL = "https://github.com/it-org/merge/pull/42";
const uniq = () => randomBytes(4).toString("hex");

beforeEach(() => {
  vi.resetAllMocks();
  const pr: PullRequest = {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "head-a",
    baseBranch: "main",
    url: PR_URL,
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockResolvedValue([{ name: "ci", status: "completed", conclusion: "success" }]);
  git.getReviews.mockResolvedValue([]);
  git.mergePullRequest.mockResolvedValue(undefined);
});

afterAll(async () => {
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  await getRedisClient().quit();
});

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

/** The newest entry of `action` in `workspaceId` (entries are written without waiting). */
async function entry(workspaceId: string, action: string) {
  for (let i = 0; i < 40; i++) {
    const [row] = await db
      .select()
      .from(optioActions)
      .where(and(eq(optioActions.workspaceId, workspaceId), eq(optioActions.action, action)))
      .orderBy(desc(optioActions.createdAt))
      .limit(1);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

describe("merges in the audit trail", () => {
  it("the reconciler's merge names the person who confirmed it, and when", async () => {
    const ws = await insertWorkspace();
    const ann = await person("ann");
    const confirmedAt = new Date("2026-10-22T08:30:00.000Z");
    const repo = await insertRepo({
      workspaceId: ws.id,
      autoMerge: true,
      autoMergeConfirmedAt: confirmedAt,
      autoMergeConfirmedBy: ann.id,
      reviewEnabled: false,
    });
    const task = await insertTask({
      workspaceId: ws.id,
      repoUrl: repo.repoUrl,
      state: "pr_opened",
      prUrl: PR_URL,
      prChecksStatus: "passing",
    });
    const snapshot = await buildWorldSnapshot({ kind: "repo", id: task.id });
    const outcome = await executeAction(reconcileRepo(snapshot!), snapshot!);
    expect(outcome.reason).toBe("auto_merged");

    const row = await entry(ws.id, "pr.merge");
    expect(row).toMatchObject({
      userId: null,
      success: true,
      params: {
        via: "auto",
        taskId: task.id,
        prUrl: PR_URL,
        prNumber: 42,
        confirmedBy: ann.id,
        confirmedAt: confirmedAt.toISOString(),
      },
    });
  });

  it("the Merge button records the merge, and a merge the host refused", async () => {
    const ws = await insertWorkspace();
    const bob = await person("bob");
    const { prReviewRoutes } = await import("../routes/pr-reviews.js");
    const app = await buildRouteTestApp(prReviewRoutes, {
      user: { id: bob.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    const merged = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: PR_URL, mergeMethod: "squash" },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(await entry(ws.id, "pr.merge")).toMatchObject({
      userId: bob.id,
      success: true,
      clientIp: "127.0.0.1",
      params: { via: "button", prUrl: PR_URL, mergeMethod: "squash" },
    });

    git.mergePullRequest.mockRejectedValue(new Error("405 Method Not Allowed"));
    const refused = await app.inject({
      method: "POST",
      url: "/api/pull-requests/merge",
      payload: { prUrl: PR_URL, mergeMethod: "merge" },
    });
    expect(refused.statusCode).toBe(400);
    let failed;
    for (let i = 0; i < 40 && !failed; i++) {
      [failed] = await db
        .select()
        .from(optioActions)
        .where(and(eq(optioActions.workspaceId, ws.id), eq(optioActions.success, false)));
      if (!failed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed).toMatchObject({
      action: "pr.merge",
      params: { via: "button", mergeMethod: "merge", reason: "405 Method Not Allowed" },
    });
    await app.close();
  });

  it("merge_pr merges for a person and is refused, and recorded, for an agent's run", async () => {
    const ws = await insertWorkspace();
    const cat = await person("cat");
    const task = await insertTask({ workspaceId: ws.id, prUrl: PR_URL, state: "pr_opened" });
    const actor = {
      userId: cat.id,
      workspaceId: ws.id,
      isAdmin: true,
      teamIds: [],
      adminTeamIds: [],
    };

    const agent: ControllerPrincipal = {
      actor,
      access: "manage",
      name: "an agent's run",
      run: { kind: "work-run", id: task.id },
    };
    const refusal = await mergeControllerPr(agent, task.id, "squash").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ControllerError);
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    expect(await entry(ws.id, "pr.merge.refused")).toMatchObject({
      userId: cat.id,
      success: false,
      params: { via: "mcp", prUrl: PR_URL, id: task.id, runId: task.id, reason: "agent_run" },
    });

    const personal: ControllerPrincipal = { actor, access: "manage", name: "cat's laptop" };
    await mergeControllerPr(personal, task.id, "rebase");
    expect(await entry(ws.id, "pr.merge")).toMatchObject({
      userId: cat.id,
      success: true,
      params: { via: "mcp", prUrl: PR_URL, mergeMethod: "rebase" },
    });
  });
});
