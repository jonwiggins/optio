import { toLocalAgentKind } from "@optio/shared";
import type { TriggerConfig } from "@/components/trigger-selector";
import { CLUSTER_RUN_LOCATION, type RunLocationValue } from "@/components/run-location-picker";

/**
 * One session, five attributes. Every kind of work Optio runs — a Task that
 * opens a PR, a Job, a scheduled blueprint, a Local automation, an
 * interactive terminal, a Persistent Agent — is a point in this space, and
 * the storage row it becomes (`deriveKind`) is a pure function of the point.
 *
 *   THEN   what happens when a turn ends: exits / waits for me / waits for messages
 *   WHERE  an Optio pod or the user's own machine, plus the repo or checkout
 *   WHO    the agent runtime (or a bare shell), and the persistent-agent identity
 *   WHAT   title, prompt, and the knobs on the run
 *   WHEN   what starts it: manual, schedule, webhook, ticket, or a GitHub / Slack /
 *          Linear event (machine only)
 */

export type Then = "exits" | "waits-for-me" | "waits-for-messages";

export type EventTriggerType = "github" | "slack" | "linear";
export type WhenType = TriggerConfig["type"] | EventTriggerType;

export interface EventTrigger {
  type: EventTriggerType;
  config: Record<string, unknown>;
}

export interface SessionDraft {
  then: Then;
  location: RunLocationValue;
  /** Pod: pick a registered repo. Machine: the checkout is the repo. */
  withRepo: boolean;
  repoId: string;
  repoUrl: string;
  repoBranch: string;
  /** "" = a plain shell (only when the session waits for me on a machine). */
  runtime: string;
  agent: {
    slug: string;
    name: string;
    podLifecycle: "sticky" | "always-on" | "on-demand";
    model: string;
    systemPrompt: string;
    agentsMd: string;
  };
  title: string;
  prompt: string;
  description: string;
  priority: number;
  maxRetries: number;
  dependsOn: string[];
  when: WhenType;
  trigger: TriggerConfig;
  event: EventTrigger;
}

export const RUNTIMES: Array<{ value: string; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "opencode", label: "OpenCode (Experimental)" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openclaw", label: "OpenClaw (Experimental)" },
  { value: "cursor", label: "Cursor" },
];

export const SHELL = "";

export function runtimeLabel(runtime: string): string {
  if (runtime === SHELL) return "shell";
  return RUNTIMES.find((r) => r.value === runtime)?.label ?? runtime;
}

export const EMPTY_DRAFT: SessionDraft = {
  then: "exits",
  location: CLUSTER_RUN_LOCATION,
  withRepo: true,
  repoId: "",
  repoUrl: "",
  repoBranch: "main",
  runtime: "claude-code",
  agent: {
    slug: "",
    name: "",
    podLifecycle: "sticky",
    model: "",
    systemPrompt: "",
    agentsMd: "",
  },
  title: "",
  prompt: "",
  description: "",
  priority: 100,
  maxRetries: 3,
  dependsOn: [],
  when: "manual",
  trigger: { type: "manual" },
  event: { type: "github", config: { events: ["review_requested", "mentioned"], login: "" } },
};

// ── Presets ──────────────────────────────────────────────────────────────────

export interface Preset {
  id: string;
  label: string;
  hint: string;
  apply: (d: SessionDraft) => SessionDraft;
}

export const PRESETS: Preset[] = [
  {
    id: "pr",
    label: "Open a PR",
    hint: "An agent changes a repo on a branch and opens a pull request.",
    apply: (d) => ({
      ...d,
      then: "exits",
      location: { ...d.location, runTarget: "cluster" },
      withRepo: true,
      when: "manual",
      trigger: { type: "manual" },
    }),
  },
  {
    id: "chat",
    label: "Interactive chat",
    hint: "An interactive session on your machine you can type into.",
    apply: (d) => ({
      ...d,
      then: "waits-for-me",
      location: { ...d.location, runTarget: "local", localSessionMode: "interactive" },
      withRepo: false,
      when: "manual",
      trigger: { type: "manual" },
    }),
  },
  {
    id: "schedule",
    label: "Scheduled run",
    hint: "An agent runs on a cron with no repo and exits.",
    apply: (d) => ({
      ...d,
      then: "exits",
      location: { ...d.location, runTarget: "cluster" },
      withRepo: false,
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * *" },
    }),
  },
  {
    id: "agent",
    label: "Persistent agent",
    hint: "A named agent that keeps memory and wakes on messages.",
    apply: (d) => ({
      ...d,
      then: "waits-for-messages",
      location: { ...d.location, runTarget: "cluster" },
      withRepo: false,
      when: "manual",
      trigger: { type: "manual" },
    }),
  },
];

// ── Derived facts ────────────────────────────────────────────────────────────

export const isLocal = (d: SessionDraft) => d.location.runTarget === "local";
export const isEventWhen = (w: WhenType): w is EventTriggerType =>
  w === "github" || w === "slack" || w === "linear";
export const isTriggered = (d: SessionDraft) => d.when !== "manual";

/** The runtimes the picked Then / Where allow. */
export function runtimeOptions(d: SessionDraft): Array<{ value: string; label: string }> {
  const list = isLocal(d)
    ? RUNTIMES.filter((r) => toLocalAgentKind(r.value) !== null)
    : RUNTIMES.filter((r) => d.then !== "waits-for-messages" || r.value !== "openclaw");
  if (d.then === "waits-for-me" && isLocal(d))
    return [...list, { value: SHELL, label: "Just a shell" }];
  return list;
}

/** Which When choices make sense for the picked Then / Where. */
export function whenOptions(d: SessionDraft): WhenType[] {
  if (d.then === "waits-for-me" && !isLocal(d)) return ["manual"];
  if (d.then === "waits-for-messages") return ["manual", "schedule", "webhook", "ticket"];
  const base: WhenType[] = ["manual", "schedule", "webhook", "ticket"];
  return isLocal(d) ? [...base, "github", "slack", "linear"] : base;
}

/** Pod sessions that wait for you are a repo terminal; nothing else is forced. */
export function needsRepo(d: SessionDraft): boolean {
  return d.withRepo || (d.then === "waits-for-me" && !isLocal(d));
}

/**
 * Snap a draft back into the space its Then / Where allow, after either
 * changes: an agent that can't run here, a When that doesn't exist here, a
 * repo requirement that vanished.
 */
export function normalize(d: SessionDraft): SessionDraft {
  let next = d;
  if (next.then === "waits-for-messages" && isLocal(next)) {
    next = { ...next, location: { ...next.location, runTarget: "cluster" } };
  }
  if (next.then === "waits-for-me" && !isLocal(next)) next = { ...next, withRepo: true };
  if (next.then === "waits-for-messages") next = { ...next, withRepo: false };
  const runtimes = runtimeOptions(next);
  if (!runtimes.some((r) => r.value === next.runtime)) {
    next = { ...next, runtime: runtimes[0]?.value ?? "claude-code" };
  }
  if (!whenOptions(next).includes(next.when)) {
    next = { ...next, when: "manual", trigger: { type: "manual" } };
  }
  const mode = next.then === "waits-for-me" ? "interactive" : "headless";
  if (next.location.localSessionMode !== mode) {
    next = { ...next, location: { ...next.location, localSessionMode: mode } };
  }
  return next;
}

// ── Kind: the storage row a draft becomes ────────────────────────────────────

export type SessionKind =
  | "repo-task" // tasks (one-shot, opens a PR)
  | "repo-blueprint" // task_configs + trigger
  | "standalone" // workflows (+ trigger, or run now)
  | "local-blueprint" // local_blueprints + trigger (event triggers, or interactive + trigger)
  | "local-terminal" // local_terminals (interactive, on a machine)
  | "pod-session" // interactive_sessions (interactive, in a repo pod)
  | "persistent-agent"; // persistent_agents

export function deriveKind(d: SessionDraft): SessionKind {
  if (d.then === "waits-for-messages") return "persistent-agent";
  if (d.then === "waits-for-me") {
    if (!isLocal(d)) return "pod-session";
    return isTriggered(d) ? "local-blueprint" : "local-terminal";
  }
  if (isEventWhen(d.when)) return "local-blueprint";
  if (d.withRepo) return isTriggered(d) ? "repo-blueprint" : "repo-task";
  return "standalone";
}

// ── The sentence ─────────────────────────────────────────────────────────────

export type SentencePart = { text: string } | { missing: string; field: SentenceField };

export type SentenceField =
  | "checkout"
  | "repo"
  | "machine"
  | "title"
  | "prompt"
  | "slug"
  | "cron"
  | "webhook";

const WEEKDAY_CRON: Record<string, string> = {
  "0 * * * *": "every hour",
  "0 */6 * * *": "every 6 hours",
  "0 9 * * *": "daily at 09:00 UTC",
  "0 9 * * 1-5": "weekdays at 09:00 UTC",
  "0 9 * * 1": "Mondays at 09:00 UTC",
};

function whenPhrase(d: SessionDraft): SentencePart[] {
  switch (d.when) {
    case "manual":
      if (d.then === "waits-for-messages") return [{ text: "woken by messages" }];
      return [{ text: d.then === "exits" ? "started now" : "opened now" }];
    case "schedule": {
      const cron = d.trigger.cronExpression?.trim();
      if (!cron || cron.split(/\s+/).length !== 5)
        return [{ missing: "a schedule", field: "cron" }];
      return [{ text: `running ${WEEKDAY_CRON[cron] ?? `on \`${cron}\``}` }];
    }
    case "webhook":
      return d.trigger.webhookPath
        ? [{ text: `started by a webhook at /api/hooks/${d.trigger.webhookPath}` }]
        : [{ missing: "a webhook path", field: "webhook" }];
    case "ticket":
      return [{ text: `started by ${d.trigger.ticketSource ?? "github"} tickets` }];
    case "github":
      return [{ text: "started by GitHub events" }];
    case "slack":
      return [{ text: "started by Slack messages" }];
    case "linear":
      return [{ text: "started by Linear events" }];
  }
}

function shortDir(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

/**
 * "A Claude Code session on my machine in ~/repos/optio that opens a PR and
 * exits when done, started now." Missing pieces are rendered as gaps that
 * point at the field, so the sentence is also the validation.
 */
export function describe(
  d: SessionDraft,
  ctx: { repoName?: string | null; machineName?: string | null } = {},
): SentencePart[] {
  const parts: SentencePart[] = [];
  const who = d.runtime === SHELL ? "A shell" : `A ${runtimeLabel(d.runtime)}`;
  parts.push({ text: `${who} ${d.then === "waits-for-messages" ? "agent" : "session"}` });

  if (d.then === "waits-for-messages") {
    parts.push(
      d.agent.slug ? { text: `named ${d.agent.slug}` } : { missing: "a name", field: "slug" },
    );
    parts.push({ text: "in an Optio pod" });
  } else if (isLocal(d)) {
    parts.push(
      d.location.localHostId
        ? { text: `on ${ctx.machineName ?? "my machine"}` }
        : { missing: "a machine", field: "machine" },
    );
    parts.push(
      d.location.localDir
        ? { text: `in ${shortDir(d.location.localDir)}` }
        : { missing: d.withRepo ? "a checkout" : "a directory", field: "checkout" },
    );
  } else {
    parts.push({ text: "in an Optio pod" });
    if (needsRepo(d)) {
      parts.push(
        d.repoUrl
          ? { text: `with ${ctx.repoName ?? d.repoUrl}` }
          : { missing: "a repo", field: "repo" },
      );
    }
  }

  if (d.then === "exits") {
    parts.push({
      text: d.withRepo ? "that opens a PR and exits when done," : "that exits when done,",
    });
  } else if (d.then === "waits-for-me") {
    parts.push({ text: "that waits for you between turns," });
  } else {
    parts.push({ text: "that keeps its memory and waits for messages," });
  }

  parts.push(...whenPhrase(d));
  parts.push({ text: "." });
  return parts;
}

/** Fields the sentence can't fill in, plus the ones the sentence doesn't mention. */
export function missingFields(d: SessionDraft, ctx: Parameters<typeof describe>[1] = {}) {
  const gaps = describe(d, ctx).flatMap((p) => ("missing" in p ? [p.field] : []));
  const kind = deriveKind(d);
  // A terminal you open by hand needs neither: it's a place to type, and its
  // title defaults to the directory. Everything else is named and prompted.
  const adHocTerminal = kind === "pod-session" || kind === "local-terminal";
  if (!adHocTerminal && !d.title.trim()) gaps.push("title");
  if (!adHocTerminal && d.runtime !== SHELL && !d.prompt.trim()) gaps.push("prompt");
  return gaps;
}
