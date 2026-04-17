import { eq, and, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowPods } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession } from "@optio/shared";
import {
  DEFAULT_AGENT_IMAGE,
  generateWorkflowPodName,
  generateWorkflowJobName,
} from "@optio/shared";
import { logger } from "../logger.js";
import { resolveImage } from "./repo-pool-service.js";
import { getWorkloadManager, isStatefulSetEnabled } from "./k8s-workload-service.js";
import type { RepoImageConfig } from "@optio/shared";
import { parseIntEnv } from "@optio/shared";

const IDLE_TIMEOUT_MS = parseIntEnv("OPTIO_WORKFLOW_POD_IDLE_MS", 600000); // 10 min default

export interface WorkflowPod {
  id: string;
  workflowRunId: string;
  podName: string | null;
  podId: string | null;
  state: string;
  activeRunCount: number;
}

/**
 * Select (or create) a workflow pod for the given workflow run.
 *
 * Workflow pods differ from repo pods: they don't clone a git repo.
 * The pod runs a setup script and then sleeps, waiting for exec commands.
 */
export async function getOrCreateWorkflowPod(
  workflowRunId: string,
  env: Record<string, string>,
  opts?: {
    imageConfig?: RepoImageConfig;
    workspaceId?: string | null;
    cpuRequest?: string | null;
    cpuLimit?: string | null;
    memoryRequest?: string | null;
    memoryLimit?: string | null;
  },
): Promise<WorkflowPod> {
  // Check for existing pods for this workflow run
  const existingPods = await db
    .select()
    .from(workflowPods)
    .where(eq(workflowPods.workflowRunId, workflowRunId));

  const rt = getRuntime();
  for (const pod of existingPods) {
    if (pod.state === "ready" && pod.podName) {
      try {
        const status = await rt.status({
          id: pod.podId ?? pod.podName,
          name: pod.podName,
        });
        if (status.state === "running") {
          return pod as WorkflowPod;
        }
      } catch {
        // Pod is gone, clean up record
      }
      await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
    } else if (pod.state === "provisioning") {
      return waitForPodReady(pod.id);
    } else if (pod.state === "error") {
      await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
    }
  }

  // Create new pod
  const createFn = isStatefulSetEnabled() ? createWorkflowPodViaJob : createWorkflowPod;
  try {
    return await createFn(workflowRunId, env, opts);
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.code === "23505") {
      logger.info({ workflowRunId }, "Concurrent pod creation detected, retrying lookup");
      return getOrCreateWorkflowPod(workflowRunId, env, opts);
    }
    throw err;
  }
}

/**
 * Create a new workflow pod.
 *
 * Unlike repo pods, workflow pods don't clone a git repo. They run a setup
 * script that touches a ready marker and then sleeps, waiting for exec commands.
 */
export async function createWorkflowPod(
  workflowRunId: string,
  env: Record<string, string>,
  opts?: {
    imageConfig?: RepoImageConfig;
    workspaceId?: string | null;
    cpuRequest?: string | null;
    cpuLimit?: string | null;
    memoryRequest?: string | null;
    memoryLimit?: string | null;
  },
): Promise<WorkflowPod> {
  const [record] = await db
    .insert(workflowPods)
    .values({
      workflowRunId,
      workspaceId: opts?.workspaceId ?? undefined,
      state: "provisioning",
    })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(opts?.imageConfig);
  const podName = generateWorkflowPodName(workflowRunId);

  let podNameForCleanup: string | undefined;
  try {
    podNameForCleanup = podName;

    // Workflow pods use a simple init script: create workspace, mark ready, sleep.
    // No git clone needed — workflow steps exec into the pod directly.
    const initScript = [
      "set -e",
      "mkdir -p /workspace/runs",
      "touch /workspace/.ready",
      "echo '[optio] Workflow pod ready'",
      "exec sleep infinity",
    ].join("\n");

    const spec: ContainerSpec = {
      name: podName,
      image,
      command: ["bash", "-c", initScript],
      env: {
        ...env,
        OPTIO_WORKFLOW_RUN_ID: workflowRunId,
      },
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      cpuRequest: opts?.cpuRequest ?? undefined,
      cpuLimit: opts?.cpuLimit ?? undefined,
      memoryRequest: opts?.memoryRequest ?? undefined,
      memoryLimit: opts?.memoryLimit ?? undefined,
      labels: {
        "optio.workflow-run-id": workflowRunId.slice(0, 63),
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

    logger.info({ workflowRunId, podName: handle.name }, "Workflow pod created");

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

    // Clean up the K8s pod if it was created
    if (podNameForCleanup) {
      try {
        const rtForCleanup = getRuntime();
        await rtForCleanup.destroy({ id: podNameForCleanup, name: podNameForCleanup });
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
  workflowRunId: string,
  env: Record<string, string>,
  opts?: {
    imageConfig?: RepoImageConfig;
    workspaceId?: string | null;
    cpuRequest?: string | null;
    cpuLimit?: string | null;
    memoryRequest?: string | null;
    memoryLimit?: string | null;
  },
): Promise<WorkflowPod> {
  const jobName = generateWorkflowJobName(workflowRunId);

  const [record] = await db
    .insert(workflowPods)
    .values({
      workflowRunId,
      workspaceId: opts?.workspaceId ?? undefined,
      state: "provisioning",
      jobName,
      managedBy: "job",
    })
    .returning();

  try {
    const image = resolveImage(opts?.imageConfig);
    const manager = getWorkloadManager();

    const initScript = [
      "set -e",
      "mkdir -p /workspace/runs",
      "touch /workspace/.ready",
      "echo '[optio] Workflow pod ready'",
      "exec sleep infinity",
    ].join("\n");

    const spec: ContainerSpec = {
      name: jobName,
      image,
      command: ["bash", "-c", initScript],
      env: {
        ...env,
        OPTIO_WORKFLOW_RUN_ID: workflowRunId,
      },
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      cpuRequest: opts?.cpuRequest ?? undefined,
      cpuLimit: opts?.cpuLimit ?? undefined,
      memoryRequest: opts?.memoryRequest ?? undefined,
      memoryLimit: opts?.memoryLimit ?? undefined,
      labels: {
        "optio.workflow-run-id": workflowRunId.slice(0, 63),
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
      { workflowRunId, podName: result.podName, jobName },
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

    // Clean up the Job if it was created
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
 * Execute a workflow step/run inside a workflow pod.
 * Returns an ExecSession for streaming output.
 */
export async function execRunInPod(
  pod: WorkflowPod,
  stepId: string,
  agentCommand: string[],
  env: Record<string, string>,
): Promise<ExecSession> {
  const rt = getRuntime();
  const handle: ContainerHandle = { id: pod.podId ?? pod.podName!, name: pod.podName! };

  // Increment active run count
  await db
    .update(workflowPods)
    .set({
      activeRunCount: sql`${workflowPods.activeRunCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workflowPods.id, pod.id));

  // Build the exec command — simpler than repo pods (no git worktree setup)
  const envJson = JSON.stringify({ ...env, OPTIO_STEP_ID: stepId });
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
    `mkdir -p /workspace/runs/${stepId}`,
    `cd /workspace/runs/${stepId}`,
    `export OPTIO_STEP_ID="${stepId}"`,
    `set +e`,
    ...agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");

  return rt.exec(handle, ["bash", "-c", script], { tty: false });
}

/**
 * Decrement the active run count for a workflow pod.
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
 * Clean up idle workflow pods that have no active runs.
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

  for (const pod of idlePods) {
    try {
      if (pod.managedBy === "job" && pod.jobName) {
        // Job-managed: delete the Job (cascades to pod)
        const manager = getWorkloadManager();
        await manager.deleteJob(pod.jobName);
      } else if (pod.podName) {
        // Bare pod: delete directly
        await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
      }
      await db.delete(workflowPods).where(eq(workflowPods.id, pod.id));
      logger.info(
        { workflowRunId: pod.workflowRunId, podName: pod.podName, managedBy: pod.managedBy },
        "Cleaned up idle workflow pod",
      );
      cleaned++;
    } catch (err) {
      logger.warn({ err, podId: pod.id }, "Failed to cleanup workflow pod");
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
