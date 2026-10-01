/**
 * What a piece of work changes about the environment its pod gives the
 * agent. The repo's settings (and the workspace's) are the defaults; a Task,
 * a scheduled Task, a Job, or a persistent agent can add to them, take from
 * them, or replace a value — the Where section of the New work form. Every
 * field is optional, and unset means "the default".
 *
 * The overlay is the same for every kind of pod work, and each part is read
 * by the one place that owns it: the agent environment (connections, MCP
 * servers, skills, setup commands) by `agent-environment-service`, the PR
 * follow-through by the reconciler's snapshot. Work on a machine runs with
 * the machine's own CLI configuration and takes none of it.
 */

/** Ids to add to a default set, and ids to take out of it. */
export interface IdOverrides {
  add?: string[];
  remove?: string[];
}

/** When a review agent looks at the PR: as it opens, or once CI passes. */
export type WorkReviewTrigger = "on_pr" | "on_ci_pass";

export interface WorkSettings {
  /** Connections (ids) on top of the ones the repo's assignments give, or left out. */
  connections?: IdOverrides;
  /** MCP servers (ids) on top of the workspace's and the repo's, or left out. */
  mcpServers?: IdOverrides;
  /** Custom skills (ids) on top of the workspace's and the repo's, or left out. */
  skills?: IdOverrides;
  /** Shell commands run in the work's directory before the agent starts. */
  setupCommands?: string | null;
  /** Repo work: a review agent reviews the PR (over the repo's Code Review setting). */
  review?: { enabled: boolean; trigger?: WorkReviewTrigger } | null;
  /** Repo work: open draft PRs that a person merges (over the repo's cautious mode). */
  cautiousMode?: boolean | null;
  /** Repo work: how many times the agent is resumed on CI failures and review comments. */
  maxAutoResumes?: number | null;
}

/** The parts of `WorkSettings` that only mean something for work that opens a PR. */
export const PR_SETTING_KEYS = ["review", "cautiousMode", "maxAutoResumes"] as const;

/**
 * A default set with the overrides applied: the defaults minus `remove`, plus
 * the `add`ed ones from `available` that aren't already in. Unknown ids are
 * ignored, so an override that names something since deleted does nothing.
 */
export function applyIdOverrides<T>(
  defaults: readonly T[],
  available: readonly T[],
  idOf: (item: T) => string,
  overrides: IdOverrides | null | undefined,
): T[] {
  const remove = new Set(overrides?.remove ?? []);
  const kept = defaults.filter((item) => !remove.has(idOf(item)));
  const have = new Set(kept.map(idOf));
  for (const id of overrides?.add ?? []) {
    if (have.has(id) || remove.has(id)) continue;
    const item = available.find((a) => idOf(a) === id);
    if (item) {
      kept.push(item);
      have.add(id);
    }
  }
  return kept;
}

function cleanIds(o: IdOverrides | undefined): IdOverrides | undefined {
  const add = [...new Set((o?.add ?? []).filter(Boolean))];
  const remove = [...new Set((o?.remove ?? []).filter((id) => id && !add.includes(id)))];
  if (add.length === 0 && remove.length === 0) return undefined;
  return { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
}

/**
 * Settings as stored: empty parts dropped, ids deduplicated (an id both added
 * and removed is added), and null when nothing is left — so work that changes
 * nothing stores nothing and keeps following the repo.
 */
export function cleanWorkSettings(s: WorkSettings | null | undefined): WorkSettings | null {
  if (!s) return null;
  const out: WorkSettings = {};
  const connections = cleanIds(s.connections);
  if (connections) out.connections = connections;
  const mcpServers = cleanIds(s.mcpServers);
  if (mcpServers) out.mcpServers = mcpServers;
  const skills = cleanIds(s.skills);
  if (skills) out.skills = skills;
  const setup = s.setupCommands?.trim();
  if (setup) out.setupCommands = setup;
  if (s.review) {
    out.review = {
      enabled: !!s.review.enabled,
      ...(s.review.trigger ? { trigger: s.review.trigger } : {}),
    };
  }
  if (typeof s.cautiousMode === "boolean") out.cautiousMode = s.cautiousMode;
  if (typeof s.maxAutoResumes === "number" && Number.isFinite(s.maxAutoResumes)) {
    out.maxAutoResumes = Math.max(0, Math.floor(s.maxAutoResumes));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Settings without the PR follow-through, for work that opens no PR. */
export function withoutPrSettings(s: WorkSettings | null): WorkSettings | null {
  if (!s) return null;
  const rest: WorkSettings = { ...s };
  for (const key of PR_SETTING_KEYS) delete rest[key];
  return cleanWorkSettings(rest);
}

/** One connection, MCP server, or skill the Where section can switch on or off. */
export interface WorkEnvironmentItem {
  id: string;
  name: string;
  /** What it is: the connection's provider, the server's command, the skill's description. */
  detail?: string | null;
  /** Where it comes from when it is on by default: "global", "repo", "assigned". */
  scope: string;
  /** On without any override (the repo's / workspace's default for this work). */
  default: boolean;
}

/**
 * What the Where section shows for a piece of pod work: everything the agent
 * could get, with the repo's defaults marked, and the repo's PR settings the
 * overrides start from. `GET /api/work/environment`.
 */
export interface WorkEnvironmentOptions {
  connections: WorkEnvironmentItem[];
  mcpServers: WorkEnvironmentItem[];
  skills: WorkEnvironmentItem[];
  /** The repo's own values (null when the work has no repo). */
  repo: {
    setupCommands: string | null;
    reviewEnabled: boolean;
    reviewTrigger: string | null;
    cautiousMode: boolean;
    maxAutoResumes: number | null;
  } | null;
}
