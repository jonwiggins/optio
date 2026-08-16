import { createRuntime, type ContainerRuntime } from "@optio/container-runtime";
import type { ContainerSpec, ContainerHandle, ContainerStatus } from "@optio/shared";
import { DEFAULT_AGENT_IMAGE } from "@optio/shared";

let runtime: ContainerRuntime | null = null;

export function getRuntime(): ContainerRuntime {
  if (!runtime) {
    const type = (process.env.OPTIO_RUNTIME ?? "docker") as "docker" | "kubernetes" | "fake";
    runtime = createRuntime({ type });
  }
  return runtime;
}

export async function launchAgentContainer(
  spec: Omit<ContainerSpec, "image" | "workDir" | "labels"> & {
    taskId: string;
    agentType: string;
    image?: string;
  },
): Promise<ContainerHandle> {
  const rt = getRuntime();
  const fullSpec: ContainerSpec = {
    image: spec.image ?? process.env.OPTIO_AGENT_IMAGE ?? DEFAULT_AGENT_IMAGE,
    command: spec.command,
    env: spec.env,
    workDir: "/workspace",
    labels: {
      "optio.task-id": spec.taskId,
      "optio.agent-type": spec.agentType,
      "managed-by": "optio",
    },
    cpuLimit: spec.cpuLimit,
    memoryLimit: spec.memoryLimit,
    volumes: spec.volumes,
    networkMode: spec.networkMode,
  };
  return rt.create(fullSpec);
}

export async function getContainerStatus(handle: ContainerHandle): Promise<ContainerStatus> {
  return getRuntime().status(handle);
}

export function streamContainerLogs(
  handle: ContainerHandle,
  opts?: { follow?: boolean },
): AsyncIterable<string> {
  return getRuntime().logs(handle, opts);
}

export async function destroyAgentContainer(handle: ContainerHandle): Promise<void> {
  return getRuntime().destroy(handle);
}

export async function checkRuntimeHealth(): Promise<boolean> {
  return getRuntime().ping();
}
