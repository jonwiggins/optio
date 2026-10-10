import { agentNodePlacement } from "./agent-node-placement.js";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentPods, tasks, interactiveSessions, workspaces } from "../db/schema.js";
import * as podPool from "./agent-pod-pool.js";
import { podIsolationKey, isolatedPodResource, type PodIsolation } from "./pod-isolation.js";
import { getRuntime } from "./container-service.js";
import type { ContainerHandle, ContainerSpec, ExecSession, RepoImageConfig } from "@optio/shared";
import {
  DEFAULT_AGENT_IMAGE,
  PRESET_IMAGES,
  generateRepoPodName,
  normalizeRepoUrl,
  shellQuote,
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
import { buildEnvExports, RUN_WORK_SETUP_COMMANDS, WRITE_SETUP_FILES } from "../utils/pod-env.js";
import { REMOVE_RUN_HOME, removeRunHome } from "../utils/harness-config.js";
import { resolveSecretsForSetup, workspaceRestrictsPodSecrets } from "./secret-service.js";

/** The run env a repo pod starts with: git sign-in and the repo's setup. */
const POD_ENV_KEYS = [
  "OPTIO_GIT_CREDENTIAL_URL",
  "OPTIO_CREDENTIAL_SECRET",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_HOST",
  "OPTIO_EXTRA_PACKAGES",
  "OPTIO_SETUP_COMMANDS",
] as const;

/**
 * The env a repo pod starts with (repo-init.sh), from a run's env: git
 * sign-in, the repo's packages and setup commands, the GitHub App's bot
 * identity, and the secrets setup may use (repo-scoped over global; the
 * organization's only when the workspace doesn't restrict pods to the
 * secrets work picks). Never the run's own secrets — the pod is shared
 * across runs and users; those travel only in each run's exec env.
 */
export async function repoPodEnv(
  runEnv: Record<string, string>,
  repoUrl: string,
  workspaceId: string | null,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of POD_ENV_KEYS) if (runEnv[key]) env[key] = runEnv[key];
  if (process.env.GITHUB_APP_BOT_NAME) env.GITHUB_APP_BOT_NAME = process.env.GITHUB_APP_BOT_NAME;
  if (process.env.GITHUB_APP_BOT_EMAIL) env.GITHUB_APP_BOT_EMAIL = process.env.GITHUB_APP_BOT_EMAIL;
  const setupSecrets = await resolveSecretsForSetup(repoUrl, workspaceId, {
    orgSecrets: !(await workspaceRestrictsPodSecrets(workspaceId)),
  });
  return { ...env, ...setupSecrets };
}

const IDLE_TIMEOUT_MS = parseIntEnv("OPTIO_REPO_POD_IDLE_MS", 600000); // 10 min default
const REPO_INIT_TIMEOUT_MS = parseIntEnv("OPTIO_REPO_INIT_TIMEOUT_MS", 120000); // 2 min default
if (Number.isNaN(REPO_INIT_TIMEOUT_MS) || REPO_INIT_TIMEOUT_MS <= 0) {
  throw new Error("OPTIO_REPO_INIT_TIMEOUT_MS must be a positive integer");
}

function getServiceAccountName(): string | undefined {
  return process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME;
}

/** A repo's pod: an `agent_pods` row with pool "repo", keyed by the normalized repo URL. */
export type RepoPod = podPool.AgentPod;

/**
 * A repo pod in the shape the cluster API has always served it (the web's
 * cluster pages and the apps' Insights decode these field names).
 */
export function repoPodView(pod: RepoPod) {
  return {
    id: pod.id,
    repoUrl: pod.poolKey,
    workspaceId: pod.workspaceId,
    repoBranch: pod.repoBranch ?? "main",
    instanceIndex: pod.instanceIndex,
    podName: pod.podName,
    podId: pod.podId,
    state: pod.state,
    activeTaskCount: pod.activeCount,
    lastTaskAt: pod.lastUsedAt,
    errorMessage: pod.errorMessage,
    cachePvcName: pod.cachePvcName,
    cachePvcState: pod.cachePvcState,
    statefulSetName: pod.statefulSetName,
    managedBy: pod.managedBy,
    createdAt: pod.createdAt,
    updatedAt: pod.updatedAt,
  };
}

/** One repo pod by id in its cluster-API shape; null for a miss or another pool's pod. */
export async function getRepoPodView(id: string) {
  const pod = await podPool.getPod(id);
  return pod?.pool === "repo" ? repoPodView(pod) : null;
}

/** Repo pods, optionally only those recorded under a workspace. */
export async function listRepoPodViews(workspaceId?: string | null) {
  const pods = await podPool.listPods("repo");
  return pods.filter((p) => !workspaceId || p.workspaceId === workspaceId).map(repoPodView);
}

/**
 * Select (or create) a repo pod for the given repo URL — agent-pod-pool's
 * pickPod over the repo's pods (retry affinity, least-loaded, scale out to
 * `maxPodInstances`), creating a bare pod or a StatefulSet replica.
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
    ownerUserId?: string | null;
    isolationPurpose?: string;
    credentialProfile?: unknown;
  },
): Promise<RepoPod> {
  return withSpan("k8s.pod.get_or_create", { "k8s.repo_url": rawRepoUrl }, async () => {
    const repoUrl = normalizeRepoUrl(rawRepoUrl);
    const createFn = isStatefulSetEnabled() ? createRepoPodViaStatefulSet : createRepoPod;
    return podPool.pickPod("repo", repoUrl, {
      isolationKey: podIsolationKey(opts ?? {}),
      preferredPodId: opts?.preferredPodId,
      maxAgentsPerPod: opts?.maxAgentsPerPod ?? 2,
      maxPodInstances: opts?.maxPodInstances ?? 1,
      create: (instanceIndex) =>
        createFn(
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
          opts,
        ),
    });
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
  isolation: PodIsolation = {},
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

  const isolationKey = podIsolationKey({ ...isolation, workspaceId });
  const record = await podPool.insertPod({
    isolationKey,
    workspaceId,
    pool: "repo",
    poolKey: repoUrl,
    repoBranch,
    instanceIndex,
  });

  const rt = getRuntime();
  const image = resolveImage(imageConfig);

  const pvcSuffix = instanceIndex > 0 ? `-${instanceIndex}` : "";
  const pvcName = `${isolatedPodResource("optio-home", repoUrl, isolationKey)}${pvcSuffix}`;
  let pvcReady = false;
  const namespace = process.env.OPTIO_NAMESPACE ?? "optio";
  // PVCs only exist for the kubernetes runtime. In docker/fake mode the
  // kubectl shell-out would target whatever cluster the local kubeconfig
  // points at — creating real PVCs from dev/test runs.
  if (process.env.OPTIO_RUNTIME === "kubernetes") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      // Check if PVC already exists
      try {
        await execFileAsync("kubectl", ["get", "pvc", pvcName, "-n", namespace]);
        pvcReady = true;
      } catch {
        // PVC doesn't exist, create it
        const pvcManifest = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: ${namespace}
  labels:
    managed-by: optio
    optio.type: home-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi`;
        // Use bash -c with heredoc since execFile doesn't support stdin input
        await execFileAsync("bash", [
          "-c",
          `echo '${pvcManifest}' | kubectl apply -f - -n ${namespace}`,
        ]);
        pvcReady = true;
        logger.info({ pvcName }, "Created PVC for repo pod home directory");
      }
    } catch (err) {
      logger.warn({ err, pvcName }, "Failed to create PVC, pod will use ephemeral storage");
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
      cacheInfo = await ensureCachePvcForPod(repoUrl, instanceIndex, sharedDirs, isolationKey);
      if (cacheInfo) {
        await db
          .update(agentPods)
          .set({
            cachePvcName: cacheInfo.pvcName,
            cachePvcState: "bound",
            updatedAt: new Date(),
          })
          .where(eq(agentPods.id, record.id));
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
        "optio.isolation": isolationKey,
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
      ...agentNodePlacement(),
      ...(getServiceAccountName() ? { serviceAccountName: getServiceAccountName() } : {}),
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

    const ready = await podPool.markPodReady(record.id, {
      podName: handle.name,
      podId: handle.id,
    });

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

    return ready;
  } catch (err) {
    await podPool.markPodError(record.id, err);

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
  isolation: PodIsolation = {},
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

  const isolationKey = podIsolationKey({ ...isolation, workspaceId });
  const stsName = isolatedPodResource("optio-repo", repoUrl, isolationKey);
  const podName = K8sWorkloadManager.podNameForOrdinal(stsName, instanceIndex);

  const record = await podPool.insertPod({
    pool: "repo",
    poolKey: repoUrl,
    repoBranch,
    instanceIndex,
    isolationKey,
    workspaceId,
    statefulSetName: stsName,
    managedBy: "statefulset",
  });

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
        "optio.isolation": isolationKey,
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
      ...agentNodePlacement(),
      ...(getServiceAccountName() ? { serviceAccountName: getServiceAccountName() } : {}),
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
        cacheInfo = await ensureCachePvcForPod(repoUrl, instanceIndex, sharedDirs, isolationKey);
        if (cacheInfo) {
          await db
            .update(agentPods)
            .set({
              cachePvcName: cacheInfo.pvcName,
              cachePvcState: "bound",
              updatedAt: new Date(),
            })
            .where(eq(agentPods.id, record.id));
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
        SERVICE_ACCOUNT_NAME_ENV: getServiceAccountName(),
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

    const ready = await podPool.markPodReady(record.id, { podName, podId });

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

    return ready;
  } catch (err) {
    await podPool.markPodError(record.id, err);
    throw err;
  }
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

      // Take a slot on the pod
      await podPool.acquireSlot(pod.id);

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

      // Build the exec command. Env values (including the task prompt) are
      // embedded as inert single-quoted exports — see buildEnvExports.
      const envExports = buildEnvExports({
        ...env,
        OPTIO_TASK_ID: taskId,
        REPO_INIT_TIMEOUT_SECS: String(Math.ceil(REPO_INIT_TIMEOUT_MS / 1000)),
      });
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
            removeRunHome(taskId),
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
        ...envExports,
        `exec 7>${shellQuote(`/workspace/.task-${taskId}.lock`)}`,
        "flock -n 7 || { echo 'Previous task process is still running; inspect it before retrying.' >&2; exit 75; }",
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
        ...WRITE_SETUP_FILES,
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
        // The run's own home (its runtime's MCP config, Codex / Gemini session
        // files) goes with the run; a retry writes it afresh (harness-config.ts).
        `trap 'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; cd /workspace/repo 2>/dev/null; git worktree remove --force /workspace/tasks/${taskId}-wt 2>/dev/null || true; git worktree prune 2>/dev/null || true; ${REMOVE_RUN_HOME}' EXIT`,
        // Background heartbeat: detect broken stdout pipe (EPIPE) from severed exec stream.
        // Writes an empty line every 30s (skipped by the NDJSON parser). If stdout is broken
        // (API pod died), sends SIGTERM to the main script which triggers the EXIT trap.
        `(trap '' PIPE; while sleep 30; do printf '\\n' 2>/dev/null || { kill -TERM $_optio_main_pid 2>/dev/null; exit; }; done) &`,
        ...RUN_WORK_SETUP_COMMANDS,
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
  const updated = await podPool.releaseSlot(podId);

  // Remove do-not-disrupt when pod becomes idle (allow Karpenter consolidation)
  if (isStatefulSetEnabled()) {
    if (updated && updated.activeCount <= 0 && updated.podName) {
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

  const idlePods = await podPool.idlePods("repo", cutoff);

  const rt = getRuntime();
  let cleaned = 0;

  // Group by repoUrl to implement scale-down logic
  const podsByRepo = new Map<string, (typeof idlePods)[number][]>();
  for (const pod of idlePods) {
    const key = JSON.stringify([pod.poolKey, pod.isolationKey]);
    const existing = podsByRepo.get(key) ?? [];
    existing.push(pod);
    podsByRepo.set(key, existing);
  }

  for (const repoIdlePods of podsByRepo.values()) {
    const repoUrl = repoIdlePods[0].poolKey;
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
          const allPodsForRepo = (await podPool.listPods("repo", repoUrl)).filter(
            (p) => p.statefulSetName === stsName,
          );
          const retained = allPodsForRepo.filter((p) => !cleanable.some((c) => c.id === p.id));
          // A StatefulSet removes the highest ordinals, never arbitrary holes.
          // An idle ordinal below a live one must stay until the tail is idle.
          const targetReplicas = retained.length
            ? Math.max(...retained.map((p) => p.instanceIndex)) + 1
            : 0;
          const removable = cleanable.filter((p) => p.instanceIndex >= targetReplicas);
          if (!removable.length) continue;

          if (targetReplicas === 0) {
            // No more pods needed — delete StatefulSet entirely
            await manager.deleteStatefulSet(stsName);
          } else {
            await manager.scale(stsName, targetReplicas);
          }

          // Clean up DB records and associated K8s resources
          for (const pod of removable) {
            if (pod.podName) {
              await deleteNetworkPolicy(pod.podName).catch(() => {});
            }
            await podPool.deletePod(pod.id);
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
        await podPool.deletePod(pod.id);
        logger.info(
          { repoUrl: pod.poolKey, podName: pod.podName, instanceIndex: pod.instanceIndex },
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
  return podPool.listPods("repo");
}

/**
 * List all repo pods for a specific repo URL.
 */
export async function listRepoPodsForRepo(repoUrl: string): Promise<RepoPod[]> {
  return podPool.listPods("repo", repoUrl);
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
  const pod = await podPool.getPod(podId);
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

  // Retain the checkout: cancellation and worker recovery must not discard
  // uncommitted changes. The normal retention policy can clean it later.
  return killed;
}

/**
 * The task's pushed branches in a repo pod: remote-tracking refs and local
 * branches with an upstream under `optio/task-<id>` (its own branch and any
 * extra `optio/task-<id>-<slug>` / `optio/task-<id>/<slug>` ones). Used after
 * a run to find PRs the agent opened from branches other than its own.
 * Best-effort: [] when the pod can't be reached.
 */
export async function listTaskBranchesInPod(podId: string, taskId: string): Promise<string[]> {
  if (!/^[A-Za-z0-9-]+$/.test(taskId)) return [];
  const pod = await podPool.getPod(podId);
  if (!pod || !pod.podName) return [];
  const rt = getRuntime();
  const handle = podPool.podHandle(pod);
  const prefix = `optio/task-${taskId}`;
  const script = [
    `cd /workspace/repo 2>/dev/null || exit 0`,
    `git for-each-ref --format='%(refname:lstrip=3)' 'refs/remotes/origin/${prefix}*' 2>/dev/null`,
    `git for-each-ref --format='%(refname:lstrip=2) %(upstream)' 'refs/heads/${prefix}*' 2>/dev/null | awk '$2 != "" { print $1 }'`,
  ].join("\n");
  try {
    const session = await rt.exec(handle, ["bash", "-c", script], { tty: false });
    let output = "";
    for await (const chunk of session.stdout as AsyncIterable<Buffer>) {
      output += chunk.toString();
      if (output.length > 64 * 1024) break;
    }
    session.close();
    const branches = output
      .split("\n")
      .map((l) => l.trim())
      .filter((b) => b === prefix || b.startsWith(`${prefix}-`) || b.startsWith(`${prefix}/`));
    return [...new Set(branches)].slice(0, 20);
  } catch (err) {
    logger.debug({ err, podId, taskId }, "Failed to list task branches in pod");
    return [];
  }
}

/**
 * Reconcile each repo pod's active count (`agent_pods.active_count`) to match
 * actual running/provisioning tasks.
 *
 * The stored counter can drift if the worker process is killed before the finally
 * block decrements it. This function resets each pod's counter to the real count
 * of tasks in running/provisioning state that reference that pod via lastPodId.
 */
export async function reconcileActiveTaskCounts(): Promise<number> {
  const rows = await db
    .select({ podId: tasks.lastPodId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.state} IN ('running', 'provisioning') AND ${tasks.lastPodId} IS NOT NULL`)
    .groupBy(tasks.lastPodId);
  return podPool.reconcileActiveCounts("repo", new Map(rows.map((r) => [r.podId as string, r.n])));
}
