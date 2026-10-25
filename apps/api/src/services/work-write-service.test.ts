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
  TRIGGER_TARGET: { standalone: "job", "repo-blueprint": "task_config" },
}));
vi.mock("./workflow-service.js", () => ({
  createWorkflowRun: (...a: unknown[]) => m.createWorkflowRun(...a),
}));
vi.mock("./work-ownership.js", () => ({
  planNewWork: (...a: unknown[]) => m.planNewWork(...a),
  planWorkUpdate: vi.fn(),
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
import { createWork, keepPinnedRemoteWorkspaceHost, WorkError } from "./work-write-service.js";

const actor = { userId: "u-1", workspaceId: "ws-1", isAdmin: false, teamIds: [], adminTeamIds: [] };
const launch = { connectionId: "00000000-0000-0000-0000-0000000000c1", templateVersionId: "tv-1" };
/** `where.coder` is Coder's: the launch it becomes names the provider. */
const coderLaunch = { ...launch, provider: "coder" };

function spec(overrides: Partial<WorkSpec> = {}): WorkSpec {
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
  vi.clearAllMocks();
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

describe("createWork in a remote workspace (where.coder)", () => {
  it("starts the workspace, runs on the machine it pairs as, and keeps the launch", async () => {
    const made = await createWork(spec(), actor);

    expect(m.startCoderWork).toHaveBeenCalledWith(coderLaunch, actor, {
      workName: "Fix the login bug",
      // The work's owner and repo, for its agent policy (agent-policy.ts).
      policy: { owner: null, repoUrl: "https://gitlab.example.com/acme/app" },
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
      spec({
        where: { ...spec().where, localDir: "/home/coder/repo/apps/web" },
      }),
      actor,
    );
    expect(m.validateRunLocation.mock.calls[0][0].localDir).toBe("/home/coder/repo/apps/web");
  });

  it("answers Coder's refusal as the work's error", async () => {
    m.startCoderWork.mockRejectedValue(
      new RemoteWorkspaceError("No Coder connection — add one", 400),
    );
    await expect(createWork(spec(), actor)).rejects.toMatchObject({
      status: 400,
      message: "No Coder connection — add one",
    });
    expect(m.submitTask).not.toHaveBeenCalled();
  });

  it("lets the workspace go when the work isn't created after all", async () => {
    m.validateRunLocation.mockResolvedValueOnce({ ok: false, error: "Host not found" });
    await expect(createWork(spec(), actor)).rejects.toBeInstanceOf(WorkError);
    expect(m.cancelCoderWork).toHaveBeenCalledWith("host-coder");

    m.submitTask.mockRejectedValueOnce(new Error("db down"));
    await expect(createWork(spec(), actor)).rejects.toThrow("db down");
    expect(m.cancelCoderWork).toHaveBeenCalledTimes(2);
  });

  it("starts the workspace for a Job that runs now and stores the launch on it", async () => {
    m.createDefinition.mockImplementation(async (_kind: string, values: unknown) => ({
      id: "job-1",
      ...(values as object),
    }));
    m.createWorkflowRun.mockResolvedValue({ id: "run-1" });
    const made = await createWork(spec({ where: { runTarget: "local", coder: launch } }), actor);
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
      spec({
        where: { runTarget: "local", coder: { ...launch, checkoutDir: "/work/app" } },
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
      }),
      actor,
    );
    expect(m.startCoderWork).not.toHaveBeenCalled();
    expect(m.validateRunLocation).not.toHaveBeenCalled();
    expect(m.resolveConnectionFor).toHaveBeenCalledWith(actor, {
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
        spec({
          where: { runTarget: "local", coder: launch },
          when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        }),
        actor,
      ),
    ).rejects.toThrow(/That Coder connection isn't available/);
    expect(m.createDefinition).not.toHaveBeenCalled();
  });

  it("takes where.remoteWorkspace for any provider, as it is", async () => {
    const sandbox = { provider: "daytona" as const, templateId: "optio-node", parameters: null };
    await createWork(
      spec({ where: { ...spec().where, coder: undefined, remoteWorkspace: sandbox } }),
      actor,
    );
    expect(m.startCoderWork).toHaveBeenCalledWith(sandbox, actor, expect.any(Object));
    expect(m.recordTaskLaunch).toHaveBeenCalledWith("task-1", sandbox);
  });

  it("ignores where.coder for work in a pod", async () => {
    m.validateRunLocation.mockResolvedValueOnce({
      ok: true,
      location: { runTarget: "cluster", localHostId: null, localDir: null, localSessionMode: null },
    });
    await createWork(spec({ where: { ...spec().where, runTarget: "cluster" } }), actor);
    expect(m.startCoderWork).not.toHaveBeenCalled();
    expect(m.recordTaskLaunch).not.toHaveBeenCalled();
  });
});

describe("createWork and the deployment's runtimes (OPTIO_RUNTIMES)", () => {
  it("refuses a runtime the list leaves out before anything starts; unset takes it", async () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    try {
      await expect(createWork(spec({ who: { runtime: "codex" } }), actor)).rejects.toMatchObject({
        status: 400,
        message: "codex isn't available in this deployment",
      });
      expect(m.startCoderWork).not.toHaveBeenCalled();
      expect(m.submitTask).not.toHaveBeenCalled();

      vi.stubEnv("OPTIO_RUNTIMES", "");
      await createWork(spec({ who: { runtime: "codex" } }), actor);
      expect(m.submitTask).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
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
