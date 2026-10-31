import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { reconcileRepo, type CICheck, type PullRequest, type Review } from "@optio/shared";
import { db } from "../db/client.js";
import { repos, tasks, users, workAutoMergeConfirmations } from "../db/schema.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildWorldSnapshot } from "./reconcile-snapshot.js";
import { executeAction } from "./reconcile-executor.js";
import { getRedisClient } from "./event-bus.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { MERGE_CONFIRMATION, forgetSwitches, setDeploymentSetting } from "./deployment-settings.js";
import * as repoService from "./repo-service.js";
import * as definitions from "./work-definition-service.js";
import { WorkError, createWork, updateWork } from "./work-write-service.js";
import type { Actor } from "./ownership.js";
import { mergeControllerPr } from "./controller-reviews.js";
import { ControllerError } from "./controller-access.js";
import type { ControllerPrincipal } from "./controller-auth.js";

// The optional confirmation before automatic merging (docs/merge-confirmation.md)
// against a real database and Redis; only the git host is mocked.
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

let pr: PullRequest;
let checks: CICheck[];
let reviews: Review[];

async function confirmationRequired(on: boolean | null) {
  await setDeploymentSetting(MERGE_CONFIRMATION.key, on, null);
  forgetSwitches();
}

beforeEach(async () => {
  vi.resetAllMocks();
  pr = {
    number: 42,
    title: "test",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "head-a",
    baseBranch: "main",
    url: "https://github.com/it-org/merge/pull/42",
    author: "it",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
  };
  checks = [{ name: "test", status: "completed", conclusion: "success" }];
  reviews = [];
  git.getPullRequest.mockImplementation(async () => ({ ...pr }));
  git.getCIChecks.mockImplementation(async () => checks);
  git.getReviews.mockImplementation(async () => reviews);
  git.mergePullRequest.mockResolvedValue(undefined);
  await confirmationRequired(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await confirmationRequired(null);
});
afterAll(async () => {
  await reconcileQueue.close();
  const { prWatcherQueue } = await import("../workers/pr-watcher-worker.js");
  await prWatcherQueue.close();
  await getRedisClient().quit();
});

async function openTask(repo: { autoMerge: boolean; autoMergeConfirmedAt?: Date | null }) {
  const row = await insertRepo({ ...repo, reviewEnabled: false });
  return insertTask({
    repoUrl: row.repoUrl,
    state: "pr_opened",
    prUrl: pr.url,
    prChecksStatus: "passing",
  });
}

async function pass(taskId: string) {
  const snapshot = await buildWorldSnapshot({ kind: "repo", id: taskId });
  if (!snapshot) throw new Error("missing task");
  const action = reconcileRepo(snapshot);
  const outcome = await executeAction(action, snapshot);
  return { snapshot, action, outcome };
}

describe("the reconciler with the merge confirmation on", () => {
  it("merges a confirmed repo setting", async () => {
    const task = await openTask({ autoMerge: true, autoMergeConfirmedAt: new Date() });
    const { snapshot, outcome } = await pass(task.id);
    expect(snapshot.settings.mergeConfirmationRequired).toBe(true);
    expect(snapshot.settings.autoMergeConfirmed).toBe(true);
    expect(outcome.reason).toBe("auto_merged");
    // The guard read every review page.
    expect(git.getReviews).toHaveBeenCalledWith(expect.anything(), 42, { all: true });
  });

  it("never merges a setting nobody confirmed (on before the switch)", async () => {
    const task = await openTask({ autoMerge: true });
    const { snapshot, action } = await pass(task.id);
    expect(snapshot.settings.autoMergeConfirmed).toBe(false);
    expect(action.kind).not.toBe("autoMergePr");
    // Even a forced merge action stops at the guard.
    const outcome = await executeAction({ kind: "autoMergePr", reason: "test" }, snapshot);
    expect(outcome.reason).toBe("auto_merge_not_confirmed");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("hands a PR a reviewer still blocks to a person instead of retrying forever", async () => {
    const task = await openTask({ autoMerge: true, autoMergeConfirmedAt: new Date() });
    // The latest review overall is an approval, so the snapshot lets the
    // merge through; reviewer a's own latest say is still "changes requested".
    reviews = [
      { author: "a", state: "CHANGES_REQUESTED", body: "no" },
      { author: "b", state: "APPROVED", body: "" },
    ];
    const { outcome } = await pass(task.id);
    expect(outcome.reason).toBe("auto_merge_changes_requested");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row.state).toBe("needs_attention");
    expect(row.errorMessage ?? "").toMatch(/still requests changes/);
  });

  it("waits on a draft PR without merging", async () => {
    const task = await openTask({ autoMerge: true, autoMergeConfirmedAt: new Date() });
    pr.draft = true;
    const { outcome } = await pass(task.id);
    expect(outcome.reason).toBe("pr_draft");
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("a task's own unconfirmed follow-through doesn't borrow the repo's confirmation", async () => {
    const row = await insertRepo({ autoMerge: true, autoMergeConfirmedAt: new Date() });
    const task = await insertTask({
      repoUrl: row.repoUrl,
      state: "pr_opened",
      prUrl: pr.url,
      prChecksStatus: "passing",
      autoMerge: true,
    });
    const { action } = await pass(task.id);
    expect(action.kind).not.toBe("autoMergePr");
  });
});

describe("the reconciler with the merge confirmation off (the default)", () => {
  it("merges on autoMerge alone, with no re-read of the reviews, as before", async () => {
    await confirmationRequired(false);
    const task = await openTask({ autoMerge: true });
    reviews = [{ author: "a", state: "CHANGES_REQUESTED", body: "no" }];
    const { snapshot, outcome } = await pass(task.id);
    expect(snapshot.settings.mergeConfirmationRequired).toBeUndefined();
    expect(outcome.reason).toBe("auto_merged");
    // The snapshot's own review read happens as on main; the guard's doesn't.
    expect(git.getReviews).not.toHaveBeenCalledWith(expect.anything(), 42, { all: true });
  });
});

describe("the stamp", () => {
  it("turning a repo's merging off clears it, whoever writes", async () => {
    const row = await insertRepo({
      autoMerge: true,
      autoMergeConfirmedAt: new Date(),
      autoMergeConfirmedBy: null,
    });
    await repoService.updateRepo(row.id, { autoMerge: false });
    const [after] = await db.select().from(repos).where(eq(repos.id, row.id));
    expect(after.autoMergeConfirmedAt).toBeNull();
  });

  describe("on work definitions", () => {
    let actor: Actor;
    let repoUrl: string;
    beforeEach(async () => {
      const suffix = Math.random().toString(36).slice(2);
      const [user] = await db
        .insert(users)
        .values({
          provider: "github",
          externalId: `mc-${suffix}`,
          email: `mc-${suffix}@example.com`,
          displayName: "Ann Lee",
        })
        .returning();
      const ws = await insertWorkspace();
      actor = { userId: user.id, workspaceId: ws.id, isAdmin: false };
      repoUrl = (await insertRepo({ workspaceId: ws.id })).repoUrl;
    });

    const spec = (over: Record<string, unknown> = {}) =>
      ({
        name: `nightly ${Math.random().toString(36).slice(2)}`,
        when: { type: "schedule", config: { cronExpression: "0 3 * * *" } },
        where: { runTarget: "cluster", repoUrl, repoBranch: "main" },
        who: { runtime: "claude-code" },
        what: { prompt: "tidy up" },
        then: "until-merged",
        ...over,
      }) as never;

    it("refuses mergeWhenReady without the dialog, stores who confirmed it", async () => {
      await expect(createWork(spec({ mergeWhenReady: true }), actor)).rejects.toBeInstanceOf(
        WorkError,
      );
      const made = await createWork(
        spec({ mergeWhenReady: true, autoMergeConfirmed: true }),
        actor,
      );
      const stamp = await definitions.autoMergeConfirmationOf(made.id);
      expect(stamp.autoMergeConfirmedBy).toBe(actor.userId);
      expect(stamp.autoMergeConfirmedAt).toBeInstanceOf(Date);
    });

    it("an edit that keeps merging on keeps the stamp; turning it off drops it", async () => {
      const s = spec({ mergeWhenReady: true, autoMergeConfirmed: true });
      const made = await createWork(s, actor);
      await updateWork(
        made.id,
        { ...(s as object), autoMergeConfirmed: undefined } as never,
        actor,
      );
      expect((await definitions.autoMergeConfirmationOf(made.id)).autoMergeConfirmedBy).toBe(
        actor.userId,
      );
      await updateWork(made.id, { ...(s as object), mergeWhenReady: false } as never, actor);
      const rows = await db
        .select()
        .from(workAutoMergeConfirmations)
        .where(eq(workAutoMergeConfirmations.workId, made.id));
      expect(rows).toHaveLength(0);
      // On again needs the dialog again.
      await expect(
        updateWork(made.id, { ...(s as object), autoMergeConfirmed: undefined } as never, actor),
      ).rejects.toBeInstanceOf(WorkError);
    });

    it("with the confirmation off, mergeWhenReady needs no dialog, as before", async () => {
      await confirmationRequired(false);
      const made = await createWork(spec({ mergeWhenReady: true }), actor);
      expect((await definitions.autoMergeConfirmationOf(made.id)).autoMergeConfirmedAt).toBeNull();
    });
  });
});

describe("the controller's merge_pr", () => {
  async function setup() {
    const ws = await insertWorkspace();
    const task = await insertTask({ workspaceId: ws.id, prUrl: pr.url, state: "pr_opened" });
    const actor = { userId: null, workspaceId: ws.id, isAdmin: true };
    return { task, actor };
  }

  it("refuses an agent run's own merge while the confirmation is on", async () => {
    const { task, actor } = await setup();
    const agent = {
      actor,
      access: "manage",
      name: "agent",
      run: { kind: "work-run", id: task.id },
    } as ControllerPrincipal;
    const err = await mergeControllerPr(agent, task.id, "squash").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControllerError);
    expect((err as ControllerError).status).toBe(403);
    expect(git.mergePullRequest).not.toHaveBeenCalled();
  });

  it("lets a person's own token merge, and an agent run once the confirmation is off", async () => {
    const { task, actor } = await setup();
    const personal = { actor, access: "manage", name: "laptop" } as ControllerPrincipal;
    await mergeControllerPr(personal, task.id, "squash");
    expect(git.mergePullRequest).toHaveBeenCalledTimes(1);

    await confirmationRequired(false);
    const agent = {
      actor,
      access: "manage",
      name: "agent",
      run: { kind: "work-run", id: task.id },
    } as ControllerPrincipal;
    await mergeControllerPr(agent, task.id, "squash");
    expect(git.mergePullRequest).toHaveBeenCalledTimes(2);
  });
});
