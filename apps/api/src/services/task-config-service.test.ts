import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workDefinitions: { workspaceId: "work_definitions.workspace_id" },
  workflowTriggers: {
    id: "workflow_triggers.id",
    targetType: "workflow_triggers.target_type",
    targetId: "workflow_triggers.target_id",
    type: "workflow_triggers.type",
    enabled: "workflow_triggers.enabled",
    createdAt: "workflow_triggers.created_at",
  },
}));

vi.mock("./work-definition-service.js", () => ({
  getDefinition: vi.fn(),
  listDefinitions: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));

vi.mock("./task-service.js", () => ({
  createTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("./prompt-template-service.js", () => ({
  getPromptTemplateById: vi.fn(),
  renderTemplateString: vi.fn((s: string) => s),
  renderRunTitle: vi.fn((s: string | null, _p: unknown, fallback: string) => s || fallback),
}));

const mockRepoDefaultBranch = vi.fn().mockResolvedValue("main");
vi.mock("./repo-service.js", () => ({
  getRepoByUrl: vi.fn().mockResolvedValue(null),
  repoDefaultBranch: (...args: unknown[]) => mockRepoDefaultBranch(...args),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: vi.fn() },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as taskService from "./task-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { createDefinition, getDefinition } from "./work-definition-service.js";
import { createTaskConfig, instantiateTask } from "./task-config-service.js";

function mockGetTaskConfig(definition: Record<string, unknown>) {
  vi.mocked(getDefinition).mockResolvedValue(definition as any);
}

/** A `repo-blueprint` work definition, in the unified row shape. */
const baseConfig = {
  id: "cfg-1",
  kind: "repo-blueprint",
  name: "Nightly",
  runTitle: "Nightly task",
  prompt: "Do the thing",
  promptTemplateId: null,
  repoUrl: "https://github.com/o/r",
  repoBranch: "main",
  agentType: null,
  maxRetries: 3,
  priority: 100,
  enabled: true,
  createdBy: null,
};

describe("task-config-service instantiateTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-1", maxRetries: 3 } as any);
  });

  it("uses the config's own workspaceId when set", async () => {
    mockGetTaskConfig({ ...baseConfig, workspaceId: "ws-config" });

    await instantiateTask("cfg-1");

    expect(getDefinition).toHaveBeenCalledWith("cfg-1", "repo-blueprint");
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-config" }),
    );
    expect(getRepoByUrl).not.toHaveBeenCalled();
  });

  it("points the spawned task at its definition and renders the run title", async () => {
    mockGetTaskConfig({ ...baseConfig, workspaceId: "ws-config" });

    await instantiateTask("cfg-1", { triggerId: "trig-1" });

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Nightly task",
        prompt: "Do the thing",
        workId: "cfg-1",
        metadata: expect.objectContaining({
          taskConfigId: "cfg-1",
          taskConfigName: "Nightly",
          triggerId: "trig-1",
        }),
      }),
    );
  });

  it("refuses a missing or disabled definition", async () => {
    vi.mocked(getDefinition).mockResolvedValueOnce(null);
    await expect(instantiateTask("cfg-1")).rejects.toThrow(/not found/);

    mockGetTaskConfig({ ...baseConfig, enabled: false, workspaceId: null });
    await expect(instantiateTask("cfg-1")).rejects.toThrow(/disabled/);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("falls back to the repo's workspaceId when the config has none (issue #544)", async () => {
    mockGetTaskConfig({ ...baseConfig, workspaceId: null });
    vi.mocked(getRepoByUrl).mockResolvedValueOnce({ id: "repo-1", workspaceId: "ws-repo" } as any);

    await instantiateTask("cfg-1");

    expect(getRepoByUrl).toHaveBeenCalledWith("https://github.com/o/r");
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-repo" }),
    );
  });

  it("passes a NULL workspaceId when neither config nor repo has one", async () => {
    mockGetTaskConfig({ ...baseConfig, workspaceId: null });

    await instantiateTask("cfg-1");

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null }),
    );
  });
});

describe("task-config-service createTaskConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createDefinition).mockImplementation(
      async (_kind, values) => ({ ...baseConfig, ...values, id: "cfg-new" }) as any,
    );
  });

  it("stores the repo's default branch when none is given (#643)", async () => {
    mockRepoDefaultBranch.mockResolvedValueOnce("master");

    await createTaskConfig({
      name: "Nightly",
      title: "Nightly task",
      prompt: "Do the thing",
      repoUrl: "https://github.com/o/r",
      workspaceId: "ws-1",
    } as any);

    expect(mockRepoDefaultBranch).toHaveBeenCalledWith("https://github.com/o/r", "ws-1");
    expect(createDefinition).toHaveBeenCalledWith(
      "repo-blueprint",
      expect.objectContaining({ repoBranch: "master" }),
    );
  });

  it("keeps an explicit branch", async () => {
    await createTaskConfig({
      name: "Nightly",
      title: "Nightly task",
      prompt: "Do the thing",
      repoUrl: "https://github.com/o/r",
      repoBranch: "release",
    } as any);

    expect(mockRepoDefaultBranch).not.toHaveBeenCalled();
    expect(createDefinition).toHaveBeenCalledWith(
      "repo-blueprint",
      expect.objectContaining({ repoBranch: "release" }),
    );
  });
});
