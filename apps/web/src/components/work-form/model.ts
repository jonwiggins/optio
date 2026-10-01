import {
  getProviderCatalog,
  isModelProviderAgent,
  MODEL_PROVIDER_OPTION_KEY,
  modelProviderIdFrom,
  providerForAgentType,
  toLocalAgentKind,
  type LocalHost,
  type ModelProvider,
  type PickableSecret,
  type ResourceOwner,
  type WorkFormDefaults,
} from "@optio/shared";
import type { TriggerConfig } from "@/components/trigger-selector";
import type { AgentOptionsValues } from "@/components/agent-options-picker";
import { CLUSTER_RUN_LOCATION, type RunLocationValue } from "@/components/run-location-picker";

/**
 * One piece of work, five attributes. Every kind of work Optio runs — a Task
 * that opens a PR, a Job, a scheduled blueprint, a Local automation, an
 * interactive terminal, a Persistent Agent — is a point in this space, and
 * the storage row it becomes (`deriveKind`) is a pure function of the point.
 *
 * The form asks in this order, each answer narrowing the next:
 *
 *   WHEN   what starts it: now, a schedule, a webhook, a ticket, or a GitHub /
 *          Slack / Linear event — every When works with every Where
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

export type Then = "exits" | "until-merged" | "waits-for-me" | "waits-for-messages";

/** Then answers that are one headless run (or one per firing), not a session. */
export const isOneShot = (then: Then): boolean => then === "exits" || then === "until-merged";

export type EventTriggerType = "github" | "slack" | "linear";
export type WhenType = TriggerConfig["type"] | EventTriggerType;

export interface EventTrigger {
  type: EventTriggerType;
  config: Record<string, unknown>;
}

/** GitHub / Linear event kinds that are "about you" and need a login to match. */
export const PERSONAL_EVENT_KINDS: Record<EventTriggerType, readonly string[]> = {
  github: ["review_requested", "mentioned", "assigned"],
  slack: [],
  linear: ["assigned", "mentioned"],
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
  // No kinds checked would mean "every kind" to the matcher — make it a choice.
  if (events.length === 0) return ["events"];
  const personal =
    events.some((k) => PERSONAL_EVENT_KINDS[e.type].includes(k)) ||
    // Linear's "only tickets from someone else" skips yours: it has to know you.
    (e.type === "linear" && c.othersOnly === true);
  const identity = String((e.type === "github" ? c.login : c.user) ?? "").trim();
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
}

export const RUNTIMES: Array<{ value: string; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Google Gemini" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "openclaw", label: "OpenClaw" },
];

export const TERMINAL = "";

export function runtimeLabel(runtime: string): string {
  if (runtime === TERMINAL) return "terminal";
  return RUNTIMES.find((r) => r.value === runtime)?.label ?? runtime;
}

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
};

// ── Derived facts ────────────────────────────────────────────────────────────

export const isLocal = (d: WorkDraft) => d.location.runTarget === "local";
export const isEventWhen = (w: WhenType): w is EventTriggerType =>
  w === "github" || w === "slack" || w === "linear";
export const isTriggered = (d: WorkDraft) => d.when !== "manual";

export const WHEN_TYPES: WhenType[] = [
  "manual",
  "schedule",
  "webhook",
  "ticket",
  "github",
  "slack",
  "linear",
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

/** The terminal and the runtimes the picked Where allows. */
export function runtimeOptions(d: WorkDraft): Choice<string>[] {
  const local = isLocal(d);
  const terminal: Choice<string> = {
    value: TERMINAL,
    ...(isTriggered(d)
      ? { disabled: "A trigger starts an agent — a terminal is opened by hand, pick Now above." }
      : !local && !d.withRepo
        ? { disabled: "A pod terminal is attached to a repo — pick a repository above." }
        : {}),
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
      value: "exits",
      ...(terminal ? { disabled: "A terminal with no agent waits for you." } : {}),
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
      value: "waits-for-messages",
      ...(local
        ? { disabled: "Persistent agents run in an Optio pod so they stay reachable." }
        : terminal
          ? { disabled: "A persistent agent needs an agent runtime." }
          : d.withRepo
            ? { disabled: "Persistent agents don't attach to a repo — pick No repo above." }
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

/** The repo's configured values for this runtime's options, to seed the picker. */
export function optionsFromRepo(
  runtime: string,
  repo: Record<string, unknown> | null | undefined,
): AgentOptionsValues {
  // Codex shares Copilot's copilotModel / copilotEffort columns, but a repo's
  // values there are Copilot's settings — Codex has none per repo.
  if (!repo || runtime === TERMINAL || runtime === "codex") return {};
  const catalog = getProviderCatalog(providerForAgentType(runtime));
  if (!catalog) return {};
  const keys = [catalog.modelField, ...catalog.options.map((o) => o.key)];
  const out: AgentOptionsValues = {};
  for (const k of keys) {
    const v = repo[k];
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** A slug for a persistent agent, from its name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ── PR follow-through ────────────────────────────────────────────────────────

/** The repo settings that decide what happens to a PR after it opens. */
export interface RepoPrSettings {
  autoResume?: boolean | null;
  autoMerge?: boolean | null;
  cautiousMode?: boolean | null;
  reviewEnabled?: boolean | null;
  reviewTrigger?: string | null;
  maxAutoResumes?: number | null;
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
 * rules the reconciler applies (`reconcile-repo.ts`): a task's own
 * follow-through ("Works until merged") wins over the repo's settings, review
 * is always the repo's, and cautious mode (draft PRs) never merges. Null when
 * the work doesn't open a PR.
 */
export function followThrough(
  d: WorkDraft,
  repo: RepoPrSettings | null | undefined,
): { fromRepo: boolean; steps: FollowThroughStep[] } | null {
  if (!d.withRepo || d.runtime === TERMINAL || !isOneShot(d.then)) return null;
  const own = d.then === "until-merged";
  const resume = own ? true : !!repo?.autoResume;
  const merge = own ? d.mergeWhenReady : !!repo?.autoMerge;
  const cautious = !!repo?.cautiousMode;
  const cap = repo?.maxAutoResumes ?? DEFAULT_MAX_AUTO_RESUMES;
  // The reconciler launches a review only on these two triggers.
  const reviewOn =
    !!repo?.reviewEnabled &&
    (repo?.reviewTrigger === "on_pr" || repo?.reviewTrigger === "on_ci_pass");
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
          ? repo?.reviewTrigger === "on_pr"
            ? "As soon as the PR opens."
            : "Once CI passes."
          : "Off for this repo — turn it on in the repo's settings.",
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
            ? "Held back: this repo opens draft PRs (cautious mode), so a person merges."
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

export type WorkKind =
  | "repo-task" // tasks (one-shot, opens a PR)
  | "repo-blueprint" // task_configs + trigger
  | "standalone" // workflows (+ trigger, or run now)
  | "local-blueprint" // local_blueprints + trigger (interactive + trigger on a machine)
  | "local-terminal" // local_terminals (interactive, on a machine)
  | "pod-session" // interactive_sessions (interactive, in a repo pod)
  | "persistent-agent"; // persistent_agents

export function deriveKind(d: WorkDraft): WorkKind {
  if (d.then === "waits-for-messages") return "persistent-agent";
  if (d.then === "waits-for-me") {
    if (!isLocal(d)) return "pod-session";
    return isTriggered(d) ? "local-blueprint" : "local-terminal";
  }
  if (d.withRepo) return isTriggered(d) ? "repo-blueprint" : "repo-task";
  return "standalone";
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
      return [{ text: `Started by ${d.trigger.ticketSource ?? "github"} tickets,` }];
    case "github":
    case "slack":
    case "linear": {
      const source = { github: "GitHub events", slack: "Slack messages", linear: "Linear events" }[
        d.when
      ];
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
  const who = d.runtime === TERMINAL ? "a terminal" : `a ${runtimeLabel(d.runtime)}`;
  // Plain English for the exit condition: a run finishes, a session waits
  // for you, an agent stays.
  const noun =
    d.then === "waits-for-messages" ? "agent" : d.then === "waits-for-me" ? "session" : "run";
  parts.push({ text: d.runtime === TERMINAL ? who : `${who} ${noun}` });

  if (d.then === "waits-for-messages") {
    parts.push({ text: "in an Optio pod" });
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
      text: d.withRepo ? "that opens a PR and exits when done." : "that exits when done.",
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

/** What the sentence can't fill in, plus the prompt when the work needs one. */
export function missingFields(d: WorkDraft, ctx: Parameters<typeof describe>[1] = {}) {
  const gaps = describe(d, ctx).flatMap((p) => ("missing" in p ? [p.field] : []));
  const kind = deriveKind(d);
  // A terminal you open by hand needs no prompt; everything an agent runs
  // unattended does.
  const adHocTerminal = kind === "pod-session" || kind === "local-terminal";
  if (!adHocTerminal && d.runtime !== TERMINAL && !d.prompt.trim()) gaps.push("prompt");
  return gaps;
}

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

/** Work that runs in an Optio pod with an agent: the kinds that take an owner and pod secrets. */
export function isPodWork(d: WorkDraft): boolean {
  if (isLocal(d) || d.runtime === TERMINAL) return false;
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
): WorkDraft {
  let next: WorkDraft = { ...d, owner };
  if (owner === "workspace") {
    const p = pickedProvider(next, providers);
    if (p && p.ownerUserId !== null) next = withProvider(next, null);
    if (next.podSecrets) {
      next = {
        ...next,
        podSecrets: next.podSecrets.filter((n) => !isPersonalOnlySecret(n, pickable)),
      };
    }
  }
  return next;
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
 * A blank New work form with your last settings applied: the remembered
 * runtime when it can run here (never a bare terminal — the runtime key is
 * always an agent), and that runtime's saved options. Without saved options
 * for the runtime it lands on, the draft's own options stay.
 */
export function applyWorkDefaults(
  d: WorkDraft,
  defaults: WorkFormDefaults | null | undefined,
  providers: ModelProvider[],
): WorkDraft {
  if (!defaults || d.runtime === TERMINAL) return d;
  const wanted = defaults.runtime;
  const runtime =
    wanted &&
    wanted !== TERMINAL &&
    runtimeOptions(d).some((r) => r.value === wanted && !r.disabled)
      ? wanted
      : d.runtime;
  const next: WorkDraft = runtime === d.runtime ? d : { ...d, runtime, agentOptions: {} };
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
): WorkDraft {
  const next = normalize(preset.apply(d));
  if (Object.keys(next.agentOptions).length > 0 || touched.has(next.runtime)) return next;
  const saved = savedOptionsFor(defaults, next.runtime, providers);
  return saved ? normalize(withSavedOptions(next, saved, providers)) : next;
}
