// Pod lifecycle for Persistent Agents.
//
// Three configurable modes (per agent):
//   - always-on : pod runs until the agent is paused/archived. Most expensive.
//   - sticky    : pod kept warm for `idle_pod_timeout_ms` after each turn,
//                 reused if next message lands in window, cold-restart otherwise.
//   - on-demand : cold-start each turn. Cheapest, slower response.
//
// Unlike workflow pool, persistent agents are single-threaded — at most one
// pod per agent, at most one turn in flight at a time. A `keep_warm_until`
// timestamp drives reaping. The repo-cleanup-worker also calls
// `cleanupIdlePersistentAgentPods()` on its periodic sweep.

import { eq, and, desc, lt, sql, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgentPods, persistentAgents } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession } from "@optio/shared";
import { PersistentAgentPodLifecycle, parseIntEnv, type RepoImageConfig } from "@optio/shared";
import { logger } from "../logger.js";
import { resolveImage } from "./repo-pool-service.js";

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
    const [existing] = await db
      .select()
      .from(persistentAgentPods)
      .where(eq(persistentAgentPods.agentId, agentId))
      .orderBy(desc(persistentAgentPods.updatedAt))
      .limit(1);
    if (existing && existing.state === "ready" && existing.podName) {
      try {
        const status = await rt.status({
          id: existing.podId ?? existing.podName,
          name: existing.podName,
        });
        if (status.state === "running") {
          await db
            .update(persistentAgentPods)
            .set({ updatedAt: new Date() })
            .where(eq(persistentAgentPods.id, existing.id));
          return {
            id: existing.id,
            agentId,
            podName: existing.podName,
            podId: existing.podId,
            state: existing.state,
          };
        }
      } catch {
        // Pod gone — fall through to create a new one.
      }
      // Pod row exists but the K8s pod isn't healthy — clean up the row.
      await db.delete(persistentAgentPods).where(eq(persistentAgentPods.id, existing.id));
    } else if (existing && existing.state === "provisioning") {
      return waitForPodReady(existing.id);
    } else if (existing) {
      // error or terminating — wipe and recreate.
      await db.delete(persistentAgentPods).where(eq(persistentAgentPods.id, existing.id));
    }
  } else {
    // on-demand: always start fresh; remove any leftover row.
    await db.delete(persistentAgentPods).where(eq(persistentAgentPods.agentId, agentId));
  }

  return createPod(agent, opts);
}

async function createPod(
  agent: typeof persistentAgents.$inferSelect,
  opts: AcquirePodOpts,
): Promise<PersistentAgentPodHandle> {
  const [record] = await db
    .insert(persistentAgentPods)
    .values({
      agentId: agent.id,
      workspaceId: opts.workspaceId ?? agent.workspaceId ?? undefined,
      state: "provisioning",
    })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(opts.imageConfig);
  const safeSlug = agent.slug
    .replace(/[^a-z0-9-]/gi, "-")
    .slice(0, 30)
    .toLowerCase();
  const podName = `optio-pa-${safeSlug}-${record.id.slice(0, 8)}`;

  try {
    const spec: ContainerSpec = {
      name: podName,
      image,
      command: ["bash", "-c", buildInitScript()],
      env: {
        OPTIO_PERSISTENT_AGENT_ID: agent.id,
        OPTIO_PERSISTENT_AGENT_SLUG: agent.slug,
        OPTIO_AGENT_RUNTIME: agent.agentRuntime,
      },
      workDir: "/workspace",
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
    await db
      .update(persistentAgentPods)
      .set({
        podName: handle.name,
        podId: handle.id,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(persistentAgentPods.id, record.id));
    await db
      .update(persistentAgents)
      .set({ stickyPodId: record.id, updatedAt: new Date() })
      .where(eq(persistentAgents.id, agent.id));

    logger.info(
      { agentId: agent.id, slug: agent.slug, podName: handle.name },
      "Persistent agent pod created",
    );
    return {
      id: record.id,
      agentId: agent.id,
      podName: handle.name,
      podId: handle.id,
      state: "ready",
    };
  } catch (err) {
    await db
      .update(persistentAgentPods)
      .set({ state: "error", errorMessage: String(err), updatedAt: new Date() })
      .where(eq(persistentAgentPods.id, record.id));
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

async function waitForPodReady(
  podId: string,
  timeoutMs = POD_PROVISION_TIMEOUT_MS,
): Promise<PersistentAgentPodHandle> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pod] = await db
      .select()
      .from(persistentAgentPods)
      .where(eq(persistentAgentPods.id, podId));
    if (!pod) throw new Error(`Persistent agent pod record ${podId} disappeared`);
    if (pod.state === "ready" && pod.podName) {
      return {
        id: pod.id,
        agentId: pod.agentId,
        podName: pod.podName,
        podId: pod.podId,
        state: pod.state,
      };
    }
    if (pod.state === "error") throw new Error(`Pod failed: ${pod.errorMessage}`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Timed out waiting for persistent agent pod ${podId}`);
}

/**
 * Execute a turn inside the agent's pod. Each turn isolates its working
 * directory under `/workspace/turns/<turnId>` so multiple turns over time
 * leave a clean per-turn artifact trail.
 */
export async function execTurnInPod(
  pod: PersistentAgentPodHandle,
  turnId: string,
  agentCommand: string[],
  env: Record<string, string>,
): Promise<ExecSession> {
  const rt = getRuntime();
  const handle: ContainerHandle = {
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  };

  const envJson = JSON.stringify({ ...env, OPTIO_PERSISTENT_AGENT_TURN_ID: turnId });
  const envB64 = Buffer.from(envJson).toString("base64");

  const script = [
    "set -e",
    `eval $(echo '${envB64}' | base64 -d | python3 -c "`,
    `import json, sys, shlex`,
    `env = json.load(sys.stdin)`,
    `for k, v in env.items():`,
    `    print(f'export {k}={shlex.quote(v)}')`,
    `")`,
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: pod not ready after 120s"; exit 1; }`,
    `mkdir -p /workspace/turns/${turnId}`,
    `cd /workspace/turns/${turnId}`,
    `export OPTIO_PERSISTENT_AGENT_TURN_ID="${turnId}"`,
    `set +e`,
    ...agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");

  return rt.exec(handle, ["bash", "-c", script], { tty: false });
}

/**
 * Mark the pod as warm for a fixed window after a turn ends. The cleanup
 * worker reaps pods whose `keep_warm_until` is past, except for always-on
 * agents where the field stays null.
 */
export async function markPodIdle(agentId: string): Promise<void> {
  const [agent] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, agentId));
  if (!agent) return;

  const [pod] = await db
    .select()
    .from(persistentAgentPods)
    .where(eq(persistentAgentPods.agentId, agentId))
    .orderBy(desc(persistentAgentPods.updatedAt))
    .limit(1);
  if (!pod) return;

  const lifecycle = agent.podLifecycle as PersistentAgentPodLifecycle;

  if (lifecycle === PersistentAgentPodLifecycle.ALWAYS_ON) {
    // Clear keep_warm_until — the cleanup worker will skip it.
    await db
      .update(persistentAgentPods)
      .set({ keepWarmUntil: null, lastTurnAt: new Date(), updatedAt: new Date() })
      .where(eq(persistentAgentPods.id, pod.id));
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
    .update(persistentAgentPods)
    .set({ keepWarmUntil, lastTurnAt: new Date(), updatedAt: new Date() })
    .where(eq(persistentAgentPods.id, pod.id));
}

export async function reapPod(podId: string): Promise<void> {
  const [pod] = await db
    .select()
    .from(persistentAgentPods)
    .where(eq(persistentAgentPods.id, podId));
  if (!pod) return;
  if (pod.podName) {
    try {
      const rt = getRuntime();
      await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
    } catch (err) {
      logger.warn({ err, podName: pod.podName }, "failed to destroy persistent agent pod");
    }
  }
  await db.delete(persistentAgentPods).where(eq(persistentAgentPods.id, podId));
}

/**
 * Reap pods whose warm window has passed. Always-on pods (keep_warm_until
 * IS NULL on a ready pod that's been touched recently) are kept.
 *
 * Called periodically by the repo-cleanup-worker.
 */
export async function cleanupIdlePersistentAgentPods(): Promise<number> {
  const now = new Date();
  const expired = await db
    .select()
    .from(persistentAgentPods)
    .where(
      and(
        eq(persistentAgentPods.state, "ready"),
        isNotNull(persistentAgentPods.keepWarmUntil),
        lt(persistentAgentPods.keepWarmUntil, now),
      ),
    );

  let reaped = 0;
  for (const pod of expired) {
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

export async function listPodsForAgent(agentId: string) {
  return db
    .select()
    .from(persistentAgentPods)
    .where(eq(persistentAgentPods.agentId, agentId))
    .orderBy(desc(persistentAgentPods.createdAt));
}
