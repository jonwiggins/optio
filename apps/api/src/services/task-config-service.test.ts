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
  taskConfigs: { id: "task_configs.id" },
  workflowTriggers: {
    id: "workflow_triggers.id",
    targetType: "workflow_triggers.target_type",
    targetId: "workflow_triggers.target_id",
    type: "workflow_triggers.type",
    enabled: "workflow_triggers.enabled",
    createdAt: "workflow_triggers.created_at",
  },
}));

vi.mock("./task-service.js", () => ({
  createTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("./prompt-template-service.js", () => ({
  getPromptTemplateById: vi.fn(),
  renderTemplateString: vi.fn((s: string) => s),
}));

vi.mock("./repo-service.js", () => ({
  getRepoByUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: { add: vi.fn() },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from "../db/client.js";
import * as taskService from "./task-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { instantiateTask } from "./task-config-service.js";

function mockGetTaskConfig(config: Record<string, unknown>) {
  (db.select as any) = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([config]),
    }),
  });
}

const baseConfig = {
  id: "cfg-1",
  name: "Nightly",
  title: "Nightly task",
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

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-config" }),
    );
    expect(getRepoByUrl).not.toHaveBeenCalled();
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
