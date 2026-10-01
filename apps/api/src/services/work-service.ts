/**
 * Work — the read side of the one noun the UI shows for every kind of agent
 * work. `listWork` builds the Work list (`GET /api/work`) by projecting each
 * kind's rows onto `WorkRow` (When / Where / Who / Then + a status), scoped
 * exactly like the per-kind endpoints it replaces for clients: workspace rows
 * by workspace, a person's machines and pod sessions by person. `resolveWork`
 * answers "what is this id?" across every kind (`GET /api/work/:id`).
 *
 * See docs/tasks.md ("The Work feed") and docs/plans/work-unification.md.
 */
import {
  sortWork,
  shortDir,
  shortRepo,
  type WorkRow,
  type WorkSource,
  type WorkStatus,
  type WorkWhere,
} from "@optio/shared";
import type {
  interactiveSessions,
  localHosts,
  persistentAgents,
  taskConfigs,
  tasks,
  workflows,
} from "../db/schema.js";
import * as taskService from "./task-service.js";
import * as taskConfigService from "./task-config-service.js";
import * as workflowService from "./workflow-service.js";
import * as terminalService from "./local-terminal-service.js";
import * as blueprintService from "./local-blueprint-service.js";
import * as hostService from "./local-host-service.js";
import * as sessionService from "./interactive-session-service.js";
import * as paService from "./persistent-agent-service.js";
import type { LocalTerminalRow } from "./local-terminal-service.js";
import type { LocalBlueprintRow } from "./local-blueprint-service.js";

type TaskRow = typeof tasks.$inferSelect;
type TaskConfigRow = typeof taskConfigs.$inferSelect;
type WorkflowRow = typeof workflows.$inferSelect;
type PodSessionRow = typeof interactiveSessions.$inferSelect;
type PersistentAgentRow = typeof persistentAgents.$inferSelect;
type LocalHostRow = typeof localHosts.$inferSelect;

/** Who is asking: workspace-scoped kinds use the workspace, personal kinds the user. */
export interface WorkScope {
  workspaceId: string | null;
  userId: string | null;
}

/** Every row the Work list is built from, as each kind's list endpoint returns it. */
export interface WorkSources {
  tasks: TaskRow[];
  taskConfigs: TaskConfigRow[];
  workflows: WorkflowRow[];
  localTerminals: LocalTerminalRow[];
  localBlueprints: LocalBlueprintRow[];
  podSessions: PodSessionRow[];
  agents: PersistentAgentRow[];
  /** The caller's machines — names for rows that run on them. */
  hosts: Pick<LocalHostRow, "id" | "name">[];
}

/** How many rows of each high-volume kind the list carries (the web's old fan-out limits). */
const TASK_LIMIT = 200;
const POD_SESSION_LIMIT = 100;

export async function gatherWorkSources(scope: WorkScope): Promise<WorkSources> {
  const [taskRows, configs, workflowRows, terminals, blueprints, podSessions, agents, hosts] =
    await Promise.all([
      taskService.listTasks({ workspaceId: scope.workspaceId, limit: TASK_LIMIT }),
      taskConfigService.listTaskConfigs({ workspaceId: scope.workspaceId }),
      workflowService.listWorkflows(scope.workspaceId ?? undefined),
      terminalService.listTerminals(scope.userId),
      blueprintService.listBlueprints(scope.userId),
      sessionService.listSessions({
        limit: POD_SESSION_LIMIT,
        userId: scope.userId ?? undefined,
      }),
      paService.listPersistentAgents(scope.workspaceId),
      hostService.listHosts(scope.userId),
    ]);
  return {
    tasks: taskRows,
    taskConfigs: configs.slice(0, TASK_LIMIT),
    workflows: workflowRows.slice(0, TASK_LIMIT),
    localTerminals: terminals,
    localBlueprints: blueprints,
    podSessions,
    agents,
    hosts,
  };
}

/** The Work list for whoever is asking, needs-you first. */
export async function listWork(scope: WorkScope): Promise<WorkRow[]> {
  return projectWork(await gatherWorkSources(scope));
}

// ── Projection ──────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function taskStatus(state: string): [WorkStatus, string] {
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

function terminalStatus(t: LocalTerminalRow): [WorkStatus, string] {
  if (t.state === "error") return ["failed", "error"];
  if (t.state === "exited") return ["done", "exited"];
  if (t.state === "pending") {
    return ["queued", t.pendingReason === "host_offline" ? "host offline" : "pending"];
  }
  if (t.attentionState === "needs_you") return ["needs_you", "needs you"];
  if (t.attentionState === "idle") return ["waiting", "idle"];
  return ["running", "working"];
}

function agentStatus(a: PersistentAgentRow): [WorkStatus, string] {
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

/** A definition's status: armed while enabled, paused otherwise. */
function definitionStatus(enabled: boolean): Pick<WorkRow, "status" | "statusLabel"> {
  return enabled
    ? { status: "scheduled", statusLabel: "armed" }
    : { status: "paused", statusLabel: "paused" };
}

/** Projects each source row onto a `WorkRow`. Pure; `listWork` feeds it. */
export function projectWork(src: WorkSources): WorkRow[] {
  const hostName = new Map(src.hosts.map((h) => [h.id, h.name]));
  const machine = (hostId: string | null, dir: string | null): WorkWhere => ({
    target: "machine",
    detail: [hostName.get(hostId ?? "") ?? null, shortDir(dir)].filter(Boolean).join(" · ") || null,
  });
  const repoWhere = (
    row: { runTarget: "cluster" | "local"; localHostId: string | null; localDir: string | null },
    repoUrl: string | null,
  ): WorkWhere =>
    row.runTarget === "local"
      ? machine(row.localHostId, row.localDir)
      : { target: "pod", detail: shortRepo(repoUrl) };
  const rows: WorkRow[] = [];

  for (const t of src.tasks) {
    const [status, statusLabel] = taskStatus(t.state);
    const configId = (t.metadata as { taskConfigId?: string } | null)?.taskConfigId;
    rows.push({
      key: `task-${t.id}`,
      source: "repo-task",
      id: t.id,
      href: `/tasks/${t.id}`,
      name: t.title,
      when: configId ? "on a trigger" : "now",
      where: repoWhere(t, t.repoUrl),
      who: t.agentType ?? "claude-code",
      then: t.autoResume ? "until-merged" : "exits",
      status,
      statusLabel,
      note: t.prUrl ? `PR ${t.prUrl.split("/").pop()}` : null,
      prUrl: t.prUrl ?? null,
      lastActivity: iso(t.updatedAt ?? t.createdAt),
      recurring: false,
      editHref: null,
      spawned: !!configId,
    });
  }

  for (const c of src.taskConfigs) {
    rows.push({
      key: `blueprint-${c.id}`,
      source: "repo-blueprint",
      id: c.id,
      href: `/tasks/scheduled/${c.id}`,
      name: c.name ?? c.title,
      when: "on a trigger",
      where: repoWhere(c, c.repoUrl),
      who: c.agentType ?? "claude-code",
      then: c.autoResume ? "until-merged" : "exits",
      ...definitionStatus(c.enabled),
      note: c.autoResume ? "works each PR until it merges" : "opens a PR each run",
      prUrl: null,
      lastActivity: iso(c.updatedAt ?? c.createdAt),
      recurring: true,
      editHref: `/work/${c.id}/edit`,
      spawned: false,
    });
  }

  for (const w of src.workflows) {
    rows.push({
      key: `job-${w.id}`,
      source: "standalone",
      id: w.id,
      href: `/jobs/${w.id}`,
      name: w.name,
      when: "on a trigger",
      where:
        w.runTarget === "local"
          ? machine(w.localHostId, w.localDir)
          : { target: "pod", detail: null },
      who: w.agentRuntime ?? "claude-code",
      then: "exits",
      ...definitionStatus(w.enabled),
      note: null,
      prUrl: null,
      lastActivity: iso(w.updatedAt ?? w.createdAt),
      recurring: true,
      editHref: `/work/${w.id}/edit`,
      spawned: false,
    });
  }

  for (const t of src.localTerminals) {
    // A local Task run already has its `tasks` row above; a local Job run
    // and hand-opened terminals only exist here.
    if (t.taskId) continue;
    const [status, statusLabel] = terminalStatus(t);
    const spec = t.spec as { kind?: string; agent?: string; mode?: string };
    const interactive = spec.kind !== "agent" || spec.mode !== "headless";
    rows.push({
      key: `terminal-${t.id}`,
      source: "local-terminal",
      id: t.id,
      href: `/local/${t.id}`,
      name: t.title ?? "Terminal",
      when: t.spawnedBy === "manual" || !t.spawnedBy ? "now" : t.spawnedBy,
      where: machine(t.hostId, t.dir),
      who: spec.kind === "agent" && spec.agent ? spec.agent : "terminal",
      then: interactive ? "waits-for-me" : "exits",
      status,
      statusLabel,
      note: t.attentionState === "needs_you" && t.attentionReason ? t.attentionReason : null,
      prUrl: null,
      lastActivity: iso(t.lastActivityAt ?? t.updatedAt),
      recurring: false,
      editHref: null,
      spawned: !!t.blueprintId || !!t.workflowRunId,
    });
  }

  for (const b of src.localBlueprints) {
    rows.push({
      key: `automation-${b.id}`,
      source: "local-blueprint",
      id: b.id,
      href: `/local/automations/${b.id}`,
      name: b.name,
      when: "on an event",
      where: machine(b.hostId, b.dir),
      who: b.agent ?? "terminal",
      then: b.sessionMode === "headless" ? "exits" : "waits-for-me",
      ...definitionStatus(b.enabled),
      note: null,
      prUrl: null,
      lastActivity: iso(b.updatedAt ?? b.createdAt),
      recurring: true,
      editHref: `/work/${b.id}/edit`,
      spawned: false,
    });
  }

  for (const s of src.podSessions) {
    const active = s.state === "active";
    rows.push({
      key: `session-${s.id}`,
      source: "pod-session",
      id: s.id,
      href: `/sessions/${s.id}`,
      name: s.title || s.branch || `Session ${s.id.slice(0, 8)}`,
      when: "now",
      where: { target: "pod", detail: shortRepo(s.repoUrl) },
      who: "terminal",
      then: "waits-for-me",
      status: active ? "waiting" : "done",
      statusLabel: active ? "open" : "ended",
      note: null,
      prUrl: null,
      lastActivity: iso(s.endedAt ?? s.createdAt),
      recurring: false,
      editHref: null,
      spawned: false,
    });
  }

  for (const a of src.agents) {
    const [status, statusLabel] = agentStatus(a);
    rows.push({
      key: `agent-${a.id}`,
      source: "persistent-agent",
      id: a.id,
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
      lastActivity: iso(a.lastTurnAt ?? a.updatedAt ?? a.createdAt),
      recurring: false,
      editHref: null,
      spawned: false,
    });
  }

  return sortWork(rows);
}

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvedWork {
  source: WorkSource;
  /** The native row from its table. */
  data: Record<string, unknown>;
  /** The row as the Work list shows it. */
  row: WorkRow;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Scoped like each kind's own detail endpoint: a miss and a forbidden row both read as null. */
export async function resolveWork(id: string, scope: WorkScope): Promise<ResolvedWork | null> {
  if (!UUID.test(id)) return null;
  const inWorkspace = (row: { workspaceId: string | null }) =>
    !scope.workspaceId || !row.workspaceId || row.workspaceId === scope.workspaceId;
  const empty: WorkSources = {
    tasks: [],
    taskConfigs: [],
    workflows: [],
    localTerminals: [],
    localBlueprints: [],
    podSessions: [],
    agents: [],
    hosts: [],
  };
  const found = async (
    source: WorkSource,
    data: object,
    sources: Partial<WorkSources>,
  ): Promise<ResolvedWork> => {
    const hosts = await hostService.listHosts(scope.userId);
    const [row] = projectWork({ ...empty, ...sources, hosts });
    return { source, data: data as Record<string, unknown>, row };
  };

  const task = await taskService.getTask(id);
  if (task) return inWorkspace(task) ? found("repo-task", task, { tasks: [task] }) : null;

  const config = await taskConfigService.getTaskConfig(id);
  if (config) {
    return inWorkspace(config) ? found("repo-blueprint", config, { taskConfigs: [config] }) : null;
  }

  const workflow = await workflowService.getWorkflow(id);
  if (workflow) {
    return inWorkspace(workflow) ? found("standalone", workflow, { workflows: [workflow] }) : null;
  }

  const blueprint = await blueprintService.getBlueprint(id);
  if (blueprint) {
    return blueprintService.canAccessBlueprint(blueprint, scope.userId)
      ? found("local-blueprint", blueprint, { localBlueprints: [blueprint] })
      : null;
  }

  const terminal = await terminalService.getTerminal(id);
  if (terminal) {
    // A terminal that executes a task is that task's run, not work of its own.
    if (terminal.taskId || !terminalService.canAccessTerminal(terminal, scope.userId)) return null;
    return found("local-terminal", terminal, { localTerminals: [terminal] });
  }

  const session = await sessionService.getSession(id);
  if (session) {
    if (scope.userId && session.userId && session.userId !== scope.userId) return null;
    return found("pod-session", session, { podSessions: [session] });
  }

  const agent = await paService.getPersistentAgentScoped(id, scope.workspaceId);
  if (agent) return found("persistent-agent", agent, { agents: [agent] });

  return null;
}
