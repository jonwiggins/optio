import { describe as suite, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  PRESETS,
  TERMINAL,
  TRIGGER_PARAMS,
  describe,
  deriveKind,
  eventGaps,
  missingFields,
  normalize,
  optionsFromRepo,
  runtimeOptions,
  slugify,
  thenOptions,
  whereOptions,
  type WhenType,
  type WorkDraft,
} from "./model";

const local = (d: WorkDraft, dir = "/Users/dev/repos/app"): WorkDraft => ({
  ...d,
  location: { ...d.location, runTarget: "local", localHostId: "h1", localDir: dir },
});
const text = (d: WorkDraft, ctx?: Parameters<typeof describe>[1]) =>
  describe(d, ctx)
    .map((p) => ("missing" in p ? `[${p.missing}]` : p.text))
    .reduce((acc, t) => (/^[,.]/.test(t) ? acc + t : acc ? `${acc} ${t}` : t), "");
const enabled = <T>(choices: Array<{ value: T; disabled?: string }>) =>
  choices.filter((c) => !c.disabled).map((c) => c.value);

suite("deriveKind — every kind is a point in the attribute space", () => {
  const base = { ...EMPTY_DRAFT, prompt: "p" };

  it("exits + pod + repo", () => {
    expect(deriveKind(base)).toBe("repo-task");
    expect(deriveKind({ ...base, when: "schedule" })).toBe("repo-blueprint");
  });

  it("exits + no repo / current directory", () => {
    expect(deriveKind({ ...base, withRepo: false })).toBe("standalone");
    expect(deriveKind({ ...base, withRepo: false, when: "webhook" })).toBe("standalone");
    expect(deriveKind(local({ ...base, withRepo: false, when: "schedule" }))).toBe("standalone");
  });

  it("exits + machine + new branch opens a PR", () => {
    expect(deriveKind(local({ ...base, withRepo: true }))).toBe("repo-task");
  });

  it("an event trigger is a When like any other: the Where and Then pick the kind", () => {
    // Pod + repo + GitHub event → a scheduled Task; no repo → a Job.
    expect(deriveKind({ ...base, when: "github" })).toBe("repo-blueprint");
    expect(deriveKind({ ...base, when: "slack", withRepo: false })).toBe("standalone");
    // Machine + branch + Linear event → a scheduled Task that runs in the checkout.
    expect(deriveKind(local({ ...base, when: "linear" }))).toBe("repo-blueprint");
    // Only an interactive automation on a machine is a Local automation.
    expect(deriveKind(local({ ...base, when: "github", then: "waits-for-me" }))).toBe(
      "local-blueprint",
    );
  });

  it("waits for me", () => {
    expect(deriveKind(local({ ...base, then: "waits-for-me" }))).toBe("local-terminal");
    expect(deriveKind(local({ ...base, then: "waits-for-me", when: "slack" }))).toBe(
      "local-blueprint",
    );
    expect(deriveKind({ ...base, then: "waits-for-me" })).toBe("pod-session");
  });

  it("persistent agent", () => {
    expect(deriveKind({ ...base, then: "waits-for-messages", withRepo: false })).toBe(
      "persistent-agent",
    );
  });
});

suite("constraints flow downstream", () => {
  it("every trigger works with every Where", () => {
    for (const when of ["manual", "schedule", "webhook", "ticket", "github", "slack", "linear"]) {
      expect(enabled(whereOptions({ ...EMPTY_DRAFT, when: when as WhenType }))).toEqual([
        "cluster",
        "local",
      ]);
    }
    expect(normalize({ ...EMPTY_DRAFT, when: "linear" }).location.runTarget).toBe("cluster");
  });

  it("a machine offers a terminal and only the CLIs the daemon can launch", () => {
    const opts = runtimeOptions(local({ ...EMPTY_DRAFT, withRepo: false }));
    expect(enabled(opts)).toContain(TERMINAL);
    expect(enabled(opts)).not.toContain("copilot");
    expect(normalize(local({ ...EMPTY_DRAFT, runtime: "copilot" })).runtime).toBe("claude-code");
  });

  it("a pod terminal needs a repo and is opened by hand", () => {
    expect(enabled(runtimeOptions({ ...EMPTY_DRAFT, withRepo: false }))).not.toContain(TERMINAL);
    expect(enabled(runtimeOptions({ ...EMPTY_DRAFT, when: "schedule" }))).not.toContain(TERMINAL);
    expect(enabled(runtimeOptions(EMPTY_DRAFT))).toContain(TERMINAL);
  });

  it("a trigger never starts a bare terminal, on a pod or a machine", () => {
    expect(enabled(runtimeOptions(local({ ...EMPTY_DRAFT, when: "schedule" })))).not.toContain(
      TERMINAL,
    );
    expect(enabled(runtimeOptions(local({ ...EMPTY_DRAFT, when: "slack" })))).not.toContain(
      TERMINAL,
    );
    expect(normalize(local({ ...EMPTY_DRAFT, when: "schedule", runtime: TERMINAL })).runtime).toBe(
      "claude-code",
    );
  });

  it("a terminal with no agent waits for you", () => {
    const d = normalize(local({ ...EMPTY_DRAFT, withRepo: false, runtime: TERMINAL }));
    expect(enabled(thenOptions(d))).toEqual(["waits-for-me"]);
    expect(d.then).toBe("waits-for-me");
    expect(d.location.localSessionMode).toBe("interactive");
  });

  it("a persistent agent lives in a pod, with no repo, and not on event triggers", () => {
    expect(enabled(thenOptions(local(EMPTY_DRAFT)))).not.toContain("waits-for-messages");
    expect(enabled(thenOptions(EMPTY_DRAFT))).not.toContain("waits-for-messages");
    expect(enabled(thenOptions({ ...EMPTY_DRAFT, withRepo: false }))).toContain(
      "waits-for-messages",
    );
    const flipped = normalize(
      local({ ...EMPTY_DRAFT, withRepo: false, then: "waits-for-messages" }),
    );
    expect(flipped.then).toBe("exits");
  });

  it("a pod session chats with Claude Code, so other runtimes can't wait for you there", () => {
    expect(enabled(thenOptions({ ...EMPTY_DRAFT, runtime: "codex" }))).not.toContain(
      "waits-for-me",
    );
    expect(enabled(thenOptions({ ...EMPTY_DRAFT, runtime: "claude-code" }))).toContain(
      "waits-for-me",
    );
    expect(enabled(thenOptions({ ...EMPTY_DRAFT, runtime: TERMINAL }))).toContain("waits-for-me");
    // On a machine any launchable CLI can wait for you.
    expect(enabled(thenOptions(local({ ...EMPTY_DRAFT, runtime: "codex" })))).toContain(
      "waits-for-me",
    );
  });

  it("switching runtimes clears the previous runtime's options", () => {
    const d = normalize(
      local({ ...EMPTY_DRAFT, runtime: "copilot", agentOptions: { copilotModel: "x" } }),
    );
    expect(d.agentOptions).toEqual({});
  });
});

suite("the sentence", () => {
  it("leads with the trigger and reads naturally for a PR task", () => {
    const d = { ...EMPTY_DRAFT, repoUrl: "https://github.com/acme/app" };
    expect(text(d, { repoName: "acme/app" })).toBe(
      "Started now, a Claude Code run in an Optio pod with acme/app that opens a PR and exits when done.",
    );
  });

  it("names the machine and directory for a local terminal", () => {
    const d = normalize(
      local({ ...EMPTY_DRAFT, then: "waits-for-me", withRepo: false }, "/Users/dev/notes"),
    );
    expect(text(d, { machineName: "M1" })).toBe(
      "Opened now, a Claude Code session on M1 in ~/notes that waits for you between turns.",
    );
    const branch = normalize(local({ ...EMPTY_DRAFT, withRepo: true }));
    expect(text(branch)).toContain("on a new branch in ~/repos/app that opens a PR");
  });

  it("describes schedules and marks what's missing", () => {
    const d = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * 1-5" },
    });
    expect(text(d)).toBe(
      "Running weekdays at 09:00 UTC, a Claude Code run in an Optio pod that exits when done.",
    );
    expect(missingFields(d)).toEqual(["prompt"]);
    const bad = { ...d, trigger: { type: "schedule" as const, cronExpression: "nope" } };
    expect(text(bad)).toContain("[on a schedule]");
  });

  it("an event trigger about you needs your login, a Slack one a channel id", () => {
    const gh = (config: Record<string, unknown>) =>
      eventGaps({ type: "github", config: { events: ["review_requested"], ...config } });
    expect(gh({ login: "" })).toEqual(["identity"]);
    expect(gh({ login: "octocat" })).toEqual([]);
    expect(eventGaps({ type: "github", config: { events: ["pr_opened"], login: "" } })).toEqual([]);
    expect(eventGaps({ type: "linear", config: { events: ["assigned"], user: "" } })).toEqual([
      "identity",
    ]);
    // "Only tickets from someone else" has to know whose tickets to skip.
    expect(
      eventGaps({ type: "linear", config: { events: ["created"], othersOnly: true, user: "" } }),
    ).toEqual(["identity"]);
    expect(
      eventGaps({ type: "linear", config: { events: ["created"], othersOnly: true, user: "Ada" } }),
    ).toEqual([]);
    expect(eventGaps({ type: "github", config: { events: [], login: "octocat" } })).toEqual([
      "events",
    ]);
    expect(eventGaps({ type: "slack", config: { channelId: "general" } })).toEqual(["channel"]);
    expect(eventGaps({ type: "slack", config: { channelId: "C0123ABCD" } })).toEqual([]);
    // The sentence carries the gap, so the form can't submit.
    const d = normalize({
      ...EMPTY_DRAFT,
      when: "github",
      prompt: "p",
      event: { type: "github", config: { events: ["mentioned"], login: "" } },
    });
    expect(text(local(d))).toContain("[about you]");
    expect(missingFields(local(d))).toContain("identity");
  });

  it("a shell terminal on a machine never claims a new branch", () => {
    const d = normalize(local({ ...EMPTY_DRAFT, withRepo: true, runtime: TERMINAL }));
    expect(text(d)).toContain("a terminal on my machine in ~/repos/app");
    expect(text(d)).not.toContain("new branch");
  });

  it("does not demand a prompt for a terminal you open by hand", () => {
    expect(
      missingFields(normalize(local({ ...EMPTY_DRAFT, then: "waits-for-me", withRepo: false }))),
    ).toEqual([]);
    expect(
      missingFields(normalize({ ...EMPTY_DRAFT, then: "waits-for-me", repoUrl: "x" })),
    ).toEqual([]);
  });
});

suite("presets and params", () => {
  it("presets land on the kinds their labels promise", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, normalize(p.apply(EMPTY_DRAFT))]));
    expect(deriveKind(by.pr)).toBe("repo-task");
    expect(deriveKind(local(by.chat))).toBe("local-terminal");
    expect(deriveKind(local(by.terminal))).toBe("local-terminal");
    expect(by.terminal.runtime).toBe(TERMINAL);
    expect(deriveKind(by.schedule)).toBe("standalone");
    expect(deriveKind(by.agent)).toBe("persistent-agent");
  });

  it("ticket-style params are offered for ticket and Linear triggers", () => {
    expect(TRIGGER_PARAMS.ticket).toContain("ticketUrl");
    expect(TRIGGER_PARAMS.linear).toContain("ticketUrl");
    expect(TRIGGER_PARAMS.schedule).toEqual([]);
  });

  it("slugifies names for agents", () => {
    expect(slugify("Release Manager!")).toBe("release-manager");
    expect(slugify("Session 12")).toBe("session-12");
  });
});

suite("optionsFromRepo", () => {
  const repo = {
    claudeModel: "opus",
    claudeEffort: "low",
    copilotModel: "claude-sonnet-4.5",
    copilotEffort: "high",
  };

  it("seeds a runtime's options from the repo's columns", () => {
    expect(optionsFromRepo("claude-code", repo)).toMatchObject({
      claudeModel: "opus",
      claudeEffort: "low",
    });
    expect(optionsFromRepo("copilot", repo)).toEqual({
      copilotModel: "claude-sonnet-4.5",
      copilotEffort: "high",
    });
  });

  it("never seeds Codex from Copilot's shared columns", () => {
    expect(optionsFromRepo("codex", repo)).toEqual({});
  });
});

// ── Owner, pod secrets, model providers ─────────────────────────────────────

import type { ModelProvider, PickableSecret } from "@optio/shared";
import {
  addableSecrets,
  effectiveOwner,
  isPersonalOnlySecret,
  isPodWork,
  pickedProvider,
  providerDisabled,
  providerModelsFor,
  usableProviders,
  withOwner,
  withProvider,
  withSecret,
  withoutSecret,
} from "./model";

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: "p-org",
  workspaceId: "ws",
  ownerUserId: null,
  ownerName: null,
  kind: "bedrock",
  name: "Bedrock",
  agents: ["claude-code", "codex"],
  region: "us-west-2",
  models: {
    "claude-code": [{ id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5" }],
    codex: [{ id: "openai.gpt-5.5" }],
  },
  localAwsProfile: null,
  podCredential: "access-key",
  hasPodCredentials: true,
  mine: false,
  canEdit: true,
  createdAt: "",
  updatedAt: "",
  ...over,
});
const orgP = provider();
const myP = provider({ id: "p-me", name: "My Bedrock", ownerUserId: "u-me", mine: true });
const theirP = provider({ id: "p-them", ownerUserId: "u-them", canEdit: false });

suite("model providers in the draft", () => {
  const job = normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi" });

  it("offers org providers and mine for the runtime, never someone else's", () => {
    expect(usableProviders(job, [orgP, myP, theirP]).map((p) => p.id)).toEqual(["p-org", "p-me"]);
    expect(usableProviders({ ...job, runtime: "gemini" }, [orgP])).toEqual([]);
    expect(usableProviders(job, [provider({ agents: ["codex"] })]).map((p) => p.id)).toEqual([]);
  });

  it("picking a provider sets the option and its first model; Default removes both", () => {
    const picked = withProvider(job, orgP);
    expect(picked.agentOptions).toEqual({
      modelProvider: "p-org",
      claudeModel: "us.anthropic.claude-opus-5-5",
    });
    expect(pickedProvider(picked, [orgP])?.id).toBe("p-org");
    expect(providerModelsFor(picked, orgP)?.[0].id).toBe("us.anthropic.claude-opus-5-5");
    expect(picked.owner).toBe("workspace");
    const back = withProvider(
      { ...picked, agentOptions: { ...picked.agentOptions, effort: "high" } },
      null,
    );
    expect(back.agentOptions).toEqual({ effort: "high" });
    // Default with no provider picked leaves a chosen model alone.
    expect(
      withProvider({ ...job, agentOptions: { claudeModel: "opus" } }, null).agentOptions,
    ).toEqual({
      claudeModel: "opus",
    });
  });

  it("Codex's model goes in copilotModel", () => {
    const codex = normalize({ ...job, runtime: "codex" });
    expect(withProvider(codex, orgP).agentOptions.copilotModel).toBe("openai.gpt-5.5");
  });

  it("a personal provider makes the work mine; making it the org's drops it", () => {
    const mine = withProvider(job, myP);
    expect(mine.owner).toBe("me");
    const org = withOwner(mine, "workspace", [orgP, myP], []);
    expect(org.owner).toBe("workspace");
    expect(org.agentOptions.modelProvider).toBeUndefined();
    // An org provider survives the switch.
    expect(
      withOwner(withProvider(job, orgP), "workspace", [orgP], []).agentOptions.modelProvider,
    ).toBe("p-org");
  });

  it("disables a provider with the reason", () => {
    expect(providerDisabled(job, provider({ podCredential: "none" }), undefined)).toBe(
      "Machines only",
    );
    const onMachine = normalize({
      ...job,
      location: { ...job.location, runTarget: "local", localHostId: "h", localDir: "/x" },
    });
    expect(providerDisabled(onMachine, orgP, { name: "mac", modelProviders: false })).toBe(
      "Update Optio Local on mac to use model providers",
    );
    expect(
      providerDisabled(onMachine, provider({ localAwsProfile: "work" }), {
        name: "mac",
        modelProviders: true,
        awsProfiles: ["default"],
      }),
    ).toBe("AWS profile work isn't on mac");
    expect(
      providerDisabled(onMachine, provider({ podCredential: "none" }), {
        name: "mac",
        modelProviders: true,
        awsProfiles: [],
      }),
    ).toBeUndefined();
  });
});

suite("owner and pod secrets", () => {
  const job = normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi" });
  const pickable: PickableSecret[] = [
    { name: "SHARED", owner: "workspace" },
    { name: "SHARED", owner: "me" },
    { name: "MINE", owner: "me" },
    { name: "ORG", owner: "workspace" },
  ];

  it("pod work takes secrets; a machine run is always mine and takes none", () => {
    expect(isPodWork(job)).toBe(true);
    expect(isPodWork({ ...job, runtime: "" })).toBe(false);
    const local = normalize({ ...job, location: { ...job.location, runTarget: "local" } });
    expect(isPodWork(local)).toBe(false);
    expect(effectiveOwner(local)).toBe("me");
    expect(effectiveOwner(job)).toBe("workspace");
  });

  it("knows which names only I have", () => {
    expect(isPersonalOnlySecret("MINE", pickable)).toBe(true);
    expect(isPersonalOnlySecret("SHARED", pickable)).toBe(false);
    expect(isPersonalOnlySecret("ORG", pickable)).toBe(false);
  });

  it("adds, removes, and hides picked names from the add list", () => {
    const one = withSecret(job, { name: "ORG", owner: "workspace" });
    expect(one.podSecrets).toEqual(["ORG"]);
    expect(one.owner).toBe("workspace");
    expect(addableSecrets(one, pickable).map((s) => s.name)).toEqual(["SHARED", "SHARED", "MINE"]);
    const two = withSecret(one, { name: "MINE", owner: "me" });
    expect(two.owner).toBe("me");
    expect(withoutSecret(two, "ORG").podSecrets).toEqual(["MINE"]);
    // Back to the org: my-only secrets go, the rest stay.
    expect(withOwner(two, "workspace", [], pickable).podSecrets).toEqual(["ORG"]);
  });

  it("a legacy null list becomes an array on the first pick", () => {
    expect(
      withSecret({ ...job, podSecrets: null }, { name: "ORG", owner: "workspace" }).podSecrets,
    ).toEqual(["ORG"]);
  });
});

// ── Remembered agent settings ───────────────────────────────────────────────

import { applyWorkDefaults, sameOptions, savedOptionsFor } from "./model";

suite("remembered agent settings", () => {
  const blank = normalize(PRESETS[0].apply(EMPTY_DRAFT));
  const defaults = {
    runtime: "codex",
    agentOptions: {
      codex: { copilotModel: "gpt-5.5", copilotEffort: "high" },
      "claude-code": { claudeModel: "opus", claudeEffort: "max" },
    },
  };

  it("applies the saved runtime and its options to a blank form", () => {
    const d = applyWorkDefaults(blank, defaults, []);
    expect(d.runtime).toBe("codex");
    expect(d.agentOptions).toEqual({ copilotModel: "gpt-5.5", copilotEffort: "high" });
  });

  it("keeps the form's runtime when the saved one can't run here", () => {
    const onMachine = normalize(PRESETS[1].apply(EMPTY_DRAFT));
    const d = applyWorkDefaults(onMachine, { ...defaults, runtime: "no-such-agent" }, []);
    expect(d.runtime).toBe(onMachine.runtime);
    expect(d.agentOptions).toEqual({ claudeModel: "opus", claudeEffort: "max" });
  });

  it("never applies to a terminal and is a no-op without defaults", () => {
    const term = normalize(PRESETS[2].apply(EMPTY_DRAFT));
    expect(applyWorkDefaults(term, defaults, [])).toBe(term);
    expect(applyWorkDefaults(blank, null, [])).toBe(blank);
    expect(applyWorkDefaults(blank, {}, [])).toEqual(blank);
  });

  it("drops a provider that's gone, someone else's, or doesn't serve the runtime — with its model", () => {
    const withP = (id: string) => ({
      agentOptions: {
        "claude-code": { modelProvider: id, claudeModel: "us.anthropic.x", claudeEffort: "high" },
      },
    });
    for (const id of ["p-gone", theirP.id]) {
      expect(savedOptionsFor(withP(id), "claude-code", [orgP, theirP])).toEqual({
        claudeEffort: "high",
      });
    }
    const codexOnly = provider({ id: "p-codex", agents: ["codex"] });
    expect(savedOptionsFor(withP("p-codex"), "claude-code", [codexOnly])).toEqual({
      claudeEffort: "high",
    });
    expect(savedOptionsFor(withP(orgP.id), "claude-code", [orgP])).toEqual({
      modelProvider: orgP.id,
      claudeModel: "us.anthropic.x",
      claudeEffort: "high",
    });
  });

  it("makes the work yours when the saved provider is personal", () => {
    const d = applyWorkDefaults(
      blank,
      { runtime: "claude-code", agentOptions: { "claude-code": { modelProvider: myP.id } } },
      [myP],
    );
    expect(d.agentOptions).toEqual({ modelProvider: myP.id });
    expect(d.owner).toBe("me");
  });

  it("keeps free-text models and compares options ignoring blanks", () => {
    expect(
      savedOptionsFor({ agentOptions: { codex: { copilotModel: "my-model" } } }, "codex", []),
    ).toEqual({ copilotModel: "my-model" });
    expect(sameOptions({ a: "1", b: "" }, { a: "1" })).toBe(true);
    expect(sameOptions({ a: "1" }, { a: "2" })).toBe(false);
  });
});

import { applyPreset } from "./model";

suite("example chips keep remembered settings", () => {
  const defaults = {
    runtime: "claude-code",
    agentOptions: { "claude-code": { claudeModel: "claude-sonnet-4-6", claudeEffort: "high" } },
  };
  const start = normalize(PRESETS[0].apply(EMPTY_DRAFT));
  const chip = (id: string) => PRESETS.find((p) => p.id === id)!;

  it("a chip that leaves options blank starts from the saved ones", () => {
    const d = applyPreset(start, chip("pr"), defaults, []);
    expect(d.agentOptions).toEqual({ claudeModel: "claude-sonnet-4-6", claudeEffort: "high" });
    expect(applyPreset(start, chip("chat"), defaults, []).agentOptions).toEqual(
      defaults.agentOptions["claude-code"],
    );
  });

  it("keeps a chip's own options, skips a terminal, and respects touched runtimes", () => {
    const own = {
      ...chip("pr"),
      apply: (x: WorkDraft) => ({ ...x, agentOptions: { claudeEffort: "low" } }),
    };
    expect(applyPreset(start, own, defaults, []).agentOptions).toEqual({ claudeEffort: "low" });
    expect(applyPreset(start, chip("terminal"), defaults, []).agentOptions).toEqual({});
    expect(
      applyPreset(start, chip("pr"), defaults, [], new Set(["claude-code"])).agentOptions,
    ).toEqual({});
    expect(applyPreset(start, chip("pr"), null, []).agentOptions).toEqual({});
  });
});
