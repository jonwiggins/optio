/**
 * K8s workload manager for StatefulSets (repo pods) and Jobs (workflow pods).
 *
 * Provides the controller-managed wrappers that Karpenter (and other node
 * autoscalers) require to provision nodes for agent workloads. The existing
 * ContainerRuntime interface is unchanged — exec/status/logs/destroy still
 * operate on individual pods via the runtime.
 */
import {
  KubeConfig,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  V1StatefulSet,
  V1Job,
  V1ObjectMeta,
  V1Service,
  V1ServiceSpec,
  V1ServicePort,
  V1LabelSelector,
  V1PodTemplateSpec,
  V1PodSpec,
  V1Container,
  V1EnvVar,
  V1ResourceRequirements,
  V1Volume,
  V1VolumeMount,
  V1SecurityContext,
  V1PodSecurityContext,
  V1Capabilities,
  V1EmptyDirVolumeSource,
  V1PersistentVolumeClaim,
  V1PersistentVolumeClaimSpec,
  V1VolumeResourceRequirements,
  KubernetesObjectApi,
  PatchStrategy,
} from "@kubernetes/client-node";
import type { ContainerSpec } from "@optio/shared";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";

const NAMESPACE = process.env.OPTIO_NAMESPACE ?? "optio";
const TERMINATION_GRACE_PERIOD = parseIntEnv("OPTIO_TERMINATION_GRACE_PERIOD_SECONDS", 300);
const POD_READY_TIMEOUT_MS = parseIntEnv("OPTIO_POD_READY_TIMEOUT_MS", 300000);
const POD_READY_POLL_MS = 1_000;

export class K8sWorkloadManager {
  private kubeConfig: KubeConfig;
  private appsApi: AppsV1Api;
  private batchApi: BatchV1Api;
  private coreApi: CoreV1Api;
  private objectApi: KubernetesObjectApi;
  private namespace: string;

  constructor(namespace: string = NAMESPACE) {
    this.namespace = namespace;
    this.kubeConfig = new KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.appsApi = this.kubeConfig.makeApiClient(AppsV1Api);
    this.batchApi = this.kubeConfig.makeApiClient(BatchV1Api);
    this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
    this.objectApi = KubernetesObjectApi.makeApiClient(this.kubeConfig);
  }

  // ── StatefulSet methods (repo pods) ─────────────────────────────────────────

  /**
   * Ensure a StatefulSet and its headless Service exist for the given repo.
   * Idempotent — creates if missing, returns current state if already present.
   */
  async ensureStatefulSet(opts: {
    name: string;
    spec: ContainerSpec;
    homePvcSize?: string;
    homePvcStorageClass?: string;
  }): Promise<{ name: string; replicas: number }> {
    const { name, spec, homePvcSize, homePvcStorageClass } = opts;

    logger.info({ name, serviceAccountName: spec.serviceAccountName }, "ensureStatefulSet called");

    // Ensure the headless Service exists
    await this.ensureHeadlessService(name, spec.labels);
    logger.info({ name }, "Headless service ensured");

    // Check if StatefulSet already exists
    let existingSts: V1StatefulSet | null = null;
    try {
      existingSts = await this.appsApi.readNamespacedStatefulSet({
        name,
        namespace: this.namespace,
      });
      logger.info({ name, replicas: existingSts.spec?.replicas }, "StatefulSet already exists");

      // Build desired pod template to compare with existing
      const desiredPodTemplate = this.buildPodTemplate(spec, name, "Always");

      // Check if pod template needs updating (environment variables might have changed)
      const currentEnv = existingSts.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const desiredEnv = desiredPodTemplate.spec?.containers?.[0]?.env ?? [];
      const currentServiceAccount = existingSts.spec?.template?.spec?.serviceAccountName;
      const desiredServiceAccount = desiredPodTemplate.spec?.serviceAccountName;

      const envChanged = JSON.stringify(currentEnv) !== JSON.stringify(desiredEnv);
      const serviceAccountChanged = currentServiceAccount !== desiredServiceAccount;

      if (envChanged || serviceAccountChanged) {
        logger.info(
          { name, envChanged, serviceAccountChanged },
          "StatefulSet pod template needs update",
        );

        // Update the StatefulSet's pod template
        existingSts.spec!.template = desiredPodTemplate;

        await this.appsApi.replaceNamespacedStatefulSet({
          name,
          namespace: this.namespace,
          body: existingSts,
        });
        logger.info({ name }, "StatefulSet pod template updated");
      }

      return {
        name,
        replicas: existingSts.spec?.replicas ?? 0,
      };
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) {
        logger.error({ err, name }, "Error checking StatefulSet existence");
        throw err;
      }
      logger.info({ name }, "StatefulSet does not exist, will create");
    }

    // Build the StatefulSet
    logger.info({ name }, "Building pod template");
    const podTemplate = this.buildPodTemplate(spec, name, "Always");
    logger.info(
      { name, serviceAccountName: podTemplate.spec?.serviceAccountName },
      "Pod template built",
    );
    const matchLabels: Record<string, string> = {
      "app.kubernetes.io/instance": name,
    };

    const sts = new V1StatefulSet();
    sts.apiVersion = "apps/v1";
    sts.kind = "StatefulSet";
    sts.metadata = new V1ObjectMeta();
    sts.metadata.name = name;
    sts.metadata.namespace = this.namespace;
    sts.metadata.labels = {
      "managed-by": "optio",
      "optio.type": "repo-statefulset",
    };

    sts.spec = {
      serviceName: name,
      replicas: 1,
      podManagementPolicy: "Parallel",
      updateStrategy: { type: "OnDelete" },
      selector: { matchLabels } as V1LabelSelector,
      template: podTemplate,
      volumeClaimTemplates: this.buildVolumeClaimTemplates(homePvcSize, homePvcStorageClass),
    };

    logger.info(
      {
        name,
        namespace: this.namespace,
        serviceAccountName: sts.spec?.template.spec?.serviceAccountName,
      },
      "Creating StatefulSet",
    );
    try {
      await this.appsApi.createNamespacedStatefulSet({
        namespace: this.namespace,
        body: sts,
      });
      logger.info({ name }, "StatefulSet created successfully");
    } catch (err: unknown) {
      logger.error({ err, name, namespace: this.namespace }, "Error creating StatefulSet");
      // Another API replica may have created it concurrently (409 Conflict)
      if (this.isConflictError(err)) {
        logger.info({ name }, "StatefulSet already exists (conflict), reading existing");
        const existing = await this.appsApi.readNamespacedStatefulSet({
          name,
          namespace: this.namespace,
        });
        return { name, replicas: existing.spec?.replicas ?? 0 };
      }
      throw err;
    }

    return { name, replicas: 1 };
  }

  /**
   * Scale a StatefulSet to the target replica count.
   */
  async scale(name: string, replicas: number): Promise<void> {
    const currentScale = await this.appsApi.readNamespacedStatefulSetScale({
      name,
      namespace: this.namespace,
    });
    currentScale.spec = { ...currentScale.spec, replicas };
    await this.appsApi.replaceNamespacedStatefulSetScale({
      name,
      namespace: this.namespace,
      body: currentScale,
    });
    logger.info({ name, replicas }, "StatefulSet scaled");
  }

  /**
   * Get the current replica count and ready count for a StatefulSet.
   */
  async getScale(name: string): Promise<{ replicas: number; ready: number }> {
    const sts = await this.appsApi.readNamespacedStatefulSet({ name, namespace: this.namespace });
    return {
      replicas: sts.spec?.replicas ?? 0,
      ready: sts.status?.readyReplicas ?? 0,
    };
  }

  /**
   * Get the pod name for a specific ordinal in a StatefulSet.
   */
  static podNameForOrdinal(statefulSetName: string, ordinal: number): string {
    return `${statefulSetName}-${ordinal}`;
  }

  /**
   * Delete a StatefulSet and its headless Service.
   * PVCs created by volumeClaimTemplates are NOT deleted (they persist for reuse).
   */
  async deleteStatefulSet(name: string): Promise<void> {
    try {
      await this.appsApi.deleteNamespacedStatefulSet({ name, namespace: this.namespace });
      logger.info({ name }, "StatefulSet deleted");
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }

    try {
      await this.coreApi.deleteNamespacedService({ name, namespace: this.namespace });
      logger.info({ name }, "Headless Service deleted");
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }
  }

  // ── Job methods (workflow pods) ─────────────────────────────────────────────

  /**
   * Create a K8s Job for a workflow run. Returns the Job name and pod name
   * once the pod is running.
   */
  async createJob(opts: {
    name: string;
    spec: ContainerSpec;
  }): Promise<{ jobName: string; podName: string; podId: string }> {
    const { name, spec } = opts;
    const podTemplate = this.buildPodTemplate(spec, name, "Never");
    const matchLabels: Record<string, string> = {
      "app.kubernetes.io/instance": name,
    };

    const job = new V1Job();
    job.apiVersion = "batch/v1";
    job.kind = "Job";
    job.metadata = new V1ObjectMeta();
    job.metadata.name = name;
    job.metadata.namespace = this.namespace;
    job.metadata.labels = {
      "managed-by": "optio",
      "optio.type": "workflow-job",
    };

    job.spec = {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      selector: { matchLabels } as V1LabelSelector,
      manualSelector: true,
      template: podTemplate,
    };

    try {
      await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: job,
      });
      logger.info({ name }, "Job created");
    } catch (err: unknown) {
      if (this.isConflictError(err)) {
        logger.info({ name }, "Job already exists (concurrent creation)");
      } else {
        throw err;
      }
    }

    // Wait for the Job's pod to appear and be running
    const podName = await this.waitForJobPod(name);
    const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace: this.namespace });
    const podId = pod.metadata?.uid ?? podName;

    return { jobName: name, podName, podId };
  }

  /**
   * Delete a Job (cascades to its pod).
   */
  async deleteJob(jobName: string): Promise<void> {
    try {
      await this.batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        propagationPolicy: "Foreground",
      } as any);
      logger.info({ jobName }, "Job deleted");
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }
  }

  /**
   * Look up the pod name for a Job.
   */
  async getJobPodName(jobName: string): Promise<string | null> {
    const pods = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });
    return pods.items?.[0]?.metadata?.name ?? null;
  }

  // ── Shared: annotation patching ─────────────────────────────────────────────

  /**
   * Patch annotations on a specific pod. Pass null as value to remove a key.
   */
  async patchPodAnnotations(
    podName: string,
    annotations: Record<string, string | null>,
  ): Promise<void> {
    const patch: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(annotations)) {
      patch[key] = value;
    }

    try {
      await this.objectApi.patch(
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: podName,
            namespace: this.namespace,
            annotations: patch,
          },
        } as any,
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch,
      );
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) {
        logger.warn({ err, podName }, "Failed to patch pod annotations");
      }
    }
  }

  /**
   * Wait for a specific pod to reach Running state.
   */
  async waitForPodRunning(podName: string, timeoutMs = POD_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    logger.info({ podName, timeoutMs }, "Waiting for pod to reach Running state");

    let lastPhase: string | undefined;
    while (Date.now() < deadline) {
      try {
        const pod = await this.coreApi.readNamespacedPodStatus({
          name: podName,
          namespace: this.namespace,
        });
        const phase = pod.status?.phase;
        if (phase !== lastPhase) {
          logger.info({ podName, phase, conditions: pod.status?.conditions }, "Pod phase changed");
          lastPhase = phase;
        }
        if (phase === "Running") {
          logger.info({ podName }, "Pod is Running");
          return;
        }
        if (phase === "Succeeded" || phase === "Failed") {
          logger.info({ podName, phase }, "Pod reached terminal state");
          return;
        }
      } catch (err: unknown) {
        // Pod may not exist yet (StatefulSet scaling up)
        if (!this.isNotFoundError(err)) {
          logger.error({ err, podName }, "Error reading pod status");
          throw err;
        }
        if (lastPhase !== "NotFound") {
          logger.info({ podName }, "Pod not found yet");
          lastPhase = "NotFound";
        }
      }

      await this.sleep(POD_READY_POLL_MS);
    }

    logger.error({ podName, timeoutMs }, "Timed out waiting for pod");
    throw new Error(
      `Timed out waiting for pod "${podName}" to reach Running state after ${timeoutMs / 1000}s`,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async ensureHeadlessService(
    name: string,
    podLabels: Record<string, string>,
  ): Promise<void> {
    try {
      await this.coreApi.readNamespacedService({ name, namespace: this.namespace });
      return; // Already exists
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }

    const svc = new V1Service();
    svc.apiVersion = "v1";
    svc.kind = "Service";
    svc.metadata = new V1ObjectMeta();
    svc.metadata.name = name;
    svc.metadata.namespace = this.namespace;
    svc.metadata.labels = {
      "managed-by": "optio",
      "optio.type": "repo-headless-svc",
    };

    const port = new V1ServicePort();
    port.port = 80;
    port.name = "http";

    const spec = new V1ServiceSpec();
    spec.clusterIP = "None";
    spec.selector = { "app.kubernetes.io/instance": name };
    spec.ports = [port];
    svc.spec = spec;

    try {
      await this.coreApi.createNamespacedService({ namespace: this.namespace, body: svc });
      logger.info({ name }, "Headless Service created");
    } catch (err: unknown) {
      // Another replica may have created it
      if (!this.isConflictError(err)) throw err;
    }
  }

  private buildPodTemplate(
    spec: ContainerSpec,
    instanceName: string,
    restartPolicy: "Always" | "Never",
  ): V1PodTemplateSpec {
    // Build container env
    const env: V1EnvVar[] = Object.entries(spec.env).map(([name, value]) => {
      const envVar = new V1EnvVar();
      envVar.name = name;
      envVar.value = value;
      return envVar;
    });

    // Build resources
    const resources = new V1ResourceRequirements();
    const limits: Record<string, string> = {};
    const requests: Record<string, string> = {};
    if (spec.cpuLimit) limits["cpu"] = spec.cpuLimit;
    if (spec.cpuRequest) requests["cpu"] = spec.cpuRequest;
    else if (spec.cpuLimit) requests["cpu"] = spec.cpuLimit;
    if (spec.memoryLimit) limits["memory"] = spec.memoryLimit;
    if (spec.memoryRequest) requests["memory"] = spec.memoryRequest;
    else if (spec.memoryLimit) requests["memory"] = spec.memoryLimit;
    if (Object.keys(limits).length) resources.limits = limits;
    if (Object.keys(requests).length) resources.requests = requests;

    // Build main container
    const container = new V1Container();
    container.name = "main";
    container.image = spec.image;
    container.imagePullPolicy = spec.imagePullPolicy ?? "IfNotPresent";
    container.command = spec.command;
    container.env = env;
    container.workingDir = spec.workDir;
    container.resources = resources;
    container.stdin = true;
    container.tty = true;

    // Security context
    const secCtx = new V1SecurityContext();
    const caps = new V1Capabilities();
    caps.drop = ["ALL"];
    if (spec.capabilities && spec.capabilities.length > 0) {
      caps.add = spec.capabilities;
    }
    secCtx.capabilities = caps;
    container.securityContext = secCtx;

    // Build volumes and mounts
    const volumes: V1Volume[] = [];
    const volumeMounts: V1VolumeMount[] = [];

    if (spec.volumes) {
      for (let i = 0; i < spec.volumes.length; i++) {
        const v = spec.volumes[i];
        const volumeName = `vol-${i}`;
        const volume = new V1Volume();
        volume.name = volumeName;
        if (v.persistentVolumeClaim) {
          volume.persistentVolumeClaim = { claimName: v.persistentVolumeClaim };
        }
        volumes.push(volume);

        const mount = new V1VolumeMount();
        mount.name = volumeName;
        mount.mountPath = v.mountPath;
        mount.readOnly = v.readOnly ?? false;
        volumeMounts.push(mount);
      }
    }

    // Tmpfs mounts
    if (spec.tmpfsMounts) {
      for (let i = 0; i < spec.tmpfsMounts.length; i++) {
        const t = spec.tmpfsMounts[i];
        const volumeName = `tmpfs-${i}`;
        const volume = new V1Volume();
        volume.name = volumeName;
        const emptyDir = new V1EmptyDirVolumeSource();
        emptyDir.medium = "Memory";
        if (t.sizeLimit) emptyDir.sizeLimit = t.sizeLimit;
        volume.emptyDir = emptyDir;
        volumes.push(volume);

        const mount = new V1VolumeMount();
        mount.name = volumeName;
        mount.mountPath = t.mountPath;
        volumeMounts.push(mount);
      }
    }

    // Extra volume mounts for main container
    if (spec.extraVolumeMounts) {
      for (const evm of spec.extraVolumeMounts) {
        const mount = new V1VolumeMount();
        mount.name = evm.name;
        mount.mountPath = evm.mountPath;
        mount.subPath = evm.subPath;
        mount.readOnly = evm.readOnly ?? false;
        volumeMounts.push(mount);
      }
    }

    // For StatefulSets, add volumeClaimTemplate mount for home directory
    if (restartPolicy === "Always") {
      const mount = new V1VolumeMount();
      mount.name = "home";
      mount.mountPath = "/home/agent";
      volumeMounts.push(mount);
    }

    container.volumeMounts = volumeMounts.length > 0 ? volumeMounts : undefined;

    // Extra volumes (emptyDir, configMap, etc.)
    if (spec.extraVolumes) {
      for (const ev of spec.extraVolumes) {
        volumes.push(ev.raw as V1Volume);
      }
    }

    // Build pod spec
    const podSpec = new V1PodSpec();
    podSpec.containers = [container];
    podSpec.restartPolicy = restartPolicy;
    podSpec.terminationGracePeriodSeconds =
      spec.terminationGracePeriodSeconds ?? TERMINATION_GRACE_PERIOD;
    podSpec.volumes = volumes.length > 0 ? volumes : undefined;

    if (spec.hostUsers === false) {
      podSpec.hostUsers = false;
    }
    if (spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0) {
      podSpec.nodeSelector = spec.nodeSelector;
    }
    if (spec.tolerations && spec.tolerations.length > 0) {
      podSpec.tolerations = spec.tolerations as V1PodSpec["tolerations"];
    }
    if (spec.serviceAccountName) {
      podSpec.serviceAccountName = spec.serviceAccountName;
    }

    // Pod-level security context for StatefulSets — ensures PVC mounts are
    // writable by the agent user (UID/GID 1001). fsGroup sets the group owner
    // of all files in mounted volumes. UID 1001 matches the `agent` user
    // created in images/base.Dockerfile and owns /workspace in the image.
    if (restartPolicy === "Always") {
      const podSecCtx = new V1PodSecurityContext();
      podSecCtx.fsGroup = 1001;
      podSecCtx.runAsUser = 1001;
      podSecCtx.runAsGroup = 1001;
      podSpec.securityContext = podSecCtx;
    }

    // Sidecar containers
    if (spec.sidecarContainers && spec.sidecarContainers.length > 0) {
      for (const sc of spec.sidecarContainers) {
        podSpec.containers.push(sc.raw as V1Container);
      }
    }

    // Init containers
    const initContainers: V1Container[] = [];

    // For StatefulSets, prepend an initContainer that chowns the home PVC
    // mount to UID 1001 (the `agent` user in images/base.Dockerfile). This
    // is necessary because some storage classes (docker-desktop's hostpath,
    // GKE default) don't honor the pod's fsGroup setting, leaving the mount
    // root-owned and unwritable by the main container. Running chown as
    // root (UID 0) here is safe — it only touches the volume mount before
    // the main container starts.
    if (restartPolicy === "Always") {
      const permInit = new V1Container();
      permInit.name = "home-perm-fix";
      permInit.image = spec.image;
      permInit.imagePullPolicy = spec.imagePullPolicy ?? "IfNotPresent";
      permInit.command = ["sh", "-c", "chown -R 1001:1001 /home/agent && chmod 755 /home/agent"];
      const initSec = new V1SecurityContext();
      initSec.runAsUser = 0;
      initSec.runAsGroup = 0;
      initSec.capabilities = new V1Capabilities();
      initSec.capabilities.drop = ["ALL"];
      initSec.capabilities.add = ["CHOWN", "FOWNER", "DAC_OVERRIDE"];
      permInit.securityContext = initSec;
      const initMount = new V1VolumeMount();
      initMount.name = "home";
      initMount.mountPath = "/home/agent";
      permInit.volumeMounts = [initMount];
      initContainers.push(permInit);
    }

    if (spec.initContainers && spec.initContainers.length > 0) {
      for (const ic of spec.initContainers) {
        initContainers.push(ic.raw as V1Container);
      }
    }
    if (initContainers.length > 0) {
      podSpec.initContainers = initContainers;
    }

    // Build labels for the template
    const templateLabels: Record<string, string> = {
      ...spec.labels,
      "app.kubernetes.io/managed-by": "optio",
      "app.kubernetes.io/instance": instanceName,
    };

    const template: V1PodTemplateSpec = {
      metadata: {
        labels: templateLabels,
        ...(spec.annotations && Object.keys(spec.annotations).length > 0
          ? { annotations: spec.annotations }
          : {}),
      },
      spec: podSpec,
    };

    return template;
  }

  private buildVolumeClaimTemplates(
    sizeGi?: string,
    storageClass?: string,
  ): V1PersistentVolumeClaim[] {
    const pvc = new V1PersistentVolumeClaim();
    pvc.metadata = new V1ObjectMeta();
    pvc.metadata.name = "home";
    pvc.metadata.labels = {
      "managed-by": "optio",
      "optio.type": "home-pvc",
    };

    const pvcSpec = new V1PersistentVolumeClaimSpec();
    pvcSpec.accessModes = ["ReadWriteOnce"];

    const resources = new V1VolumeResourceRequirements();
    resources.requests = { storage: sizeGi ?? "10Gi" };
    pvcSpec.resources = resources;

    if (storageClass) {
      pvcSpec.storageClassName = storageClass;
    }

    pvc.spec = pvcSpec;
    return [pvc];
  }

  private async waitForJobPod(jobName: string, timeoutMs = POD_READY_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Workflow pods are labeled with `app.kubernetes.io/instance=${jobName}`
      // (set by our pod template builder). The standard K8s `job-name` label
      // isn't reliably added by the Job controller here, so we use the more
      // specific instance label we control.
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `app.kubernetes.io/instance=${jobName}`,
      });

      if (pods.items && pods.items.length > 0) {
        const pod = pods.items[0];
        const podName = pod.metadata?.name;
        const phase = pod.status?.phase;

        if (podName && (phase === "Running" || phase === "Succeeded" || phase === "Failed")) {
          return podName;
        }
        if (podName && phase === "Pending") {
          // Pod exists but not ready yet, keep waiting
        }
      }

      await this.sleep(POD_READY_POLL_MS);
    }

    throw new Error(
      `Timed out waiting for Job "${jobName}" pod to be Running after ${timeoutMs / 1000}s`,
    );
  }

  private isNotFoundError(err: unknown): boolean {
    if (err && typeof err === "object") {
      if ("statusCode" in err && (err as { statusCode: number }).statusCode === 404) return true;
      if ("code" in err && (err as { code: number }).code === 404) return true;
      if (
        "response" in err &&
        err.response &&
        typeof err.response === "object" &&
        "httpStatusCode" in err.response &&
        (err.response as { httpStatusCode: number }).httpStatusCode === 404
      ) {
        return true;
      }
    }
    return false;
  }

  private isConflictError(err: unknown): boolean {
    if (err && typeof err === "object") {
      if ("statusCode" in err && (err as { statusCode: number }).statusCode === 409) return true;
      if ("code" in err && (err as { code: number }).code === 409) return true;
      if (
        "response" in err &&
        err.response &&
        typeof err.response === "object" &&
        "httpStatusCode" in err.response &&
        (err.response as { httpStatusCode: number }).httpStatusCode === 409
      ) {
        return true;
      }
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Singleton instance, lazily initialized. */
let _manager: K8sWorkloadManager | null = null;

export function getWorkloadManager(): K8sWorkloadManager {
  if (!_manager) {
    _manager = new K8sWorkloadManager();
  }
  return _manager;
}

/** Whether the StatefulSet/Job workload mode is enabled. */
export function isStatefulSetEnabled(): boolean {
  return process.env.OPTIO_STATEFULSET_ENABLED !== "false";
}
