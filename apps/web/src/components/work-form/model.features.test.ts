import { featuresFromEnv } from "@optio/shared/features";
import type { PickableSecret } from "@optio/shared";
import { describe as suite, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  PRESETS,
  TERMINAL,
  WHEN_TYPES,
  describe,
  draftForFeatures,
  effectiveOwner,
  followThrough,
  missingFields,
  normalize,
  remoteWorkspaceDisabled,
  thenOptions,
  whenTypesFor,
  withMergeConfirmation,
  withOwner,
  withSecret,
  type WorkDraft,
} from "./model";

const text = (d: WorkDraft, ctx?: Parameters<typeof describe>[1]) =>
  describe(d, ctx)
    .map((p) => ("missing" in p ? `[${p.missing}]` : p.text))
    .reduce((acc, t) => (/^[,.]/.test(t) ? acc + t : acc ? `${acc} ${t}` : t), "");
const enabled = <T>(choices: Array<{ value: T; disabled?: string }>) =>
  choices.filter((c) => !c.disabled).map((c) => c.value);

suite("a team's work", () => {
  const job = normalize({ ...EMPTY_DRAFT, withRepo: false, prompt: "hi" });
  const pickable: PickableSecret[] = [
    { name: "SHARED", owner: "workspace" },
    { name: "SHARED", owner: "me" },
    { name: "MINE", owner: "me" },
    { name: "ORG", owner: "workspace" },
  ];

  it("a team's work is the team's in a pod, and drops what only I have, like the org's", () => {
    const TEAM = "team:11111111-2222-4333-8444-555555555555" as const;
    const mine = withSecret(withSecret(job, { name: "ORG", owner: "workspace" }), {
      name: "MINE",
      owner: "me",
    });
    const teams = withOwner(mine, TEAM, [], pickable);
    expect(teams.owner).toBe(TEAM);
    expect(teams.podSecrets).toEqual(["ORG"]);
    expect(effectiveOwner(teams)).toBe(TEAM);
    // On a machine it is still mine.
    const local = normalize({ ...teams, location: { ...teams.location, runTarget: "local" } });
    expect(effectiveOwner(local)).toBe("me");
    // A private secret picked later makes it mine again.
    expect(withSecret(teams, { name: "MINE", owner: "me" }).owner).toBe("me");
  });
});

suite("Work until merged under the automatic-merge confirmation", () => {
  const base = { ...EMPTY_DRAFT, prompt: "p", repoUrl: "https://github.com/a/b" };
  const on = (plan: ReturnType<typeof followThrough>) =>
    plan!.steps.filter((s) => s.on).map((s) => s.key);
  const repo = {
    autoResume: true,
    autoMerge: true,
    reviewEnabled: true,
    reviewTrigger: "on_ci_pass" as const,
  };

  it("leaves the draft alone without the confirmation (the default)", () => {
    const d = normalize(PRESETS.find((p) => p.id === "assign")!.apply(EMPTY_DRAFT));
    expect(d.mergeWhenReady).toBe(true);
    expect(withMergeConfirmation(d, false)).toBe(d);
    expect(on(followThrough(base, repo))).toEqual([
      "pr",
      "review",
      "ci",
      "changes",
      "merge",
      "done",
    ]);
  });

  it("with the confirmation on, merges nothing until someone confirms it", () => {
    const d = normalize({ ...base, then: "until-merged" });
    const off = withMergeConfirmation(d, true);
    expect(off.mergeWhenReady).toBe(false);
    expect(text(off)).toMatch(/keeps it green until you merge it\.$/);
    // Confirmed in this edit (the dialog), or when the saved work was confirmed.
    const now = { ...d, autoMergeConfirmed: true };
    expect(withMergeConfirmation(now, true)).toBe(now);
    const saved = { ...d, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" };
    expect(withMergeConfirmation(saved, true)).toBe(saved);
    // Off stays off.
    const manual = { ...d, mergeWhenReady: false };
    expect(withMergeConfirmation(manual, true)).toBe(manual);
  });

  it("with the confirmation on, a repo's auto-merge nobody confirmed merges nothing", () => {
    expect(on(followThrough(base, repo, true))).toEqual(["pr", "review", "ci", "changes", "done"]);
    expect(
      on(followThrough(base, { ...repo, autoMergeConfirmedAt: "2026-10-01T00:00:00Z" }, true)),
    ).toEqual(["pr", "review", "ci", "changes", "merge", "done"]);
  });
});

suite("A remote workspace", () => {
  const inRemoteWorkspace = (d: WorkDraft): WorkDraft => ({
    ...d,
    location: {
      ...d.location,
      runTarget: "local",
      localHostId: "",
      localDir: "",
      remoteWorkspace: {
        connectionId: "c1",
        source: "new",
        workspaceId: "",
        templateId: "",
        parameters: {},
        name: "",
        checkoutDir: "",
        repoUrl: "",
      },
    },
  });

  it("is for new work, and for saved work that has one", () => {
    expect(remoteWorkspaceDisabled(EMPTY_DRAFT)).toBeUndefined();
    expect(remoteWorkspaceDisabled(EMPTY_DRAFT, true)).toMatch(/start new work/);
    expect(remoteWorkspaceDisabled(inRemoteWorkspace(EMPTY_DRAFT), true)).toBeUndefined();
  });

  it("stays on a trigger or a schedule — the workspace starts when the work fires", () => {
    expect(remoteWorkspaceDisabled({ ...EMPTY_DRAFT, when: "schedule" })).toBeUndefined();
    const next = normalize({ ...inRemoteWorkspace(EMPTY_DRAFT), when: "schedule" });
    expect(next.location.runTarget).toBe("local");
    expect(next.location.remoteWorkspace?.connectionId).toBe(
      inRemoteWorkspace(EMPTY_DRAFT).location.remoteWorkspace?.connectionId,
    );
  });

  it("can't wait for you", () => {
    const d = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code" });
    expect(thenOptions(d).find((t) => t.value === "waits-for-me")?.disabled).toMatch(
      /remote workspace/,
    );
    expect(enabled(thenOptions(d))).toContain("exits");
  });

  it("says it in the sentence, and asks a Task for its repo", () => {
    const job = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code", withRepo: false });
    expect(text(job)).toContain("in a new remote workspace");
    expect(missingFields(job)).not.toContain("machine");
    const task = inRemoteWorkspace({ ...EMPTY_DRAFT, runtime: "claude-code", withRepo: true });
    expect(missingFields(task)).toContain("repo");
    const noConnection = inRemoteWorkspace(EMPTY_DRAFT);
    noConnection.location.remoteWorkspace!.connectionId = "";
    expect(missingFields(noConnection)).toContain("machine");
  });
});

suite("When answers by deployment features", () => {
  it("keeps every When by default", () => {
    expect(whenTypesFor(featuresFromEnv({}))).toEqual(WHEN_TYPES);
  });

  it("offers the restricted deployment's: no GitHub, Slack, Linear or SaaS alerting", () => {
    expect(
      whenTypesFor(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual([
      "manual",
      "schedule",
      "webhook",
      "ticket",
      "gitlab",
      "jira",
      "sentry",
      "alertmanager",
    ]);
  });

  it("moves an example onto GitLab with GitLab selected and leaves it alone by default", () => {
    const assign = PRESETS.find((p) => p.id === "assign")!.apply(EMPTY_DRAFT);
    expect(assign.trigger.ticketSource).toBe("github");
    expect(draftForFeatures(assign, featuresFromEnv({}))).toBe(assign);
    const standard = draftForFeatures(
      assign,
      featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    );
    expect(standard.trigger.ticketSource).toBe("gitlab");
    expect(standard.event.type).toBe("gitlab");
    expect(standard.event.config).toEqual({
      events: ["review_requested", "mentioned"],
      username: "",
    });
  });

  it("moves an agent the restricted deployment doesn't offer onto Claude Code", () => {
    const codex: WorkDraft = { ...EMPTY_DRAFT, runtime: "codex", agentOptions: { model: "x" } };
    expect(draftForFeatures(codex, featuresFromEnv({}))).toBe(codex);
    const standard = draftForFeatures(
      codex,
      featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    );
    expect(standard.runtime).toBe("claude-code");
    expect(standard.agentOptions).toEqual({});
    const opencode: WorkDraft = { ...EMPTY_DRAFT, runtime: "opencode" };
    expect(
      draftForFeatures(
        opencode,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).runtime,
    ).toBe("opencode");
    const terminal: WorkDraft = { ...EMPTY_DRAFT, runtime: TERMINAL };
    expect(
      draftForFeatures(
        terminal,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ).runtime,
    ).toBe(TERMINAL);
  });
});

suite("independent feature lists in fresh drafts", () => {
  it("chooses an offered runtime and event rather than assuming Claude Code or GitLab", () => {
    const features = featuresFromEnv({ OPTIO_RUNTIMES: "codex", OPTIO_TRIGGERS: "schedule,slack" });
    const draft = draftForFeatures({ ...EMPTY_DRAFT, when: "github" }, features);
    expect(draft.runtime).toBe("codex");
    expect(draft.when).toBe("schedule");
    expect(draft.event.type).toBe("slack");
    expect(draft.agentOptions).toEqual({});
  });
});
