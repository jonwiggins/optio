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
import { createWork } from "./work-write-service.js";
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
