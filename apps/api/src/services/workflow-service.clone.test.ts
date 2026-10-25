import { beforeEach, describe, expect, it, vi } from "vitest";

/** Cloning a Job (cloneWorkflow): what the copy keeps of the source's run location. */

vi.mock("../db/client.js", () => ({ db: {} }));

vi.mock("./work-definition-service.js", () => ({
  getDefinition: vi.fn(),
  createDefinition: vi.fn(),
}));

vi.mock("./trigger-service.js", () => ({
  listTriggers: vi.fn().mockResolvedValue([]),
  createTrigger: vi.fn(),
}));

vi.mock("./event-bus.js", () => ({ publishWorkflowRunEvent: vi.fn() }));

import * as definitions from "./work-definition-service.js";
import type { WorkDefinition } from "./work-definition-service.js";
import { cloneWorkflow } from "./workflow-service.js";

function definition(overrides: Partial<WorkDefinition> = {}): WorkDefinition {
  return {
    id: "w-1",
    kind: "standalone",
    name: "Nightly",
    description: null,
    workspaceId: "ws-1",
    ownerUserId: null,
    ownerTeamId: null,
    podSecrets: null,
    settings: null,
    createdBy: null,
    enabled: true,
    prompt: "Run it",
    promptTemplateId: null,
    runTitle: null,
    paramsSchema: null,
    agentType: "claude-code",
    model: null,
    agentOptions: null,
    repoUrl: null,
    repoBranch: null,
    runTarget: "cluster",
    localHostId: null,
    localDir: null,
    localSessionMode: "headless",
    remoteWorkspaceLaunch: null,
    environmentSpec: null,
    spawnMode: "auto",
    maxRetries: 1,
    priority: 100,
    autoResume: null,
    autoMerge: null,
    autoMergeConfirmedAt: null,
    autoMergeConfirmedBy: null,
    maxTurns: null,
    budgetUsd: null,
    maxConcurrent: 2,
    warmPoolSize: 0,
    maxPodInstances: 1,
    maxAgentsPerPod: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("cloneWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(definitions.createDefinition).mockImplementation(async (_kind, values) =>
      definition({ ...values, id: "w-2" } as Partial<WorkDefinition>),
    );
  });

  it("keeps a remote-workspace Job's launch and lets the copy start a workspace of its own", async () => {
    const launch = { connectionId: "cc-1", templateId: "tpl-1", checkoutDir: "/home/coder/repo" };
    vi.mocked(definitions.getDefinition).mockResolvedValue(
      definition({
        runTarget: "local",
        localHostId: "host-paired-by-the-source",
        localDir: "/home/coder/repo",
        remoteWorkspaceLaunch: launch,
      }),
    );

    const cloned = await cloneWorkflow("w-1", { createdBy: "u-1" });

    expect(cloned?.id).toBe("w-2");
    expect(definitions.createDefinition).toHaveBeenCalledWith(
      "standalone",
      expect.objectContaining({
        name: "Nightly (copy)",
        runTarget: "local",
        remoteWorkspaceLaunch: launch,
        localHostId: null,
        localDir: "/home/coder/repo",
        enabled: false,
      }),
    );
  });

  it("keeps the machine of a Job on someone's own machine", async () => {
    vi.mocked(definitions.getDefinition).mockResolvedValue(
      definition({ runTarget: "local", localHostId: "host-1", localDir: "/src" }),
    );

    await cloneWorkflow("w-1");

    const [, values] = vi.mocked(definitions.createDefinition).mock.calls[0];
    expect(values).toMatchObject({ runTarget: "local", localHostId: "host-1", localDir: "/src" });
    expect(values).not.toHaveProperty("remoteWorkspaceLaunch");
  });

  it("returns null for a Job that isn't there", async () => {
    vi.mocked(definitions.getDefinition).mockResolvedValue(null);
    expect(await cloneWorkflow("nope")).toBeNull();
    expect(definitions.createDefinition).not.toHaveBeenCalled();
  });
});
