import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @kubernetes/client-node
// ---------------------------------------------------------------------------
const mockCoreApi = {
  createNamespacedPod: vi.fn(),
  readNamespacedPodStatus: vi.fn(),
  readNamespacedPodLog: vi.fn(),
  deleteNamespacedPod: vi.fn(),
  listNamespacedPod: vi.fn(),
  readNamespace: vi.fn(),
  createNamespace: vi.fn(),
};

const mockExecInstance = {
  exec: vi.fn(),
};

const mockLogInstance = {
  log: vi.fn(),
};

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: vi.fn(function () {
    return { loadFromDefault: vi.fn(), makeApiClient: vi.fn(() => mockCoreApi) };
  }),
  CoreV1Api: vi.fn(),
  Exec: vi.fn(function () {
    return mockExecInstance;
  }),
  Log: vi.fn(function () {
    return mockLogInstance;
  }),
  V1Pod: vi.fn(function () {
    return {};
  }),
  V1Namespace: vi.fn(function () {
    return {};
  }),
  V1ObjectMeta: vi.fn(function () {
    return {};
  }),
  V1PodSpec: vi.fn(function () {
    return {};
  }),
  V1Container: vi.fn(function () {
    return {};
  }),
  V1EnvVar: vi.fn(function () {
    return {};
  }),
  V1ResourceRequirements: vi.fn(function () {
    return {};
  }),
  V1Volume: vi.fn(function () {
    return {};
  }),
  V1VolumeMount: vi.fn(function () {
    return {};
  }),
  V1HostPathVolumeSource: vi.fn(function () {
    return {};
  }),
  V1PersistentVolumeClaimVolumeSource: vi.fn(function () {
    return {};
  }),
  V1SecurityContext: vi.fn(function () {
    return {};
  }),
  V1Capabilities: vi.fn(function () {
    return {};
  }),
  V1EmptyDirVolumeSource: vi.fn(function () {
    return {};
  }),
}));

import { KubernetesContainerRuntime } from "./kubernetes.js";
import type { ContainerSpec } from "@optio/shared";

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["/bin/sh", "-c", "sleep infinity"],
    env: {},
    workDir: "/workspace",
    labels: { taskId: "task-123" },
    ...overrides,
  };
}

describe("KubernetesContainerRuntime preStop", () => {
  let runtime: KubernetesContainerRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new KubernetesContainerRuntime("test-ns");
    mockCoreApi.readNamespace.mockResolvedValue({});
    mockCoreApi.createNamespacedPod.mockResolvedValue({
      metadata: { uid: "uid-abc", name: "optio-task-task-123" },
    });
    mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Running" } });
  });

  it("maps spec.preStop to the main container's lifecycle.preStop.exec", async () => {
    const preStop = ["/bin/sh", "-c", "docker ps -q | xargs -r docker rm -f; true"];
    await runtime.create(baseSpec({ preStop }));

    const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
    expect(container.lifecycle).toEqual({ preStop: { exec: { command: preStop } } });
  });

  it("sets no lifecycle when spec.preStop is unset or empty", async () => {
    await runtime.create(baseSpec());
    await runtime.create(baseSpec({ preStop: [] }));

    for (const call of mockCoreApi.createNamespacedPod.mock.calls) {
      expect(call[0].body.spec.containers[0].lifecycle).toBeUndefined();
    }
  });
});
