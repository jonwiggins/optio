/**
 * Docker-in-Docker repo pods: the start command goes through the dind
 * entrypoint (so dockerd runs) and a preStop hook stops dockerd, on both the
 * bare-pod and the StatefulSet path. Other repo pods are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("./secret-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secret-service.js")>()),
  resolveSecretsForSetup: vi.fn(async () => ({})),
  workspaceRestrictsPodSecrets: vi.fn(async () => false),
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
const mockRuntimeStartRun = vi.fn();

vi.mock("./container-service.js", () => ({
  getRuntime: () => ({
    create: mockRuntimeCreate,
    exec: mockRuntimeExec,
    status: mockRuntimeStatus,
    destroy: mockRuntimeDestroy,
    startRun: mockRuntimeStartRun,
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

const workloadManager = vi.hoisted(() => ({
  ensureStatefulSet: vi.fn(),
  waitForPodRunning: vi.fn(),
}));
vi.mock("./k8s-workload-service.js", () => ({
  isStatefulSetEnabled: vi.fn(() => false),
  getWorkloadManager: () => workloadManager,
  K8sWorkloadManager: {
    podNameForOrdinal: (name: string, ordinal: number) => `${name}-${ordinal}`,
  },
}));

import { db } from "../db/client.js";
import { getOrCreateRepoPod, type RepoPod } from "./repo-pool-service.js";
import { isStatefulSetEnabled } from "./k8s-workload-service.js";
import { DIND_POD_COMMAND, DIND_PRE_STOP } from "./dind-pod.js";

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

const REPO_INIT = ["/opt/optio/repo-init.sh"];

describe("getOrCreateRepoPod: Docker-in-Docker pod spec (bare pod)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
    vi.mocked(isStatefulSetEnabled).mockReturnValue(false);
  });

  it("starts through the dind entrypoint and adds the preStop hook", async () => {
    provisionNewPod({ workspaceLookup: [{ allowDockerInDocker: true }] });
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
      dockerInDocker: true,
      workspaceId: "ws-1",
    });

    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.command).toEqual(DIND_POD_COMMAND);
    expect(spec.command.join(" ")).toContain("/opt/optio/dind-entrypoint.sh");
    expect(spec.preStop).toEqual(DIND_PRE_STOP);
    // The existing DinD fields stay as they were.
    expect(spec.hostUsers).toBe(false);
    expect(spec.capabilities).toEqual(["SYS_CHROOT"]);
  });

  it("leaves a non-DinD pod's command and lifecycle unchanged", async () => {
    provisionNewPod();
    mockRuntimeCreate.mockResolvedValueOnce({ id: "k8s-id", name: "optio-repo-abc" });

    await getOrCreateRepoPod(REPO_URL, "main", {}, undefined, { dockerInDocker: false });

    const spec = mockRuntimeCreate.mock.calls[0][0];
    expect(spec.command).toEqual(REPO_INIT);
    expect(spec.preStop).toBeUndefined();
  });
});

describe("getOrCreateRepoPod: Docker-in-Docker pod spec (StatefulSet)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db as any).where.mockReset().mockReturnThis();
    vi.mocked(isStatefulSetEnabled).mockReturnValue(true);
    workloadManager.ensureStatefulSet.mockResolvedValue({ replicas: 1 });
    workloadManager.waitForPodRunning.mockResolvedValue(undefined);
    mockRuntimeStatus.mockResolvedValue({ state: "running" });
  });

  function stsSpec() {
    return workloadManager.ensureStatefulSet.mock.calls[0][0].spec;
  }

  it("starts through the dind entrypoint and adds the preStop hook", async () => {
    provisionNewPod({ workspaceLookup: [{ allowDockerInDocker: true }] });

    await getOrCreateRepoPod(REPO_URL, "main", {}, undefined, {
      dockerInDocker: true,
      workspaceId: "ws-1",
    });

    expect(stsSpec().command).toEqual(DIND_POD_COMMAND);
    expect(stsSpec().preStop).toEqual(DIND_PRE_STOP);
  });

  it("leaves a non-DinD pod's command and lifecycle unchanged", async () => {
    provisionNewPod();

    await getOrCreateRepoPod(REPO_URL, "main", {});

    expect(stsSpec().command).toEqual(REPO_INIT);
    expect(stsSpec().preStop).toBeUndefined();
  });
});
