/**
 * Picking a pod in a pool, against real rows: retry affinity, least-loaded
 * first, dead / errored / abandoned rows removed on the way, the instance
 * limit, and scale-up at the lowest free index. The container runtime is a
 * stub that knows which pods are "running".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { agentPods } from "../db/schema.js";

const running = new Set<string>();
vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    status: async (h: { name: string }) => {
      if (!running.has(h.name)) throw new Error("not found");
      return { state: "running" };
    },
  }),
}));

import * as podPool from "./agent-pod-pool.js";

let key = 0;
const nextKey = () => `pool-key-${++key}-${Date.now()}`;

async function pod(
  poolKey: string,
  over: Partial<typeof agentPods.$inferInsert> & { up?: boolean } = {},
) {
  const { up = true, ...values } = over;
  const name = `pod-${poolKey}-${values.instanceIndex ?? 0}-${Math.random().toString(36).slice(2, 6)}`;
  const [row] = await db
    .insert(agentPods)
    .values({ pool: "standalone", poolKey, state: "ready", podName: name, ...values })
    .returning();
  if (up && row.podName) running.add(row.podName);
  return row;
}

function creator(poolKey: string, pool: podPool.PodPool = "standalone") {
  const created: number[] = [];
  return {
    created,
    create: async (instanceIndex: number) => {
      created.push(instanceIndex);
      const row = await podPool.insertPod({ pool, poolKey, instanceIndex });
      const ready = await podPool.markPodReady(row.id, {
        podName: `new-${poolKey}-${instanceIndex}`,
        podId: null,
      });
      running.add(ready.podName!);
      return ready;
    },
  };
}

beforeEach(() => running.clear());

describe("pickPod", () => {
  it("prefers the pod the last attempt ran on while it is up and has a slot", async () => {
    const k = nextKey();
    await pod(k, { activeCount: 0, instanceIndex: 0 });
    const preferred = await pod(k, { activeCount: 1, instanceIndex: 1 });
    const { create } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      preferredPodId: preferred.id,
      maxAgentsPerPod: 2,
      maxPodInstances: 2,
      create,
    });
    expect(picked.id).toBe(preferred.id);
  });

  it("takes the least-loaded live pod, removing rows whose pod is gone or errored", async () => {
    const k = nextKey();
    const gone = await pod(k, { activeCount: 0, instanceIndex: 0, up: false });
    const errored = await pod(k, { state: "error", instanceIndex: 1 });
    const busy = await pod(k, { activeCount: 1, instanceIndex: 2 });
    const { create, created } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 3,
      create,
    });
    expect(picked.id).toBe(busy.id);
    expect(created).toEqual([]);
    expect(await podPool.getPod(gone.id)).toBeNull();
    expect(await podPool.getPod(errored.id)).toBeNull();
  });

  it("removes a row stuck provisioning past ten minutes and scales up in its place", async () => {
    const k = nextKey();
    const stuck = await pod(k, {
      state: "provisioning",
      podName: null,
      createdAt: new Date(Date.now() - 11 * 60_000),
    });
    const { create, created } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 1,
      create,
    });
    expect(await podPool.getPod(stuck.id)).toBeNull();
    expect(created).toEqual([0]);
    expect(picked.instanceIndex).toBe(0);
  });

  it("scales up at the lowest free instance index", async () => {
    const k = nextKey();
    await pod(k, { activeCount: 2, instanceIndex: 0 });
    await pod(k, { activeCount: 2, instanceIndex: 2 });
    const { create, created } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 3,
      create,
    });
    expect(created).toEqual([1]);
    expect(picked.instanceIndex).toBe(1);
  });

  it("at the instance limit, shares the least-loaded ready pod instead of creating one", async () => {
    const k = nextKey();
    await pod(k, { activeCount: 3, instanceIndex: 0 });
    const lighter = await pod(k, { activeCount: 2, instanceIndex: 1 });
    const { create, created } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 2,
      create,
    });
    expect(picked.id).toBe(lighter.id);
    expect(created).toEqual([]);
  });

  it("keeps pools apart: another pool's pods under the same key are never picked", async () => {
    const k = nextKey();
    await pod(k, { pool: "repo", activeCount: 0 });
    const { create, created } = creator(k);

    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 1,
      create,
    });
    expect(picked.pool).toBe("standalone");
    expect(created).toEqual([0]);
  });

  it("retries a scale-up that lost the instance-index race to a concurrent creator", async () => {
    const k = nextKey();
    let first = true;
    const create = async (instanceIndex: number) => {
      if (first) {
        first = false;
        // A concurrent creator takes index 0 between our read and our insert.
        await pod(k, { instanceIndex: 0, activeCount: 0 });
        return podPool.insertPod({ pool: "standalone", poolKey: k, instanceIndex });
      }
      throw new Error("should have picked the winner's pod");
    };
    const picked = await podPool.pickPod("standalone", k, {
      maxAgentsPerPod: 2,
      maxPodInstances: 1,
      create,
    });
    expect(picked.instanceIndex).toBe(0);
    expect(picked.state).toBe("ready");
  });
});

describe("slots and count repair", () => {
  it("acquires and releases slots, never below zero", async () => {
    const k = nextKey();
    const p = await pod(k, { activeCount: 0 });
    await podPool.acquireSlot(p.id);
    expect((await podPool.getPod(p.id))!.activeCount).toBe(1);
    expect((await podPool.getPod(p.id))!.lastUsedAt).toBeInstanceOf(Date);
    await podPool.releaseSlot(p.id);
    const after = await podPool.releaseSlot(p.id);
    expect(after!.activeCount).toBe(0);
  });

  it("repairs drifted counts in one pool from the runs actually holding each pod", async () => {
    const k = nextKey();
    const drifted = await pod(k, { activeCount: 5 });
    const empty = await pod(k, { activeCount: 1, instanceIndex: 1 });
    const repoPod = await pod(k, { pool: "repo", activeCount: 7 });

    const corrected = await podPool.reconcileActiveCounts("standalone", new Map([[drifted.id, 2]]));
    expect(corrected).toBeGreaterThanOrEqual(2);
    expect((await podPool.getPod(drifted.id))!.activeCount).toBe(2);
    expect((await podPool.getPod(empty.id))!.activeCount).toBe(0);
    expect((await podPool.getPod(repoPod.id))!.activeCount).toBe(7);
  });

  it("lists the pool's idle pods: ready, nothing running, untouched since the cutoff", async () => {
    const k = nextKey();
    const old = new Date(Date.now() - 60 * 60_000);
    const idle = await pod(k, { activeCount: 0, updatedAt: old });
    const busy = await pod(k, { activeCount: 1, updatedAt: old, instanceIndex: 1 });
    const recent = await pod(k, { activeCount: 0, instanceIndex: 2 });
    const otherPool = await pod(k, { pool: "repo", activeCount: 0, updatedAt: old });

    const ids = (await podPool.idlePods("standalone", new Date(Date.now() - 60_000))).map(
      (p) => p.id,
    );
    expect(ids).toContain(idle.id);
    expect(ids).not.toContain(busy.id);
    expect(ids).not.toContain(recent.id);
    expect(ids).not.toContain(otherPool.id);
  });
});
