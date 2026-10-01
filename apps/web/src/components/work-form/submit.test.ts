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
  createLocalTerminal: vi.fn(),
  putWorkDefaults: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/persistent-agent-defaults", () => ({ defaultAgentsMd: () => "" }));

import { createWork, rememberWorkDefaults, updateWork, workDefaultsFrom } from "./submit";
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

  it("sends the run name as each kind's run-title template", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "w-1" } });
    api.createTaskTrigger.mockResolvedValue({});
    const linear: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      name: "Linear triage",
      runName: "  Triage: {{ticketTitle}} ",
      withRepo: false,
      prompt: "Triage {{ticketUrl}}",
      when: "linear",
      event: { type: "linear", config: { events: ["mentioned"], user: "jon" } },
    });
    await createWork(linear, { repoUrl: "", autoName: "Job 1" });
    expect(api.createTaskUnified.mock.calls[0][0]).toMatchObject({
      type: "standalone",
      name: "Linear triage",
      runTitle: "Triage: {{ticketTitle}}",
    });

    api.createTaskUnified.mockClear();
    await createWork(
      { ...linear, withRepo: true, repoUrl: "https://github.com/a/b" },
      { repoUrl: "https://github.com/a/b", autoName: "Task 1" },
    );
    expect(api.createTaskUnified.mock.calls[0][0]).toMatchObject({
      type: "repo-blueprint",
      name: "Linear triage",
      title: "Triage: {{ticketTitle}}",
    });
  });

  const onMachine = {
    runTarget: "local" as const,
    localHostId: "h1",
    localDir: "/Users/dev/app",
    localSessionMode: "interactive" as const,
  };

  it("hands a session on a machine its model, effort and permission mode", async () => {
    api.createLocalTerminal.mockResolvedValue({ terminal: { id: "t-9" } });
    const session: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      runtime: "claude-code",
      agentOptions: {
        claudeModel: "opus",
        claudeEffort: "high",
        claudePermissionMode: "bypassPermissions",
        // Pod-only: never reaches the machine.
        claudeThinking: true,
      },
      location: onMachine,
      prompt: "Tidy up",
      then: "waits-for-me",
    });
    const created = await createWork(session, { repoUrl: "", autoName: "Session 1" });
    expect(created.href).toBe("/local/t-9");
    expect(api.createLocalTerminal.mock.calls[0][0].spec).toEqual({
      kind: "agent",
      agent: "claude-code",
      prompt: "Tidy up",
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
  });

  it("runs Codex on a machine with --yolo when every check is skipped", async () => {
    api.createLocalTerminal.mockResolvedValue({ terminal: { id: "t-10" } });
    const session: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", codexPermissionMode: "bypassPermissions" },
      location: onMachine,
      prompt: "Fix the flaky test",
      then: "waits-for-me",
    });
    await createWork(session, { repoUrl: "", autoName: "Session 2" });
    expect(api.createLocalTerminal.mock.calls.at(-1)![0].spec).toEqual({
      kind: "agent",
      agent: "codex",
      prompt: "Fix the flaky test",
      model: "gpt-5.6-sol",
      permissionMode: "bypassPermissions",
    });
  });

  it("saves a Local automation's agent options", async () => {
    api.createLocalBlueprint.mockResolvedValue({ blueprint: { id: "b-2" } });
    api.createLocalBlueprintTrigger.mockResolvedValue({});
    const auto: WorkDraft = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", copilotEffort: "xhigh" },
      location: onMachine,
      prompt: "Nightly cleanup",
      then: "waits-for-me",
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * *" },
    });
    await createWork(auto, { repoUrl: "", autoName: "Automation 1" });
    expect(api.createLocalBlueprint.mock.calls[0][0]).toMatchObject({
      agent: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", copilotEffort: "xhigh" },
    });
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
    foreignOwnerId: null,
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

describe("owner and pod secrets on the wire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createTaskRun.mockResolvedValue({ runId: "run-1" });
  });

  it("a new pod Job sends its owner and an array of secrets, even empty", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "w-1" } });
    await createWork(normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi" }), {
      repoUrl: "",
      autoName: "Job 1",
    });
    expect(api.createTaskUnified).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "workspace", podSecrets: [] }),
    );
  });

  it("a personal repo Task with secrets and a provider sends them all", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "t-1" } });
    await createWork(
      normalize({
        ...EMPTY_DRAFT,
        prompt: "fix it",
        owner: "me",
        podSecrets: ["NPM_TOKEN"],
        agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
      }),
      { repoUrl: "https://github.com/acme/app", autoName: "Task 1" },
    );
    expect(api.createTaskUnified).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "me",
        podSecrets: ["NPM_TOKEN"],
        metadata: {
          agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
        },
      }),
    );
  });

  it("a Job on a machine is always mine and sends no pod secrets", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "w-2" } });
    await createWork(
      normalize({
        ...EMPTY_DRAFT,
        withRepo: false,
        prompt: "hi",
        podSecrets: ["X"],
        location: {
          runTarget: "local",
          localHostId: "h",
          localDir: "/d",
          localSessionMode: "headless",
        },
      }),
      { repoUrl: "", autoName: "Job 2" },
    );
    const body = api.createTaskUnified.mock.calls[0][0];
    expect(body.owner).toBe("me");
    expect(body).not.toHaveProperty("podSecrets");
  });

  it("a persistent agent carries them; a local terminal carries only the provider", async () => {
    const createPersistentAgent = vi.fn().mockResolvedValue({ agent: { id: "a-1" } });
    (api as any).createPersistentAgent = createPersistentAgent;
    await createWork(
      normalize({
        ...EMPTY_DRAFT,
        withRepo: false,
        prompt: "hi",
        then: "waits-for-messages",
        owner: "me",
        podSecrets: ["A"],
      }),
      { repoUrl: "", autoName: "Agent 1" },
    );
    expect(createPersistentAgent).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "me", podSecrets: ["A"] }),
    );

    api.createLocalTerminal.mockResolvedValue({ terminal: { id: "lt-1" } });
    await createWork(
      normalize({
        ...EMPTY_DRAFT,
        withRepo: false,
        then: "waits-for-me",
        agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
        location: {
          runTarget: "local",
          localHostId: "h",
          localDir: "/d",
          localSessionMode: "interactive",
        },
      }),
      { repoUrl: "", autoName: "Terminal 1" },
    );
    const body = api.createLocalTerminal.mock.calls[0][0];
    expect(body.agentOptions).toEqual({ modelProvider: "p-1" });
    expect(body.spec.model).toBe("us.anthropic.claude-opus-5-5");
    expect(body).not.toHaveProperty("owner");
  });

  it("an edit keeps a legacy null secret list and sends the owner", async () => {
    const draft = normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi", podSecrets: null });
    await updateWork(
      {
        id: "w-1",
        kind: "standalone",
        row: { id: "w-1", name: "Digest" },
        trigger: null,
        triggers: [],
        draft,
        foreignOwnerId: null,
      },
      draft,
      { repoUrl: "" },
    );
    expect(api.updateWorkflow).toHaveBeenCalledWith(
      "w-1",
      expect.objectContaining({ owner: "workspace", podSecrets: null }),
    );
  });
});

describe("remembering the agent settings", () => {
  it("saves the runtime and the options actually set, never for a terminal", () => {
    const d = normalize({
      ...EMPTY_DRAFT,
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.5", copilotEffort: "" },
    });
    expect(workDefaultsFrom(d)).toEqual({
      runtime: "codex",
      agentOptions: { codex: { copilotModel: "gpt-5.5" } },
    });
    expect(workDefaultsFrom({ ...d, runtime: "" })).toBeNull();
  });

  it("is fire-and-forget: a failing PUT never throws", async () => {
    api.putWorkDefaults.mockReset();
    api.putWorkDefaults.mockRejectedValue(new Error("boom"));
    expect(() => rememberWorkDefaults(normalize({ ...EMPTY_DRAFT }))).not.toThrow();
    expect(api.putWorkDefaults).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});

describe("Work until merged", () => {
  beforeEach(() => vi.clearAllMocks());
  const draft: WorkDraft = normalize({
    ...EMPTY_DRAFT,
    prompt: "fix it",
    repoUrl: "https://github.com/a/b",
    then: "until-merged",
  });

  it("a Task carries its own follow-through", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "t-1" } });
    await createWork(draft, { repoUrl: "https://github.com/a/b", autoName: "Task 1" });
    expect(api.createTaskUnified.mock.calls[0][0]).toMatchObject({
      type: "repo-task",
      autoResume: true,
      autoMerge: true,
    });
  });

  it("'you merge it' keeps resuming but doesn't merge", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "t-1" } });
    await createWork(
      { ...draft, mergeWhenReady: false },
      { repoUrl: "https://github.com/a/b", autoName: "Task 1" },
    );
    expect(api.createTaskUnified.mock.calls[0][0]).toMatchObject({
      autoResume: true,
      autoMerge: false,
    });
  });

  it("Exit when done leaves the PR to the repo's settings", async () => {
    api.createTaskUnified.mockResolvedValue({ task: { id: "t-1" } });
    await createWork(
      { ...draft, then: "exits" },
      { repoUrl: "https://github.com/a/b", autoName: "Task 1" },
    );
    const body = api.createTaskUnified.mock.calls[0][0];
    expect(body.autoResume).toBeUndefined();
    expect(body.autoMerge).toBeUndefined();
  });

  it("a scheduled Task saves it, and switching back to Exit when done clears it", async () => {
    const ticket = {
      ...draft,
      when: "ticket" as const,
      trigger: { type: "ticket" as const, ticketSource: "github" as const },
    };
    api.createTaskUnified.mockResolvedValue({ task: { id: "c-1" } });
    api.createTaskTrigger.mockResolvedValue({});
    await createWork(ticket, { repoUrl: "https://github.com/a/b", autoName: "Task 1" });
    expect(api.createTaskUnified.mock.calls[0][0]).toMatchObject({
      type: "repo-blueprint",
      autoResume: true,
      autoMerge: true,
    });

    api.updateTaskConfig.mockResolvedValue({});
    api.updateTaskTrigger.mockResolvedValue({});
    const target = {
      id: "c-1",
      kind: "repo-blueprint",
      row: { name: "Task 1" },
      trigger: { id: "tr-1", type: "ticket" },
    } as unknown as EditTarget;
    await updateWork(target, { ...ticket, then: "exits" }, { repoUrl: "https://github.com/a/b" });
    expect(api.updateTaskConfig.mock.calls[0][1]).toMatchObject({
      autoResume: null,
      autoMerge: null,
    });
  });
});
