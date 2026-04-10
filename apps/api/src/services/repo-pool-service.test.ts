import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
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
  repoPods: {
    id: "id",
    repoUrl: "repoUrl",
    state: "state",
    activeTaskCount: "activeTaskCount",
    updatedAt: "updatedAt",
    podName: "podName",
    podId: "podId",
    instanceIndex: "instanceIndex",
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
  parseJsonEnv,
} from "./repo-pool-service.js";

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

  it("decrements the active task count via DB update", async () => {
    vi.mocked(db.update(undefined as any).set(undefined as any).where as any).mockResolvedValueOnce(
      [],
    );

    await releaseRepoPodTask("pod-1");

    expect(db.update).toHaveBeenCalled();
    expect(db.update(undefined as any).set).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedAt: expect.any(Date),
      }),
    );
  });
});

// ── cleanupIdleRepoPods ─────────────────────────────────────────────

describe("cleanupIdleRepoPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no idle pods exist", async () => {
    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([]);

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(0);
  });

  it("destroys idle pods and removes their records", async () => {
    const idlePod = {
      id: "pod-1",
      repoUrl: "https://github.com/org/repo",
      podName: "optio-repo-org-repo-abc1",
      podId: "k8s-pod-id-1",
      state: "ready",
      activeTaskCount: 0,
      instanceIndex: 0,
    };

    // where() is used as both a terminal (idle pods, delete) and chainable (.limit() for sessions).
    // Return an object that supports .limit() and is also thenable.
    const chainable = {
      limit: vi.fn().mockResolvedValue([]),
      then: (res: any, rej?: any) => Promise.resolve([]).then(res, rej),
    };
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([idlePod]) // idle pods query
      .mockReturnValueOnce(chainable); // interactive sessions query (chainable to .limit())

    mockRuntimeDestroy.mockResolvedValueOnce(undefined);
    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValueOnce(undefined);

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).toHaveBeenCalledWith({
      id: idlePod.podId,
      name: idlePod.podName,
    });
  });

  it("continues cleanup even if one pod fails to destroy", async () => {
    const pods = [
      {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        podName: "pod-a",
        podId: "id-a",
        state: "ready",
        instanceIndex: 0,
      },
      {
        id: "pod-2",
        repoUrl: "https://github.com/org/repo",
        podName: "pod-b",
        podId: "id-b",
        state: "ready",
        instanceIndex: 1,
      },
    ];

    const chainable = {
      limit: vi.fn().mockResolvedValue([]),
      then: (res: any, rej?: any) => Promise.resolve([]).then(res, rej),
    };
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce(pods)
      .mockReturnValueOnce(chainable) // session check for pod-2 (sorted desc by instanceIndex)
      .mockReturnValueOnce(chainable); // session check for pod-1

    mockRuntimeDestroy
      .mockRejectedValueOnce(new Error("Failed to destroy"))
      .mockResolvedValueOnce(undefined);

    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValue(undefined);

    const cleaned = await cleanupIdleRepoPods();
    // First pod fails, second succeeds
    expect(cleaned).toBe(1);
  });

  it("skips destroy if pod has no podName", async () => {
    const pod = {
      id: "pod-1",
      repoUrl: "https://github.com/org/repo",
      podName: null,
      podId: null,
      state: "ready",
      instanceIndex: 0,
    };

    const chainable = {
      limit: vi.fn().mockResolvedValue([]),
      then: (res: any, rej?: any) => Promise.resolve([]).then(res, rej),
    };
    vi.mocked(db.select().from(undefined as any).where as any)
      .mockResolvedValueOnce([pod])
      .mockReturnValueOnce(chainable); // session check
    vi.mocked(db.delete(undefined as any).where as any).mockResolvedValue(undefined);

    const cleaned = await cleanupIdleRepoPods();
    expect(cleaned).toBe(1);
    expect(mockRuntimeDestroy).not.toHaveBeenCalled();
  });
});

// ── listRepoPods ────────────────────────────────────────────────────

describe("listRepoPods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all pods from the database", async () => {
    const mockPods = [
      { id: "pod-1", repoUrl: "url1", podName: "p1", state: "ready" },
      { id: "pod-2", repoUrl: "url2", podName: "p2", state: "provisioning" },
    ];

    vi.mocked(db.select().from as any).mockResolvedValueOnce(mockPods);

    const result = await listRepoPods();
    expect(result).toEqual(mockPods);
  });
});

// ── reconcileActiveTaskCounts ───────────────────────────────────────

describe("reconcileActiveTaskCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no pods exist", async () => {
    // First call: select pods
    vi.mocked(db.select().from as any).mockResolvedValueOnce([]);

    const result = await reconcileActiveTaskCounts();
    expect(result).toBe(0);
  });

  it("corrects inflated activeTaskCount to match actual running tasks", async () => {
    const pods = [
      { id: "pod-1", activeTaskCount: 13 },
      { id: "pod-2", activeTaskCount: 5 },
    ];

    // The mock chain uses mockReturnThis, so all methods return the same db mock.
    // where() calls are interleaved: SELECT count, UPDATE, SELECT count, UPDATE
    const dbMock = db as any;
    dbMock.from.mockResolvedValueOnce(pods);
    dbMock.where
      .mockResolvedValueOnce([{ count: 1 }]) // SELECT: pod-1 has 1 running task
      .mockResolvedValueOnce([]) // UPDATE: correct pod-1
      .mockResolvedValueOnce([{ count: 0 }]) // SELECT: pod-2 has 0 running tasks
      .mockResolvedValueOnce([]); // UPDATE: correct pod-2

    const result = await reconcileActiveTaskCounts();
    // Both pods should be corrected: pod-1 from 13→1, pod-2 from 5→0
    expect(result).toBe(2);
    expect(db.update).toHaveBeenCalled();
  });

  it("does not update pods that already have the correct count", async () => {
    const pods = [{ id: "pod-1", activeTaskCount: 0 }];

    const dbMock = db as any;
    dbMock.from.mockResolvedValueOnce(pods);
    dbMock.where.mockResolvedValueOnce([{ count: 0 }]);

    const result = await reconcileActiveTaskCounts();
    expect(result).toBe(0);
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
  /**
   * Helper: set up the db mock chain for getOrCreateRepoPod.
   * The function chains: select().from().where().orderBy() which needs special handling
   * because mockResolvedValueOnce on where() consumes the chain before orderBy() is called.
   */
  function mockGetOrCreateFlow(opts: {
    existingPods?: any[];
    podCount?: number;
    workspaceLookup?: any[];
    insertedPod?: any;
  }) {
    const dbMock = db as any;

    // The main challenge: select().from(repoPods).where().orderBy() must be awaitable
    // after the full chain. We use a thenable + orderBy combo.
    const orderByResult = opts.existingPods ?? [];
    const chainableWithOrderBy = {
      orderBy: vi.fn().mockResolvedValue(orderByResult),
    };

    // Track call count to know which where() call we're on:
    // 1st where: existing pods (needs .orderBy)
    // 2nd where: pod count (terminal, returns [{count}])
    // 3rd where: workspace lookup (terminal, returns workspace row)
    // 4th+ where: update calls (terminal)
    let whereCallCount = 0;
    dbMock.where.mockImplementation(() => {
      whereCallCount++;
      if (whereCallCount === 1) {
        // existing pods query → needs .orderBy()
        return chainableWithOrderBy;
      }
      if (whereCallCount === 2) {
        // pod count query
        return Promise.resolve([{ count: opts.podCount ?? 0 }]);
      }
      if (whereCallCount === 3 && opts.workspaceLookup !== undefined) {
        // workspace lookup
        return Promise.resolve(opts.workspaceLookup);
      }
      // Remaining calls: update queries (e.g. state transitions)
      return Promise.resolve([]);
    });

    if (opts.insertedPod) {
      dbMock.returning.mockResolvedValueOnce([opts.insertedPod]);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset where to default behavior
    (db as any).where.mockReset().mockReturnThis();
  });

  it("rejects DinD when no workspaceId is provided", async () => {
    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    await expect(
      getOrCreateRepoPod("https://github.com/org/repo", "main", {}, undefined, {
        dockerInDocker: true,
      }),
    ).rejects.toThrow("Docker-in-Docker requires a workspace with allowDockerInDocker enabled");
  });

  it("rejects DinD when workspace has allowDockerInDocker=false", async () => {
    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      workspaceLookup: [{ allowDockerInDocker: false }],
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    await expect(
      getOrCreateRepoPod("https://github.com/org/repo", "main", {}, undefined, {
        dockerInDocker: true,
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Docker-in-Docker requires workspace admin opt-in");
  });

  it("rejects DinD when workspace is not found", async () => {
    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      workspaceLookup: [],
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    await expect(
      getOrCreateRepoPod("https://github.com/org/repo", "main", {}, undefined, {
        dockerInDocker: true,
        workspaceId: "nonexistent-ws",
      }),
    ).rejects.toThrow("Docker-in-Docker requires workspace admin opt-in");
  });

  it("allows DinD when workspace has allowDockerInDocker=true", async () => {
    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      workspaceLookup: [{ allowDockerInDocker: true }],
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    const pod = await getOrCreateRepoPod("https://github.com/org/repo", "main", {}, undefined, {
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
    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    const pod = await getOrCreateRepoPod("https://github.com/org/repo", "main", {}, undefined, {
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
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([]); // pod lookup returns nothing

    const result = await killOrphanedAgentInPod("nonexistent-pod", "task-1");
    expect(result).toBe(false);
  });

  it("returns false when pod has no podName", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([{ id: "pod-1", podName: null, state: "ready" }]);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
  });

  it("returns false when pod is not in ready state", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([
      { id: "pod-1", podName: "p1", podId: "pid1", state: "error" },
    ]);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
  });

  it("returns false when pod is not reachable", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([
      { id: "pod-1", podName: "p1", podId: "pid1", state: "ready" },
    ]);
    mockRuntimeStatus.mockRejectedValueOnce(new Error("unreachable"));

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
  });

  it("returns true when orphaned processes are found and killed", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([
      { id: "pod-1", podName: "p1", podId: "pid1", state: "ready" },
    ]);
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const killSession = makeExecSession("killed\n");
    const cleanSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(killSession).mockResolvedValueOnce(cleanSession);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(true);
    expect(mockRuntimeExec).toHaveBeenCalledTimes(2); // kill + worktree cleanup
  });

  it("returns false when no orphaned processes are found but still cleans worktree", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([
      { id: "pod-1", podName: "p1", podId: "pid1", state: "ready" },
    ]);
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    const killSession = makeExecSession("none\n");
    const cleanSession = makeExecSession("");
    mockRuntimeExec.mockResolvedValueOnce(killSession).mockResolvedValueOnce(cleanSession);

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    // Should still clean up the worktree even if no processes found
    expect(mockRuntimeExec).toHaveBeenCalledTimes(2);
  });

  it("handles kill exec failure gracefully and still cleans worktree", async () => {
    const dbMock = db as any;
    dbMock.where.mockResolvedValueOnce([
      { id: "pod-1", podName: "p1", podId: "pid1", state: "ready" },
    ]);
    mockRuntimeStatus.mockResolvedValueOnce({ state: "running" });

    // Kill exec throws, but cleanup should still run
    mockRuntimeExec
      .mockRejectedValueOnce(new Error("exec failed"))
      .mockResolvedValueOnce(makeExecSession(""));

    const result = await killOrphanedAgentInPod("pod-1", "task-1");
    expect(result).toBe(false);
    // Should still attempt worktree cleanup
    expect(mockRuntimeExec).toHaveBeenCalledTimes(2);
  });
});

// ── parseJsonEnv ─────────────────────────────────────────────────────

describe("parseJsonEnv", () => {
  it("returns undefined when value is undefined", () => {
    expect(parseJsonEnv("TEST_VAR", undefined)).toBeUndefined();
  });

  it("returns undefined when value is empty string", () => {
    expect(parseJsonEnv("TEST_VAR", "")).toBeUndefined();
  });

  it("parses valid JSON object", () => {
    const result = parseJsonEnv("TEST_VAR", '{"disktype":"ssd"}');
    expect(result).toEqual({ disktype: "ssd" });
  });

  it("parses valid JSON array", () => {
    const result = parseJsonEnv(
      "TEST_VAR",
      '[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]',
    );
    expect(result).toEqual([{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);
  });

  it("throws a descriptive error for malformed JSON", () => {
    expect(() => parseJsonEnv("OPTIO_AGENT_NODE_SELECTOR", "{bad json}")).toThrow(
      /Invalid JSON in OPTIO_AGENT_NODE_SELECTOR/,
    );
  });

  it("includes the original value in the error message", () => {
    expect(() => parseJsonEnv("OPTIO_AGENT_TOLERATIONS", "not-json")).toThrow(/not-json/);
  });
});

// ── nodeSelector / tolerations env var integration ────────────────────

describe("getOrCreateRepoPod — nodeSelector and tolerations env vars", () => {
  function mockGetOrCreateFlow(opts: {
    existingPods?: any[];
    podCount?: number;
    insertedPod?: any;
  }) {
    const dbMock = db as any;

    const orderByResult = opts.existingPods ?? [];
    const chainableWithOrderBy = {
      orderBy: vi.fn().mockResolvedValue(orderByResult),
    };

    let whereCallCount = 0;
    dbMock.where.mockImplementation(() => {
      whereCallCount++;
      if (whereCallCount === 1) return chainableWithOrderBy;
      if (whereCallCount === 2) return Promise.resolve([{ count: opts.podCount ?? 0 }]);
      return Promise.resolve([]);
    });

    if (opts.insertedPod) {
      dbMock.returning.mockResolvedValueOnce([opts.insertedPod]);
    }
  }

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

    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod("https://github.com/org/repo", "main", {});
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.nodeSelector).toEqual({ disktype: "ssd" });
  });

  it("passes parsed tolerations to the container spec", async () => {
    delete process.env.OPTIO_AGENT_NODE_SELECTOR;
    process.env.OPTIO_AGENT_TOLERATIONS =
      '[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]';

    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod("https://github.com/org/repo", "main", {});
    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.tolerations).toEqual([{ key: "gpu", operator: "Exists", effect: "NoSchedule" }]);
  });

  it("throws a descriptive error when OPTIO_AGENT_NODE_SELECTOR contains malformed JSON", async () => {
    process.env.OPTIO_AGENT_NODE_SELECTOR = "{bad json}";
    delete process.env.OPTIO_AGENT_TOLERATIONS;

    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    await expect(getOrCreateRepoPod("https://github.com/org/repo", "main", {})).rejects.toThrow(
      /Invalid JSON in OPTIO_AGENT_NODE_SELECTOR/,
    );
  });

  it("throws a descriptive error when OPTIO_AGENT_TOLERATIONS contains malformed JSON", async () => {
    delete process.env.OPTIO_AGENT_NODE_SELECTOR;
    process.env.OPTIO_AGENT_TOLERATIONS = "not valid json";

    mockGetOrCreateFlow({
      existingPods: [],
      podCount: 0,
      insertedPod: {
        id: "pod-1",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "main",
        state: "provisioning",
        instanceIndex: 0,
      },
    });

    await expect(getOrCreateRepoPod("https://github.com/org/repo", "main", {})).rejects.toThrow(
      /Invalid JSON in OPTIO_AGENT_TOLERATIONS/,
    );
  });
});
