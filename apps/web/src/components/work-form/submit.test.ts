import { beforeEach, describe, expect, it, vi } from "vitest";
import { kindOfSpec, localAgentParams, type WorkCreated, type WorkSpec } from "@optio/shared";

const api = vi.hoisted(() => ({
  createWork: vi.fn(),
  updateWork: vi.fn(),
  putWorkDefaults: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("@/lib/persistent-agent-defaults", () => ({ defaultAgentsMd: () => "DEFAULT AGENTS.MD" }));

import { createWork, rememberWorkDefaults, specFor, updateWork, workDefaultsFrom } from "./submit";
import {
  deriveKind,
  EMPTY_DRAFT,
  normalize,
  TERMINAL,
  type WorkDraft,
  type WorkKind,
} from "./model";
import type { EditTarget } from "./load";

const REPO = "https://github.com/acme/app";

const draft = (patch: Partial<WorkDraft>): WorkDraft => normalize({ ...EMPTY_DRAFT, ...patch });

const onMachine = (localSessionMode: "interactive" | "headless" = "interactive") => ({
  runTarget: "local" as const,
  localHostId: "h1",
  localDir: "/Users/dev/app",
  localSessionMode,
});

const schedule = {
  when: "schedule" as const,
  trigger: { type: "schedule" as const, cronExpression: "0 9 * * *" },
};

/** The spec the last `POST /api/work` carried. */
const sent = (): WorkSpec => api.createWork.mock.calls.at(-1)![0];

/** What the server answers a create with. */
const made = (kind: WorkKind, id: string, href: string, run?: WorkCreated["run"]): WorkCreated => ({
  kind,
  id,
  href,
  ...(run ? { run } : {}),
});

const taken = (details: string) =>
  Object.assign(new Error("A Job named x already exists"), { status: 409, details });

beforeEach(() => {
  vi.clearAllMocks();
  api.createWork.mockResolvedValue(made("standalone", "w-1", "/jobs/w-1"));
  api.updateWork.mockResolvedValue(made("standalone", "w-1", "/jobs/w-1"));
});

describe("specFor — the draft as the five attributes", () => {
  /** One draft per kind, as the form would submit it. */
  const kinds: [WorkKind, WorkDraft][] = [
    ["repo-task", draft({ prompt: "Fix it", repoUrl: REPO })],
    ["repo-blueprint", draft({ ...schedule, prompt: "Sweep", repoUrl: REPO })],
    ["standalone", draft({ withRepo: false, prompt: "Say hello" })],
    [
      "local-blueprint",
      draft({
        ...schedule,
        withRepo: false,
        location: onMachine(),
        prompt: "Tidy",
        then: "waits-for-me",
      }),
    ],
    [
      "local-terminal",
      draft({ withRepo: false, location: onMachine(), runtime: TERMINAL, then: "waits-for-me" }),
    ],
    ["pod-session", draft({ repoUrl: REPO, runtime: TERMINAL, then: "waits-for-me" })],
    ["persistent-agent", draft({ withRepo: false, prompt: "Hi", then: "waits-for-messages" })],
  ];

  it.each(kinds)("the server derives the kind the form previews: %s", (kind, d) => {
    expect(deriveKind(d)).toBe(kind);
    expect(kindOfSpec(specFor(d, { repoUrl: REPO, name: "N" }))).toBe(kind);
  });

  it("a pod Task: its repo, branch, agent, set options, prompt, dependencies and owner", () => {
    const d = draft({
      repoUrl: REPO,
      repoBranch: "develop",
      runtime: "codex",
      // A blank select means "default": not sent.
      agentOptions: { copilotModel: "gpt-5.5", copilotEffort: "" },
      prompt: "  Fix it  ",
      description: "  Why  ",
      dependsOn: ["t-0"],
      priority: 7,
      maxRetries: 1,
    });
    expect(specFor(d, { repoUrl: REPO, name: "Fix" })).toEqual({
      name: "Fix",
      description: "Why",
      when: { type: "manual" },
      where: {
        runTarget: "cluster",
        repoUrl: REPO,
        repoBranch: "develop",
        localHostId: null,
        localDir: null,
      },
      who: { runtime: "codex", agentOptions: { copilotModel: "gpt-5.5" }, model: "gpt-5.5" },
      what: { prompt: "Fix it", runTitle: null },
      then: "exits",
      mergeWhenReady: true,
      maxRetries: 1,
      priority: 7,
      dependsOn: ["t-0"],
      owner: "workspace",
      podSecrets: [],
      settings: null,
    });
  });

  it("a Job has no repo, even with one still picked from before, and no dependencies", () => {
    const spec = specFor(
      draft({ withRepo: false, repoId: "r-1", repoUrl: REPO, dependsOn: ["t-0"], prompt: "hi" }),
      { repoUrl: REPO, name: "Job 1" },
    );
    expect(spec.where).toMatchObject({ runTarget: "cluster", repoUrl: null, repoBranch: null });
    expect(spec).not.toHaveProperty("dependsOn");
    expect(spec.description).toBeNull();
  });

  it("sends the run name as each kind's run-title template", () => {
    const linear = draft({
      name: "Linear triage",
      runName: "  Triage: {{ticketTitle}} ",
      withRepo: false,
      prompt: "Triage {{ticketUrl}}",
      when: "linear",
      event: { type: "linear", config: { events: ["mentioned"], user: "jon" } },
    });
    const job = specFor(linear, { repoUrl: "", name: "Linear triage" });
    expect(kindOfSpec(job)).toBe("standalone");
    expect(job.name).toBe("Linear triage");
    expect(job.what.runTitle).toBe("Triage: {{ticketTitle}}");

    const task = specFor(
      { ...linear, withRepo: true, repoUrl: REPO },
      { repoUrl: REPO, name: "Linear triage" },
    );
    expect(kindOfSpec(task)).toBe("repo-blueprint");
    expect(task.what.runTitle).toBe("Triage: {{ticketTitle}}");

    // Blank: each run takes the work's name.
    expect(specFor({ ...linear, runName: "  " }, { repoUrl: "", name: "x" }).what.runTitle).toBe(
      null,
    );
  });

  it("each When is the same trigger shape whatever it starts", () => {
    const job = (patch: Partial<WorkDraft>) =>
      specFor(draft({ withRepo: false, prompt: "p", ...patch }), { repoUrl: "", name: "J" }).when;
    expect(
      job({ when: "schedule", trigger: { type: "schedule", cronExpression: " 0 9 * * 1 " } }),
    ).toEqual({ type: "schedule", config: { cronExpression: "0 9 * * 1" } });
    expect(job({ when: "webhook", trigger: { type: "webhook", webhookPath: "hook-1" } })).toEqual({
      type: "webhook",
      config: { path: "hook-1" },
    });
    expect(
      job({
        when: "ticket",
        trigger: { type: "ticket", ticketSource: "linear", ticketLabels: ["bug"] },
      }),
    ).toEqual({ type: "ticket", config: { source: "linear", labels: ["bug"] } });
    expect(job({ when: "ticket", trigger: { type: "ticket", ticketLabels: [] } })).toEqual({
      type: "ticket",
      config: { source: "github" },
    });
    const event = { events: ["pr_opened"], repos: ["acme/app"] };
    expect(job({ when: "github", event: { type: "github", config: event } })).toEqual({
      type: "github",
      config: event,
    });
    const incident = {
      events: ["incident.triggered"],
      services: ["Checkout API"],
      urgency: "high",
    };
    expect(job({ when: "pagerduty", event: { type: "pagerduty", config: incident } })).toEqual({
      type: "pagerduty",
      config: incident,
    });
    expect(job({ when: "pylon", event: { type: "pylon", config: { events: [] } } })).toEqual({
      type: "pylon",
      config: { events: [] },
    });
    expect(job({})).toEqual({ type: "manual" });
  });

  it("hands back a new Pylon trigger's id and secret, this once", async () => {
    api.createWork.mockResolvedValue({
      ...made("standalone", "w-2", "/jobs/w-2"),
      trigger: { id: "t-1", secret: "s3cret" },
    });
    const created = await createWork(
      draft({ when: "pylon", event: { type: "pylon", config: { events: [] } }, prompt: "p" }),
      { repoUrl: "", name: "Pylon" },
    );
    expect(created.trigger).toEqual({ id: "t-1", secret: "s3cret" });
    // Other work carries no trigger field at all.
    api.createWork.mockResolvedValue(made("standalone", "w-3", "/jobs/w-3"));
    const plain = await createWork(draft({ prompt: "p" }), { repoUrl: "", name: "Plain" });
    expect(plain).not.toHaveProperty("trigger");
  });

  it("a terminal sends no agent, options, or model; a pod session carries its repo", () => {
    const session = specFor(
      draft({
        repoUrl: REPO,
        runtime: TERMINAL,
        then: "waits-for-me",
        agentOptions: { claudeModel: "opus" },
      }),
      { repoUrl: REPO, name: "Session 1" },
    );
    expect(session.who).toEqual({ runtime: null, agentOptions: null, model: null });
    expect(session.where.repoUrl).toBe(REPO);
    // Only Tasks, Jobs, and agents have an owner.
    expect(session).not.toHaveProperty("owner");
    expect(session).not.toHaveProperty("podSecrets");
  });

  it("a persistent agent's slug comes from its name, and it ships the default agents.md", () => {
    const agent = draft({ withRepo: false, prompt: "Hi", then: "waits-for-messages" });
    expect(specFor(agent, { repoUrl: "", name: "Release Bot" }).agent).toEqual({
      slug: "release-bot",
      systemPrompt: null,
      agentsMd: "DEFAULT AGENTS.MD",
      podLifecycle: "sticky",
    });
    const own = specFor(
      {
        ...agent,
        agent: { slug: " rb ", podLifecycle: "always-on", systemPrompt: "Be terse", agentsMd: "M" },
      },
      { repoUrl: "", name: "Release Bot" },
    );
    expect(own.agent).toEqual({
      slug: "rb",
      systemPrompt: "Be terse",
      agentsMd: "M",
      podLifecycle: "always-on",
    });
    // Nothing else carries an agent block.
    expect(specFor(draft({ prompt: "p" }), { repoUrl: REPO, name: "T" })).not.toHaveProperty(
      "agent",
    );
  });
});

describe("work on a machine", () => {
  it("hands a session its model, effort and permission mode through its options", async () => {
    api.createWork.mockResolvedValue(made("local-terminal", "t-9", "/local/t-9"));
    const session = draft({
      withRepo: false,
      runtime: "claude-code",
      agentOptions: {
        claudeModel: "opus",
        claudeEffort: "high",
        claudePermissionMode: "bypassPermissions",
        claudeThinking: true,
      },
      location: onMachine(),
      prompt: "Tidy up",
      then: "waits-for-me",
    });
    const created = await createWork(session, { repoUrl: "", autoName: "Session 1" });
    expect(created.href).toBe("/local/t-9");
    expect(sent().where).toEqual({
      runTarget: "local",
      repoUrl: null,
      repoBranch: null,
      localHostId: "h1",
      localDir: "/Users/dev/app",
    });
    expect(sent().who.runtime).toBe("claude-code");
    expect(sent().what.prompt).toBe("Tidy up");
    // What the daemon passes the CLI; Thinking is pod-only and never reaches the machine.
    expect(localAgentParams("claude-code", sent().who.agentOptions)).toEqual({
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
  });

  it("runs Codex with --yolo when every check is skipped", async () => {
    api.createWork.mockResolvedValue(made("local-terminal", "t-10", "/local/t-10"));
    const session = draft({
      withRepo: false,
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", codexPermissionMode: "bypassPermissions" },
      location: onMachine(),
      prompt: "Fix the flaky test",
      then: "waits-for-me",
    });
    await createWork(session, { repoUrl: "", autoName: "Session 2" });
    expect(sent().who).toEqual({
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", codexPermissionMode: "bypassPermissions" },
      model: "gpt-5.6-sol",
    });
    expect(localAgentParams("codex", sent().who.agentOptions)).toEqual({
      model: "gpt-5.6-sol",
      permissionMode: "bypassPermissions",
    });
  });

  it("saves a Local automation's agent options", async () => {
    api.createWork.mockResolvedValue(made("local-blueprint", "b-2", "/local/automations/b-2"));
    const auto = draft({
      ...schedule,
      withRepo: false,
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", copilotEffort: "xhigh" },
      location: onMachine(),
      prompt: "Nightly cleanup",
      then: "waits-for-me",
    });
    const created = await createWork(auto, { repoUrl: "", autoName: "Automation 1" });
    expect(kindOfSpec(sent())).toBe("local-blueprint");
    expect(sent().who).toEqual({
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.6-sol", copilotEffort: "xhigh" },
      model: "gpt-5.6-sol",
    });
    expect(sent().when).toEqual({ type: "schedule", config: { cronExpression: "0 9 * * *" } });
    expect(created).toMatchObject({ href: "/local/automations/b-2", toast: "Automation 1 saved" });
  });

  it("a base branch is what says 'on a new branch'; the directory as it is sends none", () => {
    const chat = draft({
      withRepo: false,
      location: onMachine(),
      prompt: "Rename it",
      then: "waits-for-me",
    });
    // The checkout's remote is known, but the work happens in the directory as it is.
    expect(specFor(chat, { repoUrl: REPO, name: "Chat" }).where).toMatchObject({
      repoUrl: null,
      repoBranch: null,
    });
    const branched = specFor(
      { ...chat, withRepo: true, repoBranch: "" },
      { repoUrl: REPO, name: "Chat" },
    );
    expect(branched.where).toMatchObject({ repoUrl: REPO, repoBranch: "main" });
    expect(kindOfSpec(branched)).toBe("local-terminal");
    // An unknown remote still makes it a new branch.
    expect(
      specFor({ ...chat, withRepo: true, repoBranch: "dev" }, { repoUrl: "", name: "Chat" }).where,
    ).toMatchObject({ repoUrl: null, repoBranch: "dev" });
  });
});

describe("createWork", () => {
  const job = draft({ ...schedule, withRepo: false, prompt: "hi" });

  it("bumps an automatic name on a name clash and keeps the user's own name as an error", async () => {
    api.createWork
      .mockRejectedValueOnce(taken("name_taken"))
      .mockResolvedValueOnce(made("standalone", "w-1", "/jobs/w-1"));
    const created = await createWork(job, { repoUrl: "", autoName: "Session 4" });
    expect(created.href).toBe("/jobs/w-1");
    expect(api.createWork.mock.calls.map(([spec]) => spec.name)).toEqual([
      "Session 4",
      "Session 4 (2)",
    ]);

    api.createWork.mockReset().mockRejectedValue(taken("name_taken"));
    await expect(
      createWork({ ...job, name: "Nightly" }, { repoUrl: "", autoName: "Session 4" }),
    ).rejects.toThrow(/already exists/);
    expect(api.createWork).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a clash a new name can't fix, and gives up after five names", async () => {
    api.createWork.mockRejectedValue(
      Object.assign(new Error('Webhook path "hook-1" is already in use'), {
        status: 409,
        details: "webhook_path_taken",
      }),
    );
    await expect(createWork(job, { repoUrl: "", autoName: "Job 1" })).rejects.toThrow(
      /Webhook path/,
    );
    expect(api.createWork).toHaveBeenCalledTimes(1);

    api.createWork.mockReset().mockRejectedValue(taken("name_taken"));
    await expect(createWork(job, { repoUrl: "", autoName: "Job 1" })).rejects.toMatchObject({
      status: 409,
    });
    expect(api.createWork.mock.calls.map(([spec]) => spec.name)).toEqual([
      "Job 1",
      "Job 1 (2)",
      "Job 1 (3)",
      "Job 1 (4)",
      "Job 1 (5)",
    ]);
  });

  it("a Job started now lands on its first run; a triggered one on its own page", async () => {
    api.createWork.mockResolvedValue(
      made("standalone", "w-1", "/jobs/w-1", { id: "r-1", href: "/jobs/w-1/runs/r-1" }),
    );
    const now = await createWork(draft({ withRepo: false, prompt: "hi" }), {
      repoUrl: "",
      autoName: "Job 1",
    });
    expect(now).toEqual({
      kind: "standalone",
      href: "/jobs/w-1/runs/r-1",
      toast: "Job 1 started",
    });

    api.createWork.mockResolvedValue(made("standalone", "w-2", "/jobs/w-2"));
    const later = await createWork(job, { repoUrl: "", autoName: "Job 2" });
    expect(later).toEqual({ kind: "standalone", href: "/jobs/w-2", toast: "Job 2 saved" });
  });

  it("goes where the server says the new work lives", async () => {
    api.createWork.mockResolvedValue(made("repo-task", "t-1", "/tasks/t-1"));
    const task = await createWork(draft({ prompt: "Fix", name: "Fixer" }), {
      repoUrl: REPO,
      autoName: "Task 1",
    });
    expect(task).toEqual({
      kind: "repo-task",
      href: "/tasks/t-1",
      toast: "Fixer started — it will open a PR",
    });

    api.createWork.mockResolvedValue(made("persistent-agent", "a-1", "/agents/a-1"));
    const agent = await createWork(
      draft({ withRepo: false, prompt: "Hi", then: "waits-for-messages" }),
      { repoUrl: "", autoName: "Agent 1" },
    );
    expect(agent).toEqual({
      kind: "persistent-agent",
      href: "/agents/a-1",
      toast: "Agent 1 created",
    });
  });
});

describe("updateWork", () => {
  const job = draft({
    ...schedule,
    name: "Digest",
    withRepo: false,
    prompt: "Summarize",
  });
  const target = (patch: Partial<EditTarget> = {}): EditTarget => ({
    id: "w-1",
    kind: "standalone",
    row: { id: "w-1", kind: "standalone", name: "Digest" },
    trigger: { id: "t1", type: "schedule", config: { cronExpression: "0 8 * * *" } },
    triggers: [],
    draft: job,
    foreignOwnerId: null,
    ...patch,
  });

  it("PATCHes the target with the draft's spec and returns its page", async () => {
    const saved = await updateWork(target(), job, { repoUrl: "" });
    expect(api.updateWork).toHaveBeenCalledTimes(1);
    expect(api.updateWork).toHaveBeenCalledWith(
      "w-1",
      specFor(job, { repoUrl: "", name: "Digest" }),
    );
    expect(api.updateWork.mock.calls[0][1]).toMatchObject({
      name: "Digest",
      when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
      what: { prompt: "Summarize" },
      where: { runTarget: "cluster" },
    });
    expect(api.createWork).not.toHaveBeenCalled();
    expect(saved).toEqual({ kind: "standalone", href: "/jobs/w-1", toast: "Digest saved" });
  });

  it("a blank name keeps the saved one", async () => {
    await updateWork(target(), { ...job, name: "  " }, { repoUrl: "" });
    expect(api.updateWork.mock.calls[0][1].name).toBe("Digest");
  });

  it("going back to Now asks for no trigger", async () => {
    await updateWork(
      target(),
      { ...job, when: "manual", trigger: { type: "manual" } },
      {
        repoUrl: "",
      },
    );
    expect(api.updateWork.mock.calls[0][1].when).toEqual({ type: "manual" });
  });

  it("saves a Local automation's event trigger and base branch", async () => {
    const auto = draft({
      name: "Reviews",
      when: "github",
      event: { type: "github", config: { events: ["mentioned"], login: "octocat" } },
      location: { ...onMachine(), localDir: "/Users/dev/repos/app" },
      withRepo: true,
      repoBranch: "main",
      prompt: "Look at {{url}}",
      then: "waits-for-me",
    });
    const saved = await updateWork(
      target({ id: "b-1", kind: "local-blueprint", row: { name: "Reviews" }, draft: auto }),
      auto,
      { repoUrl: REPO },
    );
    const [id, spec] = api.updateWork.mock.calls[0];
    expect(id).toBe("b-1");
    expect(kindOfSpec(spec)).toBe("local-blueprint");
    expect(spec).toMatchObject({
      name: "Reviews",
      when: { type: "github", config: { events: ["mentioned"], login: "octocat" } },
      where: {
        runTarget: "local",
        localHostId: "h1",
        localDir: "/Users/dev/repos/app",
        repoUrl: REPO,
        repoBranch: "main",
      },
      who: { runtime: "claude-code" },
      what: { prompt: "Look at {{url}}" },
      then: "waits-for-me",
    });
    expect(saved.href).toBe("/local/automations/b-1");
  });
});

describe("owner and pod secrets on the wire", () => {
  it("a new pod Job sends its owner and an array of secrets, even empty", async () => {
    await createWork(draft({ withRepo: false, prompt: "hi" }), {
      repoUrl: "",
      autoName: "Job 1",
    });
    expect(sent()).toMatchObject({ owner: "workspace", podSecrets: [] });
  });

  it("a personal repo Task with secrets and a provider sends them all", async () => {
    api.createWork.mockResolvedValue(made("repo-task", "t-1", "/tasks/t-1"));
    await createWork(
      draft({
        prompt: "fix it",
        owner: "me",
        podSecrets: ["NPM_TOKEN"],
        agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
      }),
      { repoUrl: REPO, autoName: "Task 1" },
    );
    expect(sent()).toMatchObject({
      owner: "me",
      podSecrets: ["NPM_TOKEN"],
      who: {
        runtime: "claude-code",
        agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
      },
    });
  });

  it("a Job on a machine is always mine and sends no pod secrets", async () => {
    await createWork(
      draft({ withRepo: false, prompt: "hi", podSecrets: ["X"], location: onMachine("headless") }),
      { repoUrl: "", autoName: "Job 2" },
    );
    expect(kindOfSpec(sent())).toBe("standalone");
    expect(sent().owner).toBe("me");
    expect(sent()).not.toHaveProperty("podSecrets");
  });

  it("a persistent agent carries them; a local terminal carries only the provider", async () => {
    api.createWork.mockResolvedValue(made("persistent-agent", "a-1", "/agents/a-1"));
    await createWork(
      draft({
        withRepo: false,
        prompt: "hi",
        then: "waits-for-messages",
        owner: "me",
        podSecrets: ["A"],
      }),
      { repoUrl: "", autoName: "Agent 1" },
    );
    expect(sent()).toMatchObject({ owner: "me", podSecrets: ["A"] });

    api.createWork.mockResolvedValue(made("local-terminal", "lt-1", "/local/lt-1"));
    await createWork(
      draft({
        withRepo: false,
        then: "waits-for-me",
        agentOptions: { modelProvider: "p-1", claudeModel: "us.anthropic.claude-opus-5-5" },
        location: onMachine(),
      }),
      { repoUrl: "", autoName: "Terminal 1" },
    );
    expect(kindOfSpec(sent())).toBe("local-terminal");
    expect(sent()).not.toHaveProperty("owner");
    expect(sent()).not.toHaveProperty("podSecrets");
    expect(sent().who.agentOptions).toEqual({
      modelProvider: "p-1",
      claudeModel: "us.anthropic.claude-opus-5-5",
    });
    expect(localAgentParams("claude-code", sent().who.agentOptions).model).toBe(
      "us.anthropic.claude-opus-5-5",
    );
  });

  it("an edit keeps a legacy null secret list and sends the owner", async () => {
    const d = draft({ withRepo: false, prompt: "hi", podSecrets: null });
    await updateWork(
      {
        id: "w-1",
        kind: "standalone",
        row: { id: "w-1", name: "Digest" },
        trigger: null,
        triggers: [],
        draft: d,
        foreignOwnerId: null,
      },
      d,
      { repoUrl: "" },
    );
    expect(api.updateWork.mock.calls[0][1]).toMatchObject({ owner: "workspace", podSecrets: null });
  });
});

describe("environment settings on the wire", () => {
  const settings = {
    connections: { add: ["c1", "c1"], remove: [] },
    setupCommands: "  npm ci ",
    review: { enabled: true },
    cautiousMode: true,
  };

  it("pod work that opens a PR sends only its changes, PR follow-through included", () => {
    const spec = specFor(draft({ repoUrl: REPO, prompt: "Fix", settings }), {
      repoUrl: REPO,
      name: "Fix",
    });
    expect(spec.settings).toEqual({
      connections: { add: ["c1"] },
      setupCommands: "npm ci",
      review: { enabled: true },
      cautiousMode: true,
    });
  });

  it("a Job and a persistent agent send their changes too (the server drops PR follow-through)", () => {
    const cleaned = {
      connections: { add: ["c1"] },
      setupCommands: "npm ci",
      review: { enabled: true },
      cautiousMode: true,
    };
    const job = specFor(draft({ withRepo: false, prompt: "Hi", settings }), {
      repoUrl: REPO,
      name: "Job",
    });
    expect(job.settings).toEqual(cleaned);
    const agent = specFor(
      draft({ withRepo: false, prompt: "Hi", then: "waits-for-messages", settings }),
      { repoUrl: REPO, name: "Forge" },
    );
    expect(agent.settings).toEqual(cleaned);
  });

  it("work on a machine sends none (it runs with the machine's own configuration)", () => {
    const spec = specFor(
      draft({
        location: onMachine("headless"),
        withRepo: false,
        prompt: "Hi",
        settings,
      }),
      { repoUrl: "", name: "Local" },
    );
    expect(spec).not.toHaveProperty("settings");
  });

  it("nothing changed is null, so the work keeps following the repo", () => {
    const spec = specFor(draft({ repoUrl: REPO, prompt: "Fix", settings: { skills: {} } }), {
      repoUrl: REPO,
      name: "Fix",
    });
    expect(spec.settings).toBeNull();
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
    api.putWorkDefaults.mockRejectedValue(new Error("boom"));
    expect(() => rememberWorkDefaults(normalize({ ...EMPTY_DRAFT }))).not.toThrow();
    expect(api.putWorkDefaults).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});

describe("Work until merged", () => {
  const untilMerged = draft({ prompt: "fix it", repoUrl: REPO, then: "until-merged" });

  beforeEach(() => api.createWork.mockResolvedValue(made("repo-task", "t-1", "/tasks/t-1")));

  it("a Task carries its own follow-through", async () => {
    const created = await createWork(untilMerged, { repoUrl: REPO, autoName: "Task 1" });
    expect(sent()).toMatchObject({ then: "until-merged", mergeWhenReady: true });
    expect(kindOfSpec(sent())).toBe("repo-task");
    expect(created.toast).toBe("Task 1 started — it will work the PR until it merges");
  });

  it("'you merge it' keeps resuming but doesn't merge", async () => {
    await createWork(
      { ...untilMerged, mergeWhenReady: false },
      { repoUrl: REPO, autoName: "Task 1" },
    );
    expect(sent()).toMatchObject({ then: "until-merged", mergeWhenReady: false });
  });

  it("Exit when done leaves the PR to the repo's settings", async () => {
    await createWork({ ...untilMerged, then: "exits" }, { repoUrl: REPO, autoName: "Task 1" });
    expect(sent().then).toBe("exits");
  });

  it("a scheduled Task saves it, and switching back to Exit when done says so", async () => {
    const ticket = draft({
      ...untilMerged,
      when: "ticket",
      trigger: { type: "ticket", ticketSource: "github" },
    });
    api.createWork.mockResolvedValue(made("repo-blueprint", "c-1", "/tasks/scheduled/c-1"));
    await createWork(ticket, { repoUrl: REPO, autoName: "Task 1" });
    expect(kindOfSpec(sent())).toBe("repo-blueprint");
    expect(sent()).toMatchObject({ then: "until-merged", mergeWhenReady: true });

    const target = {
      id: "c-1",
      kind: "repo-blueprint",
      row: { name: "Task 1" },
      trigger: { id: "tr-1", type: "ticket" },
    } as unknown as EditTarget;
    const saved = await updateWork(target, { ...ticket, then: "exits" }, { repoUrl: REPO });
    expect(api.updateWork.mock.calls[0][1].then).toBe("exits");
    expect(saved.href).toBe("/tasks/scheduled/c-1");
  });
});
