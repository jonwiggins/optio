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
  runtimeOptions,
  slugify,
  thenOptions,
  whereOptions,
  type SessionDraft,
} from "./model";

const local = (d: SessionDraft, dir = "/Users/dev/repos/app"): SessionDraft => ({
  ...d,
  location: { ...d.location, runTarget: "local", localHostId: "h1", localDir: dir },
});
const text = (d: SessionDraft, ctx?: Parameters<typeof describe>[1]) =>
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

  it("exits + machine + event trigger is a Local automation", () => {
    expect(deriveKind(local({ ...base, when: "github" }))).toBe("local-blueprint");
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
  it("an event trigger runs on your machine", () => {
    expect(enabled(whereOptions({ ...EMPTY_DRAFT, when: "github" }))).toEqual(["local"]);
    expect(normalize({ ...EMPTY_DRAFT, when: "linear" }).location.runTarget).toBe("local");
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
      "Started now, a Claude Code session in an Optio pod with acme/app that opens a PR and exits when done.",
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
      "Running weekdays at 09:00 UTC, a Claude Code session in an Optio pod that exits when done.",
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
