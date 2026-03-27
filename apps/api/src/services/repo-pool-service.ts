import { randomUUID } from "node:crypto";
import { eq, and, lt, sql, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods, tasks } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession, RepoImageConfig } from "@optio/shared";
import {
  DEFAULT_AGENT_IMAGE,
  PRESET_IMAGES,
  generateRepoPodName,
  normalizeRepoUrl,
} from "@optio/shared";
import { logger } from "../logger.js";
import {
  generateEnvoyConfig,
  buildEnvoySidecarContainer,
  buildSecretInitContainer,
  buildEnvoyVolumes,
  getAgentProxyEnv,
  getAgentCaVolumeMount,
  PROXIED_SECRET_ENV_VARS,
  type SecretProxySecrets,
} from "./envoy-sidecar.js";

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
 * Select (or create) a repo pod for the given repo URL.
 *
 * Multi-pod scheduling:
 *   1. If preferredPodId is given (same-pod retry), try that pod first.
 *   2. Pick the ready pod with the fewest active tasks that isn't at capacity.
 *   3. If all pods are at capacity and under the instance limit, create a new one.
 *   4. If at the instance limit, return the least-loaded ready pod.
 */
export async function getOrCreateRepoPod(
  rawRepoUrl: string,
  repoBranch: string,
  env: Record<string, string>,
  imageConfig?: RepoImageConfig,
  opts?: {
    preferredPodId?: string;
    maxAgentsPerPod?: number;
    maxPodInstances?: number;
    networkPolicy?: string;
    cpuRequest?: string | null;
    cpuLimit?: string | null;
    memoryRequest?: string | null;
    memoryLimit?: string | null;
    dockerInDocker?: boolean;
    secretProxy?: boolean;
  },
): Promise<RepoPod> {
  const repoUrl = normalizeRepoUrl(rawRepoUrl);
  const maxAgentsPerPod = opts?.maxAgentsPerPod ?? 2;
  const maxPodInstances = opts?.maxPodInstances ?? 1;

  // 1. Try preferred pod (same-pod retry)
  if (opts?.preferredPodId) {
    const [preferred] = await db
      .select()
      .from(repoPods)
      .where(eq(repoPods.id, opts.preferredPodId));
    if (preferred && preferred.state === "ready" && preferred.podName) {
      const rt = getRuntime();
      try {
        const status = await rt.status({
          id: preferred.podId ?? preferred.podName,
          name: preferred.podName,
        });
        if (status.state === "running" && preferred.activeTaskCount < maxAgentsPerPod) {
          return preferred as RepoPod;
        }
      } catch {
        // Pod gone — fall through to general selection
      }
    }
  }

  // 2. Find all pods for this repo
  const existingPods = await db
    .select()
    .from(repoPods)
    .where(eq(repoPods.repoUrl, repoUrl))
    .orderBy(asc(repoPods.activeTaskCount));

  // Try to find a ready pod with capacity
  const rt = getRuntime();
  for (const pod of existingPods) {
    if (pod.state === "ready" && pod.podName && pod.activeTaskCount < maxAgentsPerPod) {
      try {
        const status = await rt.status({
          id: pod.podId ?? pod.podName,
          name: pod.podName,
        });
        if (status.state === "running") {
          return pod as RepoPod;
        }
      } catch {
        // Pod is gone, clean up record
      }
      await db.delete(repoPods).where(eq(repoPods.id, pod.id));
    } else if (pod.state === "provisioning") {
      return waitForPodReady(pod.id);
    } else if (pod.state === "error") {
      await db.delete(repoPods).where(eq(repoPods.id, pod.id));
    }
  }

  // 3. Count remaining valid pods for this repo
  const [{ count: currentPodCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(repoPods)
    .where(eq(repoPods.repoUrl, repoUrl));

  if (Number(currentPodCount) >= maxPodInstances) {
    // At instance limit — try to find any ready pod (even if at capacity)
    const [busyPod] = await db
      .select()
      .from(repoPods)
      .where(and(eq(repoPods.repoUrl, repoUrl), eq(repoPods.state, "ready")))
      .orderBy(asc(repoPods.activeTaskCount))
      .limit(1);
    if (busyPod) {
      return busyPod as RepoPod;
    }
    // Wait for provisioning pod
    const [provisioningPod] = await db
      .select()
      .from(repoPods)
      .where(and(eq(repoPods.repoUrl, repoUrl), eq(repoPods.state, "provisioning")));
    if (provisioningPod) {
      return waitForPodReady(provisioningPod.id);
    }
    throw new Error(`All ${maxPodInstances} pod instances for ${repoUrl} are unavailable`);
  }

  // 4. Create new pod instance
  const instanceIndex = Number(currentPodCount);
  try {
    return await createRepoPod(
      repoUrl,
      repoBranch,
      env,
      imageConfig,
      instanceIndex,
      opts?.networkPolicy,
      {
        cpuRequest: opts?.cpuRequest ?? undefined,
        cpuLimit: opts?.cpuLimit ?? undefined,
        memoryRequest: opts?.memoryRequest ?? undefined,
        memoryLimit: opts?.memoryLimit ?? undefined,
      },
      opts?.dockerInDocker,
      opts?.secretProxy,
    );
  } catch (err: any) {
    if (err?.message?.includes("unique") || err?.code === "23505") {
      logger.info({ repoUrl }, "Concurrent pod creation detected, retrying lookup");
      return getOrCreateRepoPod(repoUrl, repoBranch, env, imageConfig, opts);
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
  instanceIndex = 0,
  networkPolicy?: string,
  resources?: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest?: string;
    memoryLimit?: string;
  },
  dockerInDocker?: boolean,
  secretProxy?: boolean,
): Promise<RepoPod> {
  const [record] = await db
    .insert(repoPods)
    .values({ repoUrl, repoBranch, state: "provisioning", instanceIndex })
    .returning();

  const rt = getRuntime();
  const image = resolveImage(imageConfig);

  const pvcSuffix = instanceIndex > 0 ? `-${instanceIndex}` : "";
  const pvcName = `optio-home-${repoUrl.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}${pvcSuffix}`;
  let pvcReady = false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    // Check if PVC already exists
    try {
      await execFileAsync("kubectl", ["get", "pvc", pvcName, "-n", "optio"]);
      pvcReady = true;
    } catch {
      // PVC doesn't exist, create it
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
      // Use bash -c with heredoc since execFile doesn't support stdin input
      await execFileAsync("bash", ["-c", `echo '${pvcManifest}' | kubectl apply -f - -n optio`]);
      pvcReady = true;
      logger.info({ pvcName }, "Created PVC for repo pod home directory");
    }
  } catch (err) {
    logger.warn({ err, pvcName }, "Failed to create PVC, pod will use ephemeral storage");
  }

  try {
    const podName = generateRepoPodName(repoUrl);
    const volumes = pvcReady
      ? [{ persistentVolumeClaim: pvcName, mountPath: "/home/agent" }]
      : undefined;

    // Build base agent env, stripping proxied secrets when secret proxy is enabled
    const agentEnv: Record<string, string> = {
      ...env,
      OPTIO_REPO_URL: repoUrl,
      OPTIO_REPO_BRANCH: repoBranch,
    };
    if (secretProxy) {
      Object.assign(agentEnv, getAgentProxyEnv());
      agentEnv.OPTIO_SECRET_PROXY = "true";
    }

    const spec: ContainerSpec = {
      name: podName,
      image,
      command: ["/opt/optio/repo-init.sh"],
      env: agentEnv,
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
      volumes,
      cpuRequest: resources?.cpuRequest,
      cpuLimit: resources?.cpuLimit,
      memoryRequest: resources?.memoryRequest,
      memoryLimit: resources?.memoryLimit,
      labels: {
        "optio.repo-url": repoUrl.replace(/[^a-zA-Z0-9-_.]/g, "_").slice(0, 63),
        "optio.type": "repo-pod",
        "optio.instance-index": String(instanceIndex),
        "optio.network-policy": networkPolicy ?? "unrestricted",
        "optio.secret-proxy": secretProxy ? "true" : "false",
        "managed-by": "optio",
      },
      // Docker-in-Docker: user namespace isolation + capabilities + tmpfs for daemon storage
      ...(dockerInDocker
        ? {
            hostUsers: false,
            capabilities: ["SYS_ADMIN", "NET_ADMIN"],
            tmpfsMounts: [{ mountPath: "/var/lib/docker", sizeLimit: "10Gi" }],
          }
        : {}),
    };

    // Add Envoy sidecar containers and volumes when secret proxy is enabled
    if (secretProxy) {
      const envoyImage = process.env.OPTIO_ENVOY_IMAGE ?? "envoyproxy/envoy:v1.31-latest";
      const pullPolicy = (process.env.OPTIO_IMAGE_PULL_POLICY as string) ?? "IfNotPresent";

      const proxySecrets: SecretProxySecrets = {
        githubToken: env.GITHUB_TOKEN,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
      };

      const envoyConfig = generateEnvoyConfig(proxySecrets);

      // Create a ConfigMap for the Envoy config
      const configMapName = `envoy-config-${podName}`;
      await createEnvoyConfigMap(configMapName, envoyConfig).catch((err) => {
        logger.warn({ err, podName }, "Failed to create Envoy ConfigMap");
      });

      spec.sidecarContainers = [
        { raw: buildEnvoySidecarContainer({ envoyImage, imagePullPolicy: pullPolicy }) },
      ];
      spec.initContainers = [
        {
          raw: buildSecretInitContainer({
            envoyImage,
            secrets: proxySecrets,
            imagePullPolicy: pullPolicy,
          }),
        },
      ];
      spec.extraVolumes = buildEnvoyVolumes(envoyConfig).map((v) => {
        // Patch the configMap volume to use the actual ConfigMap name
        if (v.name === "envoy-config") {
          return {
            raw: {
              name: "envoy-config",
              configMap: {
                name: configMapName,
                items: [{ key: "envoy.yaml", path: "envoy.yaml" }],
              },
            },
          };
        }
        return { raw: v };
      });
      spec.extraVolumeMounts = [getAgentCaVolumeMount()];

      // Strip raw secret values from the agent container env
      for (const key of PROXIED_SECRET_ENV_VARS) {
        delete spec.env[key];
      }

      logger.info({ podName }, "Envoy secret proxy sidecar configured");
    }

    const handle = await rt.create(spec);

    // Create a K8s NetworkPolicy if restricted mode is enabled
    if (networkPolicy === "restricted") {
      await applyRestrictedNetworkPolicy(podName).catch((err) => {
        logger.warn(
          { err, podName },
          "Failed to apply NetworkPolicy — pod will run without egress restrictions",
        );
      });
    }

    await db
      .update(repoPods)
      .set({
        podName: handle.name,
        podId: handle.id,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(repoPods.id, record.id));

    logger.info(
      {
        repoUrl,
        podName: handle.name,
        instanceIndex,
        networkPolicy: networkPolicy ?? "unrestricted",
        secretProxy: !!secretProxy,
      },
      "Repo pod created",
    );

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

  // Update task worktree state to active and record which pod it's running on
  await db
    .update(tasks)
    .set({ worktreeState: "active", lastPodId: pod.id, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  // Build the exec command
  const envJson = JSON.stringify({ ...env, OPTIO_TASK_ID: taskId });
  const envB64 = Buffer.from(envJson).toString("base64");
  const runToken = randomUUID();

  // Build worktree setup commands based on whether we're resetting or creating fresh
  const worktreeSetup = opts?.resetWorktree
    ? [
        `if [ -d "/workspace/tasks/${taskId}" ]; then`,
        `  echo "[optio] Resetting existing worktree for retry..."`,
        `  cd /workspace/tasks/${taskId}`,
        `  git checkout -- . 2>/dev/null || true`,
        `  git clean -fd 2>/dev/null || true`,
        `  cd /workspace/repo`,
        `  echo "[optio] Worktree reset complete"`,
        `else`,
        `  echo "[optio] No existing worktree found, creating fresh..."`,
        `  git branch -D optio/task-${taskId} 2>/dev/null || true`,
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
      ]
    : [
        `git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true`,
        `rm -rf /workspace/tasks/${taskId}`,
        `if [ "\${OPTIO_RESTART_FROM_BRANCH:-}" = "true" ] && git rev-parse --verify origin/optio/task-${taskId} >/dev/null 2>&1; then`,
        `  echo "[optio] Force-restart: checking out existing PR branch"`,
        `  for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
        `    git worktree remove --force "$wt_path" 2>/dev/null || true`,
        `  done`,
        `  git worktree prune`,
        `  git branch -D optio/task-${taskId} 2>/dev/null || true`,
        `  git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} origin/optio/task-${taskId}`,
        `else`,
        `  git branch -D optio/task-${taskId} 2>/dev/null || true`,
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
      ];

  const script = [
    "set -e",
    `eval $(echo '${envB64}' | base64 -d | python3 -c "`,
    `import json, sys, shlex`,
    `env = json.load(sys.stdin)`,
    `for k, v in env.items():`,
    `    print(f'export {k}={shlex.quote(v)}')`,
    `")`,
    `echo "[optio] Waiting for repo to be ready..."`,
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: repo not ready after 120s"; exit 1; }`,
    `echo "[optio] Repo ready"`,
    `ENV_FRESH="true"`,
    `[ -f /home/agent/.optio-env-ready ] && ENV_FRESH="false"`,
    `export ENV_FRESH`,
    `if [ "$ENV_FRESH" = "true" ]; then echo "[optio] Fresh environment — tools may need to be installed"; else echo "[optio] Warm environment — tools from previous tasks should be available"; fi`,
    `echo "[optio] Acquiring repo lock..."`,
    `exec 9>/workspace/.repo-lock`,
    `flock 9`,
    `echo "[optio] Repo lock acquired"`,
    `cd /workspace/repo`,
    `git fetch origin`,
    `git checkout ${env.OPTIO_REPO_BRANCH ?? "main"} 2>/dev/null || true`,
    `git reset --hard origin/${env.OPTIO_REPO_BRANCH ?? "main"}`,
    ...worktreeSetup,
    `flock -u 9`,
    `exec 9>&-`,
    `cd /workspace/tasks/${taskId}`,
    `echo "${runToken}" > /workspace/tasks/${taskId}/.optio-run-token`,
    `export OPTIO_TASK_ID="${taskId}"`,
    `if [ -n "\${OPTIO_SETUP_FILES:-}" ]; then`,
    `  echo "[optio] Writing setup files..."`,
    `  WORKTREE_DIR=$(pwd)`,
    `  echo "\${OPTIO_SETUP_FILES}" | base64 -d | python3 -c "`,
    `import json, sys, os`,
    `worktree = os.environ.get('WORKTREE_DIR', '.')`,
    `files = json.load(sys.stdin)`,
    `for f in files:`,
    `    p = f['path']`,
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
    // Exclude Optio runtime files from git tracking using the local exclude file
    // (never committed, unlike .gitignore modifications)
    `EXCLUDE_FILE="$(git rev-parse --git-dir)/info/exclude"`,
    `mkdir -p "$(dirname "$EXCLUDE_FILE")"`,
    `grep -qxF '.optio/' "$EXCLUDE_FILE" 2>/dev/null || echo '.optio/' >> "$EXCLUDE_FILE"`,
    `grep -qxF '.optio-run-token' "$EXCLUDE_FILE" 2>/dev/null || echo '.optio-run-token' >> "$EXCLUDE_FILE"`,
    // EXIT trap: preserve the worktree — cleanup is handled by the cleanup worker
    // based on task state. Only clean up Claude Code's internal worktrees (-wt suffix).
    `trap 'cd /workspace/repo 2>/dev/null; git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true; git worktree prune 2>/dev/null || true' EXIT`,
    `set +e`,
    ...agentCommand,
    `AGENT_EXIT=$?`,
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
 * Update worktree state for a task.
 */
export async function updateWorktreeState(taskId: string, worktreeState: string): Promise<void> {
  await db.update(tasks).set({ worktreeState, updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

/**
 * Clean up idle repo pods. With multi-pod support, scale down higher-index pods first.
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

  // Group by repoUrl to implement scale-down logic
  const podsByRepo = new Map<string, (typeof idlePods)[number][]>();
  for (const pod of idlePods) {
    const existing = podsByRepo.get(pod.repoUrl) ?? [];
    existing.push(pod);
    podsByRepo.set(pod.repoUrl, existing);
  }

  for (const [, repoIdlePods] of podsByRepo) {
    // Sort by instance index descending (remove higher instances first)
    const sorted = repoIdlePods.sort((a, b) => b.instanceIndex - a.instanceIndex);

    for (const pod of sorted) {
      try {
        if (pod.podName) {
          await deleteNetworkPolicy(pod.podName).catch(() => {});
          await deleteEnvoyConfigMap(pod.podName).catch(() => {});
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

/**
 * List all repo pods for a specific repo URL.
 */
export async function listRepoPodsForRepo(repoUrl: string): Promise<RepoPod[]> {
  return db.select().from(repoPods).where(eq(repoPods.repoUrl, repoUrl)) as Promise<RepoPod[]>;
}

/**
 * Apply a restricted egress NetworkPolicy to a repo pod.
 * Allows only: DNS (port 53), AI provider APIs, GitHub, and intra-namespace Optio API.
 */
async function applyRestrictedNetworkPolicy(podName: string): Promise<void> {
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";
  const policyName = `optio-egress-${podName}`;

  const manifest = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: policyName,
      namespace,
      labels: {
        "managed-by": "optio",
        "optio.type": "egress-policy",
        "optio.pod-name": podName,
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          "optio.type": "repo-pod",
          "optio.network-policy": "restricted",
        },
      },
      policyTypes: ["Egress"],
      egress: [
        // Allow DNS (kube-dns, port 53 UDP+TCP)
        {
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        // Allow HTTPS to AI provider APIs and GitHub (port 443)
        {
          ports: [{ protocol: "TCP", port: 443 }],
        },
        // Allow intra-namespace traffic (Optio API server for callbacks/token refresh)
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": namespace },
              },
            },
          ],
        },
      ],
    },
  };

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const manifestJson = JSON.stringify(manifest);
  await execFileAsync("bash", [
    "-c",
    `echo ${JSON.stringify(manifestJson)} | kubectl apply -f - -n ${namespace}`,
  ]);
  logger.info({ policyName, podName }, "Applied restricted egress NetworkPolicy");
}

/**
 * Delete the NetworkPolicy associated with a repo pod.
 */
export async function deleteNetworkPolicy(podName: string): Promise<void> {
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";
  const policyName = `optio-egress-${podName}`;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("kubectl", [
      "delete",
      "networkpolicy",
      policyName,
      "-n",
      namespace,
      "--ignore-not-found",
    ]);
    logger.info({ policyName, podName }, "Deleted NetworkPolicy");
  } catch (err) {
    logger.warn({ err, policyName }, "Failed to delete NetworkPolicy");
  }
}

/**
 * Create a K8s ConfigMap for the Envoy proxy configuration.
 */
async function createEnvoyConfigMap(name: string, envoyYaml: string): Promise<void> {
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";

  const manifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace,
      labels: {
        "managed-by": "optio",
        "optio.type": "envoy-config",
      },
    },
    data: {
      "envoy.yaml": envoyYaml,
    },
  };

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const manifestJson = JSON.stringify(manifest);
  await execFileAsync("bash", [
    "-c",
    `echo ${JSON.stringify(manifestJson)} | kubectl apply -f - -n ${namespace}`,
  ]);
  logger.info({ configMapName: name }, "Created Envoy ConfigMap");
}

/**
 * Delete the Envoy ConfigMap associated with a repo pod.
 */
export async function deleteEnvoyConfigMap(podName: string): Promise<void> {
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";
  const configMapName = `envoy-config-${podName}`;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("kubectl", [
      "delete",
      "configmap",
      configMapName,
      "-n",
      namespace,
      "--ignore-not-found",
    ]);
    logger.info({ configMapName, podName }, "Deleted Envoy ConfigMap");
  } catch (err) {
    logger.warn({ err, configMapName }, "Failed to delete Envoy ConfigMap");
  }
}

/**
 * Reconcile activeTaskCount on all repo pods to match actual running/provisioning tasks.
 *
 * The stored counter can drift if the worker process is killed before the finally
 * block decrements it. This function resets each pod's counter to the real count
 * of tasks in running/provisioning state that reference that pod via lastPodId.
 */
export async function reconcileActiveTaskCounts(): Promise<number> {
  const allPods = await db
    .select({ id: repoPods.id, activeTaskCount: repoPods.activeTaskCount })
    .from(repoPods);
  if (allPods.length === 0) return 0;

  let corrected = 0;
  for (const pod of allPods) {
    const [{ count: actual }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(sql`${tasks.state} IN ('running', 'provisioning') AND ${tasks.lastPodId} = ${pod.id}`);

    if (pod.activeTaskCount !== actual) {
      await db
        .update(repoPods)
        .set({ activeTaskCount: actual, updatedAt: new Date() })
        .where(eq(repoPods.id, pod.id));
      logger.info(
        { podId: pod.id, was: pod.activeTaskCount, now: actual },
        "Reconciled activeTaskCount",
      );
      corrected++;
    }
  }

  return corrected;
}
