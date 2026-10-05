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
import type { ConnectionPart, ConnectionStatus } from "../types/connection.js";
import type { ManagedBy } from "../types/config.js";

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
  /**
   * Repo work: a review agent reviews the PR even when the repo's Code Review
   * is off. Work can only add a review — never drop the repo's.
   */
  review?: { enabled: boolean; trigger?: WorkReviewTrigger } | null;
  /** Repo work: open draft PRs that a person merges, even when the repo doesn't (true only). */
  cautiousMode?: boolean | null;
  /** Repo work: resume the agent at most this many times (never more than the repo allows). */
  maxAutoResumes?: number | null;
}

/** The parts of `WorkSettings` that only mean something for work that opens a PR. */
const PR_SETTING_KEYS = ["review", "cautiousMode", "maxAutoResumes"] as const;

/**
 * A default set with the overrides applied: the defaults minus `remove`, plus
 * the `add`ed ones from `available` that aren't already in (an id both added
 * and removed is added, as `cleanWorkSettings` stores it). Unknown ids are
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
    if (have.has(id)) continue;
    const item = available.find((a) => idOf(a) === id);
    if (item) {
      kept.push(item);
      have.add(id);
    }
  }
  return kept;
}

/**
 * `applyIdOverrides` for a default set that loads asynchronously: the full
 * list (`available`) is only loaded when the overrides add something.
 */
export async function loadWithOverrides<T>(
  defaults: Promise<T[]>,
  available: () => Promise<T[]>,
  idOf: (item: T) => string,
  overrides: IdOverrides | null | undefined,
): Promise<T[]> {
  const [have, all] = await Promise.all([
    defaults,
    (overrides?.add?.length ?? 0) > 0 ? available() : Promise.resolve([] as T[]),
  ]);
  return applyIdOverrides(have, all, idOf, overrides);
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
  // The PR settings only tighten the repo's, so "no review" and "ready PRs"
  // say nothing and aren't kept.
  if (s.review?.enabled) {
    out.review = { enabled: true, ...(s.review.trigger ? { trigger: s.review.trigger } : {}) };
  }
  if (s.cautiousMode === true) out.cautiousMode = true;
  if (typeof s.maxAutoResumes === "number" && Number.isFinite(s.maxAutoResumes)) {
    out.maxAutoResumes = Math.max(0, Math.floor(s.maxAutoResumes));
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The repo settings that decide what happens to a PR after it opens. */
export interface RepoPrSettings {
  cautiousMode?: boolean | null;
  reviewEnabled?: boolean | null;
  reviewTrigger?: string | null;
  maxAutoResumes?: number | null;
}

/** The review triggers that launch a review by themselves; anything else ("manual") launches none. */
function automaticReviewTrigger(trigger: string | null | undefined): WorkReviewTrigger | null {
  return trigger === "on_pr" || trigger === "on_ci_pass" ? trigger : null;
}

/**
 * The PR follow-through a run gets. The repo's settings are admin-only, so a
 * piece of work can make its runs more careful than the repo but never less:
 * draft PRs if either says so, a review if either asks for one, and the lower
 * resume cap. A run that asks for a review gets one on its own trigger, else
 * the repo's when that one launches reviews, else once CI passes;
 * `reviewTrigger` is null when no review launches by itself. The reconciler's
 * snapshot and the New work form's plan both read this.
 */
export function effectivePrSettings(
  own: WorkSettings | null | undefined,
  repo: RepoPrSettings | null | undefined,
  defaultMaxAutoResumes: number,
): {
  cautiousMode: boolean;
  reviewEnabled: boolean;
  reviewTrigger: WorkReviewTrigger | null;
  maxAutoResumes: number;
} {
  const ownReview = own?.review?.enabled === true;
  const repoCap = repo?.maxAutoResumes ?? defaultMaxAutoResumes;
  return {
    cautiousMode: own?.cautiousMode === true || !!repo?.cautiousMode,
    reviewEnabled: ownReview || !!repo?.reviewEnabled,
    reviewTrigger: ownReview
      ? (automaticReviewTrigger(own?.review?.trigger) ??
        automaticReviewTrigger(repo?.reviewTrigger) ??
        "on_ci_pass")
      : automaticReviewTrigger(repo?.reviewTrigger),
    maxAutoResumes: Math.min(own?.maxAutoResumes ?? repoCap, repoCap),
  };
}

/** Settings without the PR follow-through, for work that opens no PR. */
export function withoutPrSettings(s: WorkSettings | null | undefined): WorkSettings | null {
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
  /** The work owner's own private item (only offered to their work). */
  private?: boolean;
  /** The owner's display name, for someone else's private item. */
  ownerName?: string | null;
}

/** Which setting a catalog entry's toggle changes. */
export type WorkEnvironmentEntryKind = "connection" | "mcpServer" | "secret";

/**
 * One thing a piece of work can be connected to — a connection, a bare
 * secret, or a hand-written MCP server — as the "Connected to" picker and
 * the Connections page list it: a logo, a name, whose it is, and what it
 * gives the agent. `kind` says which setting a toggle changes: `connection`
 * → `settings.connections`, `mcpServer` → `settings.mcpServers`, `secret` →
 * `podSecrets` (its id is the secret's name).
 */
export interface WorkEnvironmentEntry extends WorkEnvironmentItem {
  kind: WorkEnvironmentEntryKind;
  /** The provider's icon key (a brand like "aws", or "database", "folder"…); null for a secret or MCP server. */
  icon?: string | null;
  parts: ConnectionPart[];
  providerSlug?: string | null;
  providerName?: string | null;
  status?: ConnectionStatus;
  enabled: boolean;
  /** Null = the organization's; set = one person's own. */
  ownerUserId?: string | null;
  /** Set when a configuration directory manages the row (config as code). */
  managedBy?: ManagedBy | null;
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
  /** Every connection, secret, and MCP server the work could be connected to. */
  catalog: WorkEnvironmentEntry[];
  /** The repo's own values (null when the work has no repo). */
  repo: {
    setupCommands: string | null;
    reviewEnabled: boolean;
    reviewTrigger: string | null;
    cautiousMode: boolean;
    maxAutoResumes: number | null;
  } | null;
}
