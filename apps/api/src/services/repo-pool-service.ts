import { randomUUID } from "node:crypto";
import { eq, and, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession, RepoImageConfig } from "@optio/shared";
import { DEFAULT_AGENT_IMAGE, PRESET_IMAGES } from "@optio/shared";
import { logger } from "../logger.js";

const IDLE_TIMEOUT_MS = parseInt(process.env.OPTIO_REPO_POD_IDLE_MS ?? "600000", 10); // 10 min default

export interface RepoPod {
  id: string;
  repoUrl: string;
  repoBranch: string;
  podName: string | null;
  podId: string | null;
  state: string;
  activeTaskCount: number;
}

/**
 * Get or create a repo pod for the given repo URL.
 * If a pod already exists and is ready, return it.
 * If one is provisioning, wait for it.
 * If none exists, create one.
 */
export async function getOrCreateRepoPod(
  repoUrl: string,
  repoBranch: string,
  env: Record<string, string>,
  imageConfig?: RepoImageConfig,
): Promise<RepoPod> {
  // Check for existing pod
  const [existing] = await db.select().from(repoPods).where(eq(repoPods.repoUrl, repoUrl));

  if (existing) {
    if (existing.state === "ready" && existing.podName) {
      // Verify the pod is still running
      const rt = getRuntime();
      try {
        const status = await rt.status({
          id: existing.podId ?? existing.podName,
          name: existing.podName,
        });
        if (status.state === "running") {
          return existing as RepoPod;
        }
      } catch {
        // Pod is gone, clean up the record
      }
      // Pod is dead, remove record and recreate
      await db.delete(repoPods).where(eq(repoPods.id, existing.id));
    } else if (existing.state === "provisioning") {
      // Wait for it (poll)
      return waitForPodReady(existing.id);
    } else if (existing.state === "error") {
      // Clean up and recreate
      await db.delete(repoPods).where(eq(repoPods.id, existing.id));
    }
  }

  // Create new repo pod — use upsert to handle concurrent callers
  try {
    return await createRepoPod(repoUrl, repoBranch, env, imageConfig);
  } catch (err: any) {
    // If another caller just inserted for the same repoUrl, retry the lookup
    if (err?.message?.includes("unique") || err?.code === "23505") {
      logger.info({ repoUrl }, "Concurrent pod creation detected, waiting for existing pod");
      const [retry] = await db.select().from(repoPods).where(eq(repoPods.repoUrl, repoUrl));
      if (retry) {
        if (retry.state === "ready" && retry.podName) return retry as RepoPod;
        if (retry.state === "provisioning") return waitForPodReady(retry.id);
      }
    }
    throw err;
  }
}

export function resolveImage(imageConfig?: RepoImageConfig): string {
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
): Promise<RepoPod> {
  // Insert record first
  const [record] = await db
    .insert(repoPods)
    .values({ repoUrl, repoBranch, state: "provisioning" })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(imageConfig);

  // Create a PVC for persistent home directory (tools, caches)
  const pvcName = `optio-home-${repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}`;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Check if PVC already exists (async to avoid blocking the event loop,
    // which kills BullMQ heartbeats and triggers stall detection)
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

    logger.info({ repoUrl, podName: handle.name }, "Repo pod created");

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

  // Build the exec command: create worktree, set up env, run agent
  // Encode env as base64 JSON, decode in the script to handle multi-line values safely
  const envJson = JSON.stringify({ ...env, OPTIO_TASK_ID: taskId });
  const envB64 = Buffer.from(envJson).toString("base64");
  // Unique token for this run — used to prevent stale cleanup traps from
  // deleting a retry's worktree (see Bug 3 in the cleanup trap below)
  const runToken = randomUUID();

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
    // Create worktree — either from the PR branch (force-restart) or fresh from main
    // Use flock to serialize git operations in the shared /workspace/repo directory —
    // concurrent execs doing fetch/checkout/reset will corrupt each other without this.
    `echo "[optio] Acquiring repo lock..."`,
    `exec 9>/workspace/.repo-lock`,
    `flock 9`,
    `echo "[optio] Repo lock acquired"`,
    `cd /workspace/repo`,
    `git fetch origin`,
    `git checkout ${env.OPTIO_REPO_BRANCH ?? "main"} 2>/dev/null || true`,
    `git reset --hard origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    `git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true`,
    `rm -rf /workspace/tasks/${taskId}`,
    // Force-restart: reuse the existing PR branch instead of creating fresh from main
    `if [ "\${OPTIO_RESTART_FROM_BRANCH:-}" = "true" ] && git rev-parse --verify origin/optio/task-${taskId} >/dev/null 2>&1; then`,
    `  echo "[optio] Force-restart: checking out existing PR branch"`,
    // Clean up any worktrees holding the branch (Claude Code creates its own in .claude/worktrees/)
    `  for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
    `    git worktree remove --force "$wt_path" 2>/dev/null || true`,
    `  done`,
    `  git worktree prune`,
    `  git branch -D optio/task-${taskId} 2>/dev/null || true`,
    `  git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/optio/task-${taskId}`,
    `else`,
    `  git branch -D optio/task-${taskId} 2>/dev/null || true`,
    // Try creating fresh worktree; if branch already exists (Claude Code may create
    // extra worktrees like -wt that hold the branch), clean up stale refs and retry
    `  if ! git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/${env.OPTIO_REPO_BRANCH ?? "main"} 2>/dev/null; then`,
    `    echo "[optio] Cleaning up stale worktree references..."`,
    `    git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true`,
    `    for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
    `      git worktree remove --force "$wt_path" 2>/dev/null || true`,
    `    done`,
    `    git worktree prune`,
    `    git branch -D optio/task-${taskId} 2>/dev/null || true`,
    `    git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    `  fi`,
    `fi`,
    // Release the repo lock — worktree is created, safe to run in parallel from here
    `flock -u 9`,
    `exec 9>&-`,
    `cd /workspace/tasks/${taskId}`,
    // Write a run token so the cleanup trap can verify ownership — if a retry
    // creates a new worktree before this run's trap fires, the trap will see
    // a different token and skip cleanup (preventing it from deleting the retry's worktree)
    `echo "${runToken}" > /workspace/tasks/${taskId}/.optio-run-token`,
    `export OPTIO_TASK_ID="${taskId}"`,
    // Write setup files if provided
    // Paths starting with / are absolute; relative paths are within the worktree
    // Use /home/agent instead of /opt/optio for user-writable paths
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
    // Set up cleanup trap before running the agent — ensures worktree is removed
    // even if the agent exits non-zero (set -e would otherwise kill the script).
    // Only clean up if our run token still matches — a retry may have already
    // replaced the worktree with a new run, and we must not delete it.
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
 * Clean up idle repo pods (no active tasks and idle for longer than the timeout).
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

  for (const pod of idlePods) {
    try {
      if (pod.podName) {
        await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
      }
      await db.delete(repoPods).where(eq(repoPods.id, pod.id));
      logger.info({ repoUrl: pod.repoUrl, podName: pod.podName }, "Cleaned up idle repo pod");
      cleaned++;
    } catch (err) {
      logger.warn({ err, podId: pod.id }, "Failed to cleanup repo pod");
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
