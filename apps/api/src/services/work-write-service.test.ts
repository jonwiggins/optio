import { beforeEach, describe, expect, it, vi } from "vitest";

// Work in a remote workspace (docs/remote-workspaces.md): POST /api/work
// with `where.remoteWorkspace` — or the older `where.coder`, Coder's —
// starts the workspace first, then validates the run location it returns.
// Everything around it is mocked.

const m = vi.hoisted(() => ({
  startCoderWork: vi.fn(),
  cancelCoderWork: vi.fn(),
  recordTaskLaunch: vi.fn(),
  resolveConnectionFor: vi.fn(),
  validateRunLocation: vi.fn(),
  submitTask: vi.fn(),
  createDefinition: vi.fn(),
  createWorkflowRun: vi.fn(),
  planNewWork: vi.fn(),
  planWorkUpdate: vi.fn(),
  getDefinition: vi.fn(),
  updateDefinition: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock("./remote-workspace-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remote-workspace-service.js")>();
  return {
    RemoteWorkspaceError: actual.RemoteWorkspaceError,
    startRemoteWorkspaceWork: (...a: unknown[]) => m.startCoderWork(...a),
    cancelRemoteWorkspaceWork: (...a: unknown[]) => m.cancelCoderWork(...a),
    recordTaskLaunch: (...a: unknown[]) => m.recordTaskLaunch(...a),
    resolveConnectionFor: (...a: unknown[]) => m.resolveConnectionFor(...a),
  };
});
vi.mock("./local-run-service.js", () => ({
  validateRunLocation: (...a: unknown[]) => m.validateRunLocation(...a),
}));
vi.mock("./task-service.js", () => ({
  submitTask: (...a: unknown[]) => m.submitTask(...a),
  TaskInputError: class TaskInputError extends Error {},
}));
vi.mock("./work-definition-service.js", () => ({
  createDefinition: (...a: unknown[]) => m.createDefinition(...a),
  getDefinition: (...a: unknown[]) => m.getDefinition(...a),
  updateDefinition: (...a: unknown[]) => m.updateDefinition(...a),
  saveAutoMergeConfirmation: async () => {},
  autoMergeConfirmationOf: async () => ({}),
  TRIGGER_TARGET: { standalone: "job", "repo-blueprint": "task_config" },
}));
vi.mock("./workflow-service.js", () => ({
  createWorkflowRun: (...a: unknown[]) => m.createWorkflowRun(...a),
}));
vi.mock("./work-ownership.js", () => ({
  planNewWork: (...a: unknown[]) => m.planNewWork(...a),
  planWorkUpdate: (...a: unknown[]) => m.planWorkUpdate(...a),
  workChangeError: vi.fn(),
}));
vi.mock("./trigger-service.js", () => ({
  validateTriggerConfig: () => null,
  createTrigger: vi.fn(),
}));
vi.mock("./local-blueprint-service.js", () => ({}));
vi.mock("./local-host-service.js", () => ({}));
vi.mock("./local-terminal-service.js", () => ({}));
vi.mock("./interactive-session-service.js", () => ({}));
vi.mock("./persistent-agent-service.js", () => ({}));
vi.mock("./repo-service.js", () => ({
  getRepoByUrl: vi.fn(),
  repoDefaultBranch: async () => "main",
}));

import type { WorkSpec } from "@optio/shared";
import { RemoteWorkspaceError } from "./remote-workspace-service.js";
import { ORGANIZATION_REMOTE_WORKSPACE_REFUSED } from "./remote-workspace-policy.js";
import {
  createWork,
  keepPinnedRemoteWorkspaceHost,
  updateWork,
  WorkError,
} from "./work-write-service.js";
const actor = { userId: "u-1", workspaceId: "ws-1", isAdmin: false };
function spec(runtime: "codex" | "opencode"): WorkSpec {
  return {
    name: "Feature test",
    when: { type: "manual" },
    where: {
      runTarget: "local",
      repoUrl: "https://github.com/acme/app",
      repoBranch: "main",
      localHostId: "host-1",
      localDir: "/workspace/app",
    },
    who: { runtime },
    what: { prompt: "Fix it" },
    then: "until-merged",
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.planNewWork.mockResolvedValue({ ok: true, ownerUserId: "u-1" });
  m.validateRunLocation.mockResolvedValue({
    ok: true,
    location: {
      runTarget: "local",
      localHostId: "host-1",
      localDir: "/workspace/app",
      localSessionMode: "headless",
    },
  });
  m.submitTask.mockResolvedValue({ id: "task-1" });
});
describe("work runtime allowlist", () => {
  it("rejects an excluded runtime before creating work, and preserves it when unset", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    try {
      await expect(createWork(spec("codex"), actor)).rejects.toMatchObject({
        status: 400,
        message: "codex isn't available in this deployment",
      });
      expect(m.submitTask).not.toHaveBeenCalled();
      vi.stubEnv("OPTIO_RUNTIMES", "");
      await createWork(spec("codex"), actor);
      expect(m.submitTask).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("createWork in a remote workspace (where.coder)", () => {
  const rwActor = {
    userId: "u-1",
    workspaceId: "ws-1",
    isAdmin: false,
    teamIds: [],
    adminTeamIds: [],
  };
  const launch = {
    connectionId: "00000000-0000-0000-0000-0000000000c1",
    templateVersionId: "tv-1",
  };
  /** `where.coder` is Coder's: the launch it becomes names the provider. */
  const coderLaunch = { ...launch, provider: "coder" };

  function rwSpec(overrides: Partial<WorkSpec> = {}): WorkSpec {
    return {
      name: "Fix the login bug",
      when: { type: "manual" },
      where: {
        runTarget: "local",
        repoUrl: "https://gitlab.example.com/acme/app",
        repoBranch: "main",
        coder: launch,
      },
      who: { runtime: "claude-code" },
      what: { prompt: "Fix it" },
      then: "exits",
      ...overrides,
    };
  }

  beforeEach(() => {
    m.planNewWork.mockResolvedValue({ ok: true, ownerUserId: "u-1", ownerTeamId: null });
    m.startCoderWork.mockResolvedValue({
      localHostId: "host-coder",
      localDir: "/home/coder/repo",
      connectionId: launch.connectionId,
      workspaceId: "w-1",
      workspaceName: "optio-fix-the-login-bug-abc123",
    });
    m.validateRunLocation.mockImplementation(async (input: Record<string, unknown>) => ({
      ok: true,
      location: {
        runTarget: "local",
        localHostId: input.localHostId,
        localDir: input.localDir,
        localSessionMode: "headless",
      },
    }));
    m.submitTask.mockResolvedValue({ id: "task-1" });
    m.cancelCoderWork.mockResolvedValue(undefined);
  });

  it("starts the workspace, runs on the machine it pairs as, and keeps the launch", async () => {
    const made = await createWork(rwSpec(), rwActor);

    expect(m.startCoderWork).toHaveBeenCalledWith(coderLaunch, rwActor, {
      workName: "Fix the login bug",
    });
    expect(m.validateRunLocation.mock.calls[0][0]).toMatchObject({
      runTarget: "local",
      localHostId: "host-coder",
      localDir: "/home/coder/repo",
      repoUrl: "https://gitlab.example.com/acme/app",
    });
    const task = m.submitTask.mock.calls[0][0];
    expect(task).toMatchObject({
      runTarget: "local",
      localHostId: "host-coder",
      localDir: "/home/coder/repo",
    });
    expect(task).not.toHaveProperty("remoteWorkspaceLaunch");
    expect(m.recordTaskLaunch).toHaveBeenCalledWith("task-1", coderLaunch);
    expect(made).toMatchObject({ kind: "repo-task", id: "task-1" });
  });

  it("keeps a directory the person picked inside the checkout", async () => {
    await createWork(
      rwSpec({
        where: { ...rwSpec().where, localDir: "/home/coder/repo/apps/web" },
      }),
      rwActor,
    );
    expect(m.validateRunLocation.mock.calls[0][0].localDir).toBe("/home/coder/repo/apps/web");
  });

  it("answers Coder's refusal as the work's error", async () => {
    m.startCoderWork.mockRejectedValue(
      new RemoteWorkspaceError("No Coder connection — add one", 400),
    );
    await expect(createWork(rwSpec(), rwActor)).rejects.toMatchObject({
      status: 400,
      message: "No Coder connection — add one",
    });
    expect(m.submitTask).not.toHaveBeenCalled();
  });

  it("lets the workspace go when the work isn't created after all", async () => {
    m.validateRunLocation.mockResolvedValueOnce({ ok: false, error: "Host not found" });
    await expect(createWork(rwSpec(), rwActor)).rejects.toBeInstanceOf(WorkError);
    expect(m.cancelCoderWork).toHaveBeenCalledWith("host-coder");

    m.submitTask.mockRejectedValueOnce(new Error("db down"));
    await expect(createWork(rwSpec(), rwActor)).rejects.toThrow("db down");
    expect(m.cancelCoderWork).toHaveBeenCalledTimes(2);
  });

  it("starts the workspace for a Job that runs now and stores the launch on it", async () => {
    m.createDefinition.mockImplementation(async (_kind: string, values: unknown) => ({
      id: "job-1",
      ...(values as object),
    }));
    m.createWorkflowRun.mockResolvedValue({ id: "run-1" });
    const made = await createWork(
      rwSpec({ where: { runTarget: "local", coder: launch } }),
      rwActor,
    );
    expect(m.startCoderWork).toHaveBeenCalledTimes(1);
    expect(m.createDefinition.mock.calls[0][1]).toMatchObject({
      runTarget: "local",
      localHostId: "host-coder",
      remoteWorkspaceLaunch: coderLaunch,
    });
    expect(made.run?.id).toBe("run-1");
  });

  it("saves work on a schedule with its launch and no machine: the workspace is made when it fires", async () => {
    m.resolveConnectionFor.mockResolvedValueOnce({ id: launch.connectionId, enabled: true });
    m.createDefinition.mockImplementation(async (_kind: string, values: unknown) => ({
      id: "job-2",
      ...(values as object),
    }));
    await createWork(
      rwSpec({
        where: { runTarget: "local", coder: { ...launch, checkoutDir: "/work/app" } },
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
      }),
      rwActor,
    );
    expect(m.startCoderWork).not.toHaveBeenCalled();
    expect(m.validateRunLocation).not.toHaveBeenCalled();
    expect(m.resolveConnectionFor).toHaveBeenCalledWith(rwActor, {
      connectionId: launch.connectionId,
      provider: "coder",
    });
    expect(m.createDefinition.mock.calls[0][1]).toMatchObject({
      runTarget: "local",
      localHostId: null,
      localDir: "/work/app",
      remoteWorkspaceLaunch: { ...coderLaunch, checkoutDir: "/work/app" },
    });
    expect(m.createWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses work on a schedule when no Coder connection applies", async () => {
    m.resolveConnectionFor.mockResolvedValueOnce(null);
    await expect(
      createWork(
        rwSpec({
          where: { runTarget: "local", coder: launch },
          when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        }),
        rwActor,
      ),
    ).rejects.toThrow(/That Coder connection isn't available/);
    expect(m.createDefinition).not.toHaveBeenCalled();
  });

  it("refuses organization work on a schedule or a Job in a remote workspace", async () => {
    m.planNewWork.mockResolvedValue({ ok: true, ownerUserId: null, ownerTeamId: null });
    m.resolveConnectionFor.mockResolvedValue({ id: launch.connectionId, enabled: true });
    for (const s of [
      rwSpec({
        where: {
          runTarget: "local",
          repoUrl: "https://gitlab.example.com/acme/app",
          coder: launch,
        },
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
      }),
      rwSpec({ where: { runTarget: "local", coder: launch } }),
    ]) {
      await expect(createWork(s, rwActor)).rejects.toMatchObject({
        status: 400,
        message: ORGANIZATION_REMOTE_WORKSPACE_REFUSED,
      });
    }
    expect(m.startCoderWork).not.toHaveBeenCalled();
    expect(m.createDefinition).not.toHaveBeenCalled();
  });

  it("still starts an organization Task someone runs now, as that person", async () => {
    m.planNewWork.mockResolvedValue({ ok: true, ownerUserId: null, ownerTeamId: null });
    await createWork(rwSpec(), rwActor);
    expect(m.startCoderWork).toHaveBeenCalledWith(coderLaunch, rwActor, expect.any(Object));
    expect(m.recordTaskLaunch).toHaveBeenCalledWith("task-1", coderLaunch);
  });

  it("refuses an edit that leaves organization work in a remote workspace", async () => {
    m.getDefinition.mockResolvedValue({
      id: "job-9",
      kind: "standalone",
      workspaceId: "ws-1",
      ownerUserId: null,
      remoteWorkspaceLaunch: coderLaunch,
      localHostId: null,
      localDir: null,
    });
    m.planWorkUpdate.mockResolvedValue({ ok: true, ownerUserId: null });
    m.resolveConnectionFor.mockResolvedValue({ id: launch.connectionId, enabled: true });
    await expect(
      updateWork(
        "job-9",
        rwSpec({
          where: { runTarget: "local", coder: { ...launch, templateVersionId: "tv-other" } },
          when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        }),
        { ...rwActor, userId: "admin-b", isAdmin: true },
      ),
    ).rejects.toMatchObject({ status: 400, message: ORGANIZATION_REMOTE_WORKSPACE_REFUSED });
    expect(m.updateDefinition).not.toHaveBeenCalled();
  });

  it("takes where.remoteWorkspace for any provider, as it is", async () => {
    const sandbox = { provider: "daytona" as const, templateId: "optio-node", parameters: null };
    await createWork(
      rwSpec({ where: { ...rwSpec().where, coder: undefined, remoteWorkspace: sandbox } }),
      rwActor,
    );
    expect(m.startCoderWork).toHaveBeenCalledWith(sandbox, rwActor, expect.any(Object));
    expect(m.recordTaskLaunch).toHaveBeenCalledWith("task-1", sandbox);
  });

  it("ignores where.coder for work in a pod", async () => {
    m.validateRunLocation.mockResolvedValueOnce({
      ok: true,
      location: { runTarget: "cluster", localHostId: null, localDir: null, localSessionMode: null },
    });
    await createWork(rwSpec({ where: { ...rwSpec().where, runTarget: "cluster" } }), rwActor);
    expect(m.startCoderWork).not.toHaveBeenCalled();
    expect(m.recordTaskLaunch).not.toHaveBeenCalled();
  });
});

describe("keepPinnedRemoteWorkspaceHost", () => {
  const launch = { connectionId: "c1", templateId: "t1", parameters: { cpu: "4" } };
  const saved = {
    remoteWorkspaceLaunch: launch,
    localHostId: "host-1",
    localDir: "/home/coder/repo",
  };

  it("keeps the machine the first firing paired when the workspace is the same", () => {
    // The form sends unset fields as null; the saved launch left them out.
    const columns = {
      remoteWorkspaceLaunch: { ...launch, workspaceId: null, name: null, checkoutDir: null },
      localHostId: null,
      localDir: null,
    };
    keepPinnedRemoteWorkspaceHost(columns, saved);
    expect(columns).toMatchObject({ localHostId: "host-1", localDir: "/home/coder/repo" });
  });

  it("lets a changed workspace, or a move off it, start over", () => {
    const changed = {
      remoteWorkspaceLaunch: { ...launch, parameters: { cpu: "8" } },
      localHostId: null,
      localDir: null,
    };
    keepPinnedRemoteWorkspaceHost(changed, saved);
    expect(changed.localHostId).toBeNull();
    const cluster = { remoteWorkspaceLaunch: null, localHostId: null, localDir: null };
    keepPinnedRemoteWorkspaceHost(cluster, saved);
    expect(cluster.localHostId).toBeNull();
  });
});
