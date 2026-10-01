/**
 * Work described by its five attributes — what `POST /api/work` takes and
 * `PATCH /api/work/:id` saves — and the rule that turns the answers into the
 * kind of row the server stores (`deriveWorkKind`). The New work form and the
 * server share both, so the form's preview and the row it creates can't
 * disagree. Like `feed.ts`, this lives outside `types/`: it is not a mobile
 * model.
 */
import type { ResourceOwner } from "../types/model-provider.js";
import type { WorkSource, WorkThen } from "./feed.js";

/** The kind of row a piece of work is stored as — the same names the Work list uses. */
export type WorkKind = WorkSource;

/** The kinds that save a definition (and its trigger) to run again. */
export const WORK_DEFINITION_KINDS = ["repo-blueprint", "standalone", "local-blueprint"] as const;
export type WorkDefinitionKind = (typeof WORK_DEFINITION_KINDS)[number];

export const isWorkDefinitionKind = (kind: string): kind is WorkDefinitionKind =>
  (WORK_DEFINITION_KINDS as readonly string[]).includes(kind);

/** The answers the kind follows from. */
export interface WorkKindAnswers {
  then: WorkThen;
  /** Where: on the person's own machine (vs an Optio pod). */
  local: boolean;
  /** When: something other than "now" starts it — a schedule, a webhook, an event. */
  triggered: boolean;
  /** Where: it works in a repo checkout and opens a PR. */
  withRepo: boolean;
}

/**
 * Which row a piece of work becomes. Then decides first (an agent that waits
 * for messages, a session that waits for you, or work that exits); for work
 * that waits for you Where decides (a pod session, or a terminal on your
 * machine — saved as an automation when something other than "now" starts
 * it); for work that exits, a repo makes it a Task (saved as a scheduled
 * Task when triggered) and no repo makes it a Job.
 */
export function deriveWorkKind(a: WorkKindAnswers): WorkKind {
  if (a.then === "waits-for-messages") return "persistent-agent";
  if (a.then === "waits-for-me") {
    if (!a.local) return "pod-session";
    return a.triggered ? "local-blueprint" : "local-terminal";
  }
  if (a.withRepo) return a.triggered ? "repo-blueprint" : "repo-task";
  return "standalone";
}

/** **When**: now (or on demand), or the trigger that starts it. */
export type WorkWhen =
  | { type: "manual" }
  | {
      type: "schedule" | "webhook" | "ticket" | "github" | "slack" | "linear";
      config: Record<string, unknown>;
    };

/** **Where**: an Optio pod or a machine, and the repo it works in, if any. */
export interface WorkWhereSpec {
  runTarget: "cluster" | "local";
  /** The repo it checks out and opens a PR against; null = no repo. */
  repoUrl?: string | null;
  /**
   * The branch the work starts from (and its PR targets). On a machine it
   * also says the work happens on a new branch that becomes a PR (null =
   * the directory as it is), even when the checkout's remote isn't known.
   */
  repoBranch?: string | null;
  /** Local work: the machine and the allowlisted directory on it. */
  localHostId?: string | null;
  localDir?: string | null;
}

/** **Who**: an agent runtime and its parameters, or a plain terminal. */
export interface WorkWho {
  /** Agent type (`claude-code`, `codex`, …); null = a plain terminal. */
  runtime: string | null;
  /** Per-run agent parameters keyed like the provider catalog; null = defaults. */
  agentOptions?: Record<string, string | boolean> | null;
  /** The legacy single model field some kinds still carry. */
  model?: string | null;
}

/** **What**: the prompt (a terminal's command) and what each run is called. */
export interface WorkWhat {
  /** A `{{param}}` template for triggered work; may be empty for a terminal. */
  prompt: string;
  /** Name each run gets, a `{{param}}` template; null = the work's name. */
  runTitle?: string | null;
}

/** A persistent agent's identity and pod (Then = waits for messages). */
export interface WorkAgentSpec {
  slug?: string;
  systemPrompt?: string | null;
  agentsMd?: string | null;
  podLifecycle?: "always-on" | "sticky" | "on-demand";
}

/** Work described by its attributes — the body of `POST /api/work`. */
export interface WorkSpec {
  name: string;
  description?: string | null;
  when: WorkWhen;
  where: WorkWhereSpec;
  who: WorkWho;
  what: WorkWhat;
  then: WorkThen;
  /** "Works until merged": merge the PR once checks pass (default true). */
  mergeWhenReady?: boolean;
  maxRetries?: number;
  priority?: number;
  /** A one-off Task that waits for these tasks first. */
  dependsOn?: string[];
  agent?: WorkAgentSpec;
  /**
   * Who it belongs to: the organization's, or yours (it then runs with your
   * credentials). Unset: yours when it picks a personal provider or secret.
   * Work on a machine is always yours.
   */
  owner?: ResourceOwner;
  /** Pod work: the secrets its pod gets, by name (null = the workspace's legacy behavior). */
  podSecrets?: string[] | null;
}

/** What `POST /api/work` made. */
export interface WorkCreated {
  kind: WorkKind;
  id: string;
  /** The page about it. */
  href: string;
  /** A Job started now: its first run. */
  run?: { id: string; href: string };
}

/** Whether a spec's work happens in a repo checkout and opens a PR. */
export function specWithRepo(where: WorkWhereSpec): boolean {
  return where.runTarget === "local" ? !!where.repoBranch : !!where.repoUrl;
}

/** The kind a spec describes. */
export function kindOfSpec(spec: Pick<WorkSpec, "when" | "where" | "then">): WorkKind {
  return deriveWorkKind({
    then: spec.then,
    local: spec.where.runTarget === "local",
    triggered: spec.when.type !== "manual",
    withRepo: specWithRepo(spec.where),
  });
}

/** A persistent agent's slug from its name: lowercase letters, digits, and dashes. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
