import {
  KubeConfig,
  CoreV1Api,
  Exec,
  Log,
  V1Pod,
  V1Namespace,
  V1ObjectMeta,
  V1PodSpec,
  V1Container,
  V1EnvVar,
  V1ResourceRequirements,
  V1Volume,
  V1VolumeMount as K8sVolumeMount,
  V1HostPathVolumeSource,
  V1PersistentVolumeClaimVolumeSource,
  V1SecurityContext,
  V1Capabilities,
  V1EmptyDirVolumeSource,
} from "@kubernetes/client-node";
import { Readable, Writable, PassThrough } from "node:stream";
import type { ContainerSpec, ContainerHandle, ContainerStatus, ExecSession } from "@optio/shared";
import type { ContainerRuntime, LogOptions, ExecOptions } from "./types.js";

const CONTAINER_NAME = "main";
const POD_READY_TIMEOUT_MS = 120_000;
const POD_READY_POLL_MS = 1_000;

export class KubernetesContainerRuntime implements ContainerRuntime {
  private kubeConfig: KubeConfig;
  private coreApi: CoreV1Api;
  private namespace: string;
  private namespaceEnsured = false;

  constructor(namespace: string = "optio") {
    this.namespace = namespace;
    this.kubeConfig = new KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    await this.ensureNamespace();

    const podName =
      spec.name ??
      `optio-task-${spec.labels["taskId"] ?? spec.labels["task-id"] ?? crypto.randomUUID()}`;

    const env: V1EnvVar[] = Object.entries(spec.env).map(([name, value]) => {
      const envVar = new V1EnvVar();
      envVar.name = name;
      envVar.value = value;
      return envVar;
    });

    const resources = new V1ResourceRequirements();
    if (spec.cpuLimit || spec.memoryLimit || spec.cpuRequest || spec.memoryRequest) {
      const limits: Record<string, string> = {};
      const requests: Record<string, string> = {};
      if (spec.cpuLimit) {
        limits["cpu"] = spec.cpuLimit;
      }
      if (spec.cpuRequest) {
        requests["cpu"] = spec.cpuRequest;
      } else if (spec.cpuLimit) {
        requests["cpu"] = spec.cpuLimit;
      }
      if (spec.memoryLimit) {
        limits["memory"] = spec.memoryLimit;
      }
      if (spec.memoryRequest) {
        requests["memory"] = spec.memoryRequest;
      } else if (spec.memoryLimit) {
        requests["memory"] = spec.memoryLimit;
      }
      if (Object.keys(limits).length) resources.limits = limits;
      if (Object.keys(requests).length) resources.requests = requests;
    }

    const container = new V1Container();
    container.name = CONTAINER_NAME;
    container.image = spec.image;
    container.imagePullPolicy = spec.imagePullPolicy ?? "IfNotPresent";
    container.command = spec.command;
    container.env = env;
    container.workingDir = spec.workDir;
    container.resources = resources;
    container.stdin = true;
    container.tty = true;

    // Build volumes and volume mounts
    const volumes: V1Volume[] = [];
    const volumeMounts: K8sVolumeMount[] = [];

    if (spec.volumes) {
      for (let i = 0; i < spec.volumes.length; i++) {
        const v = spec.volumes[i];
        const volumeName = `vol-${i}`;

        const volume = new V1Volume();
        volume.name = volumeName;

        if (v.hostPath) {
          const hostPath = new V1HostPathVolumeSource();
          hostPath.path = v.hostPath;
          volume.hostPath = hostPath;
        } else if (v.persistentVolumeClaim) {
          const pvc = new V1PersistentVolumeClaimVolumeSource();
          pvc.claimName = v.persistentVolumeClaim;
          volume.persistentVolumeClaim = pvc;
        }

        volumes.push(volume);

        const mount = new K8sVolumeMount();
        mount.name = volumeName;
        mount.mountPath = v.mountPath;
        mount.readOnly = v.readOnly ?? false;
        volumeMounts.push(mount);
      }
    }

    // Add tmpfs mounts (e.g. for Docker-in-Docker storage)
    if (spec.tmpfsMounts) {
      for (let i = 0; i < spec.tmpfsMounts.length; i++) {
        const t = spec.tmpfsMounts[i];
        const volumeName = `tmpfs-${i}`;

        const volume = new V1Volume();
        volume.name = volumeName;
        const emptyDir = new V1EmptyDirVolumeSource();
        emptyDir.medium = "Memory";
        if (t.sizeLimit) {
          emptyDir.sizeLimit = t.sizeLimit;
        }
        volume.emptyDir = emptyDir;
        volumes.push(volume);

        const mount = new K8sVolumeMount();
        mount.name = volumeName;
        mount.mountPath = t.mountPath;
        volumeMounts.push(mount);
      }
    }

    // Add extra volume mounts for the main container (e.g., CA certs from sidecar)
    if (spec.extraVolumeMounts) {
      for (const evm of spec.extraVolumeMounts) {
        const mount = new K8sVolumeMount();
        mount.name = evm.name;
        mount.mountPath = evm.mountPath;
        mount.subPath = evm.subPath;
        mount.readOnly = evm.readOnly ?? false;
        volumeMounts.push(mount);
      }
    }

    // Set security context (capabilities for DinD, etc.)
    if (spec.capabilities && spec.capabilities.length > 0) {
      const secCtx = new V1SecurityContext();
      const caps = new V1Capabilities();
      caps.add = spec.capabilities;
      secCtx.capabilities = caps;
      container.securityContext = secCtx;
    }

    container.volumeMounts = volumeMounts.length > 0 ? volumeMounts : undefined;

    // Add extra volumes (emptyDir, configMap, etc.)
    if (spec.extraVolumes) {
      for (const ev of spec.extraVolumes) {
        volumes.push(ev.raw as V1Volume);
      }
    }

    const podSpec = new V1PodSpec();
    podSpec.containers = [container];

    // Add sidecar containers
    if (spec.sidecarContainers && spec.sidecarContainers.length > 0) {
      for (const sc of spec.sidecarContainers) {
        podSpec.containers.push(sc.raw as V1Container);
      }
    }

    // Add init containers
    if (spec.initContainers && spec.initContainers.length > 0) {
      podSpec.initContainers = spec.initContainers.map((ic) => ic.raw as V1Container);
    }

    podSpec.restartPolicy = "Never";
    podSpec.volumes = volumes.length > 0 ? volumes : undefined;

    // User namespace isolation (K8s 1.33+)
    if (spec.hostUsers === false) {
      podSpec.hostUsers = false;
    }

    const metadata = new V1ObjectMeta();
    metadata.name = podName;
    metadata.namespace = this.namespace;
    metadata.labels = {
      ...spec.labels,
      "app.kubernetes.io/managed-by": "optio",
    };

    const pod = new V1Pod();
    pod.apiVersion = "v1";
    pod.kind = "Pod";
    pod.metadata = metadata;
    pod.spec = podSpec;

    const created = await this.coreApi.createNamespacedPod({
      namespace: this.namespace,
      body: pod,
    });

    const uid = created.metadata?.uid ?? podName;

    // Wait for the pod to reach Running state
    await this.waitForPodRunning(podName);

    return {
      id: uid,
      name: podName,
    };
  }

  async status(handle: ContainerHandle): Promise<ContainerStatus> {
    const pod = await this.coreApi.readNamespacedPodStatus({
      name: handle.name,
      namespace: this.namespace,
    });

    const phase = pod.status?.phase ?? "Unknown";
    const containerStatus = pod.status?.containerStatuses?.[0];
    const state = containerStatus?.state;

    let mappedState: ContainerStatus["state"];
    switch (phase) {
      case "Pending":
        mappedState = "pending";
        break;
      case "Running":
        mappedState = "running";
        break;
      case "Succeeded":
        mappedState = "succeeded";
        break;
      case "Failed":
        mappedState = "failed";
        break;
      default:
        mappedState = "unknown";
        break;
    }

    let exitCode: number | undefined;
    let startedAt: Date | undefined;
    let finishedAt: Date | undefined;
    let reason: string | undefined;

    if (state?.terminated) {
      exitCode = state.terminated.exitCode;
      startedAt = state.terminated.startedAt ? new Date(state.terminated.startedAt) : undefined;
      finishedAt = state.terminated.finishedAt ? new Date(state.terminated.finishedAt) : undefined;
      reason = state.terminated.reason ?? state.terminated.message ?? undefined;
    } else if (state?.running) {
      startedAt = state.running.startedAt ? new Date(state.running.startedAt) : undefined;
    } else if (state?.waiting) {
      reason = state.waiting.reason ?? state.waiting.message ?? undefined;
    }

    // Also check pod-level start time as fallback
    if (!startedAt && pod.status?.startTime) {
      startedAt = new Date(pod.status.startTime);
    }

    // Also check pod-level reason/message as fallback
    if (!reason) {
      reason = pod.status?.reason ?? pod.status?.message ?? undefined;
    }

    return {
      state: mappedState,
      exitCode,
      startedAt,
      finishedAt,
      reason,
    };
  }

  async *logs(handle: ContainerHandle, opts?: LogOptions): AsyncIterable<string> {
    if (opts?.follow) {
      yield* this.followLogs(handle, opts);
    } else {
      const sinceSeconds = opts?.since
        ? Math.max(1, Math.floor((Date.now() - opts.since.getTime()) / 1000))
        : undefined;

      const text = await this.coreApi.readNamespacedPodLog({
        name: handle.name,
        namespace: this.namespace,
        container: CONTAINER_NAME,
        follow: false,
        sinceSeconds,
        tailLines: opts?.tail,
        timestamps: true,
      });

      for (const line of text.split("\n")) {
        if (line.trim()) yield line;
      }
    }
  }

  async exec(handle: ContainerHandle, command: string[], opts?: ExecOptions): Promise<ExecSession> {
    const k8sExec = new Exec(this.kubeConfig);
    const tty = opts?.tty ?? true;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdinStream = new PassThrough();

    const ws = await k8sExec.exec(
      this.namespace,
      handle.name,
      CONTAINER_NAME,
      command,
      stdout,
      stderr,
      stdinStream,
      tty,
    );

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinStream.write(chunk, callback);
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      resize(cols: number, rows: number) {
        // Send a resize message on channel 4 (RESIZE channel in K8s exec protocol).
        // The resize message format is JSON: {"Width": cols, "Height": rows}
        const resizeMsg = JSON.stringify({ Width: cols, Height: rows });
        const buf = Buffer.alloc(1 + Buffer.byteLength(resizeMsg));
        buf.writeUInt8(4, 0); // channel 4 = resize
        buf.write(resizeMsg, 1);
        try {
          ws.send(buf);
        } catch {
          // WebSocket may already be closed
        }
      },
      close() {
        try {
          stdinStream.end();
          ws.close();
        } catch {
          // Ignore errors on close
        }
        stdout.end();
        stderr.end();
      },
    };
  }

  async destroy(handle: ContainerHandle): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedPod({
        name: handle.name,
        namespace: this.namespace,
        gracePeriodSeconds: 10,
      });
    } catch (err: unknown) {
      // If the pod is already gone (404), that is fine
      if (!this.isNotFoundError(err)) {
        throw err;
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.coreApi.listNamespacedPod({ namespace: this.namespace, limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- Private helpers ----

  private async ensureNamespace(): Promise<void> {
    if (this.namespaceEnsured) return;

    try {
      await this.coreApi.readNamespace({ name: this.namespace });
      this.namespaceEnsured = true;
      return;
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) {
        throw err;
      }
    }

    // Namespace doesn't exist — create it
    const ns = new V1Namespace();
    ns.apiVersion = "v1";
    ns.kind = "Namespace";
    const metadata = new V1ObjectMeta();
    metadata.name = this.namespace;
    metadata.labels = { "app.kubernetes.io/managed-by": "optio" };
    ns.metadata = metadata;

    try {
      await this.coreApi.createNamespace({ body: ns });
    } catch (err: unknown) {
      // Another process may have created it concurrently (409 Conflict)
      if (!this.isConflictError(err)) {
        throw err;
      }
    }

    this.namespaceEnsured = true;
  }

  private async waitForPodRunning(podName: string): Promise<void> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const pod = await this.coreApi.readNamespacedPodStatus({
        name: podName,
        namespace: this.namespace,
      });

      const phase = pod.status?.phase;

      if (phase === "Running") {
        return;
      }

      if (phase === "Succeeded" || phase === "Failed") {
        // Pod already terminated — still return; the caller can check status
        return;
      }

      await this.sleep(POD_READY_POLL_MS);
    }

    throw new Error(
      `Timed out waiting for pod "${podName}" to reach Running state after ${POD_READY_TIMEOUT_MS / 1000}s`,
    );
  }

  private async *followLogs(handle: ContainerHandle, opts?: LogOptions): AsyncGenerator<string> {
    const log = new Log(this.kubeConfig);
    const lineStream = new PassThrough({ encoding: "utf-8" });

    const sinceSeconds = opts?.since
      ? Math.max(1, Math.floor((Date.now() - opts.since.getTime()) / 1000))
      : undefined;

    const abortController = await log.log(this.namespace, handle.name, CONTAINER_NAME, lineStream, {
      follow: true,
      sinceSeconds,
      tailLines: opts?.tail,
      timestamps: true,
    });

    try {
      let buffer = "";
      for await (const chunk of lineStream) {
        buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) yield line;
        }
      }
      if (buffer.trim()) yield buffer;
    } finally {
      abortController.abort();
    }
  }

  private isNotFoundError(err: unknown): boolean {
    if (err && typeof err === "object") {
      // The generated client throws HttpError with statusCode or response.httpStatusCode
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
