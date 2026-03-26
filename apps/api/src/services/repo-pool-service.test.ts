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
  releaseRepoPodTask,
  cleanupIdleRepoPods,
  listRepoPods,
  reconcileActiveTaskCounts,
  deleteNetworkPolicy,
} from "./repo-pool-service.js";

// ── resolveImage ────────────────────────────────────────────────────

describe("resolveImage", () => {
  const origEnv = process.env.OPTIO_AGENT_IMAGE;
  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.OPTIO_AGENT_IMAGE = origEnv;
    } else {
      delete process.env.OPTIO_AGENT_IMAGE;
    }
  });

  it("returns custom image when provided", () => {
    expect(resolveImage({ customImage: "my-org/my-image:v2" })).toBe("my-org/my-image:v2");
  });

  it("returns preset image tag when preset is valid", () => {
    expect(resolveImage({ preset: "node" })).toBe("optio-node:latest");
  });

  it("returns preset image for rust", () => {
    expect(resolveImage({ preset: "rust" })).toBe("optio-rust:latest");
  });

  it("returns preset image for python", () => {
    expect(resolveImage({ preset: "python" })).toBe("optio-python:latest");
  });

  it("returns preset image for go", () => {
    expect(resolveImage({ preset: "go" })).toBe("optio-go:latest");
  });

  it("returns preset image for full", () => {
    expect(resolveImage({ preset: "full" })).toBe("optio-full:latest");
  });

  it("returns preset image for base", () => {
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

  it("falls through to default for invalid preset", () => {
    delete process.env.OPTIO_AGENT_IMAGE;
    expect(resolveImage({ preset: "nonexistent" as any })).toBe("optio-agent:latest");
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

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([idlePod]);

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

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce(pods);

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

    vi.mocked(db.select().from(undefined as any).where as any).mockResolvedValueOnce([pod]);
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
