import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanWorkSettings,
  isWorkDefinitionKind,
  kindOfSpec,
  withoutPrSettings,
  type WorkSpec,
} from "@optio/shared";

const api = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getWork: vi.fn(),
  listWorkTriggers: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { draftFromRow, loadEditTarget, ownerFromRow, pickTrigger, whenFromTrigger } from "./load";
import { specFor } from "./submit";
import {
  deriveKind,
  effectiveOwner,
  EMPTY_DRAFT,
  isEventWhen,
  isPodWork,
  kindLock,
  missingFields,
  normalize,
  prSettingsApply,
  type WorkDraft,
  type WorkKind,
} from "./model";

const ME = "u-me";
const REPO = "https://github.com/acme/app";

// ── The round trip: a saved definition reopens as the draft that saved it ──

/**
 * The `work_definitions` row the server stores for a spec: a test mirror of
 * `definitionColumns` and the owner it plans in
 * apps/api/src/services/work-write-service.ts, with the table's column
 * defaults for what a kind doesn't set. Keep it in step with the server.
 */
function rowFromSpec(spec: WorkSpec): Record<string, unknown> {
  const kind = kindOfSpec(spec);
  if (!isWorkDefinitionKind(kind)) throw new Error(`${kind} is not a definition`);
  const set = Object.entries(spec.who.agentOptions ?? {}).filter(
    ([, v]) => typeof v === "boolean" || v.trim() !== "",
  );
  const agentOptions = set.length ? Object.fromEntries(set) : null;
  const row = {
    id: "def-1",
    kind,
    name: spec.name.trim(),
    description: spec.description?.trim() || null,
    prompt: spec.what.prompt.trim(),
    runTitle: spec.what.runTitle?.trim() || null,
    agentType: spec.who.runtime,
    agentOptions,
    // Column defaults.
    model: null,
    repoUrl: null,
    repoBranch: null,
    runTarget: "cluster",
    localHostId: null,
    localDir: null,
    localSessionMode: null,
    maxRetries: 1,
    priority: 100,
    autoResume: null,
    autoMerge: null,
    // The owner the server plans: yours, or the organization's.
    ownerUserId: spec.owner === "me" ? ME : null,
    podSecrets: spec.podSecrets ?? null,
    // `settingsOf`: pod work only; PR follow-through only for a scheduled Task.
    settings:
      spec.where.runTarget === "local"
        ? null
        : kind === "repo-blueprint"
          ? cleanWorkSettings(spec.settings)
          : withoutPrSettings(cleanWorkSettings(spec.settings)),
  };
  // `runLocation`: a Task or Job on a machine runs headless.
  const location =
    spec.where.runTarget === "local"
      ? {
          runTarget: "local",
          localHostId: spec.where.localHostId,
          localDir: spec.where.localDir,
          localSessionMode: "headless",
        }
      : {};
  switch (kind) {
    case "repo-blueprint":
      return {
        ...row,
        ...location,
        repoUrl: spec.where.repoUrl,
        repoBranch: spec.where.repoBranch || "main",
        maxRetries: spec.maxRetries ?? 3,
        priority: spec.priority ?? 100,
        ...(spec.then === "until-merged"
          ? { autoResume: true, autoMerge: spec.mergeWhenReady ?? true }
          : {}),
      };
    case "standalone":
      return {
        ...row,
        ...location,
        model: spec.who.model ?? null,
        maxRetries: spec.maxRetries ?? 1,
      };
    case "local-blueprint":
      return {
        ...row,
        runTarget: "local",
        localHostId: spec.where.localHostId || null,
        localDir: spec.where.localDir || null,
        repoUrl: spec.where.repoUrl || null,
        repoBranch: spec.where.repoBranch || null,
        agentOptions: spec.who.runtime ? agentOptions : null,
        localSessionMode: spec.then === "waits-for-me" ? "interactive" : "headless",
        // An automation is always its owner's, and has no pod.
        ownerUserId: ME,
        podSecrets: null,
        settings: null,
      };
  }
}

/** The trigger row the server files for a spec's When. */
function triggerFromSpec(spec: WorkSpec) {
  return spec.when.type === "manual"
    ? null
    : { id: "tr-1", type: spec.when.type, config: spec.when.config, enabled: true };
}

/**
 * What a saved definition keeps of a draft. Not kept, by design: the repo id
 * (the form finds it again from the url), a one-off Task's dependencies and
 * an agent's identity (neither is a definition), and the answers the rest of
 * the draft doesn't use.
 */
function kept(d: WorkDraft) {
  const kind = deriveKind(d);
  const { repoId: _repoId, dependsOn: _dependsOn, agent: _agent, ...rest } = d;
  return {
    ...rest,
    // Work on a machine is always yours, and has no pod to give secrets to
    // or environment to change.
    owner: effectiveOwner(d),
    podSecrets: isPodWork(d) ? d.podSecrets : null,
    settings: isPodWork(d)
      ? prSettingsApply(d)
        ? cleanWorkSettings(d.settings)
        : withoutPrSettings(cleanWorkSettings(d.settings))
      : null,
    // An event When has no trigger form; any other When has no event.
    ...(isEventWhen(d.when) ? { trigger: undefined } : { event: undefined }),
    ...(d.withRepo ? {} : { repoUrl: undefined, repoBranch: undefined }),
    // Only "Works until merged" asks whether to merge.
    ...(d.then === "until-merged" ? {} : { mergeWhenReady: undefined }),
    // Priority is asked only of work with a repo; an automation isn't retried.
    ...(kind === "standalone" ? { priority: undefined } : {}),
    ...(kind === "local-blueprint" ? { priority: undefined, maxRetries: undefined } : {}),
  };
}

const machine = (localSessionMode: "interactive" | "headless") => ({
  runTarget: "local" as const,
  localHostId: "h1",
  localDir: "/Users/dev/repos/app",
  localSessionMode,
});

/** Drafts of every editable kind, as the form would save them. */
const SAVED: [string, WorkKind, Partial<WorkDraft>][] = [
  [
    "a scheduled pod Task, worked until merged with someone's own Codex",
    "repo-blueprint",
    {
      name: "Nightly sweep",
      description: "Keeps main tidy",
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * 1-5" },
      repoId: "r-1",
      repoUrl: REPO,
      repoBranch: "develop",
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.5", copilotEffort: "high" },
      prompt: "Sweep",
      runName: "Sweep {{date}}",
      then: "until-merged",
      mergeWhenReady: false,
      priority: 7,
      maxRetries: 1,
      owner: "me",
      podSecrets: ["NPM_TOKEN"],
      // Its own environment: a connection added, an MCP server off, setup
      // commands, and review on as the PR opens.
      settings: {
        connections: { add: ["c-1"] },
        mcpServers: { remove: ["m-1"] },
        setupCommands: "npm ci",
        review: { enabled: true, trigger: "on_pr" },
        maxAutoResumes: 3,
      },
    },
  ],
  [
    "a Linear-assigned Task on a new branch on a machine",
    "repo-blueprint",
    {
      name: "Linear triage",
      when: "linear",
      event: { type: "linear", config: { events: ["assigned"], user: "ada", teams: ["ENG"] } },
      location: machine("headless"),
      repoUrl: REPO,
      repoBranch: "main",
      agentOptions: { claudeModel: "opus", claudeEffort: "high" },
      prompt: "Triage {{url}}",
      runName: "Triage: {{title}}",
    },
  ],
  [
    "a ticket-started pod Job from before secrets were picked, a repo still picked",
    "standalone",
    {
      name: "Ticket digest",
      when: "ticket",
      trigger: { type: "ticket", ticketSource: "linear", ticketLabels: ["bug"] },
      withRepo: false,
      repoId: "r-1",
      repoUrl: REPO,
      agentOptions: { claudeModel: "sonnet", claudeThinking: true },
      prompt: "Triage {{ticketUrl}}",
      runName: "Triage: {{ticketTitle}}",
      maxRetries: 2,
      podSecrets: null,
    },
  ],
  [
    "a webhook Job on a machine",
    "standalone",
    {
      name: "Deploy",
      when: "webhook",
      trigger: { type: "webhook", webhookPath: "deploy-hook" },
      withRepo: false,
      location: machine("headless"),
      runtime: "codex",
      agentOptions: { copilotModel: "gpt-5.5", codexPermissionMode: "bypassPermissions" },
      prompt: "Deploy",
      maxRetries: 0,
    },
  ],
  [
    "a pod Job on every opened PR, with the runtime's defaults",
    "standalone",
    {
      name: "PR summary",
      when: "github",
      event: { type: "github", config: { events: ["pr_opened"], repos: ["acme/app"] } },
      withRepo: false,
      runtime: "gemini",
      prompt: "Summarize {{url}}",
      podSecrets: ["SLACK_TOKEN"],
    },
  ],
  [
    "an interactive automation on a new branch, started by GitHub",
    "local-blueprint",
    {
      name: "Reviews",
      when: "github",
      event: { type: "github", config: { events: ["review_requested"], login: "octocat" } },
      location: machine("interactive"),
      repoUrl: REPO,
      repoBranch: "release",
      agentOptions: { claudeModel: "opus", claudePermissionMode: "bypassPermissions" },
      prompt: "Review PR {{number}}",
      runName: "Review {{number}}",
      then: "waits-for-me",
    },
  ],
  [
    "an interactive automation in a directory as it is, on a schedule",
    "local-blueprint",
    {
      name: "Morning notes",
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 8 * * *" },
      withRepo: false,
      location: machine("interactive"),
      runtime: "codex",
      prompt: "Summarize yesterday",
      then: "waits-for-me",
    },
  ],
];

describe("draftFromRow is the inverse of specFor", () => {
  it.each(SAVED)("%s", (_, kind, patch) => {
    const d = normalize({ ...EMPTY_DRAFT, ...patch });
    expect(deriveKind(d)).toBe(kind);
    const ctx = { repoUrl: d.repoUrl, name: d.name };
    const spec = specFor(d, ctx);
    const row = rowFromSpec(spec);
    expect(row.kind).toBe(kind);

    const back = draftFromRow(row, triggerFromSpec(spec), ME);
    // Every answer the definition keeps comes back…
    expect(kept(back)).toEqual(kept(d));
    // …on the kind it was saved as (so the lock allows edits), with nothing to fill in.
    expect(deriveKind(back)).toBe(kind);
    expect(missingFields(back)).toEqual([]);
    // Opening it and saving without a change leaves the row as it was.
    expect(rowFromSpec(specFor(back, { repoUrl: back.repoUrl, name: back.name }))).toEqual(row);
  });
});

// ── Stored rows the form didn't save ─────────────────────────────────────────

describe("draftFromRow — stored rows", () => {
  it("a scheduled pod Task", () => {
    const d = draftFromRow(
      {
        kind: "repo-blueprint",
        name: "Nightly sweep",
        runTitle: null,
        prompt: "Sweep",
        repoUrl: REPO,
        repoBranch: "develop",
        agentType: "codex",
        agentOptions: { copilotModel: "gpt-5" },
        priority: 7,
        maxRetries: 1,
        runTarget: "cluster",
      },
      { type: "schedule", config: { cronExpression: "0 9 * * 1-5" } },
    );
    expect(deriveKind(d)).toBe("repo-blueprint");
    expect(d.when).toBe("schedule");
    expect(d.trigger.cronExpression).toBe("0 9 * * 1-5");
    expect(d.runtime).toBe("codex");
    expect(d.agentOptions).toEqual({ copilotModel: "gpt-5" });
    expect(d.repoUrl).toBe(REPO);
    expect(d.repoBranch).toBe("develop");
    expect(d.priority).toBe(7);
    expect(d.maxRetries).toBe(1);
    expect(missingFields(d)).toEqual([]);
  });

  it("a Job on a machine, folding the legacy model column into the options", () => {
    const d = draftFromRow(
      {
        kind: "standalone",
        name: "Digest",
        prompt: "Summarize {{ticketTitle}}",
        agentType: "claude-code",
        model: "opus",
        agentOptions: null,
        maxRetries: 2,
        runTarget: "local",
        localHostId: "h1",
        localDir: "/Users/dev/notes",
        localSessionMode: "headless",
      },
      { type: "ticket", config: { source: "linear", labels: ["bug"] } },
    );
    expect(deriveKind(d)).toBe("standalone");
    expect(d.when).toBe("ticket");
    expect(d.trigger).toEqual({ type: "ticket", ticketSource: "linear", ticketLabels: ["bug"] });
    expect(d.location).toEqual({
      runTarget: "local",
      localHostId: "h1",
      localDir: "/Users/dev/notes",
      localSessionMode: "headless",
    });
    expect(d.agentOptions).toEqual({ claudeModel: "opus" });
    expect(d.then).toBe("exits");
    // Options of its own win over the legacy column.
    const both = draftFromRow(
      { kind: "standalone", name: "D", prompt: "p", agentType: "claude-code", model: "opus" },
      null,
    );
    expect(both.agentOptions.claudeModel).toBe("opus");
    expect(
      draftFromRow(
        {
          kind: "standalone",
          name: "D",
          prompt: "p",
          agentType: "claude-code",
          model: "opus",
          agentOptions: { claudeModel: "sonnet" },
        },
        null,
      ).agentOptions.claudeModel,
    ).toBe("sonnet");
  });

  it("a Local automation on a new branch with a GitHub event trigger", () => {
    const d = draftFromRow(
      {
        kind: "local-blueprint",
        name: "Reviews",
        localHostId: "h1",
        localDir: "/Users/dev/repos/app",
        repoUrl: REPO,
        repoBranch: "main",
        prompt: "Review PR {{number}}",
        agentType: "claude-code",
        localSessionMode: "interactive",
        agentOptions: { claudeModel: "opus", claudePermissionMode: "bypassPermissions" },
      },
      { type: "github", config: { events: ["review_requested"], login: "octocat" } },
    );
    expect(deriveKind(d)).toBe("local-blueprint");
    // The automation's own model and permission mode come back to edit.
    expect(d.agentOptions).toEqual({
      claudeModel: "opus",
      claudePermissionMode: "bypassPermissions",
    });
    expect(d.when).toBe("github");
    expect(d.event).toEqual({
      type: "github",
      config: { events: ["review_requested"], login: "octocat" },
    });
    expect(d.withRepo).toBe(true);
    expect(d.repoBranch).toBe("main");
    expect(d.then).toBe("waits-for-me");
    expect(missingFields(d)).toEqual([]);
  });

  it("a headless scheduled automation with no branch sits on the Job point, and the lock allows it", () => {
    const d = draftFromRow(
      {
        kind: "local-blueprint",
        name: "Sync",
        localHostId: "h1",
        localDir: "/Users/dev/notes",
        repoBranch: null,
        prompt: "Sync notes",
        agentType: "codex",
        localSessionMode: "headless",
      },
      { type: "schedule", config: { cronExpression: "0 * * * *" } },
    );
    // The form would file this as a Job on a machine.
    expect(deriveKind(d)).toBe("standalone");
    expect(d.withRepo).toBe(false);
    expect(d.then).toBe("exits");
    expect(d.runtime).toBe("codex");
    expect(kindLock(d, "local-blueprint", { prompt: "x" })).toBeUndefined();
    // A new branch on a schedule is a scheduled Task on a machine — a different row.
    expect(kindLock(d, "local-blueprint", { withRepo: true })).toMatch(/automation/);
    // Waiting for you between turns is an interactive automation — still this row.
    expect(kindLock(d, "local-blueprint", { then: "waits-for-me" })).toBeUndefined();
  });
});

describe("draftFromRow — run names", () => {
  it("reads each kind's run-title template back, blank when it just repeats the name", () => {
    const linear = { type: "linear", config: { events: ["mentioned"], user: "jon" } };
    const rows = {
      "repo-blueprint": { name: "Triage", prompt: "p", repoUrl: REPO, agentType: "claude-code" },
      standalone: { name: "Triage", prompt: "p", agentType: "claude-code" },
      "local-blueprint": {
        name: "Triage",
        prompt: "p",
        agentType: "claude-code",
        localHostId: "h1",
        localDir: "/x",
      },
    };
    for (const [kind, row] of Object.entries(rows)) {
      const at = (runTitle: string | null) =>
        draftFromRow({ kind, ...row, runTitle }, linear).runName;
      expect(at("Triage: {{ticketTitle}}")).toBe("Triage: {{ticketTitle}}");
      // Older forms saved `run title = name` when no run name was set.
      expect(at("Triage")).toBe("");
      expect(at(null)).toBe("");
    }
  });
});

describe("whenFromTrigger / pickTrigger", () => {
  it("maps each stored trigger type back to the form's When", () => {
    expect(whenFromTrigger({ type: "webhook", config: { path: "hook-1" } }).trigger).toEqual({
      type: "webhook",
      webhookPath: "hook-1",
    });
    expect(whenFromTrigger({ type: "slack", config: { channelId: "C0123ABCD" } }).when).toBe(
      "slack",
    );
    expect(whenFromTrigger(null).when).toBe("manual");
  });

  it("prefers the first enabled trigger", () => {
    expect(
      pickTrigger([
        { id: "a", type: "webhook", enabled: false },
        { id: "b", type: "schedule", enabled: true },
      ]).id,
    ).toBe("b");
    expect(pickTrigger([{ id: "a", enabled: false }]).id).toBe("a");
    expect(pickTrigger([])).toBeNull();
  });
});

describe("kindLock — an edit stays inside its saved kind", () => {
  const job = draftFromRow(
    {
      kind: "standalone",
      name: "Digest",
      prompt: "p",
      agentType: "claude-code",
      runTarget: "cluster",
    },
    { type: "schedule", config: { cronExpression: "0 9 * * *" } },
  );

  it("allows changes that keep the kind and refuses ones that move it", () => {
    expect(kindLock(job, "standalone", { runtime: "codex" })).toBeUndefined();
    expect(
      kindLock(job, "standalone", { trigger: { type: "webhook" }, when: "webhook" }),
    ).toBeUndefined();
    // A repo would make it a scheduled Task.
    expect(kindLock(job, "standalone", { withRepo: true })).toMatch(/saved as a Job/);
    // Waiting for messages would make it a persistent agent.
    expect(kindLock(job, "standalone", { then: "waits-for-messages" })).toMatch(/saved as a Job/);
    // A GitHub event is just another When: still a Job, still in its pod.
    expect(kindLock(job, "standalone", { when: "github" })).toBeUndefined();
  });

  it("is a no-op when nothing is locked", () => {
    expect(kindLock(job, null, { withRepo: true })).toBeUndefined();
  });
});

describe("owner and secrets from a row", () => {
  it("maps the owner id to the form's answer and flags someone else's work", () => {
    expect(ownerFromRow({ ownerUserId: null }, ME)).toEqual({
      owner: "workspace",
      foreignOwnerId: null,
    });
    expect(ownerFromRow({ ownerUserId: ME }, ME)).toEqual({ owner: "me", foreignOwnerId: null });
    expect(ownerFromRow({ ownerUserId: "u-x" }, ME)).toEqual({
      owner: "me",
      foreignOwnerId: "u-x",
    });
    // Unknown viewer: stays editable, the server decides.
    expect(ownerFromRow({ ownerUserId: "u-x" }, null).foreignOwnerId).toBeNull();
  });

  it("restores picked secrets, keeping null for rows that never picked", () => {
    const row = { kind: "standalone", name: "J", agentType: "claude-code", prompt: "hi" };
    expect(draftFromRow({ ...row, podSecrets: ["A"] }, null).podSecrets).toEqual(["A"]);
    expect(draftFromRow({ ...row, podSecrets: null }, null).podSecrets).toBeNull();
    expect(draftFromRow(row, null).podSecrets).toBeNull();
    expect(draftFromRow({ ...row, ownerUserId: ME }, null, ME).owner).toBe("me");
    expect(draftFromRow({ ...row, ownerUserId: null }, null, ME).owner).toBe("workspace");
  });
});

describe("loading a scheduled Task's follow-through", () => {
  const row = {
    kind: "repo-blueprint",
    name: "Assign",
    prompt: "fix {{ticketTitle}}",
    repoUrl: REPO,
    repoBranch: "main",
    agentType: "claude-code",
  };

  it("a row with its own follow-through opens as Work until merged", () => {
    const d = draftFromRow({ ...row, autoResume: true, autoMerge: false }, null);
    expect(d.then).toBe("until-merged");
    expect(d.mergeWhenReady).toBe(false);
    expect(draftFromRow({ ...row, autoResume: true }, null).mergeWhenReady).toBe(true);
  });

  it("a row without one opens as Exit when done", () => {
    expect(draftFromRow(row, null).then).toBe("exits");
    expect(draftFromRow({ ...row, autoResume: null }, null).then).toBe("exits");
  });
});

// ── Resolving an id ──────────────────────────────────────────────────────────

describe("loadEditTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCurrentUser.mockResolvedValue({ user: { id: ME } });
  });

  /** `GET /api/work/:id` for a stored row. */
  const resolves = (source: string, work: Record<string, unknown>) =>
    api.getWork.mockResolvedValue({ source, row: { source, id: work.id }, work });

  it("resolves a definition through /api/work and edits its first enabled trigger", async () => {
    const work = {
      id: "w-1",
      kind: "standalone",
      name: "Digest",
      prompt: "p",
      agentType: "claude-code",
      runTarget: "cluster",
      ownerUserId: null,
    };
    resolves("standalone", work);
    const triggers = [
      { id: "t0", type: "webhook", enabled: false, config: { path: "old" } },
      { id: "t1", type: "schedule", enabled: true, config: { cronExpression: "0 9 * * *" } },
    ];
    api.listWorkTriggers.mockResolvedValue({ triggers });

    const target = await loadEditTarget("w-1");
    expect(api.getWork).toHaveBeenCalledWith("w-1");
    expect(api.listWorkTriggers).toHaveBeenCalledWith("w-1");
    expect(target).toMatchObject({ id: "w-1", kind: "standalone", row: work, triggers });
    expect(target.trigger.id).toBe("t1");
    expect(target.draft.when).toBe("schedule");
    expect(target.draft.prompt).toBe("p");
    expect(target.foreignOwnerId).toBeNull();
  });

  it("a Local automation resolves the same way, with no trigger, and is always yours", async () => {
    resolves("local-blueprint", {
      id: "b-1",
      kind: "local-blueprint",
      name: "Reviews",
      localHostId: "h1",
      localDir: "/x",
      prompt: "p",
      agentType: "claude-code",
      localSessionMode: "interactive",
      ownerUserId: "u-x",
    });
    api.listWorkTriggers.mockResolvedValue({ triggers: [] });
    const target = await loadEditTarget("b-1");
    expect(target.kind).toBe("local-blueprint");
    expect(target.trigger).toBeNull();
    expect(target.draft.location.localHostId).toBe("h1");
    expect(target.foreignOwnerId).toBeNull();
  });

  it.each(["repo-task", "local-terminal", "pod-session", "persistent-agent"])(
    "refuses a %s: it isn't a definition",
    async (source) => {
      resolves(source, { id: "x-1" });
      await expect(loadEditTarget("x-1")).rejects.toMatchObject({ status: 405 });
      expect(api.listWorkTriggers).not.toHaveBeenCalled();
    },
  );

  it("passes a missing id's error through", async () => {
    api.getWork.mockRejectedValue(Object.assign(new Error("Work not found"), { status: 404 }));
    await expect(loadEditTarget("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("flags a row owned by someone else, unless it can't tell who you are", async () => {
    const work = {
      id: "w-9",
      kind: "standalone",
      name: "J",
      ownerUserId: "u-x",
      prompt: "hi",
      agentType: "claude-code",
    };
    resolves("standalone", work);
    api.listWorkTriggers.mockResolvedValue({ triggers: [] });
    const t = await loadEditTarget("w-9");
    expect(t.foreignOwnerId).toBe("u-x");
    expect(t.draft.owner).toBe("me");

    // Unknown viewer: editable; the server refuses a non-owner save.
    api.getCurrentUser.mockRejectedValue(new Error("401"));
    expect((await loadEditTarget("w-9")).foreignOwnerId).toBeNull();
  });
});
