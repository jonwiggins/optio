import { describe as suite, it, expect, suite } from "vitest";
import {
  EMPTY_DRAFT,
  entryOn,
  withEntry,
  PERSONAL_EVENT_KINDS,
  PRESETS,
  TERMINAL,
  TRIGGER_PARAMS,
  WHEN_TYPES,
  describe,
  deriveKind,
  eventGaps,
  followThrough,
  isEventWhen,
  missingFields,
  normalize,
  optionsFromRepo,
  overrideOn,
  runtimeOptions,
  settingsChanges,
  slugify,
  thenOptions,
  toggleOverride,
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
    for (const when of WHEN_TYPES) {
      expect(enabled(whereOptions({ ...EMPTY_DRAFT, when }))).toEqual(["cluster", "local"]);
    }
    expect(normalize({ ...EMPTY_DRAFT, when: "linear" }).location.runTarget).toBe("cluster");
  });

  it("a machine offers a terminal and only the CLIs the daemon can launch", () => {
    const opts = runtimeOptions(local({ ...EMPTY_DRAFT, withRepo: false }));
    expect(enabled(opts)).toContain(TERMINAL);
    expect(enabled(opts)).not.toContain("copilot");
    expect(normalize(local({ ...EMPTY_DRAFT, runtime: "copilot" })).runtime).toBe("claude-code");
  });

  it("a terminal is a shell you open, or a command that runs and exits — whatever starts it", () => {
    // In a pod: a session in a repo, or a command with no checkout.
    expect(enabled(runtimeOptions(EMPTY_DRAFT))).toContain(TERMINAL);
    expect(enabled(runtimeOptions({ ...EMPTY_DRAFT, withRepo: false }))).toContain(TERMINAL);
    expect(
      enabled(runtimeOptions({ ...EMPTY_DRAFT, withRepo: false, when: "schedule" })),
    ).toContain(TERMINAL);
    // A trigger can't open a pod session, and a command has no checkout to
    // work in: in a repo pod a trigger starts an agent.
    const repoPodTerminal = runtimeOptions({ ...EMPTY_DRAFT, when: "schedule" }).find(
      (r) => r.value === TERMINAL,
    );
    expect(repoPodTerminal?.disabled).toMatch(/pick No repo/);
    // On a machine every trigger can start one.
    for (const when of ["schedule", "slack", "github"] as const) {
      expect(enabled(runtimeOptions(local({ ...EMPTY_DRAFT, when })))).toContain(TERMINAL);
    }
  });

  it("a terminal that exits runs a command (a Job); one that waits is a shell", () => {
    const command = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      runtime: TERMINAL,
      then: "exits",
    });
    expect(command.runtime).toBe(TERMINAL);
    expect(deriveKind(command)).toBe("standalone");
    expect(missingFields(command)).toEqual(["prompt"]);
    expect(missingFields({ ...command, prompt: "./nightly.sh" })).toEqual([]);
    expect(text({ ...command, prompt: "./nightly.sh" })).toBe(
      "Started now, a command in an Optio pod that runs and exits.",
    );

    const onMachine = normalize(
      local({
        ...EMPTY_DRAFT,
        withRepo: false,
        runtime: TERMINAL,
        when: "schedule",
        trigger: { type: "schedule", cronExpression: "0 9 * * *" },
      }),
    );
    expect(enabled(thenOptions(onMachine))).toEqual(["exits", "waits-for-me"]);
    // A shell that opens on a schedule needs nothing to run.
    const shell = normalize({ ...onMachine, then: "waits-for-me" });
    expect(deriveKind(shell)).toBe("local-blueprint");
    expect(missingFields(shell)).toEqual([]);
    expect(shell.location.localSessionMode).toBe("interactive");

    // A command never works on a branch: that's an agent's job.
    const onBranch = thenOptions(local({ ...EMPTY_DRAFT, runtime: TERMINAL }));
    expect(onBranch.find((t) => t.value === "exits")?.disabled).toMatch(/Current directory/);
  });

  it("a persistent agent lives in a pod, with a repo or without one", () => {
    expect(enabled(thenOptions(local(EMPTY_DRAFT)))).not.toContain("waits-for-messages");
    expect(enabled(thenOptions(EMPTY_DRAFT))).toContain("waits-for-messages");
    expect(enabled(thenOptions({ ...EMPTY_DRAFT, withRepo: false }))).toContain(
      "waits-for-messages",
    );
    const withRepo = normalize({
      ...EMPTY_DRAFT,
      repoUrl: "https://github.com/acme/app",
      then: "waits-for-messages",
    });
    expect(deriveKind(withRepo)).toBe("persistent-agent");
    expect(text(withRepo, { repoName: "acme/app" })).toBe(
      "Woken by messages, a Claude Code agent in an Optio pod with acme/app that keeps its memory between turns.",
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
    // PagerDuty picks kinds like GitHub but is never "about you"; Pylon's kinds are optional.
    expect(eventGaps({ type: "pagerduty", config: { events: [] } })).toEqual(["events"]);
    expect(eventGaps({ type: "pagerduty", config: { events: ["incident.triggered"] } })).toEqual(
      [],
    );
    expect(eventGaps({ type: "pylon", config: {} })).toEqual([]);
    expect(eventGaps({ type: "pylon", config: { events: ["issue.created"] } })).toEqual([]);
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
    expect(TRIGGER_PARAMS.pagerduty).toEqual(
      expect.arrayContaining(["incidentId", "urgency", "service", "ticketUrl"]),
    );
    expect(TRIGGER_PARAMS.pylon).toEqual(
      expect.arrayContaining(["issueId", "account", "requester", "payload"]),
    );
  });

  it("every event When is listed after the generic four, in the shared order", () => {
    expect(WHEN_TYPES).toEqual([
      "manual",
      "schedule",
      "webhook",
      "ticket",
      "github",
      "gitlab",
      "slack",
      "linear",
      "jira",
      "pylon",
      "pagerduty",
      "sentry",
      "alertmanager",
      "datadog",
    ]);
    for (const w of WHEN_TYPES.slice(4)) expect(isEventWhen(w)).toBe(true);
    for (const w of WHEN_TYPES.slice(0, 4)) expect(isEventWhen(w)).toBe(false);
  });

  it("GitLab and Jira are about you like GitHub and Linear; the alert sources never are", () => {
    expect(PERSONAL_EVENT_KINDS.gitlab).toEqual(["review_requested", "mentioned", "assigned"]);
    expect(PERSONAL_EVENT_KINDS.jira).toEqual(["assigned", "mentioned"]);
    expect(PERSONAL_EVENT_KINDS.sentry).toEqual([]);
    expect(PERSONAL_EVENT_KINDS.alertmanager).toEqual([]);
    expect(PERSONAL_EVENT_KINDS.datadog).toEqual([]);
    // The identity key is per source: a GitLab username, a Jira user.
    expect(
      eventGaps({ type: "gitlab", config: { events: ["review_requested"], username: "" } }),
    ).toEqual(["identity"]);
    expect(
      eventGaps({ type: "gitlab", config: { events: ["review_requested"], username: "ada" } }),
    ).toEqual([]);
    expect(eventGaps({ type: "gitlab", config: { events: ["push"], branches: ["main"] } })).toEqual(
      [],
    );
    expect(eventGaps({ type: "jira", config: { events: ["assigned"], user: "" } })).toEqual([
      "identity",
    ]);
    expect(eventGaps({ type: "jira", config: { events: ["created"] } })).toEqual([]);
    // GitHub's new repo-wide kinds need no login.
    expect(
      eventGaps({ type: "github", config: { events: ["workflow_failed"], branches: ["main"] } }),
    ).toEqual([]);
    for (const type of ["sentry", "alertmanager", "datadog"] as const) {
      expect(eventGaps({ type, config: { events: [] } })).toEqual(["events"]);
    }
    expect(eventGaps({ type: "sentry", config: { events: ["issue_created"] } })).toEqual([]);
    expect(eventGaps({ type: "alertmanager", config: { events: ["firing"] } })).toEqual([]);
    expect(eventGaps({ type: "datadog", config: { events: ["triggered"] } })).toEqual([]);
    // Each has its own sentence and params.
    const sentence = (when: WhenType, config: Record<string, unknown>) =>
      text(
        normalize({
          ...EMPTY_DRAFT,
          when,
          withRepo: false,
          prompt: "p",
          event: { type: when as "gitlab", config },
        }),
      );
    expect(sentence("gitlab", { events: ["push"] })).toContain("Started by GitLab events,");
    expect(sentence("jira", { events: ["created"] })).toContain("Started by Jira events,");
    expect(sentence("sentry", { events: ["issue_created"] })).toContain(
      "Started by Sentry alerts,",
    );
    expect(sentence("alertmanager", { events: ["firing"] })).toContain(
      "Started by Alertmanager alerts,",
    );
    expect(sentence("datadog", { events: ["triggered"] })).toContain(
      "Started by Datadog monitors,",
    );
    expect(sentence("jira", { events: ["assigned"], user: "" })).toContain("[about you]");
    expect(TRIGGER_PARAMS.github).toEqual(
      expect.arrayContaining(["workflow", "conclusion", "compareUrl", "tag", "labels"]),
    );
    expect(TRIGGER_PARAMS.gitlab).toEqual(
      expect.arrayContaining(["project", "iid", "pipelineStatus", "sourceBranch"]),
    );
    expect(TRIGGER_PARAMS.jira).toEqual(
      expect.arrayContaining(["key", "previousStatus", "issueType", "ticketUrl"]),
    );
    expect(TRIGGER_PARAMS.sentry).toEqual(
      expect.arrayContaining(["shortId", "culprit", "alertRule", "ticketUrl"]),
    );
    expect(TRIGGER_PARAMS.alertmanager).toEqual(
      expect.arrayContaining(["alertnames", "severities", "alerts", "payload"]),
    );
    expect(TRIGGER_PARAMS.datadog).toEqual(
      expect.arrayContaining(["transition", "priority", "tags", "link", "payload"]),
    );
  });

  it("PagerDuty and Pylon are event Whens with their own sentence", () => {
    expect(isEventWhen("pagerduty")).toBe(true);
    expect(isEventWhen("pylon")).toBe(true);
    expect(PERSONAL_EVENT_KINDS.pagerduty).toEqual([]);
    expect(PERSONAL_EVENT_KINDS.pylon).toEqual([]);
    const pd = normalize({
      ...EMPTY_DRAFT,
      when: "pagerduty",
      prompt: "p",
      event: { type: "pagerduty", config: { events: ["incident.triggered"], urgency: "high" } },
    });
    expect(text(pd)).toContain("Started by PagerDuty incidents,");
    const noKinds = { ...pd, event: { type: "pagerduty" as const, config: { events: [] } } };
    expect(text(noKinds)).toContain("[of some kind]");
    expect(missingFields(noKinds)).toContain("events");
    const py = normalize({
      ...EMPTY_DRAFT,
      when: "pylon",
      withRepo: false,
      prompt: "p",
      event: { type: "pylon", config: { events: [] } },
    });
    expect(text(py)).toContain("Started by Pylon events,");
    expect(missingFields(py)).toEqual([]);
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

import type { AgentCredential, ModelProvider, PickableSecret } from "@optio/shared";
import {
  addableSecrets,
  credentialIdOf,
  effectiveOwner,
  isPersonalOnlySecret,
  isPodWork,
  pickedCredential,
  pickedProvider,
  providerDisabled,
  providerModelsFor,
  signInValue,
  usableCredentials,
  usableProviders,
  withCredential,
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
    // A command Job in a pod takes them too; a terminal you open doesn't.
    expect(isPodWork({ ...job, runtime: "" })).toBe(true);
    expect(isPodWork({ ...job, runtime: "", then: "waits-for-me" })).toBe(false);
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
  const blank = normalize(PRESETS.find((p) => p.id === "pr")!.apply(EMPTY_DRAFT));
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
    const onMachine = normalize(PRESETS.find((p) => p.id === "chat")!.apply(EMPTY_DRAFT));
    const d = applyWorkDefaults(onMachine, { ...defaults, runtime: "no-such-agent" }, []);
    expect(d.runtime).toBe(onMachine.runtime);
    expect(d.agentOptions).toEqual({ claudeModel: "opus", claudeEffort: "max" });
  });

  it("never applies to a terminal and is a no-op without defaults", () => {
    const term = normalize(PRESETS.find((p) => p.id === "terminal")!.apply(EMPTY_DRAFT));
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

  it("opens on your machine and directory when the work ran there last and it is still paired", () => {
    const onMachine = {
      ...defaults,
      runtime: "claude-code",
      location: { runTarget: "local" as const, localHostId: "h1", localDir: "/Users/dev/app" },
    };
    const d = applyWorkDefaults(blank, onMachine, [], [{ id: "h1" }]);
    expect(d.location.runTarget).toBe("local");
    expect(d.location.localHostId).toBe("h1");
    expect(d.location.localDir).toBe("/Users/dev/app");
    expect(d.withRepo).toBe(false);
    expect(d.runtime).toBe("claude-code");
    expect(d.agentOptions).toEqual({ claudeModel: "opus", claudeEffort: "max" });
  });

  it("stays in a pod when the remembered machine is gone, or the work ran in a pod", () => {
    const onMachine = { ...defaults, location: { runTarget: "local" as const, localHostId: "h1" } };
    expect(applyWorkDefaults(blank, onMachine, [], [{ id: "other" }]).location.runTarget).toBe(
      "cluster",
    );
    expect(applyWorkDefaults(blank, onMachine, []).location.runTarget).toBe("cluster");
    const inPod = { ...defaults, location: { runTarget: "cluster" as const } };
    expect(applyWorkDefaults(blank, inPod, [], [{ id: "h1" }]).location.runTarget).toBe("cluster");
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
  const start = normalize(PRESETS.find((p) => p.id === "pr")!.apply(EMPTY_DRAFT));
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

suite("Work until merged — PR follow-through", () => {
  const base = { ...EMPTY_DRAFT, prompt: "p", repoUrl: "https://github.com/a/b" };

  it("is offered for an agent with a repo, in a pod or on a new branch on a machine", () => {
    expect(enabled(thenOptions(base))).toContain("until-merged");
    expect(enabled(thenOptions(local(base)))).toContain("until-merged");
    expect(enabled(thenOptions({ ...base, withRepo: false }))).not.toContain("until-merged");
    expect(enabled(thenOptions(local({ ...base, withRepo: false })))).not.toContain("until-merged");
    expect(enabled(thenOptions({ ...base, runtime: TERMINAL }))).not.toContain("until-merged");
  });

  it("is still a Task (or a scheduled Task), headless", () => {
    const d = normalize({ ...base, then: "until-merged" });
    expect(d.then).toBe("until-merged");
    expect(deriveKind(d)).toBe("repo-task");
    expect(deriveKind({ ...d, when: "ticket", trigger: { type: "ticket" } })).toBe(
      "repo-blueprint",
    );
    expect(normalize(local(d)).location.localSessionMode).toBe("headless");
  });

  it("snaps back to Exit when done once the repo goes away", () => {
    expect(normalize({ ...base, then: "until-merged", withRepo: false }).then).toBe("exits");
  });

  it("reads as a sentence", () => {
    expect(text({ ...base, then: "until-merged" })).toBe(
      "Started now, a Claude Code run in an Optio pod with https://github.com/a/b that opens a PR and keeps working on it until it merges.",
    );
    expect(text({ ...base, then: "until-merged", mergeWhenReady: false })).toMatch(
      /keeps it green until you merge it\.$/,
    );
  });

  it("the Assign to Optio preset is a ticket-labeled scheduled Task worked until merged", () => {
    const preset = PRESETS.find((p) => p.id === "assign")!;
    const d = normalize(preset.apply(EMPTY_DRAFT));
    expect(d.when).toBe("ticket");
    expect(d.trigger.ticketLabels).toEqual(["optio"]);
    expect(d.then).toBe("until-merged");
    expect(deriveKind(d)).toBe("repo-blueprint");
  });

  const on = (plan: ReturnType<typeof followThrough>) =>
    plan!.steps.filter((s) => s.on).map((s) => s.key);

  it("Exit when done shows the repo's settings", () => {
    const plan = followThrough(base, { autoResume: false, autoMerge: false });
    expect(plan!.fromRepo).toBe(true);
    expect(on(plan)).toEqual(["pr", "done"]);
    expect(
      on(
        followThrough(base, {
          autoResume: true,
          autoMerge: true,
          reviewEnabled: true,
          reviewTrigger: "on_ci_pass",
        }),
      ),
    ).toEqual(["pr", "review", "ci", "changes", "merge", "done"]);
  });

  it("Work until merged resumes and merges whatever the repo says", () => {
    const d = { ...base, then: "until-merged" as const };
    const plan = followThrough(d, { autoResume: false, autoMerge: false, maxAutoResumes: 4 });
    expect(plan!.fromRepo).toBe(false);
    expect(on(plan)).toEqual(["pr", "ci", "changes", "merge", "done"]);
    expect(plan!.steps.find((s) => s.key === "ci")!.detail).toMatch(/up to 4 times/);
    expect(on(followThrough({ ...d, mergeWhenReady: false }, null))).toEqual([
      "pr",
      "ci",
      "changes",
      "done",
    ]);
  });

  it("cautious mode holds the merge back and says why", () => {
    const plan = followThrough({ ...base, then: "until-merged" }, { cautiousMode: true });
    const merge = plan!.steps.find((s) => s.key === "merge")!;
    expect(merge.on).toBe(false);
    expect(merge.detail).toMatch(/cautious mode/);
    expect(plan!.steps[0].label).toBe("Opens a draft PR");
  });

  it("only work that opens a PR has a plan", () => {
    expect(followThrough({ ...base, withRepo: false }, null)).toBeNull();
    expect(followThrough({ ...base, then: "waits-for-me" }, null)).toBeNull();
  });

  it("the work can be more careful than its repo, never less", () => {
    const repo = { autoResume: true, reviewEnabled: false, cautiousMode: true, maxAutoResumes: 9 };
    const plan = followThrough(
      {
        ...base,
        settings: {
          review: { enabled: true, trigger: "on_pr" },
          cautiousMode: false,
          maxAutoResumes: 2,
        },
      },
      repo,
    );
    expect(on(plan)).toContain("review");
    expect(plan!.steps.find((s) => s.key === "review")!.detail).toMatch(/as soon as the PR opens/i);
    // The repo opens drafts; the work can't turn that off.
    expect(plan!.steps[0].label).toBe("Opens a draft PR");
    expect(plan!.steps.find((s) => s.key === "ci")!.detail).toMatch(/up to 2 times/);

    const loosened = followThrough(
      { ...base, settings: { review: { enabled: false }, maxAutoResumes: 50 } },
      { autoResume: true, reviewEnabled: true, reviewTrigger: "on_pr", maxAutoResumes: 4 },
    );
    expect(on(loosened)).toContain("review");
    expect(loosened!.steps.find((s) => s.key === "ci")!.detail).toMatch(/up to 4 times/);
  });
});

suite("environment overrides — only the changes from the defaults", () => {
  it("a default item is on until taken out; another is off until added", () => {
    expect(overrideOn(undefined, "a", true)).toBe(true);
    expect(overrideOn({ remove: ["a"] }, "a", true)).toBe(false);
    expect(overrideOn(undefined, "b", false)).toBe(false);
    expect(overrideOn({ add: ["b"] }, "b", false)).toBe(true);
  });

  it("toggling back to the default leaves no override", () => {
    const off = toggleOverride(undefined, "a", true, false);
    expect(off).toEqual({ remove: ["a"] });
    expect(toggleOverride(off, "a", true, true)).toEqual({});
    const added = toggleOverride(undefined, "b", false, true);
    expect(added).toEqual({ add: ["b"] });
    expect(toggleOverride(added, "b", false, false)).toEqual({});
  });

  it("counts what the work changes", () => {
    const settings = {
      mcpServers: toggleOverride(undefined, "m", true, false),
      connections: toggleOverride(undefined, "c", false, true),
    };
    expect(settings).toEqual({ mcpServers: { remove: ["m"] }, connections: { add: ["c"] } });
    // A blank setup command and "ready PRs" change nothing.
    expect(settingsChanges({ ...settings, setupCommands: " ", cautiousMode: false })).toBe(2);
    expect(settingsChanges({ ...settings, cautiousMode: true, review: { enabled: true } })).toBe(4);
  });
});

import {
  matchesRepoDefaults,
  resetToRepoDefaults,
  startingOptions,
  startWith,
  withRepoDefaults,
} from "./model";

suite("repo defaults vs your last settings — the precedence", () => {
  const factory = {
    defaultAgentType: "claude-code",
    claudeModel: "opus",
    claudeContextWindow: "1m",
    claudeThinking: true,
    claudeEffort: "high",
    geminiModel: "gemini-2.5-pro",
    geminiApprovalMode: "yolo",
  };
  const configured = { ...factory, claudeModel: "sonnet", claudeEffort: "max" };
  const saved = { claudeModel: "haiku" };
  const pod = { ...EMPTY_DRAFT, repoId: "r1" };

  it("a repo with settings of its own wins for pod work with that repo", () => {
    const s = startingOptions(pod, "claude-code", configured, saved);
    expect(s.from).toBe("repo");
    expect(s.options).toMatchObject({ claudeModel: "sonnet", claudeEffort: "max" });
  });

  it("your last settings win over a repo nobody configured", () => {
    expect(startingOptions(pod, "claude-code", factory, saved)).toEqual({
      options: saved,
      from: "saved",
    });
  });

  it("with nothing saved, a repo's column defaults still seed the picker", () => {
    expect(startingOptions(pod, "claude-code", factory, null).from).toBe("repo");
  });

  it("remembered settings apply off a repo (no repo, or on your machine)", () => {
    expect(
      startingOptions({ ...pod, withRepo: false }, "claude-code", configured, saved).from,
    ).toBe("saved");
    expect(startingOptions(local(pod), "claude-code", configured, saved).from).toBe("saved");
    expect(startingOptions(local(pod), "claude-code", configured, null).from).toBe("none");
  });

  it("startWith switches runtime and starts its parameters by the same rule", () => {
    const d = startWith(pod, "gemini", { ...factory, geminiModel: "gemini-2.5-flash" }, null, []);
    expect(d.runtime).toBe("gemini");
    expect(d.agentOptions).toMatchObject({ geminiModel: "gemini-2.5-flash" });
  });

  it("picking a configured repo takes its default agent and parameters", () => {
    const repo = { ...factory, defaultAgentType: "gemini", geminiModel: "gemini-2.5-flash" };
    const d = withRepoDefaults({ ...pod, agentOptions: saved }, repo);
    expect(d.runtime).toBe("gemini");
    expect(d.agentOptions).toMatchObject({ geminiModel: "gemini-2.5-flash" });
    // A repo nobody configured leaves your settings standing.
    const kept = { ...pod, agentOptions: saved };
    expect(withRepoDefaults(kept, factory)).toBe(kept);
    // Off a repo nothing changes.
    const off = { ...pod, withRepo: false, agentOptions: saved };
    expect(withRepoDefaults(off, repo)).toBe(off);
  });

  it("knows whether the draft still matches the repo, and resets to it", () => {
    const d = withRepoDefaults(pod, configured);
    expect(matchesRepoDefaults(d, configured)).toBe(true);
    const changed = { ...d, agentOptions: { ...d.agentOptions, claudeEffort: "low" } };
    expect(matchesRepoDefaults(changed, configured)).toBe(false);
    expect(matchesRepoDefaults({ ...d, runtime: "gemini" }, configured)).toBe(false);
    const back = resetToRepoDefaults({ ...changed, runtime: "gemini" }, configured);
    expect(back.runtime).toBe("claude-code");
    expect(matchesRepoDefaults(back, configured)).toBe(true);
  });
});

suite("connected to", () => {
  const base = { ...EMPTY_DRAFT, owner: "workspace" as const };
  const conn = {
    kind: "connection" as const,
    id: "c1",
    name: "Acme AWS",
    parts: ["env" as const],
    enabled: true,
    scope: "assigned",
    default: true,
    ownerUserId: null,
  };
  const mine = {
    kind: "secret" as const,
    id: "MY_KEY",
    name: "MY_KEY",
    parts: ["credentials" as const],
    enabled: true,
    scope: "private",
    default: false,
    ownerUserId: "jon",
  };

  it("reads an entry's state from the right setting", () => {
    expect(entryOn(base, conn)).toBe(true);
    expect(entryOn({ ...base, settings: { connections: { remove: ["c1"] } } }, conn)).toBe(false);
    expect(entryOn(base, mine)).toBe(false);
    expect(entryOn({ ...base, podSecrets: ["MY_KEY"] }, mine)).toBe(true);
  });

  it("turns a default connection off as an override, and back on", () => {
    const off = withEntry(base, conn, false);
    expect(off.draft.settings).toEqual({ connections: { remove: ["c1"] } });
    expect(off.note).toBeNull();
    const on = withEntry(off.draft, conn, true);
    expect(entryOn(on.draft, conn)).toBe(true);
    expect(on.draft.settings.connections?.remove ?? []).toEqual([]);
  });

  it("adds a private secret to the pod secrets and flips the owner, saying so", () => {
    const { draft, note } = withEntry(base, mine, true);
    expect(draft.podSecrets).toEqual(["MY_KEY"]);
    expect(draft.owner).toBe("me");
    expect(note).toMatch(/runs as you/);
    const { draft: gone, note: none } = withEntry(draft, mine, false);
    expect(gone.podSecrets).toEqual([]);
    expect(none).toBeNull();
  });
});

suite("agent credentials in the draft (the Signed in with row)", () => {
  const job = normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi" });
  const cred = (over: Partial<AgentCredential> = {}): AgentCredential => ({
    id: "secret:11111111-1111-4111-8111-111111111111",
    kind: "secret",
    method: "api-key",
    label: "Anthropic API key",
    secretName: "ANTHROPIC_API_KEY",
    owner: "workspace",
    default: true,
    ...over,
  });
  const orgKey = cred();
  const myToken = cred({
    id: "secret:22222222-2222-4222-8222-222222222222",
    method: "oauth-token",
    label: "Claude subscription (OAuth token)",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    owner: "me",
    default: false,
  });
  const orgBedrock = cred({
    id: "provider:p-org",
    kind: "provider",
    method: "bedrock",
    label: "Amazon Bedrock · Bedrock",
    secretName: null,
    providerId: "p-org",
    default: false,
  });
  const myBedrock = cred({
    id: "provider:p-me",
    kind: "provider",
    method: "bedrock",
    label: "Amazon Bedrock · My Bedrock",
    secretName: null,
    providerId: "p-me",
    owner: "me",
    default: false,
  });

  it("offers secrets and the usable providers; on a machine only providers; a terminal nothing", () => {
    const all = [
      orgKey,
      myToken,
      orgBedrock,
      myBedrock,
      cred({ id: "provider:p-them", kind: "provider", providerId: "p-them" }),
    ];
    expect(usableCredentials(job, all, [orgP, myP, theirP]).map((c) => c.id)).toEqual([
      orgKey.id,
      myToken.id,
      orgBedrock.id,
      myBedrock.id,
    ]);
    const local = normalize({
      ...job,
      location: { ...job.location, runTarget: "local", localHostId: "h1", localDir: "/w" },
    });
    expect(usableCredentials(local, all, [orgP, myP]).map((c) => c.id)).toEqual([
      orgBedrock.id,
      myBedrock.id,
    ]);
    expect(usableCredentials({ ...job, runtime: TERMINAL }, all, [orgP])).toEqual([]);
  });

  it("a secret pick sets `credential`, drops a provider and its model, and reads back", () => {
    const viaProvider = withProvider(job, orgP);
    const picked = withCredential(viaProvider, orgKey, [orgP]);
    expect(picked.agentOptions.credential).toBe(orgKey.id);
    expect(picked.agentOptions.modelProvider).toBeUndefined();
    expect(picked.agentOptions.claudeModel).toBeUndefined();
    expect(pickedCredential(picked, [orgKey, myToken])).toBe(orgKey);
    expect(signInValue(picked)).toBe(orgKey.id);
    expect(credentialIdOf(picked.agentOptions)).toBe(orgKey.id);
    expect(picked.owner).toBe("workspace");
  });

  it("a provider credential is the provider pick, and Default clears both", () => {
    const picked = withCredential(withCredential(job, orgKey, [orgP]), orgBedrock, [orgP]);
    expect(picked.agentOptions.modelProvider).toBe("p-org");
    expect(picked.agentOptions.credential).toBeUndefined();
    expect(picked.agentOptions.claudeModel).toBe("us.anthropic.claude-opus-5-5");
    expect(signInValue(picked)).toBe("provider:p-org");
    const back = withCredential(picked, null, [orgP]);
    expect(back.agentOptions.modelProvider).toBeUndefined();
    expect(back.agentOptions.credential).toBeUndefined();
    expect(signInValue(back)).toBeNull();
  });

  it("one of yours makes the work yours; handing it to the organization drops it", () => {
    const mine = withCredential(job, myToken, [orgP, myP]);
    expect(mine.owner).toBe("me");
    const org = withOwner(mine, "workspace", [orgP, myP], [], [orgKey, myToken]);
    expect(org.owner).toBe("workspace");
    expect(org.agentOptions.credential).toBeUndefined();
    // An organization credential survives the switch.
    const kept = withOwner(withCredential(job, orgKey, [orgP]), "workspace", [orgP], [], [orgKey]);
    expect(kept.agentOptions.credential).toBe(orgKey.id);
  });

  it("ignores a value that is not a secret credential", () => {
    expect(credentialIdOf({ credential: "provider:p-org" })).toBeNull();
    expect(credentialIdOf({ credential: "nonsense" })).toBeNull();
    expect(
      pickedCredential({ ...job, agentOptions: { credential: orgKey.id } }, [myToken]),
    ).toBeUndefined();
  });
});
