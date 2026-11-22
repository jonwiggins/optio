/**
 * Issue #835: a repo pod's row whose StatefulSet was deleted behind Optio's
 * back. Rows are made the way production makes them — `getOrCreateRepoPod`
 * through `createRepoPodViaStatefulSet`, the health sweep's own updates,
 * `markPodError` from a failed create — against real Postgres; only the
 * cluster is a stand-in (which StatefulSets exist, which pods run).
 *
 * The row must be provisioned again under its own id when, and only when,
 * the cluster says the StatefulSet does not exist. A pod that is merely not
 * running, or a cluster that can't be asked, leaves everything as it was:
 * the row is kept and its workspace retained for recovery.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentPods } from "../db/schema.js";

const cluster = vi.hoisted(() => ({
  /** StatefulSet name → replicas. */
  sets: new Map<string, number>(),
  /** Names of the pods that are running. */
  running: new Set<string>(),
  /** Every ensureStatefulSet call that reached the cluster. */
  ensured: [] as string[],
  /** How many times the StatefulSet's existence was asked about. */
  asked: 0,
  /** The Kubernetes API answers 503 to the existence check. */
  apiDown: false,
  /** Runs before ensureStatefulSet reaches the cluster (a creator that hangs or dies). */
  beforeEnsure: null as null | (() => Promise<void>),
  /** Replaces the wait for the pod (a creator still waiting, or timing out). */
  podWait: null as null | ((podName: string) => Promise<void>),
}));

vi.mock("./k8s-workload-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./k8s-workload-service.js")>()),
  isStatefulSetEnabled: () => true,
  getWorkloadManager: () => ({
    ensureStatefulSet: async ({ name }: { name: string }) => {
      if (cluster.beforeEnsure) await cluster.beforeEnsure();
      cluster.ensured.push(name);
      if (!cluster.sets.has(name)) cluster.sets.set(name, 1);
      return { name, replicas: cluster.sets.get(name)! };
    },
    scale: async (name: string, replicas: number) => {
      cluster.sets.set(name, replicas);
    },
    waitForPodRunning: async (podName: string) => {
      if (cluster.podWait) return cluster.podWait(podName);
      // The controller starts the replica.
      cluster.running.add(podName);
    },
    statefulSetGone: async (name: string) => {
      cluster.asked++;
      if (cluster.apiDown) throw Object.assign(new Error("Service Unavailable"), { code: 503 });
      return !cluster.sets.has(name);
    },
    deleteStatefulSet: async (name: string) => {
      cluster.sets.delete(name);
    },
  }),
}));
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    status: async (h: { name: string }) => {
      if (!cluster.running.has(h.name)) {
        throw Object.assign(new Error("pods not found"), { code: 404 });
      }
      return { state: "running" };
    },
    exec: async () => ({ stdout: (async function* () {})(), close: () => {} }),
    destroy: async () => {},
  }),
}));
// The sweep's other chores, none of them about repo pods.
vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));
vi.mock("./workflow-pool-service.js", () => ({
  reconcileActiveRunCounts: async () => 0,
  cleanupIdleWorkflowPods: async () => 0,
}));
vi.mock("./persistent-agent-pool-service.js", () => ({
  cleanupIdlePersistentAgentPods: async () => 0,
}));
vi.mock("./run-home-sweep-service.js", () => ({ sweepFinishedRunHomes: async () => 0 }));
vi.mock("./zombie-cleanup-service.js", () => ({
  cleanupZombieWorkflowRuns: async () => 0,
  cleanupOrphanedRepoTasks: async () => 0,
}));
vi.mock("./session-service.js", () => ({ cleanupExpiredSessions: async () => 0 }));

import * as podPool from "./agent-pod-pool.js";
import { getOrCreateRepoPod, listRepoPodsForRepo } from "./repo-pool-service.js";
import { repoCleanupQueue, sweepPods } from "../workers/repo-cleanup-worker.js";

const RECOVERING = "Pod is recovering; its persistent workspace is retained";
const NEEDS_RECOVERY = "Pod needs recovery; its persistent workspace is retained";

let n = 0;
const nextRepo = () => `https://github.com/acme/sts-gone-${++n}-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a task dispatch asks the repo pool for. */
function pick(repoUrl: string, opts: Parameters<typeof getOrCreateRepoPod>[4] = {}) {
  return getOrCreateRepoPod(repoUrl, "main", {}, undefined, {
    maxAgentsPerPod: 2,
    maxPodInstances: 1,
    ...opts,
  });
}

/** `kubectl delete sts`: the object is gone, and its pods with it. Volume claims stay. */
function deleteStatefulSet(name: string) {
  cluster.sets.delete(name);
  for (const podName of [...cluster.running]) {
    if (podName.startsWith(`${name}-`)) cluster.running.delete(podName);
  }
}

async function onlyRow(repoUrl: string) {
  const rows = await listRepoPodsForRepo(repoUrl);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function waitForRow(repoUrl: string) {
  for (let i = 0; i < 100; i++) {
    const rows = await listRepoPodsForRepo(repoUrl);
    if (rows.length) return rows[0];
    await sleep(20);
  }
  throw new Error("the creator never inserted its row");
}

/** The row has been there a while (its creator is long past creating the StatefulSet). */
async function age(podId: string, ms: number) {
  await db
    .update(agentPods)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(agentPods.id, podId));
}

/** Whether a pick is still waiting after `ms` (it neither returned nor threw). */
async function stillWaiting(p: Promise<unknown>, ms = 2_500): Promise<boolean> {
  return Promise.race([
    p.then(
      () => false,
      () => false,
    ),
    sleep(ms).then(() => true),
  ]);
}

/**
 * Runs `between` after pickPod has read the pool's rows for its loop and
 * before it reads them again for the instance limit — the moment the health
 * sweep has to land in for a pick to meet a provisioning row there.
 */
function betweenPoolReads(between: () => Promise<void>) {
  const select = db.select.bind(db);
  let reads = 0;
  const spy = vi.spyOn(db, "select").mockImplementation(((...args: []) => {
    const query = select(...args);
    if (++reads !== 2) return query;
    spy.mockRestore();
    return {
      from: (table: never) => ({
        where: (cond: never) => ({
          orderBy: (order: never) =>
            between().then(() =>
              select(...args)
                .from(table)
                .where(cond)
                .orderBy(order),
            ),
        }),
      }),
    };
  }) as never);
}

beforeEach(() => {
  cluster.ensured.length = 0;
  cluster.asked = 0;
  cluster.apiDown = false;
  cluster.beforeEnsure = null;
  cluster.podWait = null;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await repoCleanupQueue.close();
});

describe("a repo pod whose StatefulSet no longer exists is provisioned again under its row", () => {
  it("a row left provisioning by a creator that died before creating the StatefulSet", async () => {
    const repo = nextRepo();
    // The creator inserts its row and dies before the StatefulSet exists.
    cluster.beforeEnsure = () => new Promise<void>(() => {});
    void pick(repo).catch(() => {});
    const left = await waitForRow(repo);
    expect(left).toMatchObject({ state: "provisioning", managedBy: "statefulset", podName: null });
    expect(cluster.sets.has(left.statefulSetName!)).toBe(false);
    await age(left.id, 5 * 60_000);
    cluster.beforeEnsure = null;

    const started = Date.now();
    const picked = await pick(repo);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(picked.id).toBe(left.id);
    expect(picked.state).toBe("ready");
    expect(picked.podName).toBe(`${left.statefulSetName}-0`);
    expect(cluster.sets.get(left.statefulSetName!)).toBe(1);
    expect((await onlyRow(repo)).id).toBe(left.id);
  }, 20_000);

  it("a ready row the health sweep turned back to provisioning after the StatefulSet was deleted", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    expect(first.state).toBe("ready");
    deleteStatefulSet(first.statefulSetName!);
    cluster.ensured.length = 0;

    await sweepPods();
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "provisioning" });
    // Sweep after sweep finds the pod missing and says the same thing.
    await sweepPods();
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "provisioning" });

    const started = Date.now();
    const picked = await pick(repo);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(picked).toMatchObject({ id: first.id, state: "ready", podName: first.podName });
    expect(cluster.ensured).toEqual([first.statefulSetName]);
    expect(cluster.sets.has(first.statefulSetName!)).toBe(true);
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "ready", errorMessage: null });
  }, 20_000);

  it("a ready row whose StatefulSet was deleted, before any sweep has seen it", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    deleteStatefulSet(first.statefulSetName!);

    const picked = await pick(repo);

    expect(picked).toMatchObject({ id: first.id, state: "ready" });
    expect(cluster.sets.has(first.statefulSetName!)).toBe(true);
  }, 20_000);

  it("a row its creator marked failed: the StatefulSet was deleted while it waited for the pod", async () => {
    const repo = nextRepo();
    // The creator makes the StatefulSet, then waits for a pod that never
    // comes because the StatefulSet is deleted under it; its wait times out.
    cluster.podWait = async (podName) => {
      deleteStatefulSet(podName.replace(/-0$/, ""));
      throw new Error(`Timed out waiting for pod "${podName}" to reach Running state after 300s`);
    };
    await expect(pick(repo)).rejects.toThrow("Timed out waiting for pod");
    const failed = await onlyRow(repo);
    expect(failed).toMatchObject({ state: "error", managedBy: "statefulset" });
    cluster.podWait = null;
    cluster.ensured.length = 0;

    const picked = await pick(repo);

    expect(picked).toMatchObject({ id: failed.id, state: "ready", errorMessage: null });
    expect(cluster.ensured).toEqual([failed.statefulSetName]);
  }, 20_000);

  it("keeps what points at the row: a task's last pod and the slot a later run takes", async () => {
    const repo = nextRepo();
    const first = await pick(repo, { reserveSlot: true, maxAgentsPerPod: 1 });
    expect(first.activeCount).toBe(1);
    deleteStatefulSet(first.statefulSetName!);
    await sweepPods();

    // The retry of the run that was on it asks for the same pod again.
    const picked = await pick(repo, {
      reserveSlot: true,
      maxAgentsPerPod: 1,
      preferredPodId: first.id,
    });

    expect(picked).toMatchObject({ id: first.id, state: "ready", activeCount: 1 });
  }, 20_000);

  describe("at the instance limit, when the sweep lands between the pick's two reads", () => {
    for (const reserveSlot of [true, false]) {
      it(`reserveSlot=${reserveSlot}: the pod is made again instead of waited on for two minutes`, async () => {
        const repo = nextRepo();
        // One pod, one slot, and a run holding it.
        const first = await pick(repo, { reserveSlot, maxAgentsPerPod: 1 });
        if (!reserveSlot) await podPool.acquireSlot(first.id);
        expect((await onlyRow(repo)).activeCount).toBe(1);
        cluster.ensured.length = 0;

        // The second run's pick reads a full, ready pod; then the
        // StatefulSet is deleted and the sweep marks the row provisioning.
        betweenPoolReads(async () => {
          deleteStatefulSet(first.statefulSetName!);
          await sweepPods();
        });
        const started = Date.now();
        const picked = await pick(repo, { reserveSlot, maxAgentsPerPod: 1 });

        expect(Date.now() - started).toBeLessThan(10_000);
        expect(picked).toMatchObject({ id: first.id, state: "ready" });
        expect(cluster.ensured).toEqual([first.statefulSetName]);
        // The sweep zeroed the count with the pod; the reserving run holds its slot.
        expect((await onlyRow(repo)).activeCount).toBe(reserveSlot ? 1 : 0);
      }, 20_000);
    }
  });
});

describe("a StatefulSet that still exists is left to recover, as before", () => {
  it("a pod that is not running: the pick waits on the row and takes it when the pod is back", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    // The pod crashed or was evicted; its StatefulSet will start it again.
    cluster.running.delete(first.podName!);
    await sweepPods();
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "provisioning" });
    cluster.ensured.length = 0;

    const waiting = pick(repo);
    expect(await stillWaiting(waiting)).toBe(true);
    expect(cluster.asked).toBeGreaterThan(0);
    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "provisioning" });

    cluster.running.add(first.podName!);
    await sweepPods();
    expect((await waiting).id).toBe(first.id);
    expect(cluster.ensured).toEqual([]);
  }, 30_000);

  it("a ready row whose pod is not running yet is still 'recovering'", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    cluster.running.delete(first.podName!);
    cluster.ensured.length = 0;

    await expect(pick(repo)).rejects.toThrow(RECOVERING);
    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "ready" });
  });

  it("a failed row (image pull, unschedulable, slow start) still needs recovery", async () => {
    const repo = nextRepo();
    cluster.podWait = async (podName) => {
      throw new Error(`Timed out waiting for pod "${podName}" to reach Running state after 300s`);
    };
    await expect(pick(repo)).rejects.toThrow("Timed out waiting for pod");
    const failed = await onlyRow(repo);
    expect(cluster.sets.has(failed.statefulSetName!)).toBe(true);
    cluster.podWait = null;
    cluster.ensured.length = 0;

    await expect(pick(repo)).rejects.toThrow(NEEDS_RECOVERY);
    await age(failed.id, 60 * 60_000);
    await expect(pick(repo)).rejects.toThrow(NEEDS_RECOVERY);

    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({
      id: failed.id,
      state: "error",
      errorMessage: failed.errorMessage,
    });
  });

  it("a row whose creator is still creating the StatefulSet is not second-guessed", async () => {
    const repo = nextRepo();
    let finish!: () => void;
    cluster.beforeEnsure = () => new Promise<void>((resolve) => (finish = resolve));
    const creator = pick(repo);
    const row = await waitForRow(repo);
    expect(cluster.sets.has(row.statefulSetName!)).toBe(false);

    // A second run, a moment later: the StatefulSet isn't there *yet*.
    await sleep(150);
    const second = pick(repo);
    expect(await stillWaiting(second, 1_500)).toBe(true);
    expect(cluster.asked).toBe(0);

    cluster.beforeEnsure = null;
    finish();
    expect((await creator).id).toBe(row.id);
    expect((await second).id).toBe(row.id);
    expect(cluster.ensured).toEqual([row.statefulSetName]);
  }, 30_000);
});

describe("when the cluster can't say whether the StatefulSet exists, the row is left alone", () => {
  it("a failed row stays failed and keeps its workspace for recovery", async () => {
    const repo = nextRepo();
    cluster.podWait = async (podName) => {
      deleteStatefulSet(podName.replace(/-0$/, ""));
      throw new Error(`Timed out waiting for pod "${podName}" to reach Running state after 300s`);
    };
    await expect(pick(repo)).rejects.toThrow("Timed out waiting for pod");
    const failed = await onlyRow(repo);
    cluster.podWait = null;
    cluster.ensured.length = 0;
    cluster.apiDown = true;

    await expect(pick(repo)).rejects.toThrow(NEEDS_RECOVERY);

    expect(cluster.asked).toBe(1);
    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({
      id: failed.id,
      state: "error",
      errorMessage: failed.errorMessage,
    });
  });

  it("a row from before today's StatefulSet naming is not asked about, nor remade under another name", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    deleteStatefulSet(first.statefulSetName!);
    await db
      .update(agentPods)
      .set({ statefulSetName: "optio-repo-legacy-name" })
      .where(eq(agentPods.id, first.id));
    cluster.ensured.length = 0;

    await expect(pick(repo)).rejects.toThrow(RECOVERING);

    expect(cluster.asked).toBe(0);
    expect(cluster.ensured).toEqual([]);
  });

  it("a ready row whose pod can't be found stays 'recovering'", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    deleteStatefulSet(first.statefulSetName!);
    cluster.ensured.length = 0;
    cluster.apiDown = true;

    await expect(pick(repo)).rejects.toThrow(RECOVERING);

    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "ready" });
  });

  it("a provisioning row is waited on, then recreated once the cluster answers 404", async () => {
    const repo = nextRepo();
    const first = await pick(repo);
    deleteStatefulSet(first.statefulSetName!);
    await sweepPods();
    cluster.ensured.length = 0;
    cluster.apiDown = true;

    const waiting = pick(repo);
    expect(await stillWaiting(waiting)).toBe(true);
    expect(cluster.ensured).toEqual([]);
    expect(await onlyRow(repo)).toMatchObject({ id: first.id, state: "provisioning" });

    // The API is back and says the StatefulSet is gone: the next dispatch remakes it.
    cluster.apiDown = false;
    const picked = await pick(repo);
    expect(picked).toMatchObject({ id: first.id, state: "ready" });
    expect((await waiting).id).toBe(first.id);
    expect(cluster.ensured).toEqual([first.statefulSetName]);
  }, 30_000);
});
