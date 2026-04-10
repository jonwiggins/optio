import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  KubeConfig: vi.fn(() => ({
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn(() => mockCoreApi),
  })),
  CoreV1Api: vi.fn(),
  Exec: vi.fn(() => mockExecInstance),
  Log: vi.fn(() => mockLogInstance),
  V1Pod: vi.fn(() => ({})),
  V1Namespace: vi.fn(() => ({})),
  V1ObjectMeta: vi.fn(() => ({})),
  V1PodSpec: vi.fn(() => ({})),
  V1Container: vi.fn(() => ({})),
  V1EnvVar: vi.fn(() => ({})),
  V1ResourceRequirements: vi.fn(() => ({})),
  V1Volume: vi.fn(() => ({})),
  V1VolumeMount: vi.fn(() => ({})),
  V1HostPathVolumeSource: vi.fn(() => ({})),
  V1PersistentVolumeClaimVolumeSource: vi.fn(() => ({})),
  V1SecurityContext: vi.fn(() => ({})),
  V1Capabilities: vi.fn(() => ({})),
  V1EmptyDirVolumeSource: vi.fn(() => ({})),
}));

import {
  KubernetesContainerRuntime,
  ALLOWED_CAPABILITIES,
  ALLOWED_HOST_PATH_PREFIXES,
} from "./kubernetes.js";
import type { ContainerSpec } from "@optio/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Make createNamespacedPod + readNamespacedPodStatus succeed by default */
function stubHappyPath() {
  mockCoreApi.readNamespace.mockResolvedValue({});
  mockCoreApi.createNamespacedPod.mockResolvedValue({
    metadata: { uid: "uid-abc", name: "optio-task-task-123" },
  });
  mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
    status: { phase: "Running" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KubernetesContainerRuntime", () => {
  let runtime: KubernetesContainerRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test gets a fresh runtime (so namespaceEnsured is reset)
    runtime = new KubernetesContainerRuntime("test-ns");
    stubHappyPath();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // create()
  // =========================================================================
  describe("create()", () => {
    it("maps env vars from spec.env to V1EnvVar objects", async () => {
      const spec = baseSpec({ env: { FOO: "bar", BAZ: "qux" } });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      const container = body.spec.containers[0];
      expect(container.env).toHaveLength(2);
      expect(container.env[0]).toEqual({ name: "FOO", value: "bar" });
      expect(container.env[1]).toEqual({ name: "BAZ", value: "qux" });
    });

    it("sets resource requests and limits", async () => {
      const spec = baseSpec({
        cpuLimit: "2",
        cpuRequest: "500m",
        memoryLimit: "4Gi",
        memoryRequest: "1Gi",
      });

      await runtime.create(spec);

      const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.resources.limits).toEqual({ cpu: "2", memory: "4Gi" });
      expect(container.resources.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    });

    it("defaults request to limit when only limit is specified", async () => {
      const spec = baseSpec({ cpuLimit: "2", memoryLimit: "4Gi" });

      await runtime.create(spec);

      const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.resources.limits).toEqual({ cpu: "2", memory: "4Gi" });
      expect(container.resources.requests).toEqual({ cpu: "2", memory: "4Gi" });
    });

    it("rejects hostPath volumes when no host paths are allowed", async () => {
      const spec = baseSpec({
        volumes: [{ hostPath: "/host/data", mountPath: "/data" }],
      });

      await expect(runtime.create(spec)).rejects.toThrow(
        'Host path volume mount "/host/data" is not permitted',
      );
      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();
    });

    it("builds PVC volumes with mounts", async () => {
      const spec = baseSpec({
        volumes: [{ persistentVolumeClaim: "my-pvc", mountPath: "/storage" }],
      });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(body.spec.volumes[0].persistentVolumeClaim).toEqual({ claimName: "my-pvc" });
    });

    it("builds tmpfs mounts with emptyDir medium=Memory and optional sizeLimit", async () => {
      const spec = baseSpec({
        tmpfsMounts: [{ mountPath: "/tmp/cache", sizeLimit: "512Mi" }, { mountPath: "/tmp/run" }],
      });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      // 2 tmpfs volumes
      expect(body.spec.volumes).toHaveLength(2);
      expect(body.spec.volumes[0].name).toBe("tmpfs-0");
      expect(body.spec.volumes[0].emptyDir).toEqual({ medium: "Memory", sizeLimit: "512Mi" });
      expect(body.spec.volumes[1].name).toBe("tmpfs-1");
      expect(body.spec.volumes[1].emptyDir).toEqual({ medium: "Memory" });

      const mounts = body.spec.containers[0].volumeMounts;
      expect(mounts[0].mountPath).toBe("/tmp/cache");
      expect(mounts[1].mountPath).toBe("/tmp/run");
    });

    it("adds extraVolumeMounts with subPath and readOnly", async () => {
      const spec = baseSpec({
        extraVolumeMounts: [
          { name: "certs", mountPath: "/etc/ssl/certs", subPath: "ca.crt", readOnly: true },
        ],
      });

      await runtime.create(spec);

      const mounts =
        mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0].volumeMounts;
      expect(mounts).toHaveLength(1);
      expect(mounts[0]).toEqual({
        name: "certs",
        mountPath: "/etc/ssl/certs",
        subPath: "ca.crt",
        readOnly: true,
      });
    });

    it("sets security context with allowed capabilities and drops ALL", async () => {
      const spec = baseSpec({ capabilities: ["NET_ADMIN", "NET_RAW"] });

      await runtime.create(spec);

      const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.securityContext.capabilities).toEqual({
        drop: ["ALL"],
        add: ["NET_ADMIN", "NET_RAW"],
      });
    });

    it("adds sidecar containers", async () => {
      const sidecar = { name: "docker", image: "docker:dind" };
      const spec = baseSpec({
        sidecarContainers: [{ raw: sidecar }],
      });

      await runtime.create(spec);

      const podSpec = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec;
      expect(podSpec.containers).toHaveLength(2);
      expect(podSpec.containers[1]).toBe(sidecar);
    });

    it("adds init containers", async () => {
      const initC = { name: "setup", image: "busybox" };
      const spec = baseSpec({
        initContainers: [{ raw: initC }],
      });

      await runtime.create(spec);

      const podSpec = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec;
      expect(podSpec.initContainers).toEqual([initC]);
    });

    it("adds extraVolumes", async () => {
      const extraVol = { name: "shared", emptyDir: {} };
      const spec = baseSpec({
        extraVolumes: [{ raw: extraVol }],
      });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(body.spec.volumes).toContain(extraVol);
    });

    it("sets hostUsers=false when specified", async () => {
      const spec = baseSpec({ hostUsers: false });

      await runtime.create(spec);

      const podSpec = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec;
      expect(podSpec.hostUsers).toBe(false);
    });

    it("uses spec.name when provided", async () => {
      const spec = baseSpec({ name: "my-custom-pod" });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(body.metadata.name).toBe("my-custom-pod");
    });

    it("generates name from taskId label when spec.name is not set", async () => {
      const spec = baseSpec();

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(body.metadata.name).toBe("optio-task-task-123");
    });

    it("sets imagePullPolicy (defaults to IfNotPresent)", async () => {
      await runtime.create(baseSpec());
      let container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.imagePullPolicy).toBe("IfNotPresent");

      vi.clearAllMocks();
      stubHappyPath();
      // Need new runtime since namespaceEnsured is cached
      runtime = new KubernetesContainerRuntime("test-ns");
      stubHappyPath();

      await runtime.create(baseSpec({ imagePullPolicy: "Never" }));
      container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.imagePullPolicy).toBe("Never");
    });

    it("returns ContainerHandle with uid and name", async () => {
      mockCoreApi.createNamespacedPod.mockResolvedValue({
        metadata: { uid: "uid-xyz", name: "optio-task-task-123" },
      });

      const handle = await runtime.create(baseSpec());

      expect(handle).toEqual({ id: "uid-xyz", name: "optio-task-task-123" });
    });
  });

  // =========================================================================
  // Security: capability and host-path allowlists
  // =========================================================================
  describe("security allowlists", () => {
    it("drops ALL capabilities by default when none are requested", async () => {
      const spec = baseSpec();

      await runtime.create(spec);

      const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.securityContext.capabilities).toEqual({ drop: ["ALL"] });
    });

    it("rejects disallowed capabilities (SYS_ADMIN)", async () => {
      const spec = baseSpec({ capabilities: ["SYS_ADMIN"] });

      await expect(runtime.create(spec)).rejects.toThrow(
        "Disallowed container capabilities requested: SYS_ADMIN",
      );
      expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled();
    });

    it("rejects multiple disallowed capabilities", async () => {
      const spec = baseSpec({ capabilities: ["SYS_ADMIN", "SYS_PTRACE", "NET_ADMIN"] });

      await expect(runtime.create(spec)).rejects.toThrow(
        "Disallowed container capabilities requested: SYS_ADMIN, SYS_PTRACE",
      );
    });

    it("allows all capabilities in the ALLOWED_CAPABILITIES set", async () => {
      const spec = baseSpec({ capabilities: [...ALLOWED_CAPABILITIES] });

      await runtime.create(spec);

      const container = mockCoreApi.createNamespacedPod.mock.calls[0][0].body.spec.containers[0];
      expect(container.securityContext.capabilities.drop).toEqual(["ALL"]);
      expect(container.securityContext.capabilities.add).toEqual([...ALLOWED_CAPABILITIES]);
    });

    it("rejects host path mounts by default (empty allowlist)", async () => {
      const spec = baseSpec({
        volumes: [{ hostPath: "/etc/shadow", mountPath: "/mnt/shadow" }],
      });

      await expect(runtime.create(spec)).rejects.toThrow(
        "Host path mounts are disabled. Use persistentVolumeClaim volumes instead.",
      );
    });

    it("still allows PVC volumes when host paths are rejected", async () => {
      const spec = baseSpec({
        volumes: [{ persistentVolumeClaim: "my-pvc", mountPath: "/storage" }],
      });

      await runtime.create(spec);

      const body = mockCoreApi.createNamespacedPod.mock.calls[0][0].body;
      expect(body.spec.volumes[0].persistentVolumeClaim).toEqual({ claimName: "my-pvc" });
    });

    it("exports ALLOWED_CAPABILITIES as a Set", () => {
      expect(ALLOWED_CAPABILITIES).toBeInstanceOf(Set);
      expect(ALLOWED_CAPABILITIES.has("NET_ADMIN")).toBe(true);
      expect(ALLOWED_CAPABILITIES.has("SYS_ADMIN")).toBe(false);
    });

    it("exports ALLOWED_HOST_PATH_PREFIXES as an empty array by default", () => {
      expect(Array.isArray(ALLOWED_HOST_PATH_PREFIXES)).toBe(true);
      expect(ALLOWED_HOST_PATH_PREFIXES).toHaveLength(0);
    });
  });

  // =========================================================================
  // waitForPodRunning (tested through create)
  // =========================================================================
  describe("waitForPodRunning (via create)", () => {
    it("returns when pod reaches Running state", async () => {
      vi.useFakeTimers();

      mockCoreApi.readNamespacedPodStatus
        .mockResolvedValueOnce({ status: { phase: "Pending" } })
        .mockResolvedValueOnce({ status: { phase: "Running" } });

      const promise = runtime.create(baseSpec());
      await vi.advanceTimersByTimeAsync(2000);

      const handle = await promise;
      expect(handle.id).toBe("uid-abc");
      expect(mockCoreApi.readNamespacedPodStatus).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("returns when pod reaches Succeeded state", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Succeeded" } });

      const handle = await runtime.create(baseSpec());
      expect(handle.id).toBe("uid-abc");
    });

    it("returns when pod reaches Failed state", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Failed" } });

      const handle = await runtime.create(baseSpec());
      expect(handle.id).toBe("uid-abc");
    });

    it("throws on terminal container reason (ErrImageNeverPull)", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Pending",
          containerStatuses: [{ state: { waiting: { reason: "ErrImageNeverPull" } } }],
        },
      });

      await expect(runtime.create(baseSpec())).rejects.toThrow(
        'Pod "optio-task-task-123" failed with unrecoverable error: ErrImageNeverPull',
      );
    });

    it("throws on terminal container reason (InvalidImageName)", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Pending",
          containerStatuses: [{ state: { waiting: { reason: "InvalidImageName" } } }],
        },
      });

      await expect(runtime.create(baseSpec())).rejects.toThrow("InvalidImageName");
    });

    it("includes message in terminal error when available", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              state: {
                waiting: { reason: "ErrImageNeverPull", message: "image not found locally" },
              },
            },
          ],
        },
      });

      await expect(runtime.create(baseSpec())).rejects.toThrow(
        "ErrImageNeverPull: image not found locally",
      );
    });

    it("checks init container statuses for terminal reasons", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Pending",
          containerStatuses: [],
          initContainerStatuses: [{ state: { waiting: { reason: "InvalidImageName" } } }],
        },
      });

      await expect(runtime.create(baseSpec())).rejects.toThrow("InvalidImageName");
    });

    it("throws timeout error when pod never reaches Running", async () => {
      vi.useFakeTimers();

      // Always return Pending
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: { phase: "Pending" },
      });

      const promise = runtime.create(baseSpec());

      // Attach the rejection handler BEFORE advancing timers so the rejection
      // is always handled and doesn't surface as an unhandled rejection.
      const resultPromise = promise.then(
        () => {
          throw new Error("Expected promise to reject");
        },
        (err: Error) => err,
      );

      // Advance time past the 120s timeout. advanceTimersByTimeAsync resolves
      // pending micro-tasks between each tick, so the while-loop progresses.
      await vi.advanceTimersByTimeAsync(130_000);

      const error = await resultPromise;
      expect(error.message).toBe(
        'Timed out waiting for pod "optio-task-task-123" to reach Running state after 120s',
      );

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // status()
  // =========================================================================
  describe("status()", () => {
    const handle = { id: "uid-abc", name: "test-pod" };

    it("maps Pending phase", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Pending" } });
      const s = await runtime.status(handle);
      expect(s.state).toBe("pending");
    });

    it("maps Running phase", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Running" } });
      const s = await runtime.status(handle);
      expect(s.state).toBe("running");
    });

    it("maps Succeeded phase", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Succeeded" } });
      const s = await runtime.status(handle);
      expect(s.state).toBe("succeeded");
    });

    it("maps Failed phase", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Failed" } });
      const s = await runtime.status(handle);
      expect(s.state).toBe("failed");
    });

    it("maps Unknown phase", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({ status: { phase: "Unknown" } });
      const s = await runtime.status(handle);
      expect(s.state).toBe("unknown");
    });

    it("extracts exitCode, startedAt, finishedAt from terminated state", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Succeeded",
          containerStatuses: [
            {
              state: {
                terminated: {
                  exitCode: 0,
                  startedAt: "2026-01-01T00:00:00Z",
                  finishedAt: "2026-01-01T01:00:00Z",
                  reason: "Completed",
                },
              },
            },
          ],
        },
      });

      const s = await runtime.status(handle);
      expect(s.exitCode).toBe(0);
      expect(s.startedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
      expect(s.finishedAt).toEqual(new Date("2026-01-01T01:00:00Z"));
      expect(s.reason).toBe("Completed");
    });

    it("extracts startedAt from running state", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Running",
          containerStatuses: [
            {
              state: {
                running: { startedAt: "2026-02-01T12:00:00Z" },
              },
            },
          ],
        },
      });

      const s = await runtime.status(handle);
      expect(s.startedAt).toEqual(new Date("2026-02-01T12:00:00Z"));
    });

    it("extracts reason from waiting state", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              state: {
                waiting: { reason: "ContainerCreating" },
              },
            },
          ],
        },
      });

      const s = await runtime.status(handle);
      expect(s.reason).toBe("ContainerCreating");
    });

    it("falls back to pod-level startTime and reason/message", async () => {
      mockCoreApi.readNamespacedPodStatus.mockResolvedValue({
        status: {
          phase: "Failed",
          startTime: "2026-03-01T10:00:00Z",
          reason: "Evicted",
          message: "The node was low on resource: memory",
        },
      });

      const s = await runtime.status(handle);
      expect(s.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(s.reason).toBe("Evicted");
    });
  });

  // =========================================================================
  // logs() (non-follow)
  // =========================================================================
  describe("logs() (non-follow)", () => {
    const handle = { id: "uid-abc", name: "test-pod" };

    it("reads pod log and yields non-empty lines", async () => {
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("line1\nline2\n\nline3\n");

      const lines: string[] = [];
      for await (const line of runtime.logs(handle)) {
        lines.push(line);
      }
      expect(lines).toEqual(["line1", "line2", "line3"]);
    });

    it("calculates sinceSeconds from opts.since Date", async () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const tenMinutesAgo = new Date(now - 600_000);

      mockCoreApi.readNamespacedPodLog.mockResolvedValue("");

      for await (const _line of runtime.logs(handle, { since: tenMinutesAgo })) {
        // drain
      }

      const callArgs = mockCoreApi.readNamespacedPodLog.mock.calls[0][0];
      expect(callArgs.sinceSeconds).toBe(600);

      vi.restoreAllMocks();
    });

    it("passes tail and timestamps options", async () => {
      mockCoreApi.readNamespacedPodLog.mockResolvedValue("");

      for await (const _line of runtime.logs(handle, { tail: 100 })) {
        // drain
      }

      const callArgs = mockCoreApi.readNamespacedPodLog.mock.calls[0][0];
      expect(callArgs.tailLines).toBe(100);
      expect(callArgs.timestamps).toBe(true);
      expect(callArgs.follow).toBe(false);
    });
  });

  // =========================================================================
  // exec()
  // =========================================================================
  describe("exec()", () => {
    const handle = { id: "uid-abc", name: "test-pod" };

    it("creates exec session with stdin/stdout/stderr streams", async () => {
      const mockWs = { send: vi.fn(), close: vi.fn() };
      mockExecInstance.exec.mockResolvedValue(mockWs);

      const session = await runtime.exec(handle, ["bash"]);

      expect(mockExecInstance.exec).toHaveBeenCalledWith(
        "test-ns",
        "test-pod",
        "main",
        ["bash"],
        expect.any(Object), // stdout PassThrough
        expect.any(Object), // stderr PassThrough
        expect.any(Object), // stdin PassThrough
        true, // tty
      );
      expect(session.stdin).toBeDefined();
      expect(session.stdout).toBeDefined();
      expect(session.stderr).toBeDefined();
      expect(session.resize).toBeInstanceOf(Function);
      expect(session.close).toBeInstanceOf(Function);
    });

    it("resize sends buffer on channel 4 with JSON {Width, Height}", async () => {
      const mockWs = { send: vi.fn(), close: vi.fn() };
      mockExecInstance.exec.mockResolvedValue(mockWs);

      const session = await runtime.exec(handle, ["bash"]);
      session.resize(120, 40);

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sentBuf: Buffer = mockWs.send.mock.calls[0][0];
      expect(sentBuf[0]).toBe(4); // channel 4
      const json = sentBuf.subarray(1).toString();
      expect(JSON.parse(json)).toEqual({ Width: 120, Height: 40 });
    });

    it("close() ends streams", async () => {
      const mockWs = { send: vi.fn(), close: vi.fn() };
      mockExecInstance.exec.mockResolvedValue(mockWs);

      const session = await runtime.exec(handle, ["bash"]);
      session.close();

      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // destroy()
  // =========================================================================
  describe("destroy()", () => {
    const handle = { id: "uid-abc", name: "test-pod" };

    it("deletes pod with 10s grace period", async () => {
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({});

      await runtime.destroy(handle);

      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith({
        name: "test-pod",
        namespace: "test-ns",
        gracePeriodSeconds: 10,
      });
    });

    it("ignores 404 (pod already gone)", async () => {
      mockCoreApi.deleteNamespacedPod.mockRejectedValue({ statusCode: 404 });

      await expect(runtime.destroy(handle)).resolves.toBeUndefined();
    });

    it("re-throws non-404 errors", async () => {
      const error = new Error("internal server error");
      mockCoreApi.deleteNamespacedPod.mockRejectedValue(error);

      await expect(runtime.destroy(handle)).rejects.toThrow("internal server error");
    });
  });

  // =========================================================================
  // ping()
  // =========================================================================
  describe("ping()", () => {
    it("returns true when listNamespacedPod succeeds", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] });

      const result = await runtime.ping();
      expect(result).toBe(true);
    });

    it("returns true when listNamespacedPod returns 403 Forbidden (no ClusterRole)", async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValue({ statusCode: 403 });

      const result = await runtime.ping();
      expect(result).toBe(true);
    });

    it("returns true when listNamespacedPod returns 403 via response.httpStatusCode", async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValue({
        response: { httpStatusCode: 403 },
      });

      const result = await runtime.ping();
      expect(result).toBe(true);
    });

    it("returns false when it throws a non-403 error", async () => {
      mockCoreApi.listNamespacedPod.mockRejectedValue(new Error("connection refused"));

      const result = await runtime.ping();
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // ensureNamespace() (tested through create)
  // =========================================================================
  describe("ensureNamespace (via create)", () => {
    it("creates namespace when it doesn't exist (readNamespace throws 404)", async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespace.mockResolvedValue({});

      await runtime.create(baseSpec());

      expect(mockCoreApi.readNamespace).toHaveBeenCalledWith({ name: "test-ns" });
      expect(mockCoreApi.createNamespace).toHaveBeenCalledTimes(1);
      const nsBody = mockCoreApi.createNamespace.mock.calls[0][0].body;
      expect(nsBody.metadata.name).toBe("test-ns");
      expect(nsBody.metadata.labels).toEqual({ "app.kubernetes.io/managed-by": "optio" });
    });

    it("skips creation when namespace already exists", async () => {
      mockCoreApi.readNamespace.mockResolvedValue({});

      await runtime.create(baseSpec());

      expect(mockCoreApi.readNamespace).toHaveBeenCalledTimes(1);
      expect(mockCoreApi.createNamespace).not.toHaveBeenCalled();
    });

    it("handles concurrent creation (409 conflict)", async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ statusCode: 404 });
      mockCoreApi.createNamespace.mockRejectedValue({ statusCode: 409 });

      // Should not throw — 409 is swallowed
      await expect(runtime.create(baseSpec())).resolves.toBeDefined();
    });

    it("caches namespace check (second create doesn't call readNamespace again)", async () => {
      mockCoreApi.readNamespace.mockResolvedValue({});

      await runtime.create(baseSpec());
      await runtime.create(baseSpec());

      expect(mockCoreApi.readNamespace).toHaveBeenCalledTimes(1);
    });

    it("re-throws non-404/non-403 errors from readNamespace", async () => {
      mockCoreApi.readNamespace.mockRejectedValue(new Error("internal server error"));

      await expect(runtime.create(baseSpec())).rejects.toThrow("internal server error");
      expect(mockCoreApi.createNamespace).not.toHaveBeenCalled();
    });

    it("treats 403 Forbidden from readNamespace as namespace exists (no ClusterRole)", async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ statusCode: 403 });

      // Should succeed — 403 means we lack cluster-level namespace read
      // permission but the namespace must exist since we're running in it
      await expect(runtime.create(baseSpec())).resolves.toBeDefined();
      expect(mockCoreApi.createNamespace).not.toHaveBeenCalled();
    });

    it("treats 403 via response.httpStatusCode as namespace exists", async () => {
      mockCoreApi.readNamespace.mockRejectedValue({
        response: { httpStatusCode: 403 },
      });

      await expect(runtime.create(baseSpec())).resolves.toBeDefined();
      expect(mockCoreApi.createNamespace).not.toHaveBeenCalled();
    });

    it("caches namespace check after 403 so second create skips readNamespace", async () => {
      mockCoreApi.readNamespace.mockRejectedValue({ statusCode: 403 });

      await runtime.create(baseSpec());
      await runtime.create(baseSpec());

      expect(mockCoreApi.readNamespace).toHaveBeenCalledTimes(1);
    });
  });
});
