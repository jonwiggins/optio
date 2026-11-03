/**
 * Fresh pod per run, against real rows: shared pods are reused as before; a
 * per-run pod is made for one run, never picked by another, and removed when
 * the run gives its slot back (or never started); the repo's instance limit
 * still caps how many exist; the sweep removes leftovers but keeps a pod a
 * run needs for recovery, for a bounded time; the workspace default and
 * "required" decide the mode, and the repo routes enforce and report it.
 * The container runtime is an in-memory stub that knows which pods exist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPTIO_STATEFULSET_ENABLED = "false";
  process.env.OPTIO_PER_RUN_POD_WAIT_MS = "1500";
  process.env.OPTIO_PER_RUN_POD_GRACE_MS = "10000";
  process.env.OPTIO_PER_RUN_POD_RECOVERY_MS = "60000";
});

const pods = vi.hoisted(() => new Map<string, { labels: Record<string, string> }>());
const failCreate = vi.hoisted(() => ({ next: false }));
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    create: async (spec: { name: string; labels: Record<string, string> }) => {
      if (failCreate.next) {
        failCreate.next = false;
        throw new Error("image pull failed");
      }
      pods.set(spec.name, { labels: spec.labels });
      return { id: spec.name, name: spec.name };
    },
    status: async (h: { name: string }) => {
      if (!pods.has(h.name)) throw Object.assign(new Error("not found"), { statusCode: 404 });
      return { state: "running" };
    },
    destroy: async (h: { name: string }) => {
      pods.delete(h.name);
    },
  }),
}));

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentPods, interactiveSessions, tasks } from "../db/schema.js";
import * as podPool from "./agent-pod-pool.js";
import {
  PerRunPodsBusyError,
  cleanupIdleRepoPods,
  cleanupPerRunRepoPods,
  discardUnusedRunPod,
  getOrCreateRepoPod,
  releaseRepoPodTask,
} from "./repo-pool-service.js";
import { podModeForRepo } from "./pod-mode.js";
import { updateWorkspace } from "./workspace-service.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { repoRoutes } from "../routes/repos.js";
import { endSession } from "./interactive-session-service.js";
import { freshChatPrompt } from "../workers/pr-review-worker.js";

let n = 0;
const nextRepo = () => `https://github.com/it-org/fresh-${++n}-${Date.now()}`;

async function podFor(
  repoUrl: string,
  over: Partial<NonNullable<Parameters<typeof getOrCreateRepoPod>[4]>> = {},
) {
  return getOrCreateRepoPod(repoUrl, "main", {}, undefined, {
    workspaceId: null,
    ownerUserId: null,
    isolationPurpose: "work",
    maxAgentsPerPod: 2,
    maxPodInstances: 1,
    ...over,
  });
}

/** A run on the pod: takes its slot, as `startTaskInRepoPod` does. */
async function startRun(podId: string) {
  await podPool.acquireSlot(podId);
}

async function row(id: string) {
  return podPool.getPod(id);
}

async function age(id: string, ms: number) {
  await db
    .update(agentPods)
    .set({ updatedAt: new Date(Date.now() - ms) })
    .where(eq(agentPods.id, id));
}

beforeEach(() => {
  pods.clear();
  failCreate.next = false;
});

describe("shared mode (the default)", () => {
  it("reuses the repo's pod across runs and keeps it after a run ends", async () => {
    const repo = nextRepo();
    const first = await podFor(repo);
    await startRun(first.id);
    await releaseRepoPodTask(first.id);

    const second = await podFor(repo, { podMode: "shared" });
    expect(second.id).toBe(first.id);
    expect((await row(first.id))?.perRunBaseKey).toBeNull();
    expect(pods.has(first.podName!)).toBe(true);
    expect(pods.get(first.podName!)?.labels["optio.pod-mode"]).toBeUndefined();
  });
});

describe("per-run mode", () => {
  it("gives two consecutive runs different pods and removes the first when it ends", async () => {
    const repo = nextRepo();
    const first = await podFor(repo, { podMode: "per_run" });
    expect(first.perRunBaseKey).toBeTruthy();
    expect(pods.get(first.podName!)?.labels["optio.pod-mode"]).toBe("per-run");
    await startRun(first.id);
    await releaseRepoPodTask(first.id);

    expect(await row(first.id)).toBeNull();
    expect(pods.has(first.podName!)).toBe(false);

    const second = await podFor(repo, { podMode: "per_run" });
    expect(second.id).not.toBe(first.id);
    expect(second.podName).not.toBe(first.podName);
    expect(second.isolationKey).not.toBe(first.isolationKey);
    // Same boundary: both count against the same instance limit.
    expect(second.perRunBaseKey).toBe(first.perRunBaseKey);
  });

  it("never puts a second run in a pod that has room, even with agents-per-pod above one", async () => {
    const repo = nextRepo();
    const first = await podFor(repo, { podMode: "per_run", maxPodInstances: 2 });
    await startRun(first.id);
    const second = await podFor(repo, { podMode: "per_run", maxPodInstances: 2 });
    expect(second.id).not.toBe(first.id);
    // Nor does a retry asking for the earlier pod get it.
    await startRun(second.id);
    await releaseRepoPodTask(second.id);
    const retry = await podFor(repo, {
      podMode: "per_run",
      maxPodInstances: 2,
      preferredPodId: first.id,
    });
    expect(retry.id).not.toBe(first.id);
  });

  it("does not let shared pods and per-run pods pick each other", async () => {
    const repo = nextRepo();
    const shared = await podFor(repo);
    const fresh = await podFor(repo, { podMode: "per_run" });
    expect(fresh.id).not.toBe(shared.id);
    expect((await podFor(repo)).id).toBe(shared.id);
  });

  it("removes the pod of a run that never started (failed, cancelled or skipped first)", async () => {
    const repo = nextRepo();
    const fresh = await podFor(repo, { podMode: "per_run" });
    await discardUnusedRunPod(fresh.id);
    expect(await row(fresh.id)).toBeNull();
    expect(pods.has(fresh.podName!)).toBe(false);

    // A shared pod is left alone.
    const shared = await podFor(repo);
    await discardUnusedRunPod(shared.id);
    expect(await row(shared.id)).not.toBeNull();
  });

  it("removes a pod that failed to come up instead of leaving an error row", async () => {
    const repo = nextRepo();
    failCreate.next = true;
    await expect(podFor(repo, { podMode: "per_run" })).rejects.toThrow("image pull failed");
    expect(await podPool.listPods("repo", repo)).toEqual([]);
  });

  it("caps fresh pods at maxPodInstances: the next run waits, then fails if none frees up", async () => {
    const repo = nextRepo();
    const first = await podFor(repo, { podMode: "per_run" });
    await startRun(first.id);
    const started = Date.now();
    await expect(podFor(repo, { podMode: "per_run" })).rejects.toBeInstanceOf(PerRunPodsBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);

    // A run that ends frees the place for a waiting one.
    const waiting = podFor(repo, { podMode: "per_run" });
    setTimeout(() => void releaseRepoPodTask(first.id), 300);
    const next = await waiting;
    expect(next.id).not.toBe(first.id);
    expect(await row(first.id)).toBeNull();
  });

  it("lets only one of two runs starting together take the last place", async () => {
    const repo = nextRepo();
    const results = await Promise.allSettled([
      podFor(repo, { podMode: "per_run" }).then(async (p) => {
        await startRun(p.id);
        return p;
      }),
      podFor(repo, { podMode: "per_run" }).then(async (p) => {
        await startRun(p.id);
        return p;
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("leaves per-run pods out of the shared idle reaper", async () => {
    const repo = nextRepo();
    const fresh = await podFor(repo, { podMode: "per_run" });
    await age(fresh.id, 60 * 60 * 1000);
    await insertTask({ repoUrl: repo, state: "running", lastPodId: fresh.id });
    await cleanupIdleRepoPods();
    expect(await row(fresh.id)).not.toBeNull();
  });
});

describe("other runs on repo pods", () => {
  it("removes a terminal session's fresh pod when the session ends", async () => {
    const repo = nextRepo();
    const fresh = await podFor(repo, { podMode: "per_run", isolationPurpose: "session:it" });
    const [session] = await db
      .insert(interactiveSessions)
      .values({ repoUrl: repo, branch: "session/it/x", state: "active", podId: fresh.id })
      .returning();
    await age(fresh.id, 5 * 60 * 1000);
    // In use while the session is active.
    await cleanupPerRunRepoPods();
    expect(await row(fresh.id)).not.toBeNull();

    await endSession(session.id);
    expect(await row(fresh.id)).toBeNull();
    expect(pods.has(fresh.podName!)).toBe(false);
  });

  it("tells a review chat in a fresh pod what the review said", () => {
    const prompt = freshChatPrompt("Why flag line 12?", {
      prUrl: "https://github.com/o/r/pull/7",
      verdict: "request_changes",
      summary: "Missing null check.",
      fileComments: [{ path: "src/a.ts", line: 12, body: "May be null" }],
    });
    expect(prompt).toContain("https://github.com/o/r/pull/7");
    expect(prompt).toContain("Verdict: request_changes");
    expect(prompt).toContain("Missing null check.");
    expect(prompt).toContain("- src/a.ts:12: May be null");
    expect(prompt.endsWith("Why flag line 12?")).toBe(true);
  });
});

describe("the per-run sweep", () => {
  it("removes a pod whose run ended without removing it, and error rows", async () => {
    const repo = nextRepo();
    const leftover = await podFor(repo, { podMode: "per_run", maxPodInstances: 3 });
    await age(leftover.id, 5 * 60 * 1000);
    const errored = await podFor(repo, { podMode: "per_run", maxPodInstances: 3 });
    await podPool.markPodError(errored.id, "lost");

    await cleanupPerRunRepoPods();
    expect(await row(leftover.id)).toBeNull();
    expect(pods.has(leftover.podName!)).toBe(false);
    expect(await row(errored.id)).toBeNull();
  });

  it("keeps a pod in use: a live run, or one just made", async () => {
    const repo = nextRepo();
    const live = await podFor(repo, { podMode: "per_run", maxPodInstances: 3 });
    await age(live.id, 5 * 60 * 1000);
    await insertTask({ repoUrl: repo, state: "running", lastPodId: live.id });
    const justMade = await podFor(repo, { podMode: "per_run", maxPodInstances: 3 });

    await cleanupPerRunRepoPods();
    expect(await row(live.id)).not.toBeNull();
    expect(await row(justMade.id)).not.toBeNull();
  });

  it("keeps a pod a run needs for recovery, for a bounded time", async () => {
    const repo = nextRepo();
    const kept = await podFor(repo, { podMode: "per_run", maxPodInstances: 3 });
    const task = await insertTask({
      repoUrl: repo,
      state: "needs_attention",
      lastPodId: kept.id,
      recoveryRequired: true,
    });
    // Past the grace period (10 s here), within the recovery window (60 s).
    await age(kept.id, 30 * 1000);
    await cleanupPerRunRepoPods();
    expect(await row(kept.id)).not.toBeNull();

    // Past OPTIO_PER_RUN_POD_RECOVERY_MS it goes.
    await age(kept.id, 2 * 60 * 1000);
    await cleanupPerRunRepoPods();
    expect(await row(kept.id)).toBeNull();
    // The task row is untouched.
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(t.recoveryRequired).toBe(true);
  });

  it("does not count a pod kept for recovery against the instance limit", async () => {
    const repo = nextRepo();
    const kept = await podFor(repo, { podMode: "per_run" });
    await insertTask({
      repoUrl: repo,
      state: "needs_attention",
      lastPodId: kept.id,
      worktreeState: "preserved",
    });
    await age(kept.id, 5 * 60 * 1000);
    const next = await podFor(repo, { podMode: "per_run" });
    expect(next.id).not.toBe(kept.id);
  });
});

describe("workspace default and required", () => {
  it("applies the workspace default to repos that pick nothing, and the repo's own choice otherwise", async () => {
    const ws = await insertWorkspace({ podMode: "per_run" });
    const unset = await insertRepo({ workspaceId: ws.id });
    const shared = await insertRepo({ workspaceId: ws.id, podMode: "shared" });
    expect(await podModeForRepo(unset, ws.id)).toBe("per_run");
    expect(await podModeForRepo(shared, ws.id)).toBe("shared");
    // A repo Optio has no row for follows the workspace too.
    expect(await podModeForRepo(null, ws.id)).toBe("per_run");

    const plain = await insertWorkspace();
    expect(await podModeForRepo(await insertRepo({ workspaceId: plain.id }), plain.id)).toBe(
      "shared",
    );
  });

  it("gives every repo a fresh pod when required, whatever the repo picked", async () => {
    const ws = await insertWorkspace();
    const repo = await insertRepo({ workspaceId: ws.id, podMode: "shared" });
    await updateWorkspace(ws.id, { podMode: "per_run_required" });
    const mode = await podModeForRepo(repo, ws.id);
    expect(mode).toBe("per_run");

    const first = await podFor(repo.repoUrl, { workspaceId: ws.id, podMode: mode });
    await startRun(first.id);
    await releaseRepoPodTask(first.id);
    const second = await podFor(repo.repoUrl, { workspaceId: ws.id, podMode: mode });
    expect(second.id).not.toBe(first.id);
    expect(await row(first.id)).toBeNull();
  });

  it("refuses a repo switching to shared pods under required, and reports the modes", async () => {
    const ws = await insertWorkspace({ podMode: "per_run_required" });
    const repo = await insertRepo({ workspaceId: ws.id });
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: "user-1", workspaceId: ws.id, workspaceRole: "admin" },
    });
    try {
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/repos/${repo.id}`,
        payload: { podMode: "shared" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatch(/requires a fresh pod/);

      const ok = await app.inject({
        method: "PATCH",
        url: `/api/repos/${repo.id}`,
        payload: { podMode: "per_run" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().repo.podMode).toBe("per_run");

      const got = await app.inject({ method: "GET", url: `/api/repos/${repo.id}` });
      expect(got.json().repo).toMatchObject({
        podMode: "per_run",
        workspacePodMode: "per_run_required",
        effectivePodMode: "per_run",
      });

      // Under a plain default the repo may pick shared, and that wins.
      await updateWorkspace(ws.id, { podMode: "per_run" });
      const shared = await app.inject({
        method: "PATCH",
        url: `/api/repos/${repo.id}`,
        payload: { podMode: "shared" },
      });
      expect(shared.statusCode).toBe(200);
      const after = await app.inject({ method: "GET", url: `/api/repos/${repo.id}` });
      expect(after.json().repo.effectivePodMode).toBe("shared");
    } finally {
      await app.close();
    }
  });
});
