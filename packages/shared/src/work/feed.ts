/**
 * The Work list: every kind of work Optio runs, projected onto the five
 * attributes the New work form asks for (When / Where / Who / Then + a
 * status) so one list and one overview can show them together.
 *
 * The server builds the rows (`GET /api/work`, `apps/api/src/services/
 * work-service.ts`); this module is the vocabulary both sides share. It lives
 * outside `types/` on purpose: the iOS and Android apps keep hand-written
 * twins of these types, so the Swift / Kotlin generators must not emit them.
 */

/** What happens when a turn ends — the form's **Then**. */
import type { ManagedBy } from "../types/config.js";
export const WORK_THENS = ["exits", "until-merged", "waits-for-me", "waits-for-messages"] as const;
export type WorkThen = (typeof WORK_THENS)[number];

/** The kind of row a Work list entry comes from — every kind of work Optio stores. */
export const WORK_SOURCES = [
  "repo-task",
  "repo-blueprint",
  "standalone",
  "local-blueprint",
  "local-terminal",
  "pod-session",
  "persistent-agent",
] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export const WORK_STATUSES = [
  "needs_you",
  "running",
  "queued",
  "waiting",
  "scheduled",
  "paused",
  "done",
  "failed",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WORK_VIEWS = ["active", "recurring", "agents", "history", "all"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

export interface WorkWhere {
  target: "pod" | "machine";
  /** Repo, `@slug`, or "machine · ~/dir"; null when there is nothing to say. */
  detail: string | null;
  /** On a machine: the `local_hosts` id it runs on (null when none is set). */
  hostId?: string | null;
  /** On a machine: its name, when it is one of the caller's machines. */
  hostName?: string | null;
  /** On a machine: the directory it runs in, as stored. */
  dir?: string | null;
}

/** A trigger that starts (or started) a piece of work: its type, and a ticket trigger's source. */
export interface WorkTrigger {
  type: string;
  source?: string | null;
}

export interface WorkRow {
  /** Unique across kinds: `task-<id>`, `terminal-<id>`, … */
  key: string;
  source: WorkSource;
  /** Id of the underlying row (`tasks.id`, `local_terminals.id`, …). */
  id: string;
  /** The web route the row opens. */
  href: string;
  name: string;
  /** What starts it, as a short label ("now", "on a trigger", "messages"). */
  when: string;
  where: WorkWhere;
  /** Runtime id, or "terminal". */
  who: string;
  then: WorkThen;
  status: WorkStatus;
  statusLabel: string;
  /** Extra one-liner: PR link, attention reason, next fire… */
  note: string | null;
  prUrl: string | null;
  /** The PR's state when known ("open" | "merged" | "closed"). */
  prState?: string | null;
  /**
   * What starts it, when known: a recurring definition's triggers, or the
   * trigger / ticket a run was started by. Drives the brand marks on the row.
   */
  triggers?: WorkTrigger[];
  /** ISO-8601; rows sort on it lexically. */
  lastActivity: string | null;
  /**
   * What the list orders the row by, when it differs from `lastActivity`:
   * a session on your machine sorts by when you last typed into it (else
   * when it was made), so it doesn't jump as its attention state flips.
   */
  orderAt?: string | null;
  /**
   * Definitions that spawn runs (blueprints, Jobs, automations). Their `href`
   * is the page about the definition (stats, triggers, prior runs);
   * `editHref` reopens its five answers in the work form.
   */
  recurring: boolean;
  editHref: string | null;
  /** Runs spawned from a definition. */
  spawned: boolean;
  /**
   * Who the work belongs to: null = the organization's; set = one person's
   * private work, which only they (and, read-only, workspace admins) see.
   * `ownerName` names them for an admin's list. Machines and pod sessions,
   * always their person's, carry none.
   */
  ownerUserId?: string | null;
  ownerName?: string | null;
  /** Set when a configuration directory manages it (the file is the truth). */
  managedBy?: ManagedBy | null;
}

export interface WorkCounts {
  needsYou: number;
  running: number;
  waiting: number;
  recurring: number;
  agents: number;
}

export const ACTIVE_WORK_STATUSES: readonly WorkStatus[] = [
  "needs_you",
  "running",
  "queued",
  "waiting",
];

export function inView(row: WorkRow, view: WorkView): boolean {
  switch (view) {
    case "active":
      return ACTIVE_WORK_STATUSES.includes(row.status);
    case "recurring":
      return row.recurring;
    case "agents":
      return row.source === "persistent-agent";
    case "history":
      return row.status === "done" || row.status === "failed";
    case "all":
      return true;
  }
}

/**
 * Live work first (needs you / running / queued / waiting share one rank, so
 * a row doesn't jump when an agent flips between working and needs-you —
 * that shows on the row and in the Needs-you count), then armed, paused,
 * failed, done; within a rank by `orderAt ?? lastActivity`, newest first.
 */
const STATUS_RANK: Record<WorkStatus, number> = {
  needs_you: 0,
  running: 0,
  queued: 0,
  waiting: 0,
  scheduled: 1,
  paused: 2,
  failed: 3,
  done: 4,
};

export function sortWork(rows: WorkRow[]): WorkRow[] {
  const at = (r: WorkRow) => r.orderAt ?? r.lastActivity ?? "";
  return [...rows].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return at(b).localeCompare(at(a)) || a.key.localeCompare(b.key);
  });
}

export function countWork(rows: WorkRow[]): WorkCounts {
  return {
    needsYou: rows.filter((r) => r.status === "needs_you").length,
    running: rows.filter((r) => r.status === "running" || r.status === "queued").length,
    waiting: rows.filter((r) => r.status === "waiting" && r.source !== "persistent-agent").length,
    recurring: rows.filter((r) => r.recurring && r.status !== "paused").length,
    agents: rows.filter((r) => r.source === "persistent-agent" && r.status !== "done").length,
  };
}

/** `https://github.com/acme/app.git` → `acme/app`. */
export function shortRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

/** `/Users/me/src/app` → `~/src/app`. */
export function shortDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  return dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}
