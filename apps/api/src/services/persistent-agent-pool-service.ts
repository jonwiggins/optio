import { agentNodePlacement } from "./agent-node-placement.js";
import { podIsolationKey, workCredentialProfile } from "./pod-isolation.js";
// Pod lifecycle for Persistent Agents.
//
// Three configurable modes (per agent):
//   - always-on : pod runs until the agent is paused/archived. Most expensive.
//   - sticky    : pod kept warm for `idle_pod_timeout_ms` after each turn,
//                 reused if next message lands in window, cold-restart otherwise.
//   - on-demand : cold-start each turn. Cheapest, slower response.
//
// Unlike Job and repo pools, persistent agents are single-threaded — at most
// one pod per agent, at most one turn in flight at a time. Rows live in
// `agent_pods` (pool "persistent-agent", keyed by the agent's id); a
// `keep_warm_until` timestamp drives reaping (null = always-on). The
// repo-cleanup-worker calls `cleanupIdlePersistentAgentPods()` on its sweep.

import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentPods, persistentAgents } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerSpec, ExecSession } from "@optio/shared";
import { PersistentAgentPodLifecycle, parseIntEnv, type RepoImageConfig } from "@optio/shared";
import { logger } from "../logger.js";
import { resolveImage } from "./repo-pool-service.js";
import * as podPool from "./agent-pod-pool.js";
import { buildPooledExecScript } from "../utils/pod-env.js";

const POD_PROVISION_TIMEOUT_MS = parseIntEnv("OPTIO_PERSISTENT_AGENT_POD_PROVISION_MS", 120_000);

export interface PersistentAgentPodHandle {
  id: string;
  agentId: string;
  podName: string;
  podId: string | null;
  state: string;
}

export interface AcquirePodOpts {
  imageConfig?: RepoImageConfig;
  workspaceId?: string | null;
  cpuRequest?: string | null;
  cpuLimit?: string | null;
  memoryRequest?: string | null;
  memoryLimit?: string | null;
}

function toHandle(pod: podPool.AgentPod): PersistentAgentPodHandle {
  return {
    id: pod.id,
    agentId: pod.poolKey,
    podName: pod.podName!,
    podId: pod.podId,
    state: pod.state,
  };
}

/** The agent's newest pod row, if any. */
async function currentPod(
  agentId: string,
  isolationKey?: string,
): Promise<podPool.AgentPod | null> {
  const [pod] = await db
    .select()
    .from(agentPods)
    .where(
      and(
        eq(agentPods.pool, "persistent-agent"),
        eq(agentPods.poolKey, agentId),
        isolationKey ? eq(agentPods.isolationKey, isolationKey) : undefined,
      ),
    )
    .orderBy(desc(agentPods.updatedAt))
    .limit(1);
  return pod ?? null;
}

/**
 * Acquire a pod for the given persistent agent according to its configured
 * lifecycle mode. Always returns a ready pod (creating one if needed) or
 * throws.
 */
export async function acquirePodForAgent(
  agentId: string,
  opts: AcquirePodOpts = {},
): Promise<PersistentAgentPodHandle> {
  const [agent] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, agentId));
  if (!agent) throw new Error(`Persistent agent ${agentId} not found`);

  const lifecycle = agent.podLifecycle as PersistentAgentPodLifecycle;
  const rt = getRuntime();

  // Try to reuse an existing pod (sticky / always-on)
  if (
    lifecycle === PersistentAgentPodLifecycle.STICKY ||
    lifecycle === PersistentAgentPodLifecycle.ALWAYS_ON
  ) {
    const existing = await currentPod(
      agentId,
      podIsolationKey({ ...agent, credentialProfile: workCredentialProfile(agent) }),
    );
    if (existing && existing.state === "ready" && existing.podName) {
      try {
        const status = await rt.status(podPool.podHandle(existing));
        if (status.state === "running") {
          await db
            .update(agentPods)
            .set({ updatedAt: new Date() })
            .where(eq(agentPods.id, existing.id));
          return toHandle(existing);
        }
      } catch {
        // Pod gone — fall through to create a new one.
      }
      // Pod row exists but the K8s pod isn't healthy — clean up the row.
      await podPool.deletePod(existing.id);
    } else if (existing && existing.state === "provisioning") {
      return toHandle(await podPool.waitForPodReady(existing.id, POD_PROVISION_TIMEOUT_MS));
    } else if (existing) {
      // error or terminating — wipe and recreate.
      await podPool.deletePod(existing.id);
    }
  } else {
    // on-demand: always start fresh; remove any leftover row.
    await db
      .delete(agentPods)
      .where(and(eq(agentPods.pool, "persistent-agent"), eq(agentPods.poolKey, agentId)));
  }

  return createPod(agent, opts);
}

async function createPod(
  agent: typeof persistentAgents.$inferSelect,
  opts: AcquirePodOpts,
): Promise<PersistentAgentPodHandle> {
  const record = await podPool.insertPod({
    pool: "persistent-agent",
    poolKey: agent.id,
    isolationKey: podIsolationKey({ ...agent, credentialProfile: workCredentialProfile(agent) }),
    workspaceId: opts.workspaceId ?? agent.workspaceId ?? undefined,
  });

  const rt = getRuntime();
  const safeSlug = agent.slug
    .replace(/[^a-z0-9-]/gi, "-")
    .slice(0, 30)
    .toLowerCase();
  const podName = `optio-pa-${safeSlug}-${record.id.slice(0, 8)}`;

  try {
    const spec: ContainerSpec = {
      name: podName,
      image: resolveImage(opts.imageConfig),
      command: ["bash", "-c", buildInitScript()],
      env: {
        OPTIO_PERSISTENT_AGENT_ID: agent.id,
        OPTIO_PERSISTENT_AGENT_SLUG: agent.slug,
        OPTIO_AGENT_RUNTIME: agent.agentRuntime,
      },
      workDir: "/workspace",
      serviceAccountName: process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME,
      ...agentNodePlacement(),
      imagePullPolicy:
        (process.env.OPTIO_IMAGE_PULL_POLICY as ContainerSpec["imagePullPolicy"]) ?? "Never",
      cpuRequest: opts.cpuRequest ?? undefined,
      cpuLimit: opts.cpuLimit ?? undefined,
      memoryRequest: opts.memoryRequest ?? undefined,
      memoryLimit: opts.memoryLimit ?? undefined,
      labels: {
        "optio.persistent-agent-id": agent.id.slice(0, 63),
        "optio.persistent-agent-slug": safeSlug,
        "optio.type": "persistent-agent-pod",
        "managed-by": "optio",
      },
    };

    const handle = await rt.create(spec);
    const ready = await podPool.markPodReady(record.id, { podName: handle.name, podId: handle.id });
    await db
      .update(persistentAgents)
      .set({ stickyPodId: record.id, updatedAt: new Date() })
      .where(eq(persistentAgents.id, agent.id));

    logger.info(
      { agentId: agent.id, slug: agent.slug, podName: handle.name },
      "Persistent agent pod created",
    );
    return toHandle(ready);
  } catch (err) {
    await podPool.markPodError(record.id, err);
    try {
      await rt.destroy({ id: podName, name: podName });
    } catch {
      // best-effort
    }
    throw err;
  }
}

function buildInitScript(): string {
  return [
    "set -e",
    "mkdir -p /workspace/turns",
    "touch /workspace/.ready",
    "echo '[optio] Persistent agent pod ready'",
    "exec sleep infinity",
  ].join("\n");
}

/**
 * Execute a turn inside the agent's pod. Each turn isolates its working
 * directory under `/workspace/turns/<turnId>` so multiple turns over time
 * leave a clean per-turn artifact trail — unless the agent has a repo: then
 * every turn works in the pod's one checkout of it (`OPTIO_REPO_URL`).
 */
export async function execTurnInPod(
  pod: PersistentAgentPodHandle,
  turnId: string,
  agentCommand: string[],
  env: Record<string, string>,
): Promise<ExecSession> {
  const script = buildPooledExecScript({
    env: { ...env, OPTIO_PERSISTENT_AGENT_TURN_ID: turnId },
    workDir: `/workspace/turns/${turnId}`,
    agentCommand,
    checkout: !!env.OPTIO_REPO_URL,
  });
  return getRuntime().exec(podPool.podHandle(pod), ["bash", "-c", script], { tty: false });
}

/**
 * Mark the pod as warm for a fixed window after a turn ends. The cleanup
 * worker reaps pods whose `keep_warm_until` is past, except for always-on
 * agents where the field stays null.
 */
export async function markPodIdle(agentId: string): Promise<void> {
  const [agent] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, agentId));
  if (!agent) return;

  const pod = await currentPod(agentId);
  if (!pod) return;

  const lifecycle = agent.podLifecycle as PersistentAgentPodLifecycle;

  if (agent.state === "failed" || lifecycle === PersistentAgentPodLifecycle.ALWAYS_ON) {
    // Clear keep_warm_until — the cleanup worker will skip it.
    await db
      .update(agentPods)
      .set({ keepWarmUntil: null, lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentPods.id, pod.id));
    return;
  }

  if (lifecycle === PersistentAgentPodLifecycle.ON_DEMAND) {
    // Reap immediately.
    await reapPod(pod.id);
    return;
  }

  // sticky
  const keepWarmUntil = new Date(Date.now() + agent.idlePodTimeoutMs);
  await db
    .update(agentPods)
    .set({ keepWarmUntil, lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentPods.id, pod.id));
}

export async function reapPod(podId: string): Promise<void> {
  const pod = await podPool.getPod(podId);
  if (!pod) return;
  if (pod.podName) {
    try {
      await getRuntime().destroy(podPool.podHandle(pod));
    } catch (err) {
      logger.warn({ err, podName: pod.podName }, "failed to destroy persistent agent pod");
    }
  }
  await podPool.deletePod(podId);
}

/** Reap every pod of an agent — when the agent itself goes away. */
export async function reapPodsForAgent(agentId: string): Promise<void> {
  for (const pod of await podPool.listPods("persistent-agent", agentId)) {
    await reapPod(pod.id);
  }
}

/**
 * Reap pods whose warm window has passed. Always-on pods (keep_warm_until
 * IS NULL) are kept.
 *
 * Called periodically by the repo-cleanup-worker.
 */
export async function cleanupIdlePersistentAgentPods(): Promise<number> {
  const expired = await db
    .select()
    .from(agentPods)
    .where(
      and(
        eq(agentPods.pool, "persistent-agent"),
        eq(agentPods.state, "ready"),
        isNotNull(agentPods.keepWarmUntil),
        lt(agentPods.keepWarmUntil, new Date()),
      ),
    );

  let reaped = 0;
  for (const pod of expired) {
    const [agent] = await db
      .select({ state: persistentAgents.state })
      .from(persistentAgents)
      .where(eq(persistentAgents.id, pod.poolKey));
    if (agent?.state === "failed" || agent?.state === "running" || agent?.state === "provisioning")
      continue;
    try {
      await reapPod(pod.id);
      reaped++;
    } catch (err) {
      logger.warn({ err, podId: pod.id }, "failed to reap idle persistent agent pod");
    }
  }
  if (reaped > 0) {
    logger.info({ reaped }, "reaped idle persistent agent pods");
  }
  return reaped;
}
