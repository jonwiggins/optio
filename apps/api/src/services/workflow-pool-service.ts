import { eq, and, lt, sql, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowPods, workflowRuns } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession } from "@optio/shared";
import {
  generateWorkflowPodName,
  generateWorkflowJobName,
  parseIntEnv,
  type RepoImageConfig,
} from "@optio/shared";
import { logger } from "../logger.js";
import { resolveImage } from "./repo-pool-service.js";
import { getWorkloadManager, isStatefulSetEnabled } from "./k8s-workload-service.js";

const IDLE_TIMEOUT_MS = parseIntEnv("OPTIO_WORKFLOW_POD_IDLE_MS", 600000); // 10 min default

export interface WorkflowPod {
  id: string;
  workflowId: string;
  instanceIndex: number;
  podName: string | null;
  podId: string | null;
  state: string;
  activeRunCount: number;
  jobName?: string | null;
  managedBy?: string;
  errorMessage?: string | null;
}

export interface GetOrCreateOpts {
  preferredPodId?: string;
  maxAgentsPerPod?: number;
  maxPodInstances?: number;
  imageConfig?: RepoImageConfig;
  workspaceId?: string | null;
  cpuRequest?: string | null;
  cpuLimit?: string | null;
  memoryRequest?: string | null;
  memoryLimit?: string | null;
}

/**
 * Select (or create) a pooled pod for a standalone workflow.
 *
 * Shared with repo pods: runs within a workflow share pods, scaling out to
 * `maxPodInstances` replicas each hosting up to `maxAgentsPerPod` concurrent
 * runs. Selection mirrors repo-pool-service:
 *   1. Same-pod retry affinity (`preferredPodId`)
 *   2. Least-loaded ready pod with capacity
 *   3. Scale up (create another instance) if under `maxPodInstances`
 *   4. Fall back to the least-loaded ready pod (caller concurrency gates above)
 *      or wait for a provisioning pod to come up.
 */
export async function getOrCreateWorkflowPod(
  workflowId: string,
  opts: GetOrCreateOpts = {},
): Promise<WorkflowPod> {
  const maxAgentsPerPod = opts.maxAgentsPerPod ?? 2;
  const maxPodInstances = opts.maxPodInstances ?? 1;
  const rt = getRuntime();

  // 1. Preferred pod (same-pod retry affinity)
  if (opts.preferredPodId) {
    const [preferred] = await db
      .select()
      .from(workflowPods)
      .where(eq(workflowPods.id, opts.preferredPodId));
    if (preferred && preferred.state === "ready" && preferred.podName) {
      try {
        const status = await rt.status({
          id: preferred.podId ?? preferred.podName,
          name: preferred.podName,
        });
        if (status.state === "running" && preferred.activeRunCount < maxAgentsPerPod) {
          return preferred as WorkflowPod;
        }
      } catch {
        // Pod gone — fall through to general selection
      }
    }
  }

  // 2. All pods for this workflow, sorted by least-loaded first
  const existingPods = await db
    .select()
    .from(workflowPods)
    .where(eq(workflowPods.workflowId, workflowId))
    .orderBy(asc(workflowPods.activeRunCount));

  for (const pod of existingPods) {
    if (pod.state === "ready" && pod.podName && pod.activeRunCount < maxAgentsPerPod) {
      try {
        const status = await rt.status({
          id: pod.podId ?? pod.podName,
          name: pod.podName,
        });
        if (status.state === "running") {
          return pod as WorkflowPod;
        }
      } catch {
        // Pod gone
      }
      await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
    } else if (pod.state === "provisioning") {
      return waitForPodReady(pod.id);
    } else if (pod.state === "error") {
      await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
    }
  }

  // 3. At instance limit? Return least-loaded or wait for provisioning.
  const [{ count: currentPodCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowPods)
    .where(eq(workflowPods.workflowId, workflowId));

  if (Number(currentPodCount) >= maxPodInstances) {
    const [busyPod] = await db
      .select()
      .from(workflowPods)
      .where(and(eq(workflowPods.workflowId, workflowId), eq(workflowPods.state, "ready")))
      .orderBy(asc(workflowPods.activeRunCount))
      .limit(1);
    if (busyPod) {
      return busyPod as WorkflowPod;
    }
    const [provisioningPod] = await db
      .select()
      .from(workflowPods)
      .where(and(eq(workflowPods.workflowId, workflowId), eq(workflowPods.state, "provisioning")));
    if (provisioningPod) {
      return waitForPodReady(provisioningPod.id);
    }
    throw new Error(`All ${maxPodInstances} pod instances for workflow ${workflowId} unavailable`);
  }

  // 4. Scale up — next instance index.
  const nextInstanceIndex = await pickNextInstanceIndex(workflowId);
  const createFn = isStatefulSetEnabled() ? createWorkflowPodViaJob : createWorkflowPod;
  try {
    return await createFn(workflowId, nextInstanceIndex, opts);
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.code === "23505") {
      logger.info({ workflowId }, "Concurrent pod creation detected, retrying lookup");
      return getOrCreateWorkflowPod(workflowId, opts);
    }
    throw err;
  }
}

/**
 * Pick the lowest unused instance index for a workflow. When pods are removed
 * after being scaled up, we reuse the gap rather than always incrementing — so
 * that LIFO idle cleanup stays matched with LIFO scale-down semantics.
 */
async function pickNextInstanceIndex(workflowId: string): Promise<number> {
  const rows = await db
    .select({ idx: workflowPods.instanceIndex })
    .from(workflowPods)
    .where(eq(workflowPods.workflowId, workflowId));
  const taken = new Set(rows.map((r) => r.idx));
  let i = 0;
  while (taken.has(i)) i++;
  return i;
}

function buildInitScript(): string {
  return [
    "set -e",
    "mkdir -p /workspace/runs",
    "touch /workspace/.ready",
    "echo '[optio] Workflow pod ready'",
    "exec sleep infinity",
  ].join("\n");
}

export async function createWorkflowPod(
  workflowId: string,
  instanceIndex: number,
  opts: GetOrCreateOpts,
): Promise<WorkflowPod> {
  const [record] = await db
    .insert(workflowPods)
    .values({
      workflowId,
      instanceIndex,
      workspaceId: opts.workspaceId ?? undefined,
      state: "provisioning",
    })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(opts.imageConfig);
  const podName = generateWorkflowPodName(workflowId, instanceIndex);

  let podNameForCleanup: string | undefined;
  try {
    podNameForCleanup = podName;

    const spec: ContainerSpec = {
      name: podName,
      image,
      command: ["bash", "-c", buildInitScript()],
      env: {
        OPTIO_WORKFLOW_ID: workflowId,
        OPTIO_POD_INSTANCE_INDEX: String(instanceIndex),
      },
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      cpuRequest: opts.cpuRequest ?? undefined,
      cpuLimit: opts.cpuLimit ?? undefined,
      memoryRequest: opts.memoryRequest ?? undefined,
      memoryLimit: opts.memoryLimit ?? undefined,
      labels: {
        "optio.workflow-id": workflowId.slice(0, 63),
        "optio.instance-index": String(instanceIndex),
        "optio.type": "workflow-pod",
        "managed-by": "optio",
      },
    };

    const handle = await rt.create(spec);

    await db
      .update(workflowPods)
      .set({
        podName: handle.name,
        podId: handle.id,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(workflowPods.id, record.id));

    logger.info({ workflowId, instanceIndex, podName: handle.name }, "Workflow pod created");

    return {
      ...record,
      podName: handle.name,
      podId: handle.id,
      state: "ready",
    };
  } catch (err) {
    await db
      .update(workflowPods)
      .set({
        state: "error",
        errorMessage: String(err),
        updatedAt: new Date(),
      })
      .where(eq(workflowPods.id, record.id));

    if (podNameForCleanup) {
      try {
        await rt.destroy({ id: podNameForCleanup, name: podNameForCleanup });
        logger.info({ podName: podNameForCleanup }, "Cleaned up failed workflow pod");
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, podName: podNameForCleanup },
          "Failed to cleanup errored workflow pod",
        );
      }
    }

    throw err;
  }
}

/**
 * Create a workflow pod managed by a K8s Job. Used when OPTIO_STATEFULSET_ENABLED=true.
 */
async function createWorkflowPodViaJob(
  workflowId: string,
  instanceIndex: number,
  opts: GetOrCreateOpts,
): Promise<WorkflowPod> {
  const jobName = generateWorkflowJobName(workflowId, instanceIndex);

  const [record] = await db
    .insert(workflowPods)
    .values({
      workflowId,
      instanceIndex,
      workspaceId: opts.workspaceId ?? undefined,
      state: "provisioning",
      jobName,
      managedBy: "job",
    })
    .returning();

  try {
    const image = resolveImage(opts.imageConfig);
    const manager = getWorkloadManager();

    const spec: ContainerSpec = {
      name: jobName,
      image,
      command: ["bash", "-c", buildInitScript()],
      env: {
        OPTIO_WORKFLOW_ID: workflowId,
        OPTIO_POD_INSTANCE_INDEX: String(instanceIndex),
      },
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      cpuRequest: opts.cpuRequest ?? undefined,
      cpuLimit: opts.cpuLimit ?? undefined,
      memoryRequest: opts.memoryRequest ?? undefined,
      memoryLimit: opts.memoryLimit ?? undefined,
      labels: {
        "optio.workflow-id": workflowId.slice(0, 63),
        "optio.instance-index": String(instanceIndex),
        "optio.type": "workflow-pod",
        "managed-by": "optio",
      },
    };

    const result = await manager.createJob({ name: jobName, spec });

    await db
      .update(workflowPods)
      .set({
        podName: result.podName,
        podId: result.podId,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(workflowPods.id, record.id));

    logger.info(
      { workflowId, instanceIndex, podName: result.podName, jobName },
      "Workflow pod created via Job",
    );

    return {
      ...record,
      podName: result.podName,
      podId: result.podId,
      state: "ready",
    };
  } catch (err) {
    await db
      .update(workflowPods)
      .set({
        state: "error",
        errorMessage: String(err),
        updatedAt: new Date(),
      })
      .where(eq(workflowPods.id, record.id));

    try {
      const manager = getWorkloadManager();
      await manager.deleteJob(jobName);
      logger.info({ jobName }, "Cleaned up failed workflow Job");
    } catch (cleanupErr) {
      logger.warn({ err: cleanupErr, jobName }, "Failed to cleanup errored workflow Job");
    }

    throw err;
  }
}

async function waitForPodReady(podId: string, timeoutMs = 120_000): Promise<WorkflowPod> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pod] = await db.select().from(workflowPods).where(eq(workflowPods.id, podId));
    if (!pod) throw new Error(`Workflow pod record ${podId} disappeared`);
    if (pod.state === "ready") return pod as WorkflowPod;
    if (pod.state === "error") throw new Error(`Workflow pod failed: ${pod.errorMessage}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for workflow pod ${podId}`);
}

/**
 * Execute a workflow run inside a pooled workflow pod. Each run isolates its
 * working dir to `/workspace/runs/<runId>` and injects per-run env vars
 * (including `OPTIO_PROMPT`) via the exec stream — nothing about the run is
 * baked into the pod spec. Increments activeRunCount; callers must call
 * `releaseRun(pod.id)` on completion.
 */
export async function execRunInPod(
  pod: WorkflowPod,
  runId: string,
  agentCommand: string[],
  env: Record<string, string>,
): Promise<ExecSession> {
  const rt = getRuntime();
  const handle: ContainerHandle = { id: pod.podId ?? pod.podName!, name: pod.podName! };

  await db
    .update(workflowPods)
    .set({
      activeRunCount: sql`${workflowPods.activeRunCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowPods.id, pod.id));

  const envJson = JSON.stringify({ ...env, OPTIO_WORKFLOW_RUN_ID: runId });
  const envB64 = Buffer.from(envJson).toString("base64");

  const script = [
    "set -e",
    `eval $(echo '${envB64}' | base64 -d | python3 -c "`,
    `import json, sys, shlex`,
    `env = json.load(sys.stdin)`,
    `for k, v in env.items():`,
    `    print(f'export {k}={shlex.quote(v)}')`,
    `")`,
    `echo "[optio] Waiting for workflow pod to be ready..."`,
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: workflow pod not ready after 120s"; exit 1; }`,
    `echo "[optio] Workflow pod ready"`,
    `mkdir -p /workspace/runs/${runId}`,
    `cd /workspace/runs/${runId}`,
    `export OPTIO_WORKFLOW_RUN_ID="${runId}"`,
    `set +e`,
    ...agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");

  return rt.exec(handle, ["bash", "-c", script], { tty: false });
}

/**
 * Decrement the active run count for a workflow pod. Clamped at zero so a
 * double-release (e.g. zombie cleanup + worker finally) can't drive it negative.
 */
export async function releaseRun(podId: string): Promise<void> {
  await db
    .update(workflowPods)
    .set({
      activeRunCount: sql`GREATEST(${workflowPods.activeRunCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(workflowPods.id, podId));
}

/**
 * Reap idle workflow pods: those in state=ready with activeRunCount=0 and no
 * update within IDLE_TIMEOUT_MS. Scales down higher-index pods first so the
 * pool contracts LIFO — matching repo-pool semantics.
 */
export async function cleanupIdleWorkflowPods(): Promise<number> {
  const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);

  const idlePods = await db
    .select()
    .from(workflowPods)
    .where(
      and(
        eq(workflowPods.activeRunCount, 0),
        eq(workflowPods.state, "ready"),
        lt(workflowPods.updatedAt, cutoff),
      ),
    );

  const rt = getRuntime();
  let cleaned = 0;

  // Group by workflow so we can reap higher instance indices first.
  const byWorkflow = new Map<string, typeof idlePods>();
  for (const pod of idlePods) {
    const existing = byWorkflow.get(pod.workflowId) ?? [];
    existing.push(pod);
    byWorkflow.set(pod.workflowId, existing);
  }

  for (const [, pods] of byWorkflow) {
    const sorted = [...pods].sort((a, b) => b.instanceIndex - a.instanceIndex);
    for (const pod of sorted) {
      try {
        if (pod.managedBy === "job" && pod.jobName) {
          const manager = getWorkloadManager();
          await manager.deleteJob(pod.jobName);
        } else if (pod.podName) {
          await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
        }
        await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
        logger.info(
          {
            workflowId: pod.workflowId,
            instanceIndex: pod.instanceIndex,
            podName: pod.podName,
            managedBy: pod.managedBy,
          },
          "Cleaned up idle workflow pod",
        );
        cleaned++;
      } catch (err) {
        logger.warn({ err, podId: pod.id }, "Failed to cleanup workflow pod");
      }
    }
  }

  return cleaned;
}

/**
 * List all workflow pods.
 */
export async function listWorkflowPods(): Promise<WorkflowPod[]> {
  return db.select().from(workflowPods) as Promise<WorkflowPod[]>;
}

/**
 * List workflow pods for a specific workflow.
 */
export async function listWorkflowPodsForWorkflow(workflowId: string): Promise<WorkflowPod[]> {
  return db.select().from(workflowPods).where(eq(workflowPods.workflowId, workflowId)) as Promise<
    WorkflowPod[]
  >;
}

/**
 * Reconcile activeRunCount on all workflow pods to the actual number of runs
 * in running/provisioning state that hold a pod_id. Compensates for drift when
 * the worker crashes between decrement and DB update. Mirrors
 * repo-pool-service.reconcileActiveTaskCounts.
 */
export async function reconcileActiveRunCounts(): Promise<number> {
  const allPods = await db
    .select({ id: workflowPods.id, activeRunCount: workflowPods.activeRunCount })
    .from(workflowPods);
  if (allPods.length === 0) return 0;

  let corrected = 0;
  for (const pod of allPods) {
    const [{ count: actual }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(
        sql`${workflowRuns.state} IN ('running', 'provisioning') AND ${workflowRuns.podId} = ${pod.id}`,
      );

    if (pod.activeRunCount !== actual) {
      await db
        .update(workflowPods)
        .set({ activeRunCount: actual, updatedAt: new Date() })
        .where(eq(workflowPods.id, pod.id));
      logger.info(
        { podId: pod.id, was: pod.activeRunCount, now: actual },
        "Reconciled workflow pod activeRunCount",
      );
      corrected++;
    }
  }

  return corrected;
}
