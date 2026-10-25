import { featuresFromEnv } from "@optio/shared/features";
import { describe, expect, it } from "vitest";
import type { Team } from "@optio/shared";
import type { GatewayMe } from "@/lib/api-client";
import type { CredentialHealthRow } from "@/lib/credential-health-api";
import type { MyChannels } from "@/lib/notify-api";
import {
  buildChecklist,
  gatewayStep,
  pickMyTasks,
  type ChecklistContext,
  type ChecklistSources,
  type StepId,
} from "./getting-started-model";

const ME = { id: "u1", email: "carol@example.com", provider: "ldap" };
const GW = {
  id: "g1",
  name: "LiteLLM",
  baseUrl: "https://litellm.example.com",
  authHeader: "bearer" as const,
  tokenSource: "personal" as const,
  secretName: "ANTHROPIC_AUTH_TOKEN",
};
const gateway = (over: Partial<GatewayMe> = {}): GatewayMe => ({
  gateway: GW,
  hasToken: false,
  keyInfo: null,
  teams: [],
  orgHasToken: true,
  ...over,
});
const team = (over: Partial<Team>): Team => ({
  id: "t1",
  workspaceId: "w1",
  name: "Platform",
  slug: "platform",
  description: null,
  joinPolicy: "request",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  memberCount: 3,
  pendingCount: 0,
  myRole: null,
  myStatus: null,
  canManage: false,
  ...over,
});
const channels = (over: Partial<MyChannels> = {}): MyChannels => ({
  kinds: [],
  choices: { email: { "task.failed": true, "task.pr_opened": true }, push: {}, teamWork: true },
  email: { available: true, address: "carol@example.com" },
  push: { available: false },
  ...over,
});
const healthRow = (over: Partial<CredentialHealthRow>): CredentialHealthRow => ({
  key: "gateway:g1:user:u1",
  kind: "gateway",
  label: "Gateway token · LiteLLM",
  scope: "person",
  owner: { name: "Carol", userId: "u1", teamId: null },
  status: "ok",
  reason: null,
  expiresAt: null,
  checkedAt: "2026-10-24T10:00:00Z",
  details: {},
  ...over,
});

/** A brand-new person with gateway-only model access: nothing done but signing in. */
const fresh = (over: Partial<ChecklistSources> = {}): ChecklistSources => ({
  user: ME,
  gateway: gateway(),
  health: [],
  teams: [team({})],
  repoCount: 2,
  tasks: { started: null, waiting: null, merged: null },
  channels: channels(),
  ...over,
});
const DEFAULT_FEATURES = featuresFromEnv({});
const GATEWAY_ONLY: ChecklistContext = {
  gatewayOnly: true,
  features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
  teams: true,
  isAdmin: false,
  isViewer: false,
};
/** The defaults: every feature, no gateway, teams off. */
const DEFAULTS: ChecklistContext = {
  gatewayOnly: false,
  features: DEFAULT_FEATURES,
  teams: false,
  isAdmin: false,
  isViewer: false,
};

const stateOf = (list: ReturnType<typeof buildChecklist>, id: StepId) =>
  list.steps.find((s) => s.id === id)?.state;

describe("buildChecklist", () => {
  it("a new person: signed in, everything else to do, in order", () => {
    const list = buildChecklist(fresh(), GATEWAY_ONLY);
    expect(list.steps.map((s) => s.id)).toEqual([
      "sign-in",
      "gateway-token",
      "team",
      "repo",
      "first-task",
      "first-review",
      "notifications",
    ]);
    expect(stateOf(list, "sign-in")).toBe("done");
    expect(list.steps[0].detail).toBe(
      "Signed in as carol@example.com with your directory account.",
    );
    expect(stateOf(list, "gateway-token")).toBe("todo");
    expect(list.steps[1].href).toBe("/settings#my-tokens");
    expect(stateOf(list, "first-task")).toBe("todo");
    expect(list.steps.find((s) => s.id === "first-task")?.href).toBe("/work/new");
    // The team is optional: it never counts.
    expect(list.counted).toBe(6);
    expect(list.done).toBe(3); // sign-in, repo, notifications
    expect(list.complete).toBe(false);
  });

  it("everything done: complete (the optional team doesn't hold it open)", () => {
    const list = buildChecklist(
      fresh({
        gateway: gateway({
          hasToken: true,
          keyInfo: { spend: 1, maxBudget: 5, budgetResetAt: null, keyAlias: "carol" },
        }),
        tasks: {
          started: { id: "a", title: "Fix the README" },
          waiting: null,
          merged: {
            id: "a",
            title: "Fix the README",
            prUrl: "https://gitlab.example.com/x/-/merge_requests/1",
          },
        },
      }),
      GATEWAY_ONLY,
    );
    expect(stateOf(list, "team")).toBe("todo");
    expect(list.done).toBe(list.counted);
    expect(list.complete).toBe(true);
    // Every source answered and the gateway took the token: it stays done.
    expect(list.settled).toBe(true);
  });

  it("complete but not for good: isn't remembered (viewer, a failed request, an unchecked token)", () => {
    const allDone = {
      gateway: gateway({
        hasToken: true,
        keyInfo: { spend: 1, maxBudget: 5, budgetResetAt: null, keyAlias: "carol" },
      }),
      tasks: {
        started: { id: "a", title: "A" },
        waiting: null,
        merged: { id: "a", title: "A", prUrl: "https://gitlab.example.com/x/-/merge_requests/1" },
      },
    };
    // A viewer's list is complete at once; it grows when they become a member.
    const viewer = buildChecklist(fresh(), { ...GATEWAY_ONLY, isViewer: true });
    expect(viewer.complete).toBe(true);
    expect(viewer.settled).toBe(false);
    // The email step was left out because its request failed.
    const noChannels = buildChecklist(fresh({ ...allDone, channels: null }), GATEWAY_ONLY);
    expect(stateOf(noChannels, "notifications")).toBeUndefined();
    expect(noChannels.complete).toBe(true);
    expect(noChannels.settled).toBe(false);
    // A stored token Optio hasn't checked yet may still be refused.
    const unchecked = buildChecklist(
      fresh({ ...allDone, gateway: gateway({ hasToken: true }), health: [] }),
      GATEWAY_ONLY,
    );
    expect(unchecked.complete).toBe(true);
    expect(unchecked.settled).toBe(false);
    // Once a check found it fine, it is.
    const checked = buildChecklist(
      fresh({ ...allDone, gateway: gateway({ hasToken: true }), health: [healthRow({})] }),
      GATEWAY_ONLY,
    );
    expect(checked.settled).toBe(true);
  });

  it("a merge request waiting for the person: the review step links to it", () => {
    const list = buildChecklist(
      fresh({
        tasks: {
          started: { id: "a", title: "Fix the README" },
          waiting: { id: "a", title: "Fix the README" },
          merged: null,
        },
      }),
      GATEWAY_ONLY,
    );
    const review = list.steps.find((s) => s.id === "first-review")!;
    expect(review.state).toBe("todo");
    expect(review.href).toBe("/work/a");
    expect(review.detail).toContain('"Fix the README" is waiting for you');
    expect(review.title).toBe("Review your merge request");
    expect(stateOf(list, "first-task")).toBe("done");
  });

  it("speaks of pull requests with unrestricted model access on GitHub", () => {
    const list = buildChecklist(fresh(), {
      ...GATEWAY_ONLY,
      gatewayOnly: false,
      features: DEFAULT_FEATURES,
    });
    expect(list.steps.find((s) => s.id === "first-review")?.title).toBe(
      "Review your first pull request",
    );
    expect(list.steps.find((s) => s.id === "first-task")?.detail).toBe(
      "Describe the change in New work: an agent works on a branch and opens a pull request.",
    );
  });

  it("speaks of merge requests where the repos are GitLab's, whatever the feature lists", () => {
    const gitlab = buildChecklist(fresh({ repoCount: 0, repoPlatforms: ["gitlab", "gitlab"] }), {
      ...DEFAULTS,
      isAdmin: true,
    });
    expect(gitlab.steps.find((s) => s.id === "first-review")?.title).toBe(
      "Review your first merge request",
    );
    expect(gitlab.steps.find((s) => s.id === "repo")?.detail).toContain("GitLab project");
    // A mix of platforms: the feature lists decide.
    const mixed = buildChecklist(fresh({ repoPlatforms: ["gitlab", "github"] }), DEFAULTS);
    expect(mixed.steps.find((s) => s.id === "first-review")?.title).toBe(
      "Review your first pull request",
    );
    // A task's own change request says best.
    const waiting = buildChecklist(
      fresh({
        repoPlatforms: ["github"],
        tasks: {
          started: { id: "a", title: "A" },
          waiting: {
            id: "a",
            title: "A",
            prUrl: "https://gitlab.example.com/g/p/-/merge_requests/4",
          },
          merged: null,
        },
      }),
      DEFAULTS,
    );
    expect(waiting.steps.find((s) => s.id === "first-review")?.title).toBe(
      "Review your merge request",
    );
  });

  it("the defaults: no gateway step without a gateway, no team step without teams", () => {
    const list = buildChecklist(
      fresh({ gateway: gateway({ gateway: null }), teams: null }),
      DEFAULTS,
    );
    expect(list.steps.map((s) => s.id)).toEqual([
      "sign-in",
      "repo",
      "first-task",
      "first-review",
      "notifications",
    ]);
    // A gateway read that failed is no step by default either.
    const failed = buildChecklist(fresh({ gateway: null, teams: null }), DEFAULTS);
    expect(stateOf(failed, "gateway-token")).toBeUndefined();
    // Teams off aren't a request that failed: everything done is remembered.
    const done = buildChecklist(
      fresh({
        gateway: gateway({ gateway: null }),
        teams: null,
        tasks: {
          started: { id: "a", title: "A" },
          waiting: null,
          merged: { id: "a", title: "A", prUrl: "https://github.com/o/r/pull/1" },
        },
      }),
      DEFAULTS,
    );
    expect(done.complete).toBe(true);
    expect(done.settled).toBe(true);
  });

  it("a viewer gets no token, repo, task or review steps", () => {
    const list = buildChecklist(fresh(), { ...GATEWAY_ONLY, isViewer: true });
    expect(list.steps.map((s) => s.id)).toEqual(["sign-in", "team", "notifications"]);
    expect(list.complete).toBe(true);
  });

  it("the team step: a member, a request waiting, no teams at all", () => {
    const member = buildChecklist(
      fresh({ teams: [team({ myStatus: "active" }), team({ id: "t2", name: "Data" })] }),
      GATEWAY_ONLY,
    );
    expect(member.steps.find((s) => s.id === "team")).toMatchObject({
      state: "done",
      detail: "You're in Platform.",
    });
    const asked = buildChecklist(fresh({ teams: [team({ myStatus: "requested" })] }), GATEWAY_ONLY);
    expect(asked.steps.find((s) => s.id === "team")).toMatchObject({
      state: "waiting",
      detail: "Your request to join Platform waits for its admins.",
    });
    const none = buildChecklist(fresh({ teams: [] }), GATEWAY_ONLY);
    expect(none.steps.find((s) => s.id === "team")?.detail).toContain("No teams here yet");
    // Couldn't read the teams: the step is left out.
    expect(stateOf(buildChecklist(fresh({ teams: null }), GATEWAY_ONLY), "team")).toBeUndefined();
  });

  it("no repository: an admin adds one, a member waits for an admin", () => {
    const admin = buildChecklist(fresh({ repoCount: 0 }), { ...GATEWAY_ONLY, isAdmin: true });
    expect(admin.steps.find((s) => s.id === "repo")).toMatchObject({
      state: "todo",
      href: "/repos/new",
    });
    const member = buildChecklist(fresh({ repoCount: 0 }), GATEWAY_ONLY);
    expect(member.steps.find((s) => s.id === "repo")).toMatchObject({
      state: "waiting",
      href: null,
    });
    expect(member.steps.find((s) => s.id === "repo")?.detail).toContain("GitLab project");
  });

  it("notifications: your own chat hook counts, with or without email", () => {
    const hook = {
      id: "h1",
      format: "mattermost" as const,
      urlHint: "https://chat.example.test/hooks/…a1b2",
      enabled: true,
      lastSentAt: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-10-24T00:00:00Z",
    };
    const chatOnly = channels({
      email: { available: false, address: null },
      choices: { ...channels().choices, chat: { "task.pr_opened": true } },
      chat: { hook },
    });
    const done = buildChecklist(fresh({ channels: chatOnly }), GATEWAY_ONLY);
    expect(stateOf(done, "notifications")).toBe("done");
    expect(done.steps.find((s) => s.id === "notifications")?.detail).toContain(
      "posts to your chat hook",
    );
    // A switched-off hook, or every chat event off, doesn't count.
    const hookOff = channels({
      email: { available: false, address: null },
      choices: { ...channels().choices, chat: { "task.pr_opened": true } },
      chat: { hook: { ...hook, enabled: false } },
    });
    expect(
      stateOf(buildChecklist(fresh({ channels: hookOff }), GATEWAY_ONLY), "notifications"),
    ).toBe("unavailable");
    const eventsOff = channels({
      email: { available: false, address: null },
      choices: { ...channels().choices, chat: { "task.pr_opened": false } },
      chat: { hook },
    });
    expect(
      stateOf(buildChecklist(fresh({ channels: eventsOff }), GATEWAY_ONLY), "notifications"),
    ).toBe("unavailable");
  });

  it("notifications: on, all off, no address, no relay (which doesn't count)", () => {
    expect(stateOf(buildChecklist(fresh(), GATEWAY_ONLY), "notifications")).toBe("done");
    const off = channels({
      choices: { email: { "task.failed": false }, push: {}, teamWork: true },
    });
    expect(stateOf(buildChecklist(fresh({ channels: off }), GATEWAY_ONLY), "notifications")).toBe(
      "todo",
    );
    const noAddress = channels({ email: { available: true, address: null } });
    expect(
      stateOf(buildChecklist(fresh({ channels: noAddress }), GATEWAY_ONLY), "notifications"),
    ).toBe("attention");
    const noRelay = buildChecklist(
      fresh({ channels: channels({ email: { available: false, address: "c@x" } }) }),
      GATEWAY_ONLY,
    );
    expect(stateOf(noRelay, "notifications")).toBe("unavailable");
    expect(noRelay.counted).toBe(5);
  });
});

describe("gatewayStep", () => {
  it("no token: add one", () => {
    expect(gatewayStep(gateway(), [], "u1", true)).toMatchObject({
      state: "todo",
      title: "Add your gateway token",
      action: "Add token",
    });
  });

  it("stored and the gateway answers for it: done", () => {
    const step = gatewayStep(
      gateway({
        hasToken: true,
        keyInfo: { spend: 0, maxBudget: null, budgetResetAt: null, keyAlias: null },
      }),
      // A refusal (no key info read) from before the token was replaced doesn't count: the gateway takes it now.
      [healthRow({ status: "error", reason: "Rejected by the gateway (401)", details: {} })],
      "u1",
      true,
    );
    expect(step).toMatchObject({ state: "done", detail: "Stored, and LiteLLM accepts it." });
    expect(step?.provisional).toBeUndefined();
  });

  it("the gateway answers for it but its budget is spent: needs a fix, as health and the pre-flight say", () => {
    const resets = gatewayStep(
      gateway({
        hasToken: true,
        keyInfo: {
          spend: 5.1,
          maxBudget: 5,
          budgetResetAt: "2026-11-01T00:00:00Z",
          keyAlias: "carol",
        },
      }),
      // An ok row from before the budget ran out doesn't make it done.
      [healthRow({ status: "ok" })],
      "u1",
      true,
    );
    expect(resets).toMatchObject({
      state: "attention",
      title: "Your gateway token is over its budget",
      href: "/settings#my-tokens",
    });
    expect(resets?.detail).toBe(
      "LiteLLM refuses it until its budget resets on 2026-11-01 00:00 UTC ($5.10 of $5.00 spent). Runs of your own work fail until then.",
    );
    const noReset = gatewayStep(
      gateway({
        hasToken: true,
        keyInfo: { spend: 5, maxBudget: 5, budgetResetAt: null, keyAlias: null },
      }),
      [],
      "u1",
      true,
    );
    expect(noReset?.state).toBe("attention");
    expect(noReset?.detail).toContain("until whoever set its budget raises it");
  });

  it("a block or an expiry the last check read stands; a spent budget since reset doesn't", () => {
    const answers = gateway({
      hasToken: true,
      keyInfo: { spend: 1, maxBudget: 5, budgetResetAt: null, keyAlias: "carol" },
    });
    // The check read the key's info (a spend) and found it blocked: /key/info's answer here can't say otherwise.
    const blocked = gatewayStep(
      answers,
      [
        healthRow({
          status: "error",
          reason: "Blocked on the gateway",
          details: { spend: 1, maxBudget: 5 },
        }),
      ],
      "u1",
      true,
    );
    expect(blocked).toMatchObject({ state: "attention", title: "Your gateway token is refused" });
    expect(blocked?.detail).toBe(
      "Blocked on the gateway. Replaced it since? Check my tokens under Settings → My tokens checks it again.",
    );
    // The check found the budget spent; the gateway now reports budget left (it reset).
    const reset = gatewayStep(
      answers,
      [
        healthRow({
          status: "error",
          reason: "Over budget with no reset",
          details: { spend: 5, maxBudget: 5 },
        }),
      ],
      "u1",
      true,
    );
    expect(reset?.state).toBe("done");
  });

  it("stored but refused at the last check: needs a fix, with the reason", () => {
    const step = gatewayStep(
      gateway({ hasToken: true }),
      [
        healthRow({
          key: "gateway:g1:user:someone-else",
          status: "ok",
        }),
        healthRow({
          status: "error",
          reason:
            "The gateway refused it (401): expired, revoked or wrong — put in a new one under Settings → My tokens",
        }),
      ],
      "u1",
      true,
    );
    expect(step).toMatchObject({
      state: "attention",
      title: "Your gateway token is refused",
      href: "/settings#my-tokens",
    });
    expect(step?.detail).toContain("refused it (401)");
  });

  it("stored, not checked yet: done for now (provisional), and says how to check it", () => {
    const step = gatewayStep(gateway({ hasToken: true }), [], "u1", true);
    expect(step?.state).toBe("done");
    expect(step?.provisional).toBe(true);
    expect(step?.detail).toContain("Check my tokens");
    // A check that couldn't reach the gateway settles nothing either; one that passed does.
    const unknown = gatewayStep(
      gateway({ hasToken: true }),
      [healthRow({ status: "unknown", reason: "Couldn't reach the gateway" })],
      "u1",
      true,
    );
    expect(unknown).toMatchObject({ state: "done", provisional: true });
    const passed = gatewayStep(gateway({ hasToken: true }), [healthRow({})], "u1", true);
    expect(passed).toMatchObject({
      state: "done",
      detail: "Stored, and it passed the last check.",
    });
    expect(passed?.provisional).toBeUndefined();
  });

  it("a shared token on the gateway: nothing for the person to add", () => {
    const step = gatewayStep(
      gateway({ gateway: { ...GW, tokenSource: "stored" } }),
      null,
      "u1",
      true,
    );
    expect(step).toMatchObject({ state: "done", href: null });
  });

  it("no gateway: waits for an admin with gateway-only model access, isn't a step with unrestricted model access", () => {
    expect(gatewayStep(gateway({ gateway: null }), null, "u1", true)).toMatchObject({
      state: "waiting",
      title: "Model gateway",
    });
    expect(gatewayStep(gateway({ gateway: null }), null, "u1", false)).toBeNull();
  });

  it("couldn't read it: a step to go and look with the gateway alone, none by default", () => {
    expect(gatewayStep(null, null, "u1", true)).toMatchObject({
      state: "todo",
      href: "/settings#my-tokens",
    });
    expect(gatewayStep(null, null, "u1", false)).toBeNull();
  });
});

describe("pickMyTasks", () => {
  it("a merged task is one with a merge request; a completed one without proves no review", () => {
    expect(
      pickMyTasks({
        started: [{ id: "c", title: "C" }],
        waiting: [],
        completed: [
          { id: "b", title: "No MR", prUrl: null },
          { id: "a", title: "A", prUrl: "https://gitlab.example.com/p/-/merge_requests/3" },
        ],
      }),
    ).toEqual({
      started: { id: "c", title: "C", prUrl: null },
      waiting: null,
      merged: { id: "a", title: "A", prUrl: "https://gitlab.example.com/p/-/merge_requests/3" },
    });
  });
});
