export interface ContainerSpec {
  image: string;
  command: string[];
  env: Record<string, string>;
  workDir: string;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  labels: Record<string, string>;
  volumes?: VolumeMount[];
  networkMode?: string;
  imagePullPolicy?: "Always" | "Never" | "IfNotPresent";
  /** Optional pod name override. If not set, the runtime generates one. */
  name?: string;
  /** Set to false to enable K8s user namespace isolation (hostUsers: false). */
  hostUsers?: boolean;
  /** Linux capabilities to add to the container security context. */
  capabilities?: string[];
  /** Tmpfs mounts (memory-backed volumes) for the container. */
  tmpfsMounts?: { mountPath: string; sizeLimit?: string }[];
  /** Optional sidecar containers added alongside the main container. */
  sidecarContainers?: SidecarContainer[];
  /** Optional init containers that run before the main container starts. */
  initContainers?: SidecarContainer[];
  /** Optional raw K8s volumes (for emptyDir, configMap, etc.). */
  extraVolumes?: ExtraVolume[];
  /** Optional extra volume mounts for the main container. */
  extraVolumeMounts?: ExtraVolumeMount[];
}

export interface VolumeMount {
  hostPath?: string;
  persistentVolumeClaim?: string;
  mountPath: string;
  readOnly?: boolean;
}

/** A sidecar or init container definition (opaque to the shared package). */
export interface SidecarContainer {
  /** Raw K8s V1Container object — passed through to the runtime. */
  raw: unknown;
}

/** A raw K8s volume definition (for emptyDir, configMap, etc.). */
export interface ExtraVolume {
  /** Raw K8s V1Volume object — passed through to the runtime. */
  raw: unknown;
}

/** An extra volume mount for the main container. */
export interface ExtraVolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
}

export interface ContainerHandle {
  id: string;
  name: string;
}

export interface ContainerStatus {
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  exitCode?: number;
  startedAt?: Date;
  finishedAt?: Date;
  reason?: string;
}

export interface ExecSession {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  resize(cols: number, rows: number): void;
  close(): void;
}
