import { randomUUID } from "node:crypto";
import { eq, and, lt, sql, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { repoPods, tasks, interactiveSessions, workspaces } from "../db/schema.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession, RepoImageConfig } from "@optio/shared";
import {
  DEFAULT_AGENT_IMAGE,
  PRESET_IMAGES,
  generateRepoPodName,
  generateStatefulSetName,
  normalizeRepoUrl,
} from "@optio/shared";
import {
  K8sWorkloadManager,
  getWorkloadManager,
  isStatefulSetEnabled,
} from "./k8s-workload-service.js";
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
import { parseIntEnv } from "@optio/shared";
import { withSpan } from "../telemetry/spans.js";

const IDLE_TIMEOUT_MS = parseIntEnv("OPTIO_REPO_POD_IDLE_MS", 600000); // 10 min default
const REPO_INIT_TIMEOUT_MS = parseIntEnv("OPTIO_REPO_INIT_TIMEOUT_MS", 120000); // 2 min default
if (Number.isNaN(REPO_INIT_TIMEOUT_MS) || REPO_INIT_TIMEOUT_MS <= 0) {
  throw new Error("OPTIO_REPO_INIT_TIMEOUT_MS must be a positive integer");
}
const SERVICE_ACCOUNT_NAME = process.env.OPTIO_SERVICE_ACCOUNT_NAME; // K8s service account for workload identity

/**
 * Parse a JSON-encoded environment variable, returning `undefined` when unset/empty.
 * Throws a descriptive error (including the variable name and raw value) on malformed JSON
 * so operators can quickly identify typos in values.yaml or Helm overrides.
 */
export function parseJsonEnv(name: string, value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${name}: ${err instanceof Error ? err.message : err} (raw value: ${value})`,
    );
  }
}

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
    workspaceId?: string | null;
  },
): Promise<RepoPod> {
  return withSpan("k8s.pod.get_or_create", { "k8s.repo_url": rawRepoUrl }, async () => {
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
        // Check if provisioning pod is stale (>10 min old)
        const ageMs = Date.now() - new Date(pod.createdAt).getTime();
        const maxProvisioningMs = 10 * 60 * 1000; // 10 minutes
        if (ageMs > maxProvisioningMs) {
          logger.warn(
            { podId: pod.id, ageMs, maxProvisioningMs },
            "Deleting stale provisioning pod",
          );
          await db.delete(repoPods).where(eq(repoPods.id, pod.id));
          // Continue to create a new pod
        } else {
          logger.info({ podId: pod.id, ageMs }, "Waiting for provisioning pod");
          return waitForPodReady(pod.id);
        }
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
    const createFn = isStatefulSetEnabled() ? createRepoPodViaStatefulSet : createRepoPod;
    try {
      return await createFn(
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
        opts?.workspaceId,
      );
    } catch (err: any) {
      if (err?.message?.includes("unique") || err?.code === "23505") {
        logger.info({ repoUrl }, "Concurrent pod creation detected, retrying lookup");
        return getOrCreateRepoPod(repoUrl, repoBranch, env, imageConfig, opts);
      }
      throw err;
    }
  });
}

export function resolveImage(imageConfig?: RepoImageConfig): string {
  if (imageConfig?.customImage) return imageConfig.customImage;
  if (imageConfig?.preset && imageConfig.preset in PRESET_IMAGES) {
    const prefix = process.env.OPTIO_AGENT_IMAGE_PREFIX;
    if (prefix) {
      const tag = process.env.OPTIO_AGENT_IMAGE_TAG ?? "latest";
      return `${prefix}${imageConfig.preset}:${tag}`;
    }
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
  workspaceId?: string | null,
): Promise<RepoPod> {
  // Admission check: Docker-in-Docker requires explicit workspace admin opt-in
  if (dockerInDocker) {
    if (!workspaceId) {
      throw new Error("Docker-in-Docker requires a workspace with allowDockerInDocker enabled");
    }
    const [ws] = await db
      .select({ allowDockerInDocker: workspaces.allowDockerInDocker })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws?.allowDockerInDocker) {
      throw new Error(
        "Docker-in-Docker requires workspace admin opt-in. " +
          "Enable allowDockerInDocker in workspace settings.",
      );
    }
  }

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

  // Load shared directories and ensure cache PVC exists
  let cacheInfo: {
    pvcName: string;
    volumeMounts: Array<{ mountPath: string; subPath: string }>;
  } | null = null;
  try {
    const { getSharedDirectoriesForRepo, ensureCachePvcForPod } =
      await import("./shared-directory-service.js");
    const sharedDirs = await getSharedDirectoriesForRepo(repoUrl, workspaceId);
    if (sharedDirs.length > 0) {
      cacheInfo = await ensureCachePvcForPod(repoUrl, instanceIndex, sharedDirs);
      if (cacheInfo) {
        await db
          .update(repoPods)
          .set({
            cachePvcName: cacheInfo.pvcName,
            cachePvcState: "bound",
            updatedAt: new Date(),
          })
          .where(eq(repoPods.id, record.id));
      }
    }
  } catch (err) {
    logger.warn({ err, repoUrl }, "Failed to set up cache PVC — continuing without cache");
  }

  let podNameForCleanup: string | undefined;
  try {
    const podName = generateRepoPodName(repoUrl);
    podNameForCleanup = podName;
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

    // Build cache volume and mounts for shared directories
    const cacheVolumeName = "optio-cache";
    const cacheExtraVolume = cacheInfo
      ? {
          raw: {
            name: cacheVolumeName,
            persistentVolumeClaim: { claimName: cacheInfo.pvcName },
          },
        }
      : null;
    const cacheVolumeMounts = cacheInfo
      ? cacheInfo.volumeMounts.map((vm) => ({
          name: cacheVolumeName,
          mountPath: vm.mountPath,
          subPath: vm.subPath,
        }))
      : [];

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
      // Docker-in-Docker (rootless): user namespace isolation + minimal capabilities + tmpfs
      // Uses rootless Docker (runc + fuse-overlayfs) so SYS_ADMIN is NOT required.
      // SYS_CHROOT is the only extra capability needed for rootless container runtimes.
      ...(dockerInDocker
        ? {
            hostUsers: false,
            capabilities: ["SYS_CHROOT"],
            tmpfsMounts: [{ mountPath: "/var/lib/docker", sizeLimit: "10Gi" }],
          }
        : {}),
      ...(process.env.OPTIO_AGENT_NODE_SELECTOR
        ? {
            nodeSelector: parseJsonEnv(
              "OPTIO_AGENT_NODE_SELECTOR",
              process.env.OPTIO_AGENT_NODE_SELECTOR,
            ) as Record<string, string>,
          }
        : {}),
      ...(process.env.OPTIO_AGENT_TOLERATIONS
        ? {
            tolerations: parseJsonEnv(
              "OPTIO_AGENT_TOLERATIONS",
              process.env.OPTIO_AGENT_TOLERATIONS,
            ) as unknown[],
          }
        : {}),
      ...(SERVICE_ACCOUNT_NAME ? { serviceAccountName: SERVICE_ACCOUNT_NAME } : {}),
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

    // Add cache volume and mounts for shared directories
    if (cacheExtraVolume && cacheVolumeMounts.length > 0) {
      spec.extraVolumes = [...(spec.extraVolumes ?? []), cacheExtraVolume];
      spec.extraVolumeMounts = [...(spec.extraVolumeMounts ?? []), ...cacheVolumeMounts];
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

    // Clean up the K8s pod if it was created — prevents dead pods from
    // accumulating when provisioning repeatedly fails (e.g. ErrImageNeverPull).
    if (podNameForCleanup) {
      try {
        const rtForCleanup = getRuntime();
        await rtForCleanup.destroy({ id: podNameForCleanup, name: podNameForCleanup });
        await deleteNetworkPolicy(podNameForCleanup).catch(() => {});
        await deleteEnvoyConfigMap(podNameForCleanup).catch(() => {});
        logger.info({ podName: podNameForCleanup }, "Cleaned up failed pod");
      } catch (cleanupErr) {
        logger.warn(
          { err: cleanupErr, podName: podNameForCleanup },
          "Failed to cleanup errored pod",
        );
      }
    }

    throw err;
  }
}

/**
 * Create a repo pod managed by a StatefulSet. Used when OPTIO_STATEFULSET_ENABLED=true.
 * The StatefulSet and headless Service are created on first use for a repo,
 * then scaled up for additional instances.
 */
async function createRepoPodViaStatefulSet(
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
  workspaceId?: string | null,
): Promise<RepoPod> {
  // Admission check: Docker-in-Docker requires explicit workspace admin opt-in
  if (dockerInDocker) {
    if (!workspaceId) {
      throw new Error("Docker-in-Docker requires a workspace with allowDockerInDocker enabled");
    }
    const [ws] = await db
      .select({ allowDockerInDocker: workspaces.allowDockerInDocker })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws?.allowDockerInDocker) {
      throw new Error(
        "Docker-in-Docker requires workspace admin opt-in. " +
          "Enable allowDockerInDocker in workspace settings.",
      );
    }
  }

  const stsName = generateStatefulSetName(repoUrl);
  const podName = K8sWorkloadManager.podNameForOrdinal(stsName, instanceIndex);

  const [record] = await db
    .insert(repoPods)
    .values({
      repoUrl,
      repoBranch,
      state: "provisioning",
      instanceIndex,
      statefulSetName: stsName,
      managedBy: "statefulset",
    })
    .returning();

  try {
    const image = resolveImage(imageConfig);
    const manager = getWorkloadManager();

    // Build the base agent env
    const agentEnv: Record<string, string> = {
      ...env,
      OPTIO_REPO_URL: repoUrl,
      OPTIO_REPO_BRANCH: repoBranch,
    };
    if (secretProxy) {
      Object.assign(agentEnv, getAgentProxyEnv());
      agentEnv.OPTIO_SECRET_PROXY = "true";
    }

    // Build the ContainerSpec (same as bare pod path)
    const spec: ContainerSpec = {
      name: podName,
      image,
      command: ["/opt/optio/repo-init.sh"],
      env: agentEnv,
      workDir: "/workspace",
      imagePullPolicy: (process.env.OPTIO_IMAGE_PULL_POLICY as any) ?? "Never",
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
      ...(dockerInDocker
        ? {
            hostUsers: false,
            capabilities: ["SYS_CHROOT"],
            tmpfsMounts: [{ mountPath: "/var/lib/docker", sizeLimit: "10Gi" }],
          }
        : {}),
      ...(process.env.OPTIO_AGENT_NODE_SELECTOR
        ? {
            nodeSelector: parseJsonEnv(
              "OPTIO_AGENT_NODE_SELECTOR",
              process.env.OPTIO_AGENT_NODE_SELECTOR,
            ) as Record<string, string>,
          }
        : {}),
      ...(process.env.OPTIO_AGENT_TOLERATIONS
        ? {
            tolerations: parseJsonEnv(
              "OPTIO_AGENT_TOLERATIONS",
              process.env.OPTIO_AGENT_TOLERATIONS,
            ) as unknown[],
          }
        : {}),
      ...(SERVICE_ACCOUNT_NAME ? { serviceAccountName: SERVICE_ACCOUNT_NAME } : {}),
    };

    // Add Envoy sidecar if secret proxy is enabled
    if (secretProxy) {
      const envoyImage = process.env.OPTIO_ENVOY_IMAGE ?? "envoyproxy/envoy:v1.31-latest";
      const pullPolicy = (process.env.OPTIO_IMAGE_PULL_POLICY as string) ?? "IfNotPresent";
      const proxySecrets: SecretProxySecrets = {
        githubToken: env.GITHUB_TOKEN,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
      };
      const envoyConfig = generateEnvoyConfig(proxySecrets);
      const configMapName = `envoy-config-${stsName}`;
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

      for (const key of PROXIED_SECRET_ENV_VARS) {
        delete spec.env[key];
      }
    }

    // Load shared directories and ensure cache PVC exists
    let cacheInfo: {
      pvcName: string;
      volumeMounts: Array<{ mountPath: string; subPath: string }>;
    } | null = null;
    try {
      const { getSharedDirectoriesForRepo, ensureCachePvcForPod } =
        await import("./shared-directory-service.js");
      const sharedDirs = await getSharedDirectoriesForRepo(repoUrl, workspaceId);
      if (sharedDirs.length > 0) {
        cacheInfo = await ensureCachePvcForPod(repoUrl, instanceIndex, sharedDirs);
        if (cacheInfo) {
          await db
            .update(repoPods)
            .set({
              cachePvcName: cacheInfo.pvcName,
              cachePvcState: "bound",
              updatedAt: new Date(),
            })
            .where(eq(repoPods.id, record.id));
        }
      }
    } catch (err) {
      logger.warn({ err, repoUrl }, "Failed to set up cache PVC — continuing without cache");
    }

    // Add cache volume and mounts
    if (cacheInfo) {
      const cacheVolumeName = "optio-cache";
      spec.extraVolumes = [
        ...(spec.extraVolumes ?? []),
        { raw: { name: cacheVolumeName, persistentVolumeClaim: { claimName: cacheInfo.pvcName } } },
      ];
      spec.extraVolumeMounts = [
        ...(spec.extraVolumeMounts ?? []),
        ...cacheInfo.volumeMounts.map((vm) => ({
          name: cacheVolumeName,
          mountPath: vm.mountPath,
          subPath: vm.subPath,
        })),
      ];
    }

    // Ensure StatefulSet exists and scale to needed replica count
    const homePvcSize = process.env.OPTIO_HOME_PVC_SIZE ?? "10Gi";
    const homePvcStorageClass = process.env.OPTIO_HOME_PVC_STORAGE_CLASS || undefined;

    logger.info(
      {
        stsName,
        serviceAccountName: spec.serviceAccountName,
        SERVICE_ACCOUNT_NAME_ENV: SERVICE_ACCOUNT_NAME,
      },
      "Calling ensureStatefulSet",
    );

    const sts = await manager.ensureStatefulSet({
      name: stsName,
      spec,
      homePvcSize,
      homePvcStorageClass,
    });

    // Scale up if needed
    if (instanceIndex >= sts.replicas) {
      await manager.scale(stsName, instanceIndex + 1);
    }

    // Wait for the pod to be running
    await manager.waitForPodRunning(podName);

    // Apply network policy
    if (networkPolicy === "restricted") {
      await applyRestrictedNetworkPolicy(podName).catch((err) => {
        logger.warn({ err, podName }, "Failed to apply NetworkPolicy");
      });
    }

    // Read pod UID
    const rt = getRuntime();
    let podId = podName;
    try {
      const status = await rt.status({ id: podName, name: podName });
      if (status.state === "running") podId = podName;
    } catch {
      // Pod status check failed, use name as fallback
    }

    await db
      .update(repoPods)
      .set({
        podName,
        podId,
        state: "ready",
        updatedAt: new Date(),
      })
      .where(eq(repoPods.id, record.id));

    logger.info(
      {
        repoUrl,
        podName,
        instanceIndex,
        statefulSetName: stsName,
        networkPolicy: networkPolicy ?? "unrestricted",
        secretProxy: !!secretProxy,
      },
      "Repo pod created via StatefulSet",
    );

    return {
      ...record,
      podName,
      podId,
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
  return withSpan(
    "k8s.pod.exec",
    { "k8s.pod.name": pod.podName ?? "unknown", "task.id": taskId },
    async () => {
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

      // Mark pod as non-disruptable while tasks are running (Karpenter)
      if (isStatefulSetEnabled() && pod.podName) {
        getWorkloadManager()
          .patchPodAnnotations(pod.podName, { "karpenter.sh/do-not-disrupt": "true" })
          .catch((err) => logger.warn({ err }, "Failed to set do-not-disrupt annotation"));
      }

      // Update task worktree state to active and record which pod it's running on
      await db
        .update(tasks)
        .set({ worktreeState: "active", lastPodId: pod.id, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));

      // Build the exec command
      const envJson = JSON.stringify({
        ...env,
        OPTIO_TASK_ID: taskId,
        REPO_INIT_TIMEOUT_SECS: String(Math.ceil(REPO_INIT_TIMEOUT_MS / 1000)),
      });
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
            `  if ! git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} "origin/${env.OPTIO_REPO_BRANCH ?? "main"}" 2>/dev/null; then`,
            `    echo "[optio] Cleaning up stale worktree references..."`,
            `    git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true`,
            `    for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
            `      git worktree remove --force "$wt_path" 2>/dev/null || true`,
            `    done`,
            `    git worktree prune`,
            `    git branch -D optio/task-${taskId} 2>/dev/null || true`,
            `    git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} "origin/${env.OPTIO_REPO_BRANCH ?? "main"}"`,
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
            `  if ! git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} "origin/${env.OPTIO_REPO_BRANCH ?? "main"}" 2>/dev/null; then`,
            `    echo "[optio] Cleaning up stale worktree references..."`,
            `    git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true`,
            `    for wt_path in $(git worktree list --porcelain | grep -B1 "branch refs/heads/optio/task-${taskId}$" | grep "^worktree " | cut -d" " -f2-); do`,
            `      git worktree remove --force "$wt_path" 2>/dev/null || true`,
            `    done`,
            `    git worktree prune`,
            `    git branch -D optio/task-${taskId} 2>/dev/null || true`,
            `    git worktree add /workspace/tasks/${taskId} -b optio/task-${taskId} "origin/${env.OPTIO_REPO_BRANCH ?? "main"}"`,
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
        `for i in $(seq 1 \${REPO_INIT_TIMEOUT_SECS}); do [ -f /workspace/.ready ] && break; sleep 1; done`,
        `[ -f /workspace/.ready ] || { echo "[optio] ERROR: repo not ready after \${REPO_INIT_TIMEOUT_SECS}s (increase OPTIO_REPO_INIT_TIMEOUT_MS to extend)"; exit 1; }`,
        `echo "[optio] Repo ready"`,
        // Use task-scoped credential URL for git operations (user-scoped token).
        // Override the pod-level URL which returns an installation token.
        `if [ -n "\${OPTIO_GIT_TASK_CREDENTIAL_URL:-}" ]; then`,
        `  export OPTIO_GIT_CREDENTIAL_URL="\${OPTIO_GIT_TASK_CREDENTIAL_URL}"`,
        `fi`,
        // Set up gh CLI wrapper with PATH prepend (no root required)
        `if [ -f /usr/local/bin/optio-gh-wrapper ]; then`,
        `  mkdir -p /home/agent/.local/bin`,
        `  cp /usr/local/bin/optio-gh-wrapper /home/agent/.local/bin/gh 2>/dev/null || true`,
        `  chmod +x /home/agent/.local/bin/gh 2>/dev/null || true`,
        `  export PATH="/home/agent/.local/bin:$PATH"`,
        `fi`,
        // Set up glab CLI wrapper and authenticate for GitLab repos
        `if [ -n "\${GITLAB_TOKEN:-}" ]; then`,
        `  if [ -f /usr/local/bin/optio-glab-wrapper ]; then`,
        `    mkdir -p /home/agent/.local/bin`,
        `    cp /usr/local/bin/optio-glab-wrapper /home/agent/.local/bin/glab 2>/dev/null || true`,
        `    chmod +x /home/agent/.local/bin/glab 2>/dev/null || true`,
        `    export PATH="/home/agent/.local/bin:$PATH"`,
        `  fi`,
        `  GITLAB_HOST="gitlab.com"`,
        `  case "\${OPTIO_REPO_URL:-}" in *://*) GITLAB_HOST=$(echo "\${OPTIO_REPO_URL}" | sed -E 's|.*://([^/]+).*|\\1|');; esac`,
        `  glab auth login --hostname "\${GITLAB_HOST}" --token "\${GITLAB_TOKEN}" 2>/dev/null || true`,
        `fi`,
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
        `git checkout "${env.OPTIO_REPO_BRANCH ?? "main"}" 2>/dev/null || true`,
        `git reset --hard "origin/${env.OPTIO_REPO_BRANCH ?? "main"}"`,
        ...worktreeSetup,
        `if [ -f /workspace/repo/.gitmodules ]; then git -C /workspace/tasks/${taskId} submodule update --init --recursive 2>&1 || true; fi`,
        `flock -u 9`,
        `exec 9>&-`,
        `cd /workspace/tasks/${taskId}`,
        // Configure git at worktree scope so concurrent tasks don't interfere
        `if [ -n "\${OPTIO_GIT_CREDENTIAL_URL:-}" ] && [ -f /usr/local/bin/optio-git-credential ]; then`,
        `  git config --local credential.helper '/usr/local/bin/optio-git-credential'`,
        `  echo "[optio] Worktree credential helper configured"`,
        `fi`,
        `git config --local user.name "\${GITHUB_APP_BOT_NAME:-Optio Agent}"`,
        `git config --local user.email "\${GITHUB_APP_BOT_EMAIL:-optio-agent@noreply.github.com}"`,
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
        `grep -qxF '.optio-cache/' "$EXCLUDE_FILE" 2>/dev/null || echo '.optio-cache/' >> "$EXCLUDE_FILE"`,
        // EXIT trap: kill child processes (agent + watchdog) then clean up internal worktrees.
        // This ensures orphaned agent processes are killed when the exec stream is severed
        // (e.g. API pod restart closes the SPDY connection but kubelet doesn't send SIGHUP).
        `_optio_main_pid=$$`,
        `trap 'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; cd /workspace/repo 2>/dev/null; git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true; git worktree prune 2>/dev/null || true' EXIT`,
        // Background heartbeat: detect broken stdout pipe (EPIPE) from severed exec stream.
        // Writes an empty line every 30s (skipped by the NDJSON parser). If stdout is broken
        // (API pod died), sends SIGTERM to the main script which triggers the EXIT trap.
        `(trap '' PIPE; while sleep 30; do printf '\\n' 2>/dev/null || { kill -TERM $_optio_main_pid 2>/dev/null; exit; }; done) &`,
        `set +e`,
        ...agentCommand,
        `AGENT_EXIT=$?`,
        `[ $AGENT_EXIT -eq 0 ] && touch /home/agent/.optio-env-ready`,
        `exit $AGENT_EXIT`,
      ].join("\n");

      return rt.exec(handle, ["bash", "-c", script], { tty: false });
    },
  );
}

/**
 * Decrement the active task count for a repo pod.
 * Removes the do-not-disrupt annotation when count reaches 0.
 */
export async function releaseRepoPodTask(podId: string): Promise<void> {
  await db
    .update(repoPods)
    .set({
      activeTaskCount: sql`GREATEST(${repoPods.activeTaskCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(repoPods.id, podId));

  // Remove do-not-disrupt when pod becomes idle (allow Karpenter consolidation)
  if (isStatefulSetEnabled()) {
    const [updated] = await db.select().from(repoPods).where(eq(repoPods.id, podId));
    if (updated && updated.activeTaskCount <= 0 && updated.podName) {
      getWorkloadManager()
        .patchPodAnnotations(updated.podName, { "karpenter.sh/do-not-disrupt": null })
        .catch((err) => logger.warn({ err }, "Failed to remove do-not-disrupt annotation"));
    }
  }
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

  for (const [repoUrl, repoIdlePods] of podsByRepo) {
    // Sort by instance index descending (remove higher instances first)
    const sorted = repoIdlePods.sort((a, b) => b.instanceIndex - a.instanceIndex);

    // Separate StatefulSet-managed pods from bare pods
    const stsPods = sorted.filter((p) => p.managedBy === "statefulset" && p.statefulSetName);
    const barePods = sorted.filter((p) => p.managedBy !== "statefulset");

    // Handle StatefulSet-managed pods: scale down rather than delete individually
    if (stsPods.length > 0) {
      const stsName = stsPods[0].statefulSetName!;
      // Filter out pods with active sessions
      const cleanable: typeof stsPods = [];
      for (const pod of stsPods) {
        const [activeSession] = await db
          .select({ id: interactiveSessions.id })
          .from(interactiveSessions)
          .where(
            and(eq(interactiveSessions.podId, pod.id), eq(interactiveSessions.state, "active")),
          )
          .limit(1);
        if (!activeSession) cleanable.push(pod);
      }

      if (cleanable.length > 0) {
        try {
          const manager = getWorkloadManager();
          // Count non-idle pods for this repo to determine target replica count
          const allPodsForRepo = await db
            .select()
            .from(repoPods)
            .where(eq(repoPods.repoUrl, repoUrl));
          const activePodCount = allPodsForRepo.filter(
            (p) => !cleanable.some((c) => c.id === p.id),
          ).length;
          const targetReplicas = Math.max(0, activePodCount);

          if (targetReplicas === 0) {
            // No more pods needed — delete StatefulSet entirely
            await manager.deleteStatefulSet(stsName);
          } else {
            await manager.scale(stsName, targetReplicas);
          }

          // Clean up DB records and associated K8s resources
          for (const pod of cleanable) {
            if (pod.podName) {
              await deleteNetworkPolicy(pod.podName).catch(() => {});
            }
            await db.delete(repoPods).where(eq(repoPods.id, pod.id));
            logger.info(
              { repoUrl, podName: pod.podName, instanceIndex: pod.instanceIndex },
              "Cleaned up idle repo pod (StatefulSet scale-down)",
            );
            cleaned++;
          }

          // Clean up Envoy ConfigMap (one per StatefulSet)
          if (targetReplicas === 0) {
            await deleteEnvoyConfigMap(`envoy-config-${stsName}`).catch(() => {});
          }
        } catch (err) {
          logger.warn(
            { err, stsName: stsPods[0].statefulSetName },
            "Failed to scale down StatefulSet",
          );
        }
      }
    }

    // Handle bare pods: existing logic
    for (const pod of barePods) {
      const [activeSession] = await db
        .select({ id: interactiveSessions.id })
        .from(interactiveSessions)
        .where(and(eq(interactiveSessions.podId, pod.id), eq(interactiveSessions.state, "active")))
        .limit(1);
      if (activeSession) {
        logger.info(
          { podName: pod.podName, sessionId: activeSession.id },
          "Skipping idle pod cleanup — active session exists",
        );
        continue;
      }

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
 * Best-effort kill of orphaned agent processes inside a repo pod and worktree cleanup.
 *
 * Used before stale-task re-queue and during startup reconciliation to prevent
 * duplicate agents running in the same worktree. Identifies processes by the
 * OPTIO_TASK_ID env var that the exec script exports.
 *
 * Returns true if processes were found and killed, false otherwise.
 */
export async function killOrphanedAgentInPod(podId: string, taskId: string): Promise<boolean> {
  const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, podId));
  if (!pod || !pod.podName || pod.state !== "ready") return false;

  const rt = getRuntime();
  const handle: ContainerHandle = { id: pod.podId ?? pod.podName, name: pod.podName };

  try {
    // Check pod is actually reachable
    const status = await rt.status(handle);
    if (status.state !== "running") return false;
  } catch {
    return false;
  }

  let killed = false;
  try {
    // Kill any processes whose environment contains OPTIO_TASK_ID=<taskId>.
    // pgrep -f matches against the full command line; we also grep /proc/*/environ
    // as a fallback since env vars aren't always visible in cmdline.
    const killScript = [
      `pids=$(grep -rl "OPTIO_TASK_ID=${taskId}" /proc/*/environ 2>/dev/null | cut -d/ -f3 | sort -u || true)`,
      `if [ -n "$pids" ]; then`,
      `  kill -TERM $pids 2>/dev/null || true`,
      `  sleep 2`,
      `  kill -9 $pids 2>/dev/null || true`,
      `  echo "killed"`,
      `else`,
      `  echo "none"`,
      `fi`,
    ].join("\n");

    const killSession = await rt.exec(handle, ["bash", "-c", killScript], { tty: false });
    let output = "";
    for await (const chunk of killSession.stdout as AsyncIterable<Buffer>) {
      output += chunk.toString();
    }
    killSession.close();
    killed = output.includes("killed");

    if (killed) {
      logger.info({ podId, taskId, podName: pod.podName }, "Killed orphaned agent processes");
    }
  } catch (err) {
    logger.warn({ err, podId, taskId }, "Failed to kill orphaned agent processes");
  }

  // Clean up the worktree regardless of whether processes were found
  try {
    const cleanScript = [
      `cd /workspace/repo`,
      `git worktree remove --force /workspace/tasks/${taskId} 2>/dev/null || true`,
      `rm -rf /workspace/tasks/${taskId}`,
    ].join(" && ");

    const cleanSession = await rt.exec(handle, ["bash", "-c", cleanScript], { tty: false });
    for await (const _ of cleanSession.stdout as AsyncIterable<Buffer>) {
      /* drain */
    }
    cleanSession.close();
  } catch (err) {
    logger.warn({ err, podId, taskId }, "Failed to clean up worktree for orphaned task");
  }

  return killed;
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
