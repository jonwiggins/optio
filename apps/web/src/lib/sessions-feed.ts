/**
 * The unified Sessions feed: every kind of work Optio runs, projected onto
 * the five attributes the New session form asks for (When / Where / Who /
 * Then + a status), so one list and one overview can show them together.
 *
 * Today the rows come from the per-kind endpoints (unified tasks, local
 * terminals + automations, pod sessions, persistent agents) and are merged
 * client-side. A server-side `/api/sessions` read model can replace
 * `collectSessions` without touching the pages.
 */

import type { Then } from "@/components/session-form/model";

export type SessionSource =
  | "repo-task"
  | "repo-blueprint"
  | "standalone"
  | "local-blueprint"
  | "local-terminal"
  | "pod-session"
  | "persistent-agent";

export type SessionStatus =
  | "needs_you"
  | "running"
  | "queued"
  | "waiting"
  | "scheduled"
  | "paused"
  | "done"
  | "failed";

export type SessionView = "active" | "recurring" | "agents" | "history" | "all";

export interface SessionRow {
  key: string;
  source: SessionSource;
  href: string;
  name: string;
  /** What starts it, as a short label ("now", "on a trigger", "messages"). */
  when: string;
  where: { target: "pod" | "machine"; detail: string | null };
  /** Runtime id, or "terminal". */
  who: string;
  then: Then;
  status: SessionStatus;
  statusLabel: string;
  /** Extra one-liner: PR link, attention reason, next fire… */
  note: string | null;
  prUrl: string | null;
  lastActivity: string | null;
  /** Definitions that spawn runs (blueprints, automations). */
  recurring: boolean;
  /** Runs spawned from a definition / task config. */
  spawned: boolean;
}

const ACTIVE: SessionStatus[] = ["needs_you", "running", "queued", "waiting"];

export function inView(row: SessionRow, view: SessionView): boolean {
  switch (view) {
    case "active":
      return ACTIVE.includes(row.status);
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

/** needs-you first, then live, then everything by recency. */
const STATUS_RANK: Record<SessionStatus, number> = {
  needs_you: 0,
  running: 1,
  queued: 2,
  waiting: 3,
  scheduled: 4,
  paused: 5,
  failed: 6,
  done: 7,
};

export function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
  });
}

export function shortRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

export function shortDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  return dir.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

function taskStatus(state: string): [SessionStatus, string] {
  switch (state) {
    case "needs_attention":
      return ["needs_you", "needs attention"];
    case "running":
    case "provisioning":
      return ["running", state];
    case "pr_opened":
      return ["waiting", "PR open"];
    case "queued":
    case "pending":
    case "waiting_on_deps":
      return ["queued", state.replace(/_/g, " ")];
    case "completed":
      return ["done", "completed"];
    case "failed":
      return ["failed", "failed"];
    case "cancelled":
      return ["done", "cancelled"];
    default:
      return ["done", state];
  }
}

function terminalStatus(t: any): [SessionStatus, string] {
  if (t.state === "error") return ["failed", "error"];
  if (t.state === "exited") return ["done", "exited"];
  if (t.state === "pending")
    return ["queued", t.pendingReason === "host_offline" ? "host offline" : "pending"];
  if (t.attentionState === "needs_you") return ["needs_you", "needs you"];
  if (t.attentionState === "idle") return ["waiting", "idle"];
  return ["running", "working"];
}

function agentStatus(a: any): [SessionStatus, string] {
  switch (a.state) {
    case "running":
    case "provisioning":
      return ["running", a.state];
    case "queued":
      return ["queued", "queued"];
    case "idle":
      return ["waiting", "idle"];
    case "paused":
      return ["paused", "paused"];
    case "failed":
      return ["failed", "failed"];
    case "archived":
      return ["done", "archived"];
    default:
      return ["waiting", a.state ?? "idle"];
  }
}

export interface SessionSources {
  /** `GET /api/tasks?type=all` rows: repo-task | repo-blueprint | standalone. */
  unified: any[];
  localTerminals: any[];
  localBlueprints: any[];
  podSessions: any[];
  agents: any[];
  hosts: any[];
}

export function collectSessions(src: SessionSources): SessionRow[] {
  const hostName = new Map<string, string>(src.hosts.map((h: any) => [h.id, h.name]));
  const machine = (hostId: string | null | undefined, dir: string | null | undefined) => ({
    target: "machine" as const,
    detail: [hostName.get(hostId ?? "") ?? null, shortDir(dir)].filter(Boolean).join(" · ") || null,
  });
  const rows: SessionRow[] = [];

  for (const t of src.unified) {
    const local = t.runTarget === "local";
    if (t.type === "repo-task") {
      const [status, statusLabel] = taskStatus(t.state);
      rows.push({
        key: `task-${t.id}`,
        source: "repo-task",
        href: `/tasks/${t.id}`,
        name: t.title,
        when: t.metadata?.taskConfigId ? "on a trigger" : "now",
        where: local
          ? machine(t.localHostId, t.localDir)
          : { target: "pod", detail: shortRepo(t.repoUrl) },
        who: t.agentType ?? "claude-code",
        then: "exits",
        status,
        statusLabel,
        note: t.prUrl ? "PR " + t.prUrl.split("/").pop() : null,
        prUrl: t.prUrl ?? null,
        lastActivity: t.updatedAt ?? t.createdAt ?? null,
        recurring: false,
        spawned: !!t.metadata?.taskConfigId,
      });
    } else if (t.type === "repo-blueprint") {
      rows.push({
        key: `blueprint-${t.id}`,
        source: "repo-blueprint",
        href: `/tasks/scheduled/${t.id}`,
        name: t.name ?? t.title,
        when: "on a trigger",
        where: local
          ? machine(t.localHostId, t.localDir)
          : { target: "pod", detail: shortRepo(t.repoUrl) },
        who: t.agentType ?? "claude-code",
        then: "exits",
        status: t.enabled === false ? "paused" : "scheduled",
        statusLabel: t.enabled === false ? "paused" : "armed",
        note: "opens a PR each run",
        prUrl: null,
        lastActivity: t.updatedAt ?? t.createdAt ?? null,
        recurring: true,
        spawned: false,
      });
    } else if (t.type === "standalone") {
      rows.push({
        key: `job-${t.id}`,
        source: "standalone",
        href: `/jobs/${t.id}`,
        name: t.name,
        when: "on a trigger",
        where: local ? machine(t.localHostId, t.localDir) : { target: "pod", detail: null },
        who: t.agentRuntime ?? "claude-code",
        then: "exits",
        status: t.enabled === false ? "paused" : "scheduled",
        statusLabel: t.enabled === false ? "paused" : "armed",
        note: null,
        prUrl: null,
        lastActivity: t.updatedAt ?? t.createdAt ?? null,
        recurring: true,
        spawned: false,
      });
    }
  }

  for (const t of src.localTerminals) {
    // A local Task run already has its `tasks` row above; a local Job run
    // (workflow_runs) and hand-opened terminals only exist here.
    if (t.taskId) continue;
    const [status, statusLabel] = terminalStatus(t);
    const agent = t.spec?.kind === "agent" ? t.spec.agent : "terminal";
    const interactive = t.spec?.kind !== "agent" || t.spec?.mode !== "headless";
    rows.push({
      key: `terminal-${t.id}`,
      source: "local-terminal",
      href: `/local/${t.id}`,
      name: t.title ?? "Terminal",
      when: t.spawnedBy === "manual" || !t.spawnedBy ? "now" : `${t.spawnedBy}`,
      where: machine(t.hostId, t.dir),
      who: agent,
      then: interactive ? "waits-for-me" : "exits",
      status,
      statusLabel,
      note: t.attentionState === "needs_you" && t.attentionReason ? t.attentionReason : null,
      prUrl: null,
      lastActivity: t.lastActivityAt ?? t.updatedAt ?? null,
      recurring: false,
      spawned: !!t.blueprintId || !!t.workflowRunId,
    });
  }

  for (const b of src.localBlueprints) {
    rows.push({
      key: `automation-${b.id}`,
      source: "local-blueprint",
      href: "/machines#automations",
      name: b.name,
      when: "on an event",
      where: machine(b.hostId, b.dir),
      who: b.agent ?? "terminal",
      then: b.sessionMode === "headless" ? "exits" : "waits-for-me",
      status: b.enabled === false ? "paused" : "scheduled",
      statusLabel: b.enabled === false ? "paused" : "armed",
      note: null,
      prUrl: null,
      lastActivity: b.updatedAt ?? b.createdAt ?? null,
      recurring: true,
      spawned: false,
    });
  }

  for (const s of src.podSessions) {
    const active = s.state === "active";
    rows.push({
      key: `session-${s.id}`,
      source: "pod-session",
      href: `/sessions/${s.id}`,
      name: s.title || s.branch || `Session ${String(s.id).slice(0, 8)}`,
      when: "now",
      where: { target: "pod", detail: shortRepo(s.repoUrl) },
      who: "terminal",
      then: "waits-for-me",
      status: active ? "waiting" : "done",
      statusLabel: active ? "open" : "ended",
      note: null,
      prUrl: null,
      lastActivity: s.lastActivityAt ?? s.endedAt ?? s.createdAt ?? null,
      recurring: false,
      spawned: false,
    });
  }

  for (const a of src.agents) {
    const [status, statusLabel] = agentStatus(a);
    rows.push({
      key: `agent-${a.id}`,
      source: "persistent-agent",
      href: `/agents/${a.id}`,
      name: a.name ?? a.slug,
      when: "messages",
      where: { target: "pod", detail: a.slug ? `@${a.slug}` : null },
      who: a.agentRuntime ?? "claude-code",
      then: "waits-for-messages",
      status,
      statusLabel,
      note: null,
      prUrl: null,
      lastActivity: a.lastTurnAt ?? a.updatedAt ?? a.createdAt ?? null,
      recurring: false,
      spawned: false,
    });
  }

  return sortSessions(rows);
}

export interface SessionCounts {
  needsYou: number;
  running: number;
  waiting: number;
  recurring: number;
  agents: number;
}

export function countSessions(rows: SessionRow[]): SessionCounts {
  return {
    needsYou: rows.filter((r) => r.status === "needs_you").length,
    running: rows.filter((r) => r.status === "running" || r.status === "queued").length,
    waiting: rows.filter((r) => r.status === "waiting" && r.source !== "persistent-agent").length,
    recurring: rows.filter((r) => r.recurring && r.status !== "paused").length,
    agents: rows.filter((r) => r.source === "persistent-agent" && r.status !== "done").length,
  };
}
