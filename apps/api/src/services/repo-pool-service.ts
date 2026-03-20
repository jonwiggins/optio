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

  // Create new repo pod
  return createRepoPod(repoUrl, repoBranch, env, imageConfig);
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
): Promise<RepoPod> {
  // Insert record first
  const [record] = await db
    .insert(repoPods)
    .values({ repoUrl, repoBranch, state: "provisioning" })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(imageConfig);

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
  // Write env vars to a temp file and source it (handles multi-line values safely)
  const envFileLines = Object.entries(env).map(([k, v]) => {
    // Use heredoc-style for values that contain newlines or special chars
    const safe = v.replace(/'/g, "'\\''");
    return `export ${k}='${safe}'`;
  });

  const script = [
    "set -e",
    ...envFileLines,
    `export OPTIO_TASK_ID='${taskId}'`,
    // Wait for the repo-init script to finish cloning
    `echo "[optio] Waiting for repo to be ready..."`,
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: repo not ready after 120s"; exit 1; }`,
    `echo "[optio] Repo ready"`,
    // Create worktree from the main branch
    `cd /workspace/repo`,
    `git fetch origin`,
    `git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    `cd /workspace/tasks/${taskId}`,
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
    // Run the agent command
    ...agentCommand,
    // Cleanup worktree on exit (best-effort)
    `EXIT_CODE=$?`,
    `cd /workspace/repo`,
    `git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true`,
    `exit $EXIT_CODE`,
  ].join("\n");

  return rt.exec(handle, ["bash", "-c", script], { tty: true });
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
