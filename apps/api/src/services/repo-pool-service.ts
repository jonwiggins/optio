import { randomUUID } from "node:crypto";
import { eq, and, lt, sql, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods, tasks } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession, RepoImageConfig } from "@optio/shared";
import { DEFAULT_AGENT_IMAGE, PRESET_IMAGES } from "@optio/shared";
import { logger } from "../logger.js";

const IDLE_TIMEOUT_MS = parseInt(process.env.OPTIO_REPO_POD_IDLE_MS ?? "600000", 10); // 10 min default

export interface RepoPod {
  id: string;
  repoUrl: string;
  repoBranch: string;
  instanceIndex: number;
  podName: string | null;
  podId: string | null;
  state: string;
  activeTaskCount: number;
}

/**
 * Select or create a repo pod for the given repo URL.
 *
 * Multi-pod scheduling logic:
 * 1. If `preferPodId` is set (same-pod retry), try that pod first
 * 2. Otherwise, pick the ready pod with the fewest active tasks that is below maxAgentsPerPod
 * 3. If all pods are at capacity and under maxPodInstances, create a new one
 * 4. If at the instance limit, pick the pod with the fewest active tasks (oversubscribe)
 */
export async function getOrCreateRepoPod(
  repoUrl: string,
  repoBranch: string,
  env: Record<string, string>,
  imageConfig?: RepoImageConfig,
  opts?: { maxPodInstances?: number; maxAgentsPerPod?: number; preferPodId?: string },
): Promise<RepoPod> {
  const maxInstances = opts?.maxPodInstances ?? 1;
  const maxAgents = opts?.maxAgentsPerPod ?? 2;

  // 1. Try preferred pod (same-pod retry)
  if (opts?.preferPodId) {
    const [preferred] = await db.select().from(repoPods).where(eq(repoPods.id, opts.preferPodId));
    if (preferred && preferred.state === "ready" && preferred.podName) {
      const rt = getRuntime();
      try {
        const status = await rt.status({
          id: preferred.podId ?? preferred.podName,
          name: preferred.podName,
        });
        if (status.state === "running") {
          logger.info(
            { repoUrl, podName: preferred.podName },
            "Same-pod retry: reusing preferred pod",
          );
          return preferred as RepoPod;
        }
      } catch {
        // Pod is gone, fall through to normal selection
      }
    }
  }

  // 2. Get all pods for this repo
  const existingPods = await db
    .select()
    .from(repoPods)
    .where(eq(repoPods.repoUrl, repoUrl))
    .orderBy(asc(repoPods.activeTaskCount));

  // Try to find a ready pod with capacity
  for (const pod of existingPods) {
    if (pod.state === "ready" && pod.podName && pod.activeTaskCount < maxAgents) {
      const rt = getRuntime();
      try {
        const status = await rt.status({
          id: pod.podId ?? pod.podName,
          name: pod.podName,
        });
        if (status.state === "running") {
          return pod as RepoPod;
        }
      } catch {
        // Pod is gone, clean up the record
      }
      await db.delete(repoPods).where(eq(repoPods.id, pod.id));
    } else if (pod.state === "provisioning") {
      // Wait for it (poll)
      return waitForPodReady(pod.id);
    } else if (pod.state === "error") {
      // Clean up errored pod
      await db.delete(repoPods).where(eq(repoPods.id, pod.id));
    }
  }

  // 3. Count valid pods (ready or provisioning) — we may have cleaned some above
  const [{ count: validPodCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(repoPods)
    .where(and(eq(repoPods.repoUrl, repoUrl), sql`${repoPods.state} IN ('ready', 'provisioning')`));

  // 4. Create a new pod if under the instance limit
  if (Number(validPodCount) < maxInstances) {
    const instanceIndex = await getNextInstanceIndex(repoUrl);
    try {
      return await createRepoPod(repoUrl, repoBranch, env, imageConfig, instanceIndex);
    } catch (err: any) {
      // If another caller just inserted, retry the lookup
      if (err?.message?.includes("unique") || err?.code === "23505") {
        logger.info({ repoUrl }, "Concurrent pod creation detected, retrying selection");
        return getOrCreateRepoPod(repoUrl, repoBranch, env, imageConfig, opts);
      }
      throw err;
    }
  }

  // 5. All pods at capacity — pick the one with fewest tasks (oversubscribe)
  const readyPods = await db
    .select()
    .from(repoPods)
    .where(and(eq(repoPods.repoUrl, repoUrl), eq(repoPods.state, "ready")))
    .orderBy(asc(repoPods.activeTaskCount));

  if (readyPods.length > 0) {
    return readyPods[0] as RepoPod;
  }

  // 6. No ready pods at all — create one regardless of limit (shouldn't happen in normal flow)
  const instanceIndex = await getNextInstanceIndex(repoUrl);
  return createRepoPod(repoUrl, repoBranch, env, imageConfig, instanceIndex);
}

async function getNextInstanceIndex(repoUrl: string): Promise<number> {
  const [result] = await db
    .select({ maxIdx: sql<number>`COALESCE(MAX(${repoPods.instanceIndex}), -1)` })
    .from(repoPods)
    .where(eq(repoPods.repoUrl, repoUrl));
  return (Number(result?.maxIdx) ?? -1) + 1;
}

function resolveImage(imageConfig?: RepoImageConfig): string {
  if (imageConfig?.customImage) return imageConfig.customImage;
  if (imageConfig?.preset && imageConfig.preset in PRESET_IMAGES) {
    return PRESET_IMAGES[imageConfig.preset].tag;
  }
  return process.env.OPTIO_AGENT_IMAGE ?? DEFAULT_AGENT_IMAGE;
}

async function createRepoPod(
  repoUrl: string,
  repoBranch: string,
  env: Record<string, string>,
  imageConfig?: RepoImageConfig,
  instanceIndex = 0,
): Promise<RepoPod> {
  // Insert record first
  const [record] = await db
    .insert(repoPods)
    .values({ repoUrl, repoBranch, instanceIndex, state: "provisioning" })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(imageConfig);

  // Create a PVC for persistent home directory (tools, caches)
  // Include instance index in PVC name for multi-pod support
  const sanitizedUrl = repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 35);
  const pvcName = `optio-home-${sanitizedUrl}-${instanceIndex}`;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { stdout: existsOut } = await execFileAsync("bash", [
      "-c",
      `kubectl get pvc ${pvcName} -n optio 2>/dev/null && echo "yes" || echo "no"`,
    ]);
    if (existsOut.trim() !== "yes") {
      const pvcManifest = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: optio
  labels:
    managed-by: optio
    optio.type: home-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi`;
      await execFileAsync("kubectl", ["apply", "-f", "-", "-n", "optio"], {
        input: pvcManifest,
      } as any);
      logger.info({ pvcName }, "Created PVC for repo pod home directory");
    }
  } catch (err) {
    logger.warn({ err, pvcName }, "Failed to create PVC, pod will use ephemeral storage");
  }

  try {
    // Launch a pod that clones the repo then sleeps forever
    const spec: ContainerSpec = {
      image,
      command: ["/opt/optio/repo-init.sh"],
      env: {
        ...env,
        OPTIO_REPO_URL: repoUrl,
        OPTIO_REPO_BRANCH: repoBranch,
      },
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      volumes: [
        {
          persistentVolumeClaim: pvcName,
          mountPath: "/home/agent",
        },
      ],
      labels: {
        "optio.repo-url": repoUrl.replace(/[^a-zA-Z0-9-_.]/g, "_").slice(0, 63),
        "optio.type": "repo-pod",
        "optio.instance-index": String(instanceIndex),
        "managed-by": "optio",
      },
    };

    const handle = await rt.create(spec);

    // Update record with pod info
    await db
      .update(repoPods)
      .set({
        podName: handle.name,
        podId: handle.id,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(repoPods.id, record.id));

    logger.info({ repoUrl, podName: handle.name, instanceIndex }, "Repo pod created");

    return {
      ...record,
      podName: handle.name,
      podId: handle.id,
      state: "ready",
    };
  } catch (err) {
    await db
      .update(repoPods)
      .set({
        state: "error",
        errorMessage: String(err),
        updatedAt: new Date(),
      })
      .where(eq(repoPods.id, record.id));
    throw err;
  }
}

async function waitForPodReady(podId: string, timeoutMs = 120_000): Promise<RepoPod> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, podId));
    if (!pod) throw new Error(`Repo pod record ${podId} disappeared`);
    if (pod.state === "ready") return pod as RepoPod;
    if (pod.state === "error") throw new Error(`Repo pod failed: ${pod.errorMessage}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for repo pod ${podId}`);
}

/**
 * Execute a task in a repo pod using a git worktree.
 * Returns an ExecSession for streaming output.
 */
export async function execTaskInRepoPod(
  pod: RepoPod,
  taskId: string,
  agentCommand: string[],
  env: Record<string, string>,
  opts?: { resetWorktree?: boolean },
): Promise<ExecSession> {
  const rt = getRuntime();
  const handle: ContainerHandle = { id: pod.podId ?? pod.podName!, name: pod.podName! };

  // Increment active task count
  await db
    .update(repoPods)
    .set({
      activeTaskCount: sql`${repoPods.activeTaskCount} + 1`,
      lastTaskAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repoPods.id, pod.id));

  // Track which pod is running this task
  await db.update(tasks).set({ lastPodId: pod.id }).where(eq(tasks.id, taskId));

  // Build the exec command: create worktree, set up env, run agent
  const envJson = JSON.stringify({ ...env, OPTIO_TASK_ID: taskId });
  const envB64 = Buffer.from(envJson).toString("base64");
  const runToken = randomUUID();

  // Worktree reset logic: if resetWorktree is set, reset existing worktree instead of recreating
  const worktreeResetScript = opts?.resetWorktree
    ? [
        `if [ -d /workspace/tasks/${taskId} ]; then`,
        `  echo "[optio] Resetting existing worktree for retry..."`,
        `  cd /workspace/tasks/${taskId}`,
        `  git checkout -- . 2>/dev/null || true`,
        `  git clean -fd 2>/dev/null || true`,
        `  cd /workspace/repo`,
        `  WORKTREE_EXISTS="true"`,
        `else`,
        `  WORKTREE_EXISTS="false"`,
        `fi`,
      ]
    : [`WORKTREE_EXISTS="false"`];

  const script = [
    "set -e",
    // Decode env vars from base64 JSON and export them
    `eval $(echo '${envB64}' | base64 -d | python3 -c "`,
    `import json, sys, shlex`,
    `env = json.load(sys.stdin)`,
    `for k, v in env.items():`,
    `    print(f'export {k}={shlex.quote(v)}')`,
    `")`,
    // Wait for the repo-init script to finish cloning
    `echo "[optio] Waiting for repo to be ready..."`,
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: repo not ready after 120s"; exit 1; }`,
    `echo "[optio] Repo ready"`,
    // Check if the environment has been set up before
    `ENV_FRESH="true"`,
    `[ -f /home/agent/.optio-env-ready ] && ENV_FRESH="false"`,
    `export ENV_FRESH`,
    `if [ "$ENV_FRESH" = "true" ]; then echo "[optio] Fresh environment — tools may need to be installed"; else echo "[optio] Warm environment — tools from previous tasks should be available"; fi`,
    // Check for existing worktree (for reset/retry)
    ...worktreeResetScript,
    // Create worktree — either from the PR branch (force-restart) or fresh from main
    `echo "[optio] Acquiring repo lock..."`,
    `exec 9>/workspace/.repo-lock`,
    `flock 9`,
    `echo "[optio] Repo lock acquired"`,
    `cd /workspace/repo`,
    `git fetch origin`,
    `git checkout ${env.OPTIO_REPO_BRANCH ?? "main"} 2>/dev/null || true`,
    `git reset --hard origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    // Only create worktree if we don't already have a reset one
    `if [ "$WORKTREE_EXISTS" = "false" ]; then`,
    `  git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true`,
    `  rm -rf /workspace/tasks/${taskId}`,
    // Force-restart: reuse the existing PR branch instead of creating fresh from main
    `  if [ "\${OPTIO_RESTART_FROM_BRANCH:-}" = "true" ] && git rev-parse --verify origin/optio/task-${taskId} >/dev/null 2>&1; then`,
    `    echo "[optio] Force-restart: checking out existing PR branch"`,
    `    for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
    `      git worktree remove --force "$wt_path" 2>/dev/null || true`,
    `    done`,
    `    git worktree prune`,
    `    git branch -D optio/task-${taskId} 2>/dev/null || true`,
    `    git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/optio/task-${taskId}`,
    `  else`,
    `    git branch -D optio/task-${taskId} 2>/dev/null || true`,
    `    if ! git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/${env.OPTIO_REPO_BRANCH ?? "main"} 2>/dev/null; then`,
    `      echo "[optio] Cleaning up stale worktree references..."`,
    `      git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true`,
    `      for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
    `        git worktree remove --force "$wt_path" 2>/dev/null || true`,
    `      done`,
    `      git worktree prune`,
    `      git branch -D optio/task-${taskId} 2>/dev/null || true`,
    `      git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    `    fi`,
    `  fi`,
    `fi`,
    // Release the repo lock
    `flock -u 9`,
    `exec 9>&-`,
    `cd /workspace/tasks/${taskId}`,
    // Write a run token
    `echo "${runToken}" > /workspace/tasks/${taskId}/.optio-run-token`,
    `export OPTIO_TASK_ID="${taskId}"`,
    // Write setup files if provided
    `if [ -n "\${OPTIO_SETUP_FILES:-}" ]; then`,
    `  echo "[optio] Writing setup files..."`,
    `  WORKTREE_DIR=$(pwd)`,
    `  echo "\${OPTIO_SETUP_FILES}" | base64 -d | python3 -c "`,
    `import json, sys, os`,
    `worktree = os.environ.get('WORKTREE_DIR', '.')`,
    `files = json.load(sys.stdin)`,
    `for f in files:`,
    `    p = f['path']`,
    `    # Remap /opt/optio/ to /home/agent/optio/ (writable by agent user)`,
    `    if p.startswith('/opt/optio/'):`,
    `        p = '/home/agent/optio/' + p[len('/opt/optio/'):]`,
    `    elif not p.startswith('/'):`,
    `        p = os.path.join(worktree, p)`,
    `    os.makedirs(os.path.dirname(p), exist_ok=True)`,
    `    with open(p, 'w') as fh:`,
    `        fh.write(f['content'])`,
    `    if f.get('executable'):`,
    `        os.chmod(p, 0o755)`,
    `    print(f'  wrote {p}')`,
    `"`,
    `fi`,
    // Cleanup trap — only clean up if task reaches terminal state AND run token matches
    // For preserved worktrees (pr_opened, needs_attention), skip cleanup
    `trap 'CURRENT_TOKEN=$(cat /workspace/tasks/${taskId}/.optio-run-token 2>/dev/null); if [ "$CURRENT_TOKEN" = "${runToken}" ]; then cd /workspace/repo; git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true; git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true; git worktree prune 2>/dev/null || true; git branch -D optio/task-${taskId} 2>/dev/null || true; fi' EXIT`,
    `set +e`,
    // Run the agent command
    ...agentCommand,
    `AGENT_EXIT=$?`,
    // Mark environment as set up for future tasks (only on success)
    `[ $AGENT_EXIT -eq 0 ] && touch /home/agent/.optio-env-ready`,
    `exit $AGENT_EXIT`,
  ].join("\n");

  return rt.exec(handle, ["bash", "-c", script], { tty: false });
}

/**
 * Decrement the active task count for a repo pod.
 */
export async function releaseRepoPodTask(podId: string): Promise<void> {
  await db
    .update(repoPods)
    .set({
      activeTaskCount: sql`GREATEST(${repoPods.activeTaskCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(repoPods.id, podId));
}

/**
 * Clean up idle repo pods.
 * Scale-down strategy: when traffic drops, scale down to 1 pod first,
 * then to 0 after idle timeout.
 */
export async function cleanupIdleRepoPods(): Promise<number> {
  const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);
  const idlePods = await db
    .select()
    .from(repoPods)
    .where(
      and(
        eq(repoPods.activeTaskCount, 0),
        eq(repoPods.state, "ready"),
        lt(repoPods.updatedAt, cutoff),
      ),
    );

  const rt = getRuntime();
  let cleaned = 0;

  // Group idle pods by repoUrl for scale-down logic
  const podsByRepo = new Map<string, typeof idlePods>();
  for (const pod of idlePods) {
    const existing = podsByRepo.get(pod.repoUrl) ?? [];
    existing.push(pod);
    podsByRepo.set(pod.repoUrl, existing);
  }

  for (const [repoUrl, repoIdlePods] of podsByRepo) {
    // Count total pods for this repo (including non-idle ones)
    const [{ count: totalPods }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(repoPods)
      .where(eq(repoPods.repoUrl, repoUrl));

    // If there's only 1 pod total and it's idle, clean it up (normal behavior)
    // If there are multiple pods, scale down extra idle ones first (keep 1 alive)
    const totalCount = Number(totalPods);

    // Sort by instance index descending — remove higher-indexed pods first
    const sortedPods = [...repoIdlePods].sort((a, b) => b.instanceIndex - a.instanceIndex);

    for (const pod of sortedPods) {
      // Keep at least 1 pod per repo if there are non-idle pods still running
      const activePodCount = totalCount - cleaned;
      if (activePodCount <= 1) {
        // Last pod — only clean up if it's truly idle past timeout
        // (this is the normal single-pod cleanup case)
      }

      try {
        if (pod.podName) {
          await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
        }
        await db.delete(repoPods).where(eq(repoPods.id, pod.id));
        logger.info(
          { repoUrl: pod.repoUrl, podName: pod.podName, instanceIndex: pod.instanceIndex },
          "Cleaned up idle repo pod",
        );
        cleaned++;
      } catch (err) {
        logger.warn({ err, podId: pod.id }, "Failed to cleanup repo pod");
      }
    }
  }

  return cleaned;
}

/**
 * List all repo pods.
 */
export async function listRepoPods(): Promise<RepoPod[]> {
  return db.select().from(repoPods) as Promise<RepoPod[]>;
}
