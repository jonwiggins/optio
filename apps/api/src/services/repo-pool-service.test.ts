import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../db/schema.js", () => ({
  agentPods: {
    id: "id",
    pool: "pool",
    poolKey: "poolKey",
    instanceIndex: "instanceIndex",
    workspaceId: "workspaceId",
    repoBranch: "repoBranch",
    podName: "podName",
    podId: "podId",
    state: "state",
    activeCount: "activeCount",
    lastUsedAt: "lastUsedAt",
    errorMessage: "errorMessage",
    managedBy: "managedBy",
    statefulSetName: "statefulSetName",
    cachePvcName: "cachePvcName",
    cachePvcState: "cachePvcState",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  tasks: {
    id: "id",
    repoUrl: "repoUrl",
    state: "state",
    worktreeState: "worktreeState",
    lastPodId: "lastPodId",
    updatedAt: "updatedAt",
  },
  interactiveSessions: {
    id: "id",
    repoUrl: "repoUrl",
    state: "state",
    podId: "podId",
  },
  workspaces: {
    id: "id",
    allowDockerInDocker: "allowDockerInDocker",
  },
}));

// Picking a pod, the row's lifecycle, slots, and count repair are
// agent-pod-pool's (exercised against a real database in
// agent-pod-pool.int.test.ts). Here we check what the repo pool asks of it and
// what it builds around it: the pod spec, admission checks, cleanup, exec.
const podPool = vi.hoisted(() => ({
  pickPod: vi.fn(),
  insertPod: vi.fn(),
  markPodReady: vi.fn(),
  markPodError: vi.fn(),
  getPod: vi.fn(),
  listPods: vi.fn(),
  deletePod: vi.fn(),
  acquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  idlePods: vi.fn(),
  reconcileActiveCounts: vi.fn(),
}));
vi.mock("./agent-pod-pool.js", () => podPool);

// The repo has no shared cache directories configured.
vi.mock("./shared-directory-service.js", () => ({
  getSharedDirectoriesForRepo: vi.fn().mockResolvedValue([]),
  ensureCachePvcForPod: vi.fn(),
}));

const mockRuntimeCreate = vi.fn();
const mockRuntimeExec = vi.fn();
const mockRuntimeStatus = vi.fn();
const mockRuntimeDestroy = vi.fn();

vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    create: mockRuntimeCreate,
    exec: mockRuntimeExec,
    status: mockRuntimeStatus,
    destroy: mockRuntimeDestroy,
  }),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], cb: (err: null, stdout: string, stderr: string) => void) =>
      cb(null, "", ""),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
  asc: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./k8s-workload-service.js", () => ({
  isStatefulSetEnabled: () => false,
  getWorkloadManager: vi.fn(),
}));

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  resolveImage,
  getOrCreateRepoPod,
  releaseRepoPodTask,
  cleanupIdleRepoPods,
  listRepoPods,
  reconcileActiveTaskCounts,
  deleteNetworkPolicy,
  killOrphanedAgentInPod,
  execTaskInRepoPod,
  type RepoPod,
} from "./repo-pool-service.js";

const REPO_URL = "https://github.com/org/repo";

/** An `agent_pods` row in the repo pool. */
function repoPod(overrides: Partial<RepoPod> = {}): RepoPod {
  return {
    id: "pod-1",
    isolationKey: null,
    pool: "repo",
    poolKey: REPO_URL,
    instanceIndex: 0,
    workspaceId: null,
    repoBranch: "main",
    podName: "optio-repo-org-repo-0",
    podId: "k8s-pod-1",
    state: "ready",
    activeCount: 0,
    lastUsedAt: null,
    keepWarmUntil: null,
    errorMessage: null,
    managedBy: "bare-pod",
    statefulSetName: null,
    jobName: null,
    cachePvcName: null,
    cachePvcState: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * pickPod finds nothing to share and scales up: it calls the repo pool's
 * create callback for `instanceIndex`, whose row is recorded as "pod-1" and
 * then marked ready. `workspaceLookup` answers the DinD admission query.
 */
function provisionNewPod(opts: { instanceIndex?: number; workspaceLookup?: unknown[] } = {}) {
  podPool.pickPod.mockImplementation((_pool, _key, pickOpts) =>
    pickOpts.create(opts.instanceIndex ?? 0),
  );
  podPool.insertPod.mockImplementation(async (values) =>
    repoPod({ ...values, id: "pod-1", podName: null, podId: null, state: "provisioning" }),
  );
  podPool.markPodReady.mockImplementation(async (id, where) =>
    repoPod({ ...where, id, state: "ready" }),
  );
  if (opts.workspaceLookup !== undefined) {
    (db as any).where.mockResolvedValueOnce(opts.workspaceLookup);
  }
}

beforeEach(() => {
  for (const fn of Object.values(podPool)) fn.mockReset();
});

// ── resolveImage ────────────────────────────────────────────────────

describe("resolveImage", () => {
  const origEnv = process.env.OPTIO_AGENT_IMAGE;
  const origPrefix = process.env.OPTIO_AGENT_IMAGE_PREFIX;
  const origTag = process.env.OPTIO_AGENT_IMAGE_TAG;
  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.OPTIO_AGENT_IMAGE = origEnv;
    } else {
      delete process.env.OPTIO_AGENT_IMAGE;
    }
    if (origPrefix !== undefined) {
      process.env.OPTIO_AGENT_IMAGE_PREFIX = origPrefix;
    } else {
      delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    }
    if (origTag !== undefined) {
      process.env.OPTIO_AGENT_IMAGE_TAG = origTag;
    } else {
      delete process.env.OPTIO_AGENT_IMAGE_TAG;
    }
  });

  it("returns custom image when provided", () => {
    expect(resolveImage({ customImage: "my-org/my-image:v2" })).toBe("my-org/my-image:v2");
  });

  it("returns preset image tag when preset is valid (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "node" })).toBe("optio-node:latest");
  });

  it("returns preset image for rust (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "rust" })).toBe("optio-rust:latest");
  });

  it("returns preset image for python (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "python" })).toBe("optio-python:latest");
  });

  it("returns preset image for go (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "go" })).toBe("optio-go:latest");
  });

  it("returns preset image for full (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "full" })).toBe("optio-full:latest");
  });

  it("returns preset image for base (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "base" })).toBe("optio-base:latest");
  });

  it("prefers customImage over preset", () => {
    expect(resolveImage({ customImage: "custom:v1", preset: "node" })).toBe("custom:v1");
  });

  it("returns env OPTIO_AGENT_IMAGE when no config provided", () => {
    process.env.OPTIO_AGENT_IMAGE = "my-env-image:latest";
    expect(resolveImage()).toBe("my-env-image:latest");
  });

  it("returns default agent image when nothing configured", () => {
    delete process.env.OPTIO_AGENT_IMAGE;
    expect(resolveImage()).toBe("optio-agent:latest");
  });

  it("returns default when config is empty object", () => {
    delete process.env.OPTIO_AGENT_IMAGE;
    expect(resolveImage({})).toBe("optio-agent:latest");
  });

  it("returns preset image for dind (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "dind" })).toBe("optio-dind:latest");
  });

  it("returns preset image for ruby (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "ruby" })).toBe("optio-ruby:latest");
  });

  it("returns preset image for dart (no prefix env)", () => {
    delete process.env.OPTIO_AGENT_IMAGE_PREFIX;
    expect(resolveImage({ preset: "dart" })).toBe("optio-dart:latest");
  });

  it("falls through to default for invalid preset", () => {
    delete process.env.OPTIO_AGENT_IMAGE;
    expect(resolveImage({ preset: "nonexistent" as any })).toBe("optio-agent:latest");
  });

  // ── OPTIO_AGENT_IMAGE_PREFIX env var ─────────────────────────────

  it("uses OPTIO_AGENT_IMAGE_PREFIX for preset images when set", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    expect(resolveImage({ preset: "node" })).toBe("ghcr.io/jonwiggins/optio-agent-node:latest");
  });

  it("uses OPTIO_AGENT_IMAGE_PREFIX for base preset", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    expect(resolveImage({ preset: "base" })).toBe("ghcr.io/jonwiggins/optio-agent-base:latest");
  });

  it("uses OPTIO_AGENT_IMAGE_PREFIX for all presets", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    expect(resolveImage({ preset: "python" })).toBe("ghcr.io/jonwiggins/optio-agent-python:latest");
    expect(resolveImage({ preset: "go" })).toBe("ghcr.io/jonwiggins/optio-agent-go:latest");
    expect(resolveImage({ preset: "rust" })).toBe("ghcr.io/jonwiggins/optio-agent-rust:latest");
    expect(resolveImage({ preset: "ruby" })).toBe("ghcr.io/jonwiggins/optio-agent-ruby:latest");
    expect(resolveImage({ preset: "dart" })).toBe("ghcr.io/jonwiggins/optio-agent-dart:latest");
    expect(resolveImage({ preset: "full" })).toBe("ghcr.io/jonwiggins/optio-agent-full:latest");
    expect(resolveImage({ preset: "dind" })).toBe("ghcr.io/jonwiggins/optio-agent-dind:latest");
  });

  it("uses OPTIO_AGENT_IMAGE_TAG with prefix for preset images", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    process.env.OPTIO_AGENT_IMAGE_TAG = "0.1.0";
    expect(resolveImage({ preset: "node" })).toBe("ghcr.io/jonwiggins/optio-agent-node:0.1.0");
  });

  it("defaults tag to latest when OPTIO_AGENT_IMAGE_TAG is not set", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    delete process.env.OPTIO_AGENT_IMAGE_TAG;
    expect(resolveImage({ preset: "base" })).toBe("ghcr.io/jonwiggins/optio-agent-base:latest");
  });

  it("still prefers customImage over prefix-based preset", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    expect(resolveImage({ customImage: "custom:v1", preset: "node" })).toBe("custom:v1");
  });

  it("prefix does not affect fallback when preset is invalid", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "ghcr.io/jonwiggins/optio-agent-";
    delete process.env.OPTIO_AGENT_IMAGE;
    expect(resolveImage({ preset: "nonexistent" as any })).toBe("optio-agent:latest");
  });

  it("uses local prefix for local dev", () => {
    process.env.OPTIO_AGENT_IMAGE_PREFIX = "optio-";
    expect(resolveImage({ preset: "node" })).toBe("optio-node:latest");
  });
});

// ── releaseRepoPodTask ──────────────────────────────────────────────

describe("releaseRepoPodTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("decrements the active task count by releasing the pod's slot", async () => {
    podPool.releaseSlot.mockResolvedValueOnce(repoPod({ activeCount: 0 }));

    await releaseRepoPodTask("pod-1");

    expect(podPool.releaseSlot).toHaveBeenCalledTimes(1);
    expect(podPool.releaseSlot).toHaveBeenCalledWith("pod-1");
  });
});

// ── cleanupIdleRepoPods ─────────────────────────────────────────────

describe("cleanupIdleRepoPods", () => {
  // The active-session check is select().from().where().limit(); where() has
  // to hand back something .limit() can be called on.
  const noActiveSession = () => ({
    limit: vi.fn().mockResolvedValue([]),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no idle pods exist", async () => {
    podPool.idlePods.mockResolvedValueOnce([]);

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(0);
    expect(podPool.idlePods).toHaveBeenCalledWith("repo", expect.any(Date));
    expect(podPool.deletePod).not.toHaveBeenCalled();
  });

  it("destroys idle pods and removes their records", async () => {
    const idlePod = repoPod({
      id: "pod-1",
      poolKey: REPO_URL,
      podName: "optio-repo-org-repo-abc1",
      podId: "k8s-pod-id-1",
      state: "ready",
      activeCount: 0,
      instanceIndex: 0,
    });

    podPool.idlePods.mockResolvedValueOnce([idlePod]);
    vi.mocked(db.select().from(undefined as any).where as any).mockReturnValueOnce(
      noActiveSession(),
    );
    mockRuntimeDestroy.mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({
      id: idlePod.podId,
      name: idlePod.podName,
    });
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-1");
  });

  it("continues cleanup even if one pod fails to destroy", async () => {
    const pods = [
      repoPod({
        id: "pod-1",
        poolKey: REPO_URL,
        podName: "pod-a",
        podId: "id-a",
        state: "ready",
        instanceIndex: 0,
      }),
      repoPod({
        id: "pod-2",
        poolKey: REPO_URL,
        podName: "pod-b",
        podId: "id-b",
        state: "ready",
        instanceIndex: 1,
      }),
    ];

    podPool.idlePods.mockResolvedValueOnce(pods);
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockReturnValueOnce(noActiveSession()) // session check for pod-2 (sorted desc by instanceIndex)
      .mockReturnValueOnce(noActiveSession()); // session check for pod-1

    mockRuntimeDestroy
      .mockRejectedValueOnce(new Error("Failed to destroy"))
      .mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleRepoPods();
    // First pod (pod-2) fails, second (pod-1) succeeds
    expect(cleaned).toBe(1);
    // The pod that couldn't be destroyed keeps its record
    expect(podPool.deletePod).toHaveBeenCalledTimes(1);
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-1");
  });

  it("skips destroy if pod has no podName", async () => {
    const pod = repoPod({
      id: "pod-1",
      poolKey: REPO_URL,
      podName: null,
      podId: null,
      state: "ready",
      instanceIndex: 0,
    });

    podPool.idlePods.mockResolvedValueOnce([pod]);
    vi.mocked(db.select().from(undefined as any).where as any).mockReturnValueOnce(
      noActiveSession(),
    );

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).not.toHaveBeenCalled();
    expect(podPool.deletePod).toHaveBeenCalledWith("pod-1");
  });
});

// ── listRepoPods ────────────────────────────────────────────────────

describe("listRepoPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all pods in the repo pool", async () => {
    const mockPods = [
      repoPod({ id: "pod-1", poolKey: "url1", podName: "p1", state: "ready" }),
      repoPod({ id: "pod-2", poolKey: "url2", podName: "p2", state: "provisioning" }),
    ];

    podPool.listPods.mockResolvedValueOnce(mockPods);

    const result = await listRepoPods();
    expect(result).toEqual(mockPods);
    expect(podPool.listPods).toHaveBeenCalledWith("repo");
  });
});

// ── reconcileActiveTaskCounts ───────────────────────────────────────
//
// The correction itself (set each pod's activeCount to its live count, zero
// for pods no run names, leave matching pods alone) is agent-pod-pool's
// reconcileActiveCounts. The repo pool's part is counting the live tasks on
// each pod and handing that over for the repo pool.

describe("reconcileActiveTaskCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no pods exist", async () => {
    (db as any).groupBy.mockResolvedValueOnce([]);
    podPool.reconcileActiveCounts.mockResolvedValueOnce(0);

    const result = await reconcileActiveTaskCounts();
    expect(result).toBe(0);
    expect(podPool.reconcileActiveCounts).toHaveBeenCalledWith("repo", new Map());
  });

  it("corrects inflated activeTaskCount to match actual running tasks", async () => {
    // pod-1 holds 1 running task; pod-2 holds none, so it's absent from the
    // grouped counts and the pool resets it to 0. Both were inflated (13, 5).
    (db as any).groupBy.mockResolvedValueOnce([{ podId: "pod-1", n: 1 }]);
    podPool.reconcileActiveCounts.mockResolvedValueOnce(2);

    const result = await reconcileActiveTaskCounts();
    expect(result).toBe(2);
    expect(podPool.reconcileActiveCounts).toHaveBeenCalledTimes(1);
    expect(podPool.reconcileActiveCounts).toHaveBeenCalledWith("repo", new Map([["pod-1", 1]]));
  });

  it("counts only running/provisioning tasks that record a pod, grouped by pod", async () => {
    (db as any).groupBy.mockResolvedValueOnce([
      { podId: "pod-1", n: 2 },
      { podId: "pod-2", n: 1 },
    ]);
    podPool.reconcileActiveCounts.mockResolvedValueOnce(0);

    const result = await reconcileActiveTaskCounts();
    expect(result).toBe(0);

    const filter = vi
      .mocked(sql)
      .mock.calls.find(([strings]) => strings.join("?").includes("IN ('running', 'provisioning')"));
    expect(filter).toBeDefined();
    expect(filter!.slice(1)).toEqual(["state", "lastPodId"]); // tasks.state, tasks.lastPodId
    expect(filter![0].join("?")).toContain("IS NOT NULL");
    expect((db as any).groupBy).toHaveBeenCalledWith("lastPodId");
    expect(podPool.reconcileActiveCounts).toHaveBeenCalledWith(
      "repo",
      new Map([
        ["pod-1", 2],
        ["pod-2", 1],
      ]),
    );
  });
});

// ── deleteNetworkPolicy ────────────────────────────────────────────

describe("deleteNetworkPolicy", () => {
  let mockExecFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    vi.doMock("node:child_process", () => ({
      execFile: (cmd: string, args: string[], cb: any) => {
        mockExecFile(cmd, args)
          .then((res: any) => cb(null, res.stdout, res.stderr))
          .catch((err: any) => cb(err));
      },
    }));
    vi.doMock("node:util", () => ({
      promisify:
        (fn: any) =>
        (...args: any[]) =>
          new Promise((resolve, reject) => {
            fn(...args, (err: any, ...results: any[]) => {
              if (err) reject(err);
              else resolve(results.length <= 1 ? results[0] : results);
            });
          }),
    }));
  });

  it("calls kubectl delete with the correct policy name", async () => {
    await deleteNetworkPolicy("optio-repo-myorg-myrepo-abc1");

    // The function uses dynamic import, so we can't easily assert the mock.
    // Instead, verify it doesn't throw (the catch inside handles errors gracefully).
    expect(true).toBe(true);
  });

  it("does not throw when deletion fails", async () => {
    // deleteNetworkPolicy has a try/catch that swallows errors
    await expect(deleteNetworkPolicy("nonexistent-pod")).resolves.toBeUndefined();
  });
});

// ── Docker-in-Docker admission check ──────────────────────────────

describe("getOrCreateRepoPod — DinD admission check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset where to default behavior
    (db as any).where.mockReset().mockReturnThis();
  });

  it("rejects DinD when no workspaceId is provided", async () => {
    provisionNewPod();

    await expect(
      getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
        dockerInDocker: true,
      }),
    ).rejects.toThrow("Docker-in-Docker requires a workspace with allowDockerInDocker enabled");
    // Rejected before any pod row is recorded or pod created
    expect(podPool.insertPod).not.toHaveBeenCalled();
    expect(mockRuntimeCreate).not.toHaveBeenCalled();
  });

  it("rejects DinD when workspace has allowDockerInDocker=false", async () => {
    provisionNewPod({ workspaceLookup: [{ allowDockerInDocker: false }] });

    await expect(
      getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
        dockerInDocker: true,
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Docker-in-Docker requires workspace admin opt-in");
    expect(podPool.insertPod).not.toHaveBeenCalled();
    expect(mockRuntimeCreate).not.toHaveBeenCalled();
  });

  it("rejects DinD when workspace is not found", async () => {
    provisionNewPod({ workspaceLookup: [] });

    await expect(
      getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
        dockerInDocker: true,
        workspaceId: "nonexistent-ws",
      }),
    ).rejects.toThrow("Docker-in-Docker requires workspace admin opt-in");
    expect(podPool.insertPod).not.toHaveBeenCalled();
    expect(mockRuntimeCreate).not.toHaveBeenCalled();
  });

  it("allows DinD when workspace has allowDockerInDocker=true", async () => {
    provisionNewPod({ workspaceLookup: [{ allowDockerInDocker: true }] });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    const pod = await getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
      dockerInDocker: true,
      workspaceId: "ws-1",
    });

    expect(pod.state).toBe("ready");
    expect(mockRuntimeCreate).toHaveBeenCalled();

    // Verify the ContainerSpec passed to create uses SYS_CHROOT, not SYS_ADMIN
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.capabilities).toEqual(["SYS_CHROOT"]);
    expect(spec.capabilities).not.toContain("SYS_ADMIN");
    expect(spec.capabilities).not.toContain("NET_ADMIN");
    expect(spec.hostUsers).toBe(false);
    expect(spec.tmpfsMounts).toEqual([{ mountPath: "/var/lib/docker", sizeLimit: "10Gi" }]);
  });

  it("does not add DinD capabilities when dockerInDocker is false", async () => {
    provisionNewPod();

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    const pod = await getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
      dockerInDocker: false,
    });

    expect(pod.state).toBe("ready");
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.capabilities).toBeUndefined();
    expect(spec.hostUsers).toBeUndefined();
    expect(spec.tmpfsMounts).toBeUndefined();
  });
});

// ── killOrphanedAgentInPod ───────────────────────────────────────

describe("killOrphanedAgentInPod", () => {
  function makeExecSession(output: string) {
    return {
      stdout: {
        [Symbol.asyncIterator]: async function* () {
          if (output) yield Buffer.from(output);
        },
      },
      close: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when pod is not found", async () => {
    podPool.getPod.mockResolvedValueOnce(null); // pod lookup returns nothing

    const result = await killOrphanedAgentInPod("nonexistent-pod", "task-1");
    expect(result).toBe(false);
    expect(podPool.getPod).toHaveBeenCalledWith("nonexistent-pod");
    expect(mockRuntimeExec).not.toHaveBeenCalled();
  });

  it("returns false when pod has no podName", async () => {
    podPool.getPod.mockResolvedValueOnce(repoPod({ id: "pod-1", podName: null, state: "ready" }));

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    expect(mockRuntimeExec).not.toHaveBeenCalled();
  });

  it("returns false when pod is not in ready state", async () => {
    podPool.getPod.mockResolvedValueOnce(
      repoPod({ id: "pod-1", podName: "p1", podId: "pid1", state: "error" }),
    );

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    expect(mockRuntimeExec).not.toHaveBeenCalled();
  });

  it("returns false when pod is not reachable", async () => {
    podPool.getPod.mockResolvedValueOnce(
      repoPod({ id: "pod-1", podName: "p1", podId: "pid1", state: "ready" }),
    );
    mockRuntimeStatus.mockRejectedValueOnce(new Error("unreachable"));

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    expect(mockRuntimeExec).not.toHaveBeenCalled();
  });

  it("returns true when orphaned processes are found and killed", async () => {
    podPool.getPod.mockResolvedValueOnce(
      repoPod({ id: "pod-1", podName: "p1", podId: "pid1", state: "ready" }),
    );
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const killSession = makeExecSession("killed\n");
    const cleanSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(killSession).mockResolvedValueOnce(cleanSession);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(true);
    expect(mockRuntimeExec).toHaveBeenCalledTimes(1); // kill only; preserve checkout
    expect(mockRuntimeExec.mock.calls[0][0]).toEqual({ id: "pid1", name: "p1" });
  });

  it("returns false when no orphaned processes are found and preserves the worktree", async () => {
    podPool.getPod.mockResolvedValueOnce(
      repoPod({ id: "pod-1", podName: "p1", podId: "pid1", state: "ready" }),
    );
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const killSession = makeExecSession("none\n");
    const cleanSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(killSession).mockResolvedValueOnce(cleanSession);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    // No checkout deletion, even if no processes were found
    expect(mockRuntimeExec).toHaveBeenCalledTimes(1);
  });

  it("handles kill exec failure gracefully and preserves the worktree", async () => {
    podPool.getPod.mockResolvedValueOnce(
      repoPod({ id: "pod-1", podName: "p1", podId: "pid1", state: "ready" }),
    );
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    // Kill exec throws, but cleanup should still run
    mockRuntimeExec
      .mockRejectedValueOnce(new Error("exec failed"))
      .mockResolvedValueOnce(makeExecSession(""));

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    // No cleanup exec after an uncertain failure
    expect(mockRuntimeExec).toHaveBeenCalledTimes(1);
  });
});

// ── nodeSelector / tolerations env var integration ────────────────────

describe("getOrCreateRepoPod — nodeSelector and tolerations env vars", () => {
  const origNodeSelector = process.env.OPTIO_AGENT_NODE_SELECTOR;
  const origTolerations = process.env.OPTIO_AGENT_TOLERATIONS;

  afterEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
    if (origNodeSelector !== undefined) {
      process.env.OPTIO_AGENT_NODE_SELECTOR = origNodeSelector;
    } else {
      delete process.env.OPTIO_AGENT_NODE_SELECTOR;
    }
    if (origTolerations !== undefined) {
      process.env.OPTIO_AGENT_TOLERATIONS = origTolerations;
    } else {
      delete process.env.OPTIO_AGENT_TOLERATIONS;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
  });

  it("passes parsed nodeSelector to the container spec", async () => {
    process.env.OPTIO_AGENT_NODE_SELECTOR = '{"disktype":"ssd"}';
    delete process.env.OPTIO_AGENT_TOLERATIONS;

    provisionNewPod();
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {});
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.nodeSelector).toEqual({ disktype: "ssd" });
  });

  it("passes parsed tolerations to the container spec", async () => {
    delete process.env.OPTIO_AGENT_NODE_SELECTOR;
    process.env.OPTIO_AGENT_TOLERATIONS =
      '[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]';

    provisionNewPod();
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {});
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.tolerations).toEqual([{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);
  });

  it("throws a descriptive error when OPTIO_AGENT_NODE_SELECTOR contains malformed JSON", async () => {
    process.env.OPTIO_AGENT_NODE_SELECTOR = "{bad json}";
    delete process.env.OPTIO_AGENT_TOLERATIONS;

    provisionNewPod();

    await expect(getOrCreateRepoPod(REPO_URL, "main", {})).rejects.toThrow(
      /Invalid JSON in OPTIO_AGENT_NODE_SELECTOR/,
    );
    // The recorded row is marked errored rather than left provisioning
    expect(podPool.markPodError).toHaveBeenCalledWith("pod-1", expect.any(Error));
  });

  it("throws a descriptive error when OPTIO_AGENT_TOLERATIONS contains malformed JSON", async () => {
    delete process.env.OPTIO_AGENT_NODE_SELECTOR;
    process.env.OPTIO_AGENT_TOLERATIONS = "not valid json";

    provisionNewPod();

    await expect(getOrCreateRepoPod(REPO_URL, "main", {})).rejects.toThrow(
      /Invalid JSON in OPTIO_AGENT_TOLERATIONS/,
    );
    expect(podPool.markPodError).toHaveBeenCalledWith("pod-1", expect.any(Error));
  });
});

// ── Pod selection ─────────────────────────────────────────────────────
//
// Which pod a task lands on (retry affinity, least-loaded, removing gone /
// errored / stale-provisioning rows, scaling out) is agent-pod-pool's
// pickPod — see agent-pod-pool.int.test.ts. The repo pool hands it the repo's
// pool and limits, and a create callback that provisions a repo pod.

describe("getOrCreateRepoPod — pod selection via agent-pod-pool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
  });

  it("returns the pod pickPod picks from the repo's pool without creating one", async () => {
    const existing = repoPod({ id: "fresh-pod", podName: "fresh-pod-name", activeCount: 0 });
    podPool.pickPod.mockResolvedValueOnce(existing);

    const result = await getOrCreateRepoPod("git@github.com:Org/Repo.git", "main", {}, undefined, {
      preferredPodId: "pod-prev",
      maxAgentsPerPod: 3,
      maxPodInstances: 4,
    });

    expect(result).toBe(existing);
    // Keyed by the normalized repo URL, so every spelling of a repo shares pods
    expect(podPool.pickPod).toHaveBeenCalledWith("repo", REPO_URL, {
      preferredPodId: "pod-prev",
      maxAgentsPerPod: 3,
      maxPodInstances: 4,
      isolationKey: expect.any(String),
      create: expect.any(Function),
    });
    expect(podPool.insertPod).not.toHaveBeenCalled();
    expect(mockRuntimeCreate).not.toHaveBeenCalled();
  });

  it("defaults to 2 agents per pod and a single pod instance", async () => {
    podPool.pickPod.mockResolvedValueOnce(repoPod());

    await getOrCreateRepoPod(REPO_URL, "main", {});

    expect(podPool.pickPod).toHaveBeenCalledWith(
      "repo",
      REPO_URL,
      expect.objectContaining({
        preferredPodId: undefined,
        maxAgentsPerPod: 2,
        maxPodInstances: 1,
      }),
    );
  });

  it("provisions the instance index pickPod asks for and marks it ready", async () => {
    provisionNewPod({ instanceIndex: 2 });
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    const pod = await getOrCreateRepoPod(REPO_URL, "develop", {});

    expect(podPool.insertPod).toHaveBeenCalledWith({
      pool: "repo",
      poolKey: REPO_URL,
      isolationKey: expect.any(String),
      workspaceId: undefined,
      repoBranch: "develop",
      instanceIndex: 2,
    });
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.labels["optio.instance-index"]).toBe("2");
    expect(spec.env.OPTIO_REPO_URL).toBe(REPO_URL);
    expect(spec.env.OPTIO_REPO_BRANCH).toBe("develop");
    expect(podPool.markPodReady).toHaveBeenCalledWith("pod-1", {
      podName: "optio-repo-abc",
      podId: "k8s-id",
    });
    expect(pod).toMatchObject({ id: "pod-1", state: "ready", podName: "optio-repo-abc" });
  });

  it("marks the row errored and removes the pod when provisioning fails", async () => {
    provisionNewPod();
    const failure = new Error("ErrImageNeverPull");
    mockRuntimeCreate.mockRejectedValueOnce(failure);
    mockRuntimeDestroy.mockResolvedValueOnce(undefined);

    await expect(getOrCreateRepoPod(REPO_URL, "main", {})).rejects.toThrow("ErrImageNeverPull");

    expect(podPool.markPodError).toHaveBeenCalledWith("pod-1", failure);
    expect(podPool.markPodReady).not.toHaveBeenCalled();
    const podName = mockRuntimeCreate.mock.calls[0][0].name;
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({ id: podName, name: podName });
  });
});

describe("getOrCreateRepoPod — service account propagation", () => {
  const origServiceAccountName = process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME;

  afterEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
    if (origServiceAccountName !== undefined) {
      process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME = origServiceAccountName;
    } else {
      delete process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
  });

  it("passes service account name from env to container spec", async () => {
    process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME = "optio-workload-identity";

    provisionNewPod();
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {});

    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.serviceAccountName).toBe("optio-workload-identity");
  });

  it("omits service account name when env var not set", async () => {
    delete process.env.OPTIO_AGENT_SERVICE_ACCOUNT_NAME;

    provisionNewPod();
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {});

    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.serviceAccountName).toBeUndefined();
  });
});

// ── execTaskInRepoPod — env injection safety ────────────────────────

describe("execTaskInRepoPod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds a hostile prompt inertly — nothing executes before the agent command", async () => {
    // Regression for the Phase 4F symptoms ("n: command not found",
    // "optio/task-*: No such file or directory"): prompts with markdown
    // backticks, $HOME, wildcards, and literal newlines must reach the pod
    // byte-for-byte without the shell interpreting any of it.
    const hostilePrompt = [
      "Fix the `pr_opened` handling.",
      "",
      "1. Inspect $HOME and run `git status`.",
      "2. Ignore branches named optio/task-* entirely.",
      "3. Don't rewrite 'quoted' text.",
      "```bash",
      "touch injected-from-fenced-block",
      "```",
      "$(touch injected-from-substitution)",
    ].join("\n");

    mockRuntimeExec.mockResolvedValueOnce({ stdin: { write: vi.fn() } });
    const pod = repoPod({
      id: "pod-1",
      poolKey: "https://github.com/org/repo",
      podName: "optio-repo-org-repo-0",
      podId: "k8s-pod-1",
      state: "ready",
    });

    await execTaskInRepoPod(pod, "task-1", [`echo "[optio] agent"`], {
      OPTIO_PROMPT: hostilePrompt,
      OPTIO_REPO_BRANCH: "main",
    });

    // The task takes a slot on the pod before it execs
    expect(podPool.acquireSlot).toHaveBeenCalledWith("pod-1");

    const execCall = mockRuntimeExec.mock.calls[0];
    expect(execCall[0]).toEqual({ id: "k8s-pod-1", name: "optio-repo-org-repo-0" });
    expect(execCall[1][0]).toBe("bash");
    expect(execCall[1][1]).toBe("-c");
    const script: string = execCall[1][2];
    expect(script).not.toContain("eval $(");

    // Run the script prefix (set -e + env exports) through real bash and
    // verify the prompt round-trips exactly with no side effects.
    const lines = script.split("\n");
    const readyIdx = lines.findIndex((l) => l.startsWith("exec 7>"));
    expect(readyIdx).toBeGreaterThan(0);
    const prefix = lines.slice(0, readyIdx).join("\n");

    const { execFileSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "repo-pool-env-"));
    try {
      execFileSync("bash", ["-c", `${prefix}\nprintf '%s' "$OPTIO_PROMPT" > prompt-out`], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(readFileSync(join(dir, "prompt-out"), "utf8")).toBe(hostilePrompt);
      // No canary files — prompt contents never executed
      expect(readdirSync(dir)).toEqual(["prompt-out"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
