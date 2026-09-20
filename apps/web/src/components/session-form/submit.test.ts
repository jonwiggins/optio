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
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/persistent-agent-defaults", () => ({ defaultAgentsMd: () => "" }));

import { createSession } from "./submit";
import { EMPTY_DRAFT, normalize, type SessionDraft } from "./model";

const conflict = () => Object.assign(new Error("A Job named x already exists"), { status: 409 });

describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createTaskRun.mockResolvedValue({ runId: "run-1" });
  });

  it("bumps an automatic name on a 409 and keeps the user's own name as an error", async () => {
    const job: SessionDraft = normalize({
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

    const created = await createSession(job, { repoUrl: "", autoName: "Session 4" });
    expect(created.href).toBe("/jobs/w-1");
    expect(api.createTaskUnified).toHaveBeenCalledTimes(2);
    expect(api.createTaskUnified.mock.calls[0][0].name).toBe("Session 4");
    expect(api.createTaskUnified.mock.calls[1][0].name).toBe("Session 4 (2)");

    api.createTaskUnified.mockReset().mockRejectedValue(conflict());
    await expect(
      createSession({ ...job, name: "Nightly" }, { repoUrl: "", autoName: "Session 4" }),
    ).rejects.toThrow(/already exists/);
    expect(api.createTaskUnified).toHaveBeenCalledTimes(1);
  });

  it("rolls a Job back when its trigger is rejected", async () => {
    const job: SessionDraft = normalize({
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

    await expect(createSession(job, { repoUrl: "", autoName: "Session 1" })).rejects.toThrow(
      /Webhook path/,
    );
    expect(api.deleteWorkflow).toHaveBeenCalledWith("w-2");
    // A trigger 409 is not a name clash — no retry loop.
    expect(api.createTaskUnified).toHaveBeenCalledTimes(1);
  });
});
