import {
  AGENT_CREDENTIAL_OPTION_KEY,
  getProviderCatalog,
  isModelProviderAgent,
  MODEL_PROVIDER_OPTION_KEY,
  modelProviderIdFrom,
  providerForAgentType,
  secretCredentialId,
  secretIdFromCredential,
  type AgentCredential,
  toLocalAgentKind,
  type LocalHost,
  type ModelProvider,
  type PickableSecret,
  type IdOverrides,
  type WorkEnvironmentEntry,
  type ResourceOwner,
  type WorkFormDefaults,
  deriveWorkKind,
  effectivePrSettings,
  type RepoPrSettings as SharedRepoPrSettings,
  type WorkKind,
  type WorkSettings,
  type WorkThen,
} from "@optio/shared";
import type { TriggerConfig } from "@/components/trigger-selector";
import type { AgentOptionsValues } from "@/components/agent-options-picker";
import { CLUSTER_RUN_LOCATION, type RunLocationValue } from "@/components/run-location-picker";
import {
  RUNTIMES,
  TERMINAL,
  optionsFromRepo,
  repoHasOwnOptions,
  repoOwnRuntime,
  runtimeLabel,
} from "@/components/agent-choice-model";

/**
 * One piece of work, five attributes. Every kind of work Optio runs — a Task
 * that opens a PR, a Job, a scheduled blueprint, a Local automation, an
 * interactive terminal, a Persistent Agent — is a point in this space, and
 * the storage row it becomes (`deriveKind`) is a pure function of the point.
 *
 * The form asks in this order, each answer narrowing the next:
 *
 *   WHEN   what starts it: now, a schedule, a webhook, a ticket, or a GitHub /
 *          GitLab / Slack / Linear / Jira / Pylon / PagerDuty / Sentry /
 *          Alertmanager / Datadog event — every When works with every Where
 *   WHERE  an Optio pod (with one of your repos, or none) or your own machine
 *          (in the directory as it is, or on a new branch that becomes a PR)
 *   WHO    a terminal with no agent, or an agent runtime and its parameters
 *   WHAT   the prompt (agents only), with the trigger's params available
 *   THEN   what happens when a turn ends: exits / works until the PR merges /
 *          waits for me / persistent agent
 *   NAME   yours, or "Job N" / "Terminal N" for its kind
 *
 * `normalize` keeps a draft inside the space: an upstream change (say, a
 * trigger) moves the downstream answers it invalidates (a bare terminal
 * becomes an agent), never the other way round.
 */

export type Then = WorkThen;

/** Then answers that are one headless run (or one per firing), not a session. */
export const isOneShot = (then: Then): boolean => then === "exits" || then === "until-merged";

export type EventTriggerType =
  | "github"
  | "gitlab"
  | "slack"
  | "linear"
  | "jira"
  | "pagerduty"
  | "pylon"
  | "sentry"
  | "alertmanager"
  | "datadog";
export type WhenType = TriggerConfig["type"] | EventTriggerType;

export interface EventTrigger {
  type: EventTriggerType;
  config: Record<string, unknown>;
}

/** GitHub / GitLab / Linear / Jira event kinds that are "about you" and need an identity to match. */
export const PERSONAL_EVENT_KINDS: Record<EventTriggerType, readonly string[]> = {
  github: ["review_requested", "mentioned", "assigned"],
  gitlab: ["review_requested", "mentioned", "assigned"],
  slack: [],
  linear: ["assigned", "mentioned"],
  jira: ["assigned", "mentioned"],
  pagerduty: [],
  pylon: [],
  sentry: [],
  alertmanager: [],
  datadog: [],
};

/** The config key naming whom personal kinds are about: a GitHub login, a GitLab username, a Linear / Jira user. */
export const IDENTITY_KEY: Partial<Record<EventTriggerType, string>> = {
  github: "login",
  gitlab: "username",
  linear: "user",
  jira: "user",
};

/** Slack channel ids look like C0123ABCD (the API rejects anything else). */
export const SLACK_CHANNEL_ID = /^[A-Z][A-Z0-9]{5,}$/;

/**
 * What an event trigger still needs before the API would accept it — the
 * same rules the trigger routes enforce, checked up front so a rejected
 * trigger never strands a half-created row.
 */
export function eventGaps(e: EventTrigger): SentenceField[] {
  const c = e.config;
  const events = Array.isArray(c.events) ? (c.events as string[]) : [];
  if (e.type === "slack") {
    return SLACK_CHANNEL_ID.test(String(c.channelId ?? "")) ? [] : ["channel"];
  }
  // Pylon's kinds are free text: empty means whatever the Pylon trigger sends.
  if (e.type === "pylon") return [];
  // No kinds checked would mean "every kind" to the matcher — make it a choice.
  if (events.length === 0) return ["events"];
  const personal =
    events.some((k) => PERSONAL_EVENT_KINDS[e.type].includes(k)) ||
    // Linear's "only tickets from someone else" skips yours: it has to know you.
    (e.type === "linear" && c.othersOnly === true);
  const key = IDENTITY_KEY[e.type];
  const identity = key ? String(c[key] ?? "").trim() : "";
  if (personal && !identity) return ["identity"];
  return [];
}

export interface WorkDraft {
  when: WhenType;
  trigger: TriggerConfig;
  event: EventTrigger;
  location: RunLocationValue;
  /**
   * Pod: one of your registered repos (vs. no repo). Machine: work on a new
   * branch that becomes a PR (vs. the directory as it is). Either way it
   * means "this work produces a PR".
   */
  withRepo: boolean;
  repoId: string;
  repoUrl: string;
  repoBranch: string;
  /** "" = a terminal with no agent. */
  runtime: string;
  /** Model + provider options for the runtime (keys from the provider catalog). */
  agentOptions: AgentOptionsValues;
  prompt: string;
  then: Then;
  /**
   * "Works until merged" only: merge the PR once it's green and approved
   * (vs. keep it green and leave the merge to you).
   */
  mergeWhenReady: boolean;
  agent: {
    slug: string;
    podLifecycle: "sticky" | "always-on" | "on-demand";
    systemPrompt: string;
    agentsMd: string;
  };
  /** Blank = "<Kind> N" (see `KIND_WORD`). */
  name: string;
  /**
   * Triggered work only: what each run is named, with the trigger's params
   * ("Triage: {{ticketTitle}}"). Blank = the name.
   */
  runName: string;
  description: string;
  priority: number;
  maxRetries: number;
  dependsOn: string[];
  /**
   * Pod work: who it belongs to — the organization, or you (it then runs
   * with your own secrets, providers, and connections). Work on a machine is
   * always yours (`effectiveOwner`).
   */
  owner: ResourceOwner;
  /**
   * Pod work: the secrets (by name) the agent gets in its pod. Null = the
   * row predates picking (legacy behavior) and nothing was picked since.
   */
  podSecrets: string[] | null;
  /**
   * Pod work: what it changes about the repo's / workspace's environment —
   * connections, MCP servers, skills, setup commands, PR follow-through
   * (`WorkSettings`). Empty = the defaults.
   */
  settings: WorkSettings;
}

export { RUNTIMES, TERMINAL, runtimeLabel, optionsFromRepo };

export const EMPTY_DRAFT: WorkDraft = {
  when: "manual",
  trigger: { type: "manual" },
  event: { type: "github", config: { events: ["review_requested", "mentioned"], login: "" } },
  location: CLUSTER_RUN_LOCATION,
  withRepo: true,
  repoId: "",
  repoUrl: "",
  repoBranch: "main",
  runtime: "claude-code",
  agentOptions: {},
  prompt: "",
  then: "exits",
  mergeWhenReady: true,
  agent: { slug: "", podLifecycle: "sticky", systemPrompt: "", agentsMd: "" },
  name: "",
  runName: "",
  description: "",
  priority: 100,
  maxRetries: 3,
  dependsOn: [],
  owner: "workspace",
  podSecrets: [],
  settings: {},
};

// ── Presets ──────────────────────────────────────────────────────────────────

export interface Preset {
  id: string;
  label: string;
  hint: string;
  apply: (d: WorkDraft) => WorkDraft;
}

export const PRESETS: Preset[] = [
  {
    id: "pr",
    label: "Open a PR",
    hint: "An agent changes a repo on a branch and opens a pull request.",
    apply: (d) => ({
      ...d,
      when: "manual",
      trigger: { type: "manual" },
      location: { ...d.location, runTarget: "cluster" },
      withRepo: true,
      runtime: d.runtime || "claude-code",
      agentOptions: {},
      then: "exits",
    }),
  },
  {
    id: "assign",
    label: "Assign to Optio",
    hint: "Issues labeled optio become PRs an agent works on until they merge.",
    apply: (d) => ({
      ...d,
      when: "ticket",
      trigger: { type: "ticket", ticketSource: "github", ticketLabels: ["optio"] },
      location: { ...d.location, runTarget: "cluster" },
      withRepo: true,
      runtime: d.runtime || "claude-code",
      agentOptions: {},
      then: "until-merged",
      mergeWhenReady: true,
    }),
  },
  {
    id: "chat",
    label: "Interactive chat",
    hint: "An agent session on your machine you can type into.",
    apply: (d) => ({
      ...d,
      when: "manual",
      trigger: { type: "manual" },
      location: { ...d.location, runTarget: "local", localSessionMode: "interactive" },
      withRepo: false,
      runtime: d.runtime || "claude-code",
      agentOptions: {},
      then: "waits-for-me",
    }),
  },
  {
    id: "terminal",
    label: "Terminal",
    hint: "A plain shell on your machine — no agent, no prompt.",
    apply: (d) => ({
      ...d,
      when: "manual",
      trigger: { type: "manual" },
      location: { ...d.location, runTarget: "local", localSessionMode: "interactive" },
      withRepo: false,
      runtime: TERMINAL,
      agentOptions: {},
      prompt: "",
      then: "waits-for-me",
    }),
  },
  {
    id: "schedule",
    label: "Scheduled run",
    hint: "An agent runs on a cron with no repo and exits.",
    apply: (d) => ({
      ...d,
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * *" },
      location: { ...d.location, runTarget: "cluster" },
      withRepo: false,
      runtime: d.runtime || "claude-code",
      agentOptions: {},
      then: "exits",
    }),
  },
  {
    id: "agent",
    label: "Persistent agent",
    hint: "A named agent that keeps memory and wakes on messages.",
    apply: (d) => ({
      ...d,
      when: "manual",
      trigger: { type: "manual" },
      location: { ...d.location, runTarget: "cluster" },
      withRepo: false,
      runtime: d.runtime || "claude-code",
      agentOptions: {},
      then: "waits-for-messages",
    }),
  },
];

// ── Trigger params ───────────────────────────────────────────────────────────

/**
 * The `{{param}}`s a prompt can use, per trigger — what the trigger worker,
 * the webhook receiver, and the local event service put in `params`.
 */
export const TRIGGER_PARAMS: Record<WhenType, string[]> = {
  manual: [],
  schedule: [],
  webhook: [],
  ticket: [
    "ticketSource",
    "ticketExternalId",
    "ticketTitle",
    "ticketBody",
    "ticketUrl",
    "ticketLabels",
  ],
  github: [
    "event",
    "kind",
    "repo",
    "repoUrl",
    "number",
    "title",
    "body",
    "url",
    "author",
    "headBranch",
    "baseBranch",
    "commentBody",
    "commentUrl",
    "action",
    "labels",
    "label",
    "ref",
    "sha",
    "commits",
    "compareUrl",
    "tag",
    "workflow",
    "conclusion",
    "merged",
  ],
  gitlab: [
    "event",
    "kind",
    "project",
    "projectUrl",
    "iid",
    "title",
    "body",
    "url",
    "author",
    "sourceBranch",
    "targetBranch",
    "commentBody",
    "commentUrl",
    "labels",
    "label",
    "ref",
    "sha",
    "commits",
    "compareUrl",
    "tag",
    "pipelineStatus",
    "action",
  ],
  slack: ["channelId", "userId", "text", "ts", "threadTs", "permalink", "botName"],
  linear: [
    "event",
    "identifier",
    "title",
    "description",
    "url",
    "labels",
    "teamKey",
    "assignee",
    "priority",
    "state",
    "commentBody",
    "commentUrl",
    "actor",
    "ticketTitle",
    "ticketBody",
    "ticketUrl",
    "ticketLabels",
  ],
  jira: [
    "event",
    "key",
    "title",
    "description",
    "url",
    "project",
    "projectName",
    "status",
    "previousStatus",
    "assignee",
    "priority",
    "labels",
    "issueType",
    "commentBody",
    "commentUrl",
    "actor",
    "ticketSource",
    "ticketExternalId",
    "ticketTitle",
    "ticketBody",
    "ticketUrl",
    "ticketLabels",
  ],
  pagerduty: [
    "event",
    "incidentId",
    "incidentNumber",
    "title",
    "url",
    "urgency",
    "priority",
    "service",
    "serviceId",
    "status",
    "assignees",
    "ticketSource",
    "ticketExternalId",
    "ticketTitle",
    "ticketUrl",
  ],
  pylon: [
    "event",
    "issueId",
    "issueNumber",
    "title",
    "body",
    "state",
    "url",
    "account",
    "requester",
    "assignee",
    "tags",
    "payload",
  ],
  sentry: [
    "event",
    "resource",
    "action",
    "issueId",
    "shortId",
    "title",
    "culprit",
    "level",
    "project",
    "projectName",
    "url",
    "environment",
    "status",
    "assignee",
    "count",
    "userCount",
    "firstSeen",
    "lastSeen",
    "actor",
    "alertRule",
    "ticketSource",
    "ticketExternalId",
    "ticketTitle",
    "ticketUrl",
  ],
  alertmanager: [
    "event",
    "status",
    "receiver",
    "groupKey",
    "title",
    "message",
    "alertnames",
    "severities",
    "count",
    "firing",
    "resolved",
    "externalUrl",
    "labels",
    "annotations",
    "alerts",
    "payload",
  ],
  datadog: [
    "event",
    "transition",
    "alertType",
    "eventId",
    "alertId",
    "title",
    "body",
    "link",
    "priority",
    "status",
    "tags",
    "hostname",
    "query",
    "scope",
    "metric",
    "org",
    "date",
    "payload",
  ],
};

// ── Derived facts ────────────────────────────────────────────────────────────

export const isLocal = (d: WorkDraft) => d.location.runTarget === "local";

const EVENT_WHENS: ReadonlySet<string> = new Set<EventTriggerType>([
  "github",
  "gitlab",
  "slack",
  "linear",
  "jira",
  "pagerduty",
  "pylon",
  "sentry",
  "alertmanager",
  "datadog",
]);
export const isEventWhen = (w: WhenType): w is EventTriggerType => EVENT_WHENS.has(w);
export const isTriggered = (d: WorkDraft) => d.when !== "manual";

export const WHEN_TYPES: WhenType[] = [
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
];

export interface Choice<T> {
  value: T;
  /** Why it can't be picked right now, if it can't. */
  disabled?: string;
}

/** Pod or machine. Every trigger — a schedule, a webhook, a ticket, an event — works with either. */
export function whereOptions(_d: WorkDraft): Choice<"cluster" | "local">[] {
  return [{ value: "cluster" }, { value: "local" }];
}

/**
 * The terminal and the runtimes the picked Where allows. A terminal is a
 * shell you open (a pod session, a terminal on your machine) or a command
 * that runs and exits (a Job, in a pod or on your machine) — whatever starts
 * it — so it is offered wherever one of those fits.
 */
export function runtimeOptions(d: WorkDraft): Choice<string>[] {
  const local = isLocal(d);
  const terminalFits = thenOptions({ ...d, runtime: TERMINAL }).some((t) => !t.disabled);
  const terminal: Choice<string> = {
    value: TERMINAL,
    ...(terminalFits
      ? {}
      : {
          disabled:
            "In a repo pod a trigger starts an agent — pick No repo to run a command instead.",
        }),
  };
  const agents: Choice<string>[] = RUNTIMES.map((r) => ({
    value: r.value,
    ...(local && toLocalAgentKind(r.value) === null ? { disabled: "runs in pods only" } : {}),
  }));
  return [terminal, ...agents];
}

/** Exit conditions, given everything above them. */
export function thenOptions(d: WorkDraft): Choice<Then>[] {
  const local = isLocal(d);
  const terminal = d.runtime === TERMINAL;
  return [
    {
      // A terminal that exits runs a command — in a pod with no checkout, or
      // in the machine's directory as it is.
      value: "exits",
      ...(terminal && d.withRepo
        ? {
            disabled: local
              ? "A command runs in the directory as it is — pick “Current directory”, or an agent to work on a new branch."
              : "A command runs without a checkout — pick No repo, or an agent to change the repo.",
          }
        : {}),
    },
    {
      value: "until-merged",
      ...(terminal
        ? { disabled: "Following a PR through needs an agent to fix what CI and reviewers find." }
        : !d.withRepo
          ? {
              disabled: local
                ? "It works on the PR it opens — pick “On a new branch” above."
                : "It works on the PR it opens — pick a repository above.",
            }
          : {}),
    },
    {
      value: "waits-for-me",
      ...(!local && !d.withRepo
        ? { disabled: "A pod terminal is attached to a repo — pick a repository above." }
        : !local && isTriggered(d)
          ? {
              disabled: "A pod terminal is opened by hand. On your machine, triggers can open one.",
            }
          : !local && !terminal && d.runtime !== "claude-code"
            ? {
                disabled:
                  "A pod session chats with Claude Code — pick Terminal or Claude Code above.",
              }
            : {}),
    },
    {
      // In a pod, with or without a repo (it then works in a checkout of
      // it, turn after turn).
      value: "waits-for-messages",
      ...(local
        ? { disabled: "Persistent agents run in an Optio pod so they stay reachable." }
        : terminal
          ? { disabled: "A persistent agent needs an agent runtime." }
          : {}),
    },
  ];
}

const firstEnabled = <T>(choices: Choice<T>[], current: T): T =>
  choices.find((c) => c.value === current && !c.disabled)?.value ??
  choices.find((c) => !c.disabled)?.value ??
  current;

/**
 * Snap a draft back into the space its upstream answers allow, after any
 * change. Upstream wins: When over Where over Who over Then.
 */
export function normalize(d: WorkDraft): WorkDraft {
  let next = d;
  const where = firstEnabled(whereOptions(next), next.location.runTarget);
  if (where !== next.location.runTarget) {
    next = { ...next, location: { ...next.location, runTarget: where } };
  }
  // A runtime that can't run here falls back to the first agent that can —
  // never silently to a bare terminal, which is a different kind of work.
  const runtimes = runtimeOptions(next);
  const runtime = runtimes.some((r) => r.value === next.runtime && !r.disabled)
    ? next.runtime
    : firstEnabled(
        runtimes.filter((r) => r.value !== TERMINAL),
        next.runtime,
      );
  if (runtime !== next.runtime) next = { ...next, runtime, agentOptions: {} };
  const then = firstEnabled(thenOptions(next), next.then);
  if (then !== next.then) next = { ...next, then };
  const mode = next.then === "waits-for-me" ? "interactive" : "headless";
  if (next.location.localSessionMode !== mode) {
    next = { ...next, location: { ...next.location, localSessionMode: mode } };
  }
  return next;
}

/**
 * Which agent parameters the run will honor. Every pod run — a Task (over
 * the repo's defaults), a Job, a persistent agent — reads the runtime's full
 * provider option set. On your machine the daemon passes the CLI only the
 * model, the effort and the permission mode (`runsOn: ["local"]` fields);
 * everything else comes from the machine's own config.
 */
export function fullOptionsApply(d: WorkDraft): boolean {
  return !isLocal(d) && d.runtime !== TERMINAL;
}

/** A slug for a persistent agent, from its name. */
export { slugify } from "@optio/shared";

// ── Environment (Where) ──────────────────────────────────────────────────────

/** The environment parts of `WorkSettings` that switch things on and off by id. */
export type EnvironmentPart = "connections" | "mcpServers" | "skills";

/** Whether an item is on for this work: on by default and not taken out, or added. */
export function overrideOn(o: IdOverrides | undefined, id: string, isDefault: boolean): boolean {
  return isDefault ? !(o?.remove ?? []).includes(id) : (o?.add ?? []).includes(id);
}

/** Switch one item on or off, keeping only the changes from the defaults. */
export function toggleOverride(
  o: IdOverrides | undefined,
  id: string,
  isDefault: boolean,
  on: boolean,
): IdOverrides {
  const add = (o?.add ?? []).filter((x) => x !== id);
  const remove = (o?.remove ?? []).filter((x) => x !== id);
  if (isDefault && !on) remove.push(id);
  if (!isDefault && on) add.push(id);
  return { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
}

/** How many things the work changes from its defaults (for the collapsed summary). */
export function settingsChanges(s: WorkSettings): number {
  const ids = (o?: IdOverrides) => (o?.add?.length ?? 0) + (o?.remove?.length ?? 0);
  return (
    ids(s.connections) +
    ids(s.mcpServers) +
    ids(s.skills) +
    (s.setupCommands?.trim() ? 1 : 0) +
    (s.review?.enabled ? 1 : 0) +
    (s.cautiousMode === true ? 1 : 0) +
    (typeof s.maxAutoResumes === "number" ? 1 : 0)
  );
}

/** Work that opens a PR: its follow-through settings apply. */
export function prSettingsApply(d: WorkDraft): boolean {
  return d.withRepo && d.runtime !== TERMINAL && isOneShot(d.then);
}

// ── PR follow-through ────────────────────────────────────────────────────────

/** The repo settings that decide what happens to a PR after it opens. */
export interface RepoPrSettings extends SharedRepoPrSettings {
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
}

/** The server's cap when a repo sets none (OPTIO_MAX_AUTO_RESUMES' default). */
export const DEFAULT_MAX_AUTO_RESUMES = 10;

export interface FollowThroughStep {
  key: "pr" | "review" | "ci" | "changes" | "merge" | "done";
  label: string;
  on: boolean;
  detail?: string;
}

/**
 * What happens to the PR once the agent opens it, step by step — the same
 * rules the reconciler applies (`reconcile-snapshot.ts`, `reconcile-repo.ts`):
 * a task's own follow-through ("Works until merged") and its settings (review,
 * draft PRs, how often it resumes) win over the repo's, and cautious mode
 * (draft PRs) never merges. Null when the work doesn't open a PR.
 */
export function followThrough(
  d: WorkDraft,
  repo: RepoPrSettings | null | undefined,
): { fromRepo: boolean; steps: FollowThroughStep[] } | null {
  if (!prSettingsApply(d)) return null;
  const own = d.then === "until-merged";
  const s = isLocal(d) ? {} : d.settings;
  const resume = own ? true : !!repo?.autoResume;
  const merge = own ? d.mergeWhenReady : !!repo?.autoMerge;
  // The work's own settings (Where → Environment) win over the repo's — the
  // reconciler's own rule.
  const pr = effectivePrSettings(s, repo, DEFAULT_MAX_AUTO_RESUMES);
  const cautious = pr.cautiousMode;
  const cap = pr.maxAutoResumes;
  const reviewTrigger = pr.reviewTrigger;
  // The reconciler launches a review only on an automatic trigger.
  const reviewOn = pr.reviewEnabled && reviewTrigger !== null;
  const resumes = `the agent picks it back up (up to ${cap} times)`;
  return {
    fromRepo: !own,
    steps: [
      {
        key: "pr",
        label: cautious ? "Opens a draft PR" : "Opens a PR",
        on: true,
        detail: "The agent's turn ends here; Optio watches CI and reviews from then on.",
      },
      {
        key: "review",
        label: "A review agent reviews it",
        on: reviewOn,
        detail: reviewOn
          ? reviewTrigger === "on_pr"
            ? "As soon as the PR opens."
            : "Once CI passes."
          : "Off for this repo — turn it on under Where → Environment, or in the repo's settings.",
      },
      {
        key: "ci",
        label: "Fixes failing CI and merge conflicts",
        on: resume,
        detail: resume ? `When checks fail or it conflicts, ${resumes}.` : "It waits for you.",
      },
      {
        key: "changes",
        label: "Addresses requested changes",
        on: resume,
        detail: resume
          ? `When a reviewer requests changes, ${resumes}.`
          : "It waits for you to resume it.",
      },
      {
        key: "merge",
        label: "Merges when it's ready",
        on: merge && !cautious,
        detail:
          merge && cautious
            ? "Held back: this work opens draft PRs (cautious mode), so a person merges."
            : merge
              ? "Squash-merges once checks pass and any blocking review is done."
              : "You merge it.",
      },
      {
        key: "done",
        label: "Completes on merge, fails if the PR is closed",
        on: true,
      },
    ],
  };
}

// ── Kind: the storage row a draft becomes ────────────────────────────────────

export type { WorkKind };

/** The row a draft becomes — the server's own rule (`deriveWorkKind`, `kindOfSpec`). */
export function deriveKind(d: WorkDraft): WorkKind {
  return deriveWorkKind({
    then: d.then,
    local: isLocal(d),
    triggered: isTriggered(d),
    withRepo: d.withRepo,
  });
}

// ── The sentence ─────────────────────────────────────────────────────────────

export type SentencePart = { text: string } | { missing: string; field: SentenceField };

export type SentenceField =
  | "checkout"
  | "repo"
  | "machine"
  | "prompt"
  | "cron"
  | "webhook"
  | "identity"
  | "channel"
  | "events";

const CRON_WORDS: Record<string, string> = {
  "0 * * * *": "every hour",
  "0 */6 * * *": "every 6 hours",
  "0 9 * * *": "daily at 09:00 UTC",
  "0 9 * * 1-5": "weekdays at 09:00 UTC",
  "0 9 * * 1": "Mondays at 09:00 UTC",
};

function whenPhrase(d: WorkDraft): SentencePart[] {
  switch (d.when) {
    case "manual":
      if (d.then === "waits-for-messages") return [{ text: "Woken by messages," }];
      return [{ text: isOneShot(d.then) ? "Started now," : "Opened now," }];
    case "schedule": {
      const cron = d.trigger.cronExpression?.trim();
      if (!cron || cron.split(/\s+/).length !== 5) {
        return [{ text: "Running" }, { missing: "on a schedule", field: "cron" }, { text: "," }];
      }
      return [{ text: `Running ${CRON_WORDS[cron] ?? `on \`${cron}\``},` }];
    }
    case "webhook":
      return d.trigger.webhookPath
        ? [{ text: `Started by a webhook at /api/hooks/${d.trigger.webhookPath},` }]
        : [{ text: "Started by" }, { missing: "a webhook path", field: "webhook" }, { text: "," }];
    case "ticket":
      return [
        {
          text: `Started by ${TICKET_SOURCE_NAMES[d.trigger.ticketSource ?? "github"] ?? d.trigger.ticketSource} tickets,`,
        },
      ];
    case "github":
    case "gitlab":
    case "slack":
    case "linear":
    case "jira":
    case "pagerduty":
    case "pylon":
    case "sentry":
    case "alertmanager":
    case "datadog": {
      const source = EVENT_SOURCE_PHRASE[d.when];
      const gaps = eventGaps(d.event);
      if (gaps.length === 0) return [{ text: `Started by ${source},` }];
      return [
        { text: `Started by ${source}` },
        gaps[0] === "channel"
          ? { missing: "in a channel", field: "channel" }
          : gaps[0] === "events"
            ? { missing: "of some kind", field: "events" }
            : { missing: "about you", field: "identity" },
        { text: "," },
      ];
    }
  }
}

const TICKET_SOURCE_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  jira: "Jira",
  notion: "Notion",
};

/** "Started by GitHub events," — what each event When is started by. */
export const EVENT_SOURCE_PHRASE: Record<EventTriggerType, string> = {
  github: "GitHub events",
  gitlab: "GitLab events",
  slack: "Slack messages",
  linear: "Linear events",
  jira: "Jira events",
  pagerduty: "PagerDuty incidents",
  pylon: "Pylon events",
  sentry: "Sentry alerts",
  alertmanager: "Alertmanager alerts",
  datadog: "Datadog monitors",
};

/** "a Claude Code", "an OpenAI Codex". */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function shortDir(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

/**
 * "Started now, a Claude Code run in an Optio pod with acme/app that
 * opens a PR and exits when done." Missing pieces render as gaps that point
 * at their field, so the sentence is also the validation.
 */
export function describe(
  d: WorkDraft,
  ctx: { repoName?: string | null; machineName?: string | null } = {},
): SentencePart[] {
  const parts: SentencePart[] = [...whenPhrase(d)];
  const who = isCommand(d)
    ? "a command"
    : d.runtime === TERMINAL
      ? "a terminal"
      : withArticle(runtimeLabel(d.runtime));
  // Plain English for the exit condition: a run finishes, a session waits
  // for you, an agent stays.
  const noun =
    d.then === "waits-for-messages" ? "agent" : d.then === "waits-for-me" ? "session" : "run";
  parts.push({ text: d.runtime === TERMINAL ? who : `${who} ${noun}` });

  if (d.then === "waits-for-messages") {
    parts.push({ text: "in an Optio pod" });
    if (d.withRepo) {
      parts.push(
        d.repoUrl
          ? { text: `with ${ctx.repoName ?? d.repoUrl}` }
          : { missing: "a repo", field: "repo" },
      );
    }
  } else if (isLocal(d)) {
    parts.push(
      d.location.localHostId
        ? { text: `on ${ctx.machineName ?? "my machine"}` }
        : { missing: "a machine", field: "machine" },
    );
    parts.push(
      d.location.localDir
        ? {
            text: `${d.withRepo && d.runtime !== TERMINAL ? "on a new branch in" : "in"} ${shortDir(d.location.localDir)}`,
          }
        : { missing: d.withRepo ? "a checkout" : "a directory", field: "checkout" },
    );
  } else {
    parts.push({ text: "in an Optio pod" });
    if (d.withRepo) {
      parts.push(
        d.repoUrl
          ? { text: `with ${ctx.repoName ?? d.repoUrl}` }
          : { missing: "a repo", field: "repo" },
      );
    }
  }

  if (d.then === "exits") {
    parts.push({
      text: isCommand(d)
        ? "that runs and exits."
        : d.withRepo
          ? "that opens a PR and exits when done."
          : "that exits when done.",
    });
  } else if (d.then === "until-merged") {
    parts.push({
      text: d.mergeWhenReady
        ? "that opens a PR and keeps working on it until it merges."
        : "that opens a PR and keeps it green until you merge it.",
    });
  } else if (d.then === "waits-for-me") {
    parts.push({ text: "that waits for you between turns." });
  } else {
    parts.push({ text: "that keeps its memory between turns." });
  }
  return parts;
}

/** What the sentence can't fill in, plus the prompt (or command) when the work needs one. */
export function missingFields(d: WorkDraft, ctx: Parameters<typeof describe>[1] = {}) {
  const gaps = describe(d, ctx).flatMap((p) => ("missing" in p ? [p.field] : []));
  // A terminal that opens a shell needs nothing to run; a command needs its
  // command; and everything an agent runs unattended needs a prompt.
  // (An agent terminal you open on your machine can start without one.)
  if (asksForPrompt(d) && !d.prompt.trim() && deriveKind(d) !== "local-terminal") {
    gaps.push("prompt");
  }
  return gaps;
}

/** Whether the What section asks for anything: an agent's prompt, or a command to run. */
export function asksForPrompt(d: WorkDraft): boolean {
  // A pod session starts empty: only its repo and name travel.
  if (deriveKind(d) === "pod-session") return false;
  return d.runtime !== TERMINAL || d.then === "exits";
}

/** The What answer is a shell command (a terminal that runs and exits), not a prompt. */
export const isCommand = (d: WorkDraft): boolean => d.runtime === TERMINAL && d.then === "exits";

// ── Editing: the kind is fixed ───────────────────────────────────────────────

/** What a saved row is called in the UI, for "saved as a …" hints. */
/** The bare word for a kind, for default names ("Job 12"). */
export const KIND_WORD: Record<WorkKind, string> = {
  "repo-task": "Task",
  "repo-blueprint": "Task",
  standalone: "Job",
  "local-blueprint": "Automation",
  "local-terminal": "Terminal",
  "pod-session": "Session",
  "persistent-agent": "Agent",
};

export const KIND_NOUN: Record<WorkKind, string> = {
  "repo-task": "a Task",
  "repo-blueprint": "a scheduled Task",
  standalone: "a Job",
  "local-blueprint": "a Local automation",
  "local-terminal": "a terminal",
  "pod-session": "a pod session",
  "persistent-agent": "a persistent agent",
};

/**
 * Editing keeps the row: an answer that would make `deriveKind` land on a
 * different table (a Job becoming a Task, a pod run moving to your machine
 * as an automation) is refused with a reason, since silently deleting and
 * recreating the row would lose its runs, webhook path, and history. The
 * reason is `undefined` when the change stays inside the saved kind.
 *
 * A row can sit on a point the form would file elsewhere — a headless
 * scheduled automation on a machine with no branch derives to a Job — so
 * the kind the draft derives to right now is allowed as well; the save
 * always patches the saved row regardless.
 */
export function kindLock(
  d: WorkDraft,
  locked: WorkKind | null,
  patch: Partial<WorkDraft>,
): string | undefined {
  if (!locked) return undefined;
  const next = deriveKind(normalize({ ...d, ...patch }));
  if (next === locked || next === deriveKind(d)) return undefined;
  return `This is saved as ${KIND_NOUN[locked]} — start new work to make it something else.`;
}

// ── Owner, pod secrets, model providers ─────────────────────────────────────

/**
 * Work that runs unattended in an Optio pod — an agent, or a command — the
 * kinds that take an owner, pod secrets, and environment settings.
 */
export function isPodWork(d: WorkDraft): boolean {
  if (isLocal(d) || (d.runtime === TERMINAL && d.then !== "exits")) return false;
  const kind = deriveKind(d);
  return (
    kind === "repo-task" ||
    kind === "repo-blueprint" ||
    kind === "standalone" ||
    kind === "persistent-agent"
  );
}

/** The kinds whose rows carry an owner (a pod or a machine run of a Task / Job / agent). */
export function takesOwner(d: WorkDraft): boolean {
  const kind = deriveKind(d);
  return (
    kind === "repo-task" ||
    kind === "repo-blueprint" ||
    kind === "standalone" ||
    kind === "persistent-agent"
  );
}

/** Who the saved row belongs to: work on a machine is always its owner's. */
export function effectiveOwner(d: WorkDraft): ResourceOwner {
  return isLocal(d) ? "me" : d.owner;
}

/** The provider the draft picked, if it is in the list. */
export function pickedProvider(
  d: WorkDraft,
  providers: ModelProvider[],
): ModelProvider | undefined {
  const id = modelProviderIdFrom(d.agentOptions);
  return id ? providers.find((p) => p.id === id) : undefined;
}

/**
 * The providers the Provider control offers for the draft's runtime: the
 * organization's, plus your own (picking one makes the work yours). Someone
 * else's personal provider (admins see them by name) is never offered.
 */
export function usableProviders(d: WorkDraft, providers: ModelProvider[]): ModelProvider[] {
  if (d.runtime === TERMINAL || !isModelProviderAgent(d.runtime)) return [];
  const runtime = d.runtime;
  return providers.filter((p) => p.agents.includes(runtime) && (p.ownerUserId === null || p.mine));
}

/** Why a provider can't be picked here, if it can't. */
export function providerDisabled(
  d: WorkDraft,
  p: ModelProvider,
  host: Pick<LocalHost, "name" | "modelProviders" | "awsProfiles"> | undefined,
): string | undefined {
  if (!isLocal(d)) {
    return p.podCredential === "none" ? "Machines only" : undefined;
  }
  if (!host) return undefined;
  if (!host.modelProviders) return `Update Optio Local on ${host.name} to use model providers`;
  if (p.localAwsProfile && !(host.awsProfiles ?? []).includes(p.localAwsProfile)) {
    return `AWS profile ${p.localAwsProfile} isn't on ${host.name}`;
  }
  return undefined;
}

/** The runtime's model field (`claudeModel`, `copilotModel`), if it has one. */
function modelFieldFor(runtime: string): string | undefined {
  if (runtime === TERMINAL) return undefined;
  return getProviderCatalog(providerForAgentType(runtime))?.modelField;
}

/**
 * Pick a provider (or `null` for Default). A provider swaps the model to its
 * first model; Default removes the key and the provider's model. A personal
 * provider makes the work yours.
 */
export function withProvider(d: WorkDraft, p: ModelProvider | null): WorkDraft {
  const field = modelFieldFor(d.runtime);
  const options = { ...d.agentOptions };
  const wasProvider = !!modelProviderIdFrom(options);
  if (!p) {
    delete options[MODEL_PROVIDER_OPTION_KEY];
    // The provider's model id means nothing to the default sign-in.
    if (field && wasProvider) delete options[field];
    return { ...d, agentOptions: options };
  }
  options[MODEL_PROVIDER_OPTION_KEY] = p.id;
  if (field) {
    const first = isModelProviderAgent(d.runtime) ? p.models[d.runtime]?.[0]?.id : undefined;
    if (first) options[field] = first;
    else delete options[field];
  }
  return { ...d, agentOptions: options, owner: p.ownerUserId !== null ? "me" : d.owner };
}

/** A picked secret name only you have (no organization secret of that name). */
export function isPersonalOnlySecret(name: string, pickable: PickableSecret[]): boolean {
  const matches = pickable.filter((s) => s.name === name);
  return matches.length > 0 && matches.every((s) => s.owner === "me");
}

/** The secrets "+ Add secret" offers: org ones always, yours unless the work is the org's. */
export function addableSecrets(d: WorkDraft, pickable: PickableSecret[]): PickableSecret[] {
  const picked = new Set(d.podSecrets ?? []);
  const seen = new Set<string>();
  return pickable.filter((s) => {
    if (picked.has(s.name) || seen.has(`${s.owner}:${s.name}`)) return false;
    seen.add(`${s.owner}:${s.name}`);
    return true;
  });
}

/** Add a secret by name; one only you have makes the work yours. */
export function withSecret(d: WorkDraft, s: PickableSecret): WorkDraft {
  const current = d.podSecrets ?? [];
  const podSecrets = current.includes(s.name) ? current : [...current, s.name];
  return { ...d, podSecrets, owner: s.owner === "me" && !isLocal(d) ? "me" : d.owner };
}

export function withoutSecret(d: WorkDraft, name: string): WorkDraft {
  return { ...d, podSecrets: (d.podSecrets ?? []).filter((n) => n !== name) };
}

/**
 * Switch the owner. Organization work can only use organization providers
 * and secrets, so making it the org's drops a personal provider (back to
 * Default) and any secret only you have.
 */
export function withOwner(
  d: WorkDraft,
  owner: ResourceOwner,
  providers: ModelProvider[],
  pickable: PickableSecret[],
  credentials: AgentCredential[] = [],
): WorkDraft {
  let next: WorkDraft = { ...d, owner };
  if (owner === "workspace") {
    const p = pickedProvider(next, providers);
    if (p && p.ownerUserId !== null) next = withProvider(next, null);
    const c = pickedCredential(next, credentials);
    if (c && c.owner === "me") next = withCredential(next, null, providers);
    if (next.podSecrets) {
      next = {
        ...next,
        podSecrets: next.podSecrets.filter((n) => !isPersonalOnlySecret(n, pickable)),
      };
    }
  }
  return next;
}

// ── Agent credentials (the "Signed in with" row) ─────────────────────────────

/** The `agentOptions.credential` value, if it names a secret (`secret:<id>`). */
export function credentialIdOf(options: AgentOptionsValues): string | null {
  const id = secretIdFromCredential(options[AGENT_CREDENTIAL_OPTION_KEY]);
  return id ? secretCredentialId(id) : null;
}

/** The secret credential the draft picked, if it is in the list. */
export function pickedCredential(
  d: WorkDraft,
  credentials: AgentCredential[],
): AgentCredential | undefined {
  const id = credentialIdOf(d.agentOptions);
  return id ? credentials.find((c) => c.kind === "secret" && c.id === id) : undefined;
}

/**
 * What the "Signed in with" row shows as picked: the secret credential,
 * else the picked provider as a credential id, else null (Default).
 */
export function signInValue(d: WorkDraft): string | null {
  const secret = credentialIdOf(d.agentOptions);
  if (secret) return secret;
  const provider = modelProviderIdFrom(d.agentOptions);
  return provider ? `provider:${provider}` : null;
}

/**
 * The credentials the row offers. A provider entry is offered when its
 * provider is usable here (serves the runtime; the organization's or yours).
 * On a machine only providers: a secret never leaves the server, the
 * machine's own CLI login applies. A terminal signs in as nothing.
 */
export function usableCredentials(
  d: WorkDraft,
  credentials: AgentCredential[],
  providers: ModelProvider[],
): AgentCredential[] {
  if (d.runtime === TERMINAL) return [];
  const usable = new Set(usableProviders(d, providers).map((p) => p.id));
  return credentials.filter((c) =>
    c.kind === "provider" ? !!c.providerId && usable.has(c.providerId) : !isLocal(d),
  );
}

/**
 * Pick a credential (or `null` for Default). A secret credential replaces a
 * provider pick (and the provider's model); a provider credential is the
 * provider pick itself (`withProvider`). One of yours makes the work yours.
 */
export function withCredential(
  d: WorkDraft,
  c: AgentCredential | null,
  providers: ModelProvider[],
): WorkDraft {
  if (c?.kind === "provider") {
    const p = providers.find((x) => x.id === c.providerId) ?? null;
    const next = withProvider(d, p);
    return { ...next, agentOptions: without(next.agentOptions, AGENT_CREDENTIAL_OPTION_KEY) };
  }
  const next = withProvider(d, null);
  const options = without(next.agentOptions, AGENT_CREDENTIAL_OPTION_KEY);
  if (!c) return { ...next, agentOptions: options };
  options[AGENT_CREDENTIAL_OPTION_KEY] = c.id;
  return {
    ...next,
    agentOptions: options,
    owner: c.owner === "me" && !isLocal(d) ? "me" : d.owner,
  };
}

function without(options: AgentOptionsValues, key: string): AgentOptionsValues {
  if (!(key in options)) return { ...options };
  const out = { ...options };
  delete out[key];
  return out;
}

/** The provider models the picker offers instead of the catalog's, when one is picked. */
export function providerModelsFor(d: WorkDraft, p: ModelProvider | undefined) {
  if (!p || !isModelProviderAgent(d.runtime)) return undefined;
  return p.models[d.runtime] ?? [];
}

/**
 * The agent options you last used for `runtime` (from `GET
 * /api/me/work-defaults`), minus what no longer applies: a model provider
 * that's gone, someone else's, or doesn't serve the runtime is dropped along
 * with its model (a provider's model id means nothing without it). Any other
 * model is kept — free-text models exist. Null when nothing is saved.
 */
export function savedOptionsFor(
  defaults: WorkFormDefaults | null | undefined,
  runtime: string,
  providers: ModelProvider[],
): AgentOptionsValues | null {
  if (runtime === TERMINAL) return null;
  const saved = defaults?.agentOptions?.[runtime];
  if (!saved || typeof saved !== "object") return null;
  // Only string / boolean values are options (the API stores nothing else).
  const out: AgentOptionsValues = {};
  for (const [k, v] of Object.entries(saved)) {
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  const providerId = modelProviderIdFrom(out);
  if (providerId) {
    const p = providers.find((x) => x.id === providerId);
    const usable =
      !!p &&
      isModelProviderAgent(runtime) &&
      p.agents.includes(runtime) &&
      (p.ownerUserId === null || !!p.mine);
    if (!usable) {
      delete out[MODEL_PROVIDER_OPTION_KEY];
      const field = modelFieldFor(runtime);
      if (field) delete out[field];
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Options for a runtime as the form starts it: saved ones, with a personal provider making the work yours. */
export function withSavedOptions(
  d: WorkDraft,
  options: AgentOptionsValues,
  providers: ModelProvider[],
): WorkDraft {
  const p = pickedProvider({ ...d, agentOptions: options }, providers);
  return {
    ...d,
    agentOptions: options,
    owner: p && p.ownerUserId !== null && !isLocal(d) ? "me" : d.owner,
  };
}

/**
 * A blank New work form with your last settings applied: your machine when
 * the work ran there last and that machine is still paired (`hosts`; the
 * directory follows, and the picker falls back when it is gone from the
 * allowlist), the remembered runtime when it can run there (never a bare
 * terminal — the runtime key is always an agent), and that runtime's saved
 * options. Without saved options for the runtime it lands on, the draft's
 * own options stay.
 */
export function applyWorkDefaults(
  d: WorkDraft,
  defaults: WorkFormDefaults | null | undefined,
  providers: ModelProvider[],
  hosts: ReadonlyArray<{ id: string }> = [],
): WorkDraft {
  if (!defaults || d.runtime === TERMINAL) return d;
  const where = defaults.location;
  const machine =
    where?.runTarget === "local" && where.localHostId
      ? hosts.find((h) => h.id === where.localHostId)
      : undefined;
  // Like picking My machine by hand: the directory as it is, not a new branch.
  const placed: WorkDraft = machine
    ? {
        ...d,
        location: {
          ...d.location,
          runTarget: "local",
          localHostId: machine.id,
          localDir: where?.localDir ?? "",
        },
        withRepo: false,
      }
    : d;
  const wanted = defaults.runtime;
  const runtime =
    wanted &&
    wanted !== TERMINAL &&
    runtimeOptions(placed).some((r) => r.value === wanted && !r.disabled)
      ? wanted
      : placed.runtime;
  const next: WorkDraft =
    runtime === placed.runtime ? placed : { ...placed, runtime, agentOptions: {} };
  const saved = savedOptionsFor(defaults, runtime, providers);
  return normalize(saved ? withSavedOptions(next, saved, providers) : next);
}

/** Same values, ignoring blank entries (a blank select means "default"). */
export function sameOptions(a: AgentOptionsValues, b: AgentOptionsValues): boolean {
  const clean = (o: AgentOptionsValues) =>
    Object.entries(o)
      .filter(([, v]) => v !== "" && v !== undefined)
      .sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

/**
 * Apply an example chip. A chip that doesn't set agent options itself (it
 * leaves them blank) starts its runtime from your saved settings, so a stray
 * click doesn't lose the remembered model — unless you've already changed
 * that runtime's options on this form (`touched`).
 */
export function applyPreset(
  d: WorkDraft,
  preset: Preset,
  defaults: WorkFormDefaults | null | undefined,
  providers: ModelProvider[],
  touched: ReadonlySet<string> = new Set(),
  repo?: RepoRow,
): WorkDraft {
  const next = normalize(preset.apply(d));
  if (Object.keys(next.agentOptions).length > 0 || touched.has(next.runtime)) return next;
  const saved = savedOptionsFor(defaults, next.runtime, providers);
  return startWith(next, next.runtime, repo, saved, providers);
}

type RepoRow = Record<string, unknown> | null | undefined;

/** The repo's saved agent defaults apply: pod work, with a repo, driven by an agent. */
export function repoDefaultsApply(d: WorkDraft): boolean {
  return fullOptionsApply(d) && d.withRepo;
}

/**
 * Where a runtime's parameters start — the precedence. For pod work with a
 * repo, a repo with settings of its own for the runtime wins; otherwise the
 * settings you used last (`saved`); otherwise the repo's (its column
 * defaults), or nothing.
 */
export function startingOptions(
  d: WorkDraft,
  runtime: string,
  repo: RepoRow,
  saved: AgentOptionsValues | null,
): { options: AgentOptionsValues; from: "repo" | "saved" | "none" } {
  const repoApplies = !!repo && repoDefaultsApply({ ...d, runtime });
  if (repoApplies && repoHasOwnOptions(runtime, repo)) {
    return { options: optionsFromRepo(runtime, repo), from: "repo" };
  }
  if (saved) return { options: saved, from: "saved" };
  if (repoApplies) return { options: optionsFromRepo(runtime, repo), from: "repo" };
  return { options: {}, from: "none" };
}

/** The draft on `runtime`, its parameters started by `startingOptions`. */
export function startWith(
  d: WorkDraft,
  runtime: string,
  repo: RepoRow,
  saved: AgentOptionsValues | null,
  providers: ModelProvider[],
): WorkDraft {
  const fresh: WorkDraft = { ...d, runtime, agentOptions: {} };
  const { options, from } = startingOptions(fresh, runtime, repo, saved);
  if (from === "saved") return normalize(withSavedOptions(fresh, options, providers));
  return normalize({ ...fresh, agentOptions: options });
}

/**
 * A repo with saved defaults of its own takes over the agent: its default
 * agent (when that can run here — a bare terminal stays one) and that
 * agent's parameters. A repo nobody configured leaves the draft alone, so
 * your last settings stand.
 */
export function withRepoDefaults(d: WorkDraft, repo: RepoRow): WorkDraft {
  if (!repo || !repoDefaultsApply(d)) return d;
  const own = repoOwnRuntime(repo);
  const runtime =
    own && runtimeOptions(d).some((r) => r.value === own && !r.disabled) ? own : d.runtime;
  if (runtime === d.runtime && !repoHasOwnOptions(runtime, repo)) return d;
  return normalize({ ...d, runtime, agentOptions: optionsFromRepo(runtime, repo) });
}

/** The repo's default agent as the form names it ("claude-code" when unset). */
function repoRuntime(repo: Record<string, unknown>): string {
  const agent = repo.defaultAgentType;
  return typeof agent === "string" && RUNTIMES.some((r) => r.value === agent)
    ? agent
    : "claude-code";
}

/** Whether the draft's agent and its parameters are still the repo's defaults. */
export function matchesRepoDefaults(d: WorkDraft, repo: RepoRow): boolean {
  if (!repo) return false;
  return (
    d.runtime === repoRuntime(repo) && sameOptions(d.agentOptions, optionsFromRepo(d.runtime, repo))
  );
}

/** Back to the repo's defaults: its agent (when it can run here) and that agent's parameters. */
export function resetToRepoDefaults(d: WorkDraft, repo: RepoRow): WorkDraft {
  if (!repo) return d;
  const wanted = repoRuntime(repo);
  const runtime = runtimeOptions(d).some((r) => r.value === wanted && !r.disabled)
    ? wanted
    : d.runtime;
  return normalize({ ...d, runtime, agentOptions: optionsFromRepo(runtime, repo) });
}

// ── Connected to ────────────────────────────────────────────────────────────

/** Which setting a catalog entry's toggle changes — see `WorkEnvironmentEntry`. */
export function entryOn(d: WorkDraft, entry: WorkEnvironmentEntry): boolean {
  if (entry.kind === "secret") return (d.podSecrets ?? []).includes(entry.id);
  const part: EnvironmentPart = entry.kind === "connection" ? "connections" : "mcpServers";
  return overrideOn(d.settings[part], entry.id, entry.default);
}

/**
 * The draft with a catalog entry connected or disconnected. A connection or
 * an MCP server becomes an override on the defaults; a secret joins
 * `podSecrets` — and a private one flips the work's owner to the viewer
 * (`withSecret`), which `note` explains when it happens.
 */
export function withEntry(
  d: WorkDraft,
  entry: WorkEnvironmentEntry,
  on: boolean,
): { draft: WorkDraft; note: string | null } {
  if (entry.kind === "secret") {
    if (!on) return { draft: withoutSecret(d, entry.id), note: null };
    const owner: PickableSecret["owner"] = entry.ownerUserId ? "me" : "workspace";
    const flips = owner === "me" && d.owner !== "me" && !isLocal(d);
    return {
      draft: withSecret(d, { name: entry.id, owner }),
      note: flips ? `${entry.id} is your own secret, so this work now runs as you.` : null,
    };
  }
  const part: EnvironmentPart = entry.kind === "connection" ? "connections" : "mcpServers";
  return {
    draft: {
      ...d,
      settings: {
        ...d.settings,
        [part]: toggleOverride(d.settings[part], entry.id, entry.default, on),
      },
    },
    note: null,
  };
}
