/**
 * Pods for Jobs (standalone runs): runs of one Job share pods, scaling out to
 * the Job's `maxPodInstances` replicas each hosting up to `maxAgentsPerPod`
 * concurrent runs. Rows live in `agent_pods` (pool "standalone", keyed by the
 * Job's id); picking, slots, and count repair are agent-pod-pool's.
 */
import { and, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerSpec, ExecSession } from "@optio/shared";
import {
  generateWorkflowPodName,
  generateWorkflowJobName,
  parseIntEnv,
  type RepoImageConfig,
} from "@optio/shared";
import { logger } from "../logger.js";
import { resolveImage } from "./repo-pool-service.js";
import { getWorkloadManager, isStatefulSetEnabled } from "./k8s-workload-service.js";
import * as podPool from "./agent-pod-pool.js";
import { buildPooledExecScript } from "../utils/pod-env.js";

const IDLE_TIMEOUT_MS = parseIntEnv("OPTIO_WORKFLOW_POD_IDLE_MS", 600000); // 10 min default

export type WorkflowPod = podPool.AgentPod;

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

/** Pick (or create) a pod for a run of `workflowId` — see agent-pod-pool's pickPod. */
export async function getOrCreateWorkflowPod(
  workflowId: string,
  opts: GetOrCreateOpts = {},
): Promise<WorkflowPod> {
  return podPool.pickPod("standalone", workflowId, {
    preferredPodId: opts.preferredPodId,
    maxAgentsPerPod: opts.maxAgentsPerPod ?? 2,
    maxPodInstances: opts.maxPodInstances ?? 1,
    create: (instanceIndex) =>
      isStatefulSetEnabled()
        ? createWorkflowPodViaJob(workflowId, instanceIndex, opts)
        : createWorkflowPod(workflowId, instanceIndex, opts),
  });
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

function podSpec(
  name: string,
  workflowId: string,
  instanceIndex: number,
  opts: GetOrCreateOpts,
): ContainerSpec {
  return {
    name,
    image: resolveImage(opts.imageConfig),
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
}

export async function createWorkflowPod(
  workflowId: string,
  instanceIndex: number,
  opts: GetOrCreateOpts,
): Promise<WorkflowPod> {
  const record = await podPool.insertPod({
    pool: "standalone",
    poolKey: workflowId,
    instanceIndex,
    workspaceId: opts.workspaceId ?? undefined,
  });

  const rt = getRuntime();
  const podName = generateWorkflowPodName(workflowId, instanceIndex);
  try {
    const handle = await rt.create(podSpec(podName, workflowId, instanceIndex, opts));
    const ready = await podPool.markPodReady(record.id, { podName: handle.name, podId: handle.id });
    logger.info({ workflowId, instanceIndex, podName: handle.name }, "Workflow pod created");
    return ready;
  } catch (err) {
    await podPool.markPodError(record.id, err);
    try {
      await rt.destroy({ id: podName, name: podName });
      logger.info({ podName }, "Cleaned up failed workflow pod");
    } catch (cleanupErr) {
      logger.warn({ err: cleanupErr, podName }, "Failed to cleanup errored workflow pod");
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
  const record = await podPool.insertPod({
    pool: "standalone",
    poolKey: workflowId,
    instanceIndex,
    workspaceId: opts.workspaceId ?? undefined,
    jobName,
    managedBy: "job",
  });

  try {
    const result = await getWorkloadManager().createJob({
      name: jobName,
      spec: podSpec(jobName, workflowId, instanceIndex, opts),
    });
    const ready = await podPool.markPodReady(record.id, {
      podName: result.podName,
      podId: result.podId,
    });
    logger.info(
      { workflowId, instanceIndex, podName: result.podName, jobName },
      "Workflow pod created via Job",
    );
    return ready;
  } catch (err) {
    await podPool.markPodError(record.id, err);
    try {
      await getWorkloadManager().deleteJob(jobName);
      logger.info({ jobName }, "Cleaned up failed workflow Job");
    } catch (cleanupErr) {
      logger.warn({ err: cleanupErr, jobName }, "Failed to cleanup errored workflow Job");
    }
    throw err;
  }
}

/**
 * Execute a workflow run inside a pooled workflow pod. Each run isolates its
 * working dir to `/workspace/runs/<runId>` and injects per-run env vars
 * (including `OPTIO_PROMPT`) via the exec stream — nothing about the run is
 * baked into the pod spec. Takes a slot; callers must call
 * `releaseRun(pod.id)` on completion.
 */
export async function execRunInPod(
  pod: WorkflowPod,
  runId: string,
  agentCommand: string[],
  env: Record<string, string>,
): Promise<ExecSession> {
  await podPool.acquireSlot(pod.id);
  const script = buildPooledExecScript({
    env: { ...env, OPTIO_WORKFLOW_RUN_ID: runId },
    workDir: `/workspace/runs/${runId}`,
    agentCommand,
    label: "workflow pod",
  });
  return getRuntime().exec(podPool.podHandle(pod), ["bash", "-c", script], { tty: false });
}

/** A run on the pod ended: free its slot. */
export async function releaseRun(podId: string): Promise<void> {
  await podPool.releaseSlot(podId);
}

/**
 * Reap idle workflow pods: ready, nothing running, and no use within
 * IDLE_TIMEOUT_MS. Higher instance indices go first so the pool contracts
 * LIFO, matching repo pods.
 */
export async function cleanupIdleWorkflowPods(): Promise<number> {
  const idle = await podPool.idlePods("standalone", new Date(Date.now() - IDLE_TIMEOUT_MS));
  const rt = getRuntime();
  let cleaned = 0;

  for (const pod of [...idle].sort((a, b) => b.instanceIndex - a.instanceIndex)) {
    try {
      if (pod.managedBy === "job" && pod.jobName) {
        await getWorkloadManager().deleteJob(pod.jobName);
      } else if (pod.podName) {
        await rt.destroy(podPool.podHandle(pod));
      }
      await podPool.deletePod(pod.id);
      logger.info(
        {
          workflowId: pod.poolKey,
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

  return cleaned;
}

/** Every Job pod. */
export async function listWorkflowPods(): Promise<WorkflowPod[]> {
  return podPool.listPods("standalone");
}

/** One Job's pods. */
export async function listWorkflowPodsForWorkflow(workflowId: string): Promise<WorkflowPod[]> {
  return podPool.listPods("standalone", workflowId);
}

/**
 * Repair each Job pod's active count from the runs actually holding it
 * (running / provisioning with this pod_id). Mirrors
 * repo-pool-service.reconcileActiveTaskCounts.
 */
export async function reconcileActiveRunCounts(): Promise<number> {
  const rows = await db
    .select({ podId: workflowRuns.podId, n: sql<number>`count(*)::int` })
    .from(workflowRuns)
    .where(
      and(
        inArray(workflowRuns.state, ["running", "provisioning"]),
        sql`${workflowRuns.podId} IS NOT NULL`,
      ),
    )
    .groupBy(workflowRuns.podId);
  return podPool.reconcileActiveCounts(
    "standalone",
    new Map(rows.map((r) => [r.podId as string, r.n])),
  );
}
