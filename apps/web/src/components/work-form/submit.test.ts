import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createTaskUnified: vi.fn(),
  createTaskTrigger: vi.fn(),
  createTaskRun: vi.fn(),
  deleteWorkflow: vi.fn(),
  deleteTaskConfig: vi.fn(),
  deleteLocalBlueprint: vi.fn(),
  createLocalBlueprint: vi.fn(),
  createLocalBlueprintTrigger: vi.fn(),
  updateTaskConfig: vi.fn(),
  updateWorkflow: vi.fn(),
  updateTaskTrigger: vi.fn(),
  deleteTaskTrigger: vi.fn(),
  updateLocalBlueprint: vi.fn(),
  updateLocalBlueprintTrigger: vi.fn(),
  deleteLocalBlueprintTrigger: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/persistent-agent-defaults", () => ({ defaultAgentsMd: () => "" }));

import { createWork, updateWork } from "./submit";
import { EMPTY_DRAFT, normalize, type WorkDraft } from "./model";
import type { EditTarget } from "./load";

const conflict = () => Object.assign(new Error("A Job named x already exists"), { status: 409 });

describe("createWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createTaskRun.mockResolvedValue({ runId: "run-1" });
  });

  it("bumps an automatic name on a 409 and keeps the user's own name as an error", async () => {
    const job: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      prompt: "hi",
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * *" },
    });
    api.createTaskUnified
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ task: { id: "w-1" } });
    api.createTaskTrigger.mockResolvedValue({});

    const created = await createWork(job, { repoUrl: "", autoName: "Session 4" });
    expect(created.href).toBe("/jobs/w-1");
    expect(api.createTaskUnified).toHaveBeenCalledTimes(2);
    expect(api.createTaskUnified.mock.calls[0][0].name).toBe("Session 4");
    expect(api.createTaskUnified.mock.calls[1][0].name).toBe("Session 4 (2)");

    api.createTaskUnified.mockReset().mockRejectedValue(conflict());
    await expect(
      createWork({ ...job, name: "Nightly" }, { repoUrl: "", autoName: "Session 4" }),
    ).rejects.toThrow(/already exists/);
    expect(api.createTaskUnified).toHaveBeenCalledTimes(1);
  });

  it("rolls a Job back when its trigger is rejected", async () => {
    const job: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      prompt: "hi",
      when: "webhook",
      trigger: { type: "webhook", webhookPath: "hook-1" },
    });
    api.createTaskUnified.mockResolvedValue({ task: { id: "w-2" } });
    api.createTaskTrigger.mockRejectedValue(
      Object.assign(new Error("Webhook path is already in use"), { status: 409 }),
    );
    api.deleteWorkflow.mockResolvedValue(undefined);

    await expect(createWork(job, { repoUrl: "", autoName: "Session 1" })).rejects.toThrow(
      /Webhook path/,
    );
    expect(api.deleteWorkflow).toHaveBeenCalledWith("w-2");
    // A trigger 409 is not a name clash — no retry loop.
    expect(api.createTaskUnified).toHaveBeenCalledTimes(1);
  });
});

describe("updateWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(api)) fn.mockResolvedValue({});
  });

  const job: WorkDraft = normalize({
    ...EMPTY_DRAFT,
    name: "Digest",
    withRepo: false,
    prompt: "Summarize",
    when: "schedule",
    trigger: { type: "schedule", cronExpression: "0 9 * * *" },
  });
  const target = (trigger: any, kind: EditTarget["kind"] = "standalone"): EditTarget => ({
    id: "w-1",
    kind,
    row: { id: "w-1", name: "Digest" },
    trigger,
    triggers: trigger ? [trigger] : [],
    draft: job,
  });

  it("patches the row and, for the same trigger type, the trigger in place", async () => {
    const t = target({ id: "t1", type: "schedule", config: { cronExpression: "0 8 * * *" } });
    const saved = await updateWork(t, job, { repoUrl: "" });
    expect(api.updateWorkflow).toHaveBeenCalledWith(
      "w-1",
      expect.objectContaining({
        name: "Digest",
        promptTemplate: "Summarize",
        runTarget: "cluster",
      }),
    );
    expect(api.updateTaskTrigger).toHaveBeenCalledWith("w-1", "t1", {
      config: { cronExpression: "0 9 * * *" },
    });
    expect(api.createTaskTrigger).not.toHaveBeenCalled();
    expect(api.deleteTaskTrigger).not.toHaveBeenCalled();
    expect(saved.href).toBe("/jobs/w-1");
  });

  it("creates the new trigger before retiring the old one when the type changes", async () => {
    const t = target({ id: "t1", type: "webhook", config: { path: "hook-1" } });
    const order: string[] = [];
    api.createTaskTrigger.mockImplementation(async () => void order.push("create"));
    api.deleteTaskTrigger.mockImplementation(async () => void order.push("delete"));
    await updateWork(t, job, { repoUrl: "" });
    expect(api.createTaskTrigger).toHaveBeenCalledWith("w-1", {
      type: "schedule",
      config: { cronExpression: "0 9 * * *" },
      enabled: true,
    });
    expect(api.deleteTaskTrigger).toHaveBeenCalledWith("w-1", "t1");
    expect(order).toEqual(["create", "delete"]);
  });

  it("keeps the row when a replacement trigger is rejected", async () => {
    const t = target({ id: "t1", type: "webhook", config: { path: "hook-1" } });
    api.createTaskTrigger.mockRejectedValue(new Error("bad cron"));
    await expect(updateWork(t, job, { repoUrl: "" })).rejects.toThrow(/bad cron/);
    expect(api.deleteTaskTrigger).not.toHaveBeenCalled();
  });

  it("removes the loaded trigger when the edit goes back to Now", async () => {
    const t = target({ id: "t1", type: "schedule", config: { cronExpression: "0 9 * * *" } });
    await updateWork(t, { ...job, when: "manual", trigger: { type: "manual" } }, { repoUrl: "" });
    expect(api.deleteTaskTrigger).toHaveBeenCalledWith("w-1", "t1");
    expect(api.createTaskTrigger).not.toHaveBeenCalled();
  });

  it("saves a Local automation's event trigger and base branch", async () => {
    const auto: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      name: "Reviews",
      when: "github",
      trigger: { type: "manual" },
      event: { type: "github", config: { events: ["mentioned"], login: "octocat" } },
      location: {
        runTarget: "local",
        localHostId: "h1",
        localDir: "/Users/dev/repos/app",
        localSessionMode: "interactive",
      },
      withRepo: true,
      repoBranch: "main",
      prompt: "Look at {{url}}",
      then: "waits-for-me",
    });
    const t: EditTarget = {
      ...target({ id: "t1", type: "linear", config: {} }, "local-blueprint"),
      id: "b-1",
      draft: auto,
    };
    const saved = await updateWork(t, auto, { repoUrl: "https://github.com/acme/app" });
    expect(api.updateLocalBlueprint).toHaveBeenCalledWith(
      "b-1",
      expect.objectContaining({
        name: "Reviews",
        baseBranch: "main",
        repoUrl: "https://github.com/acme/app",
        commandTemplate: "Look at {{url}}",
        agent: "claude-code",
        sessionMode: "interactive",
      }),
    );
    expect(api.createLocalBlueprintTrigger).toHaveBeenCalledWith("b-1", {
      type: "github",
      config: { events: ["mentioned"], login: "octocat" },
      enabled: true,
    });
    expect(api.deleteLocalBlueprintTrigger).toHaveBeenCalledWith("b-1", "t1");
    expect(saved.href).toBe("/local/automations/b-1");
  });
});
