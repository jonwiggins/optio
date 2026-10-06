import { isPodNotFound } from "../utils/pod-status.js";
/**
 * The verbs every agent pod pool shares, over the one pod table
 * (`agent_pods`). A pool is what pods are shared across — a repo's pods, a
 * Job's pods, a persistent agent's pod — named by `(pool, poolKey)`. The
 * per-pool services build the pod spec and own their lifecycle quirks
 * (repo-pool-service: StatefulSets, PVCs, sidecars, the clone;
 * workflow-pool-service: Jobs; persistent-agent-pool-service: warm windows);
 * picking a pod, the row's lifecycle, slots, and count repair live here.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { ContainerHandle } from "@optio/shared";
import { db } from "../db/client.js";
import { agentPods } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import { logger } from "../logger.js";
import { isUniqueViolation } from "../utils/db-errors.js";

export type PodPool = "repo" | "standalone" | "persistent-agent";
export type AgentPod = typeof agentPods.$inferSelect;

/** A provisioning row older than this was abandoned (its creator died); remove it. */
const STALE_PROVISIONING_MS = 10 * 60 * 1000;
/** How many times a scale-up retries after losing an instance-index race. */
const CREATE_RACE_RETRIES = 3;

export function podHandle(pod: Pick<AgentPod, "podId" | "podName">): ContainerHandle {
  return { id: pod.podId ?? pod.podName!, name: pod.podName! };
}

async function isRunning(pod: AgentPod): Promise<boolean> {
  if (!pod.podName) return false;
  try {
    return (await getRuntime().status(podHandle(pod))).state === "running";
  } catch (err) {
    if (isPodNotFound(err)) return false;
    // An API outage is not evidence that the workload has disappeared.
    throw err;
  }
}

export interface PickPodOpts {
  /** Required trust boundary; null legacy pods are never eligible. */
  isolationKey: string;
  /** Same-pod retry affinity: the pod the previous attempt ran on. */
  preferredPodId?: string;
  maxAgentsPerPod: number;
  maxPodInstances: number;
  /** Provision instance `instanceIndex` of the pool (insert its row, create the pod). */
  create: (instanceIndex: number) => Promise<AgentPod>;
}

/**
 * Pick (or create) a pod in a pool that scales out:
 *   1. the preferred pod, if it is up and has a free slot;
 *   2. the least-loaded ready pod with a free slot — rows whose pod is gone,
 *      errored, or stuck provisioning are removed on the way, and a pod still
 *      provisioning is waited for;
 *   3. at the instance limit, the least-loaded ready pod (the callers' own
 *      concurrency limits keep it from overfilling) or one still coming up;
 *   4. otherwise a new instance at the lowest free index (StatefulSet scaling
 *      only ever grows to `index + 1` replicas, so this maps onto the ordinal
 *      the controller keeps).
 */
export async function pickPod(
  pool: PodPool,
  poolKey: string,
  opts: PickPodOpts,
  attempt = 0,
): Promise<AgentPod> {
  if (opts.preferredPodId) {
    const preferred = await getPod(opts.preferredPodId);
    if (
      preferred?.state === "ready" &&
      preferred.pool === pool &&
      preferred.poolKey === poolKey &&
      preferred.isolationKey === opts.isolationKey &&
      preferred.activeCount < opts.maxAgentsPerPod &&
      (await isRunning(preferred))
    ) {
      return preferred;
    }
  }

  const pods = await db
    .select()
    .from(agentPods)
    .where(
      and(
        eq(agentPods.pool, pool),
        eq(agentPods.poolKey, poolKey),
        eq(agentPods.isolationKey, opts.isolationKey),
      ),
    )
    .orderBy(asc(agentPods.activeCount));

  for (const pod of pods) {
    if (pod.state === "ready" && pod.podName && pod.activeCount < opts.maxAgentsPerPod) {
      if (await isRunning(pod)) return pod;
      if (pod.managedBy === "statefulset")
        throw new Error("Pod is recovering; its persistent workspace is retained");
      await deletePod(pod.id);
    } else if (pod.state === "provisioning") {
      const ageMs = Date.now() - pod.createdAt.getTime();
      if (ageMs > STALE_PROVISIONING_MS && pod.managedBy !== "statefulset") {
        logger.warn({ podId: pod.id, pool, ageMs }, "Removing a pod stuck provisioning");
        await deletePod(pod.id);
      } else {
        return waitForPodReady(pod.id);
      }
    } else if (pod.state === "error") {
      if (pod.managedBy === "statefulset")
        throw new Error("Pod needs recovery; its persistent workspace is retained");
      await deletePod(pod.id);
    }
  }

  const live = await db
    .select()
    .from(agentPods)
    .where(
      and(
        eq(agentPods.pool, pool),
        eq(agentPods.poolKey, poolKey),
        eq(agentPods.isolationKey, opts.isolationKey),
      ),
    )
    .orderBy(asc(agentPods.activeCount));
  if (live.length >= opts.maxPodInstances) {
    const busy = live.find((p) => p.state === "ready");
    if (busy) return busy;
    const coming = live.find((p) => p.state === "provisioning");
    if (coming) return waitForPodReady(coming.id);
    throw new Error(`All ${opts.maxPodInstances} ${pool} pod instances for ${poolKey} unavailable`);
  }

  const taken = new Set(live.map((p) => p.instanceIndex));
  let instanceIndex = 0;
  while (taken.has(instanceIndex)) instanceIndex++;
  try {
    return await opts.create(instanceIndex);
  } catch (err: unknown) {
    if (isUniqueViolation(err) && attempt < CREATE_RACE_RETRIES) {
      logger.info({ pool, poolKey, instanceIndex }, "Concurrent pod creation detected, retrying");
      return pickPod(pool, poolKey, opts, attempt + 1);
    }
    throw err;
  }
}

/** Block until a provisioning pod is ready (or failed, or gone). */
export async function waitForPodReady(podId: string, timeoutMs = 120_000): Promise<AgentPod> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await getPod(podId);
    if (!pod) throw new Error(`Pod record ${podId} disappeared`);
    if (pod.state === "ready" && pod.podName) return pod;
    if (pod.state === "error") throw new Error(`Pod failed: ${pod.errorMessage}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for pod ${podId}`);
}

// ── The row's lifecycle ─────────────────────────────────────────────────────

/** Record a pod being provisioned. */
export async function insertPod(
  values: Omit<typeof agentPods.$inferInsert, "state">,
): Promise<AgentPod> {
  const [row] = await db
    .insert(agentPods)
    .values({ ...values, state: "provisioning" })
    .returning();
  return row;
}

/** The pod is up: record where it lives. */
export async function markPodReady(
  podId: string,
  where: { podName: string; podId: string | null },
): Promise<AgentPod> {
  const [row] = await db
    .update(agentPods)
    .set({ podName: where.podName, podId: where.podId, state: "ready", updatedAt: new Date() })
    .where(eq(agentPods.id, podId))
    .returning();
  return row;
}

/** The pod could not be provisioned. */
export async function markPodError(podId: string, err: unknown): Promise<void> {
  await db
    .update(agentPods)
    .set({ state: "error", errorMessage: String(err), updatedAt: new Date() })
    .where(eq(agentPods.id, podId));
}

export async function getPod(id: string): Promise<AgentPod | null> {
  const [row] = await db.select().from(agentPods).where(eq(agentPods.id, id));
  return row ?? null;
}

export async function listPods(pool?: PodPool, poolKey?: string): Promise<AgentPod[]> {
  return db
    .select()
    .from(agentPods)
    .where(
      and(
        pool ? eq(agentPods.pool, pool) : undefined,
        poolKey !== undefined ? eq(agentPods.poolKey, poolKey) : undefined,
      ),
    );
}

export async function deletePod(id: string): Promise<void> {
  await db.delete(agentPods).where(eq(agentPods.id, id));
}

// ── Slots ───────────────────────────────────────────────────────────────────

/** A run starts on the pod. */
export async function acquireSlot(podId: string): Promise<void> {
  await db
    .update(agentPods)
    .set({
      activeCount: sql`${agentPods.activeCount} + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(agentPods.id, podId));
}

/**
 * A run on the pod ended. Clamped at zero so a double release (zombie cleanup
 * plus the worker's finally) can't drive it negative. Returns the pod.
 */
export async function releaseSlot(podId: string): Promise<AgentPod | null> {
  const [row] = await db
    .update(agentPods)
    .set({
      activeCount: sql`GREATEST(${agentPods.activeCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(agentPods.id, podId))
    .returning();
  return row ?? null;
}

/** Ready pods with nothing running and no use since `cutoff` — candidates for the idle reaper. */
export async function idlePods(pool: PodPool, cutoff: Date): Promise<AgentPod[]> {
  return db
    .select()
    .from(agentPods)
    .where(
      and(
        eq(agentPods.pool, pool),
        eq(agentPods.activeCount, 0),
        eq(agentPods.state, "ready"),
        lt(agentPods.updatedAt, cutoff),
        // Keep uncertain work reachable, including ephemeral Job/bare-pod files.
        sql`NOT EXISTS (SELECT 1 FROM tasks t
          WHERE (t.last_pod_id = ${agentPods.id} OR t.pod_id = ${agentPods.id})
          AND (t.recovery_required = true OR t.worktree_state = 'preserved'))`,
      ),
    );
}

/**
 * Repair `activeCount` drift (a worker that died between starting a run and
 * releasing its slot) from the runs actually holding each pod. `actual`
 * counts live runs per pod id; pods it doesn't name hold none. Returns how
 * many pods were corrected.
 */
export async function reconcileActiveCounts(
  pool: PodPool,
  actual: Map<string, number>,
): Promise<number> {
  const pods = await db
    .select({ id: agentPods.id, activeCount: agentPods.activeCount })
    .from(agentPods)
    .where(eq(agentPods.pool, pool));
  let corrected = 0;
  for (const pod of pods) {
    const now = actual.get(pod.id) ?? 0;
    if (pod.activeCount === now) continue;
    await db
      .update(agentPods)
      .set({ activeCount: now, updatedAt: new Date() })
      .where(eq(agentPods.id, pod.id));
    logger.info({ podId: pod.id, pool, was: pod.activeCount, now }, "Reconciled pod activeCount");
    corrected++;
  }
  return corrected;
}
