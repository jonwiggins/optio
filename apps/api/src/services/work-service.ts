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
import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  sortWork,
  shortDir,
  shortRepo,
  type WorkRow,
  type WorkSource,
  type WorkStatus,
  type WorkTrigger,
  type WorkWhere,
} from "@optio/shared";
import { db } from "../db/client.js";
import {
  localTerminals,
  tasks,
  workDefinitions,
  workflowRuns,
  workflowTriggers,
  type interactiveSessions,
  type localHosts,
  type persistentAgents,
} from "../db/schema.js";
import * as taskService from "./task-service.js";
import * as workflowService from "./workflow-service.js";
import * as definitions from "./work-definition-service.js";
import * as terminalService from "./local-terminal-service.js";
import * as hostService from "./local-host-service.js";
import * as sessionService from "./interactive-session-service.js";
import * as paService from "./persistent-agent-service.js";
import { canAccessBlueprint, ownedBy } from "./local-blueprint-service.js";
import { canSee, ownerNameFor, ownerNames, visibleOwner, type Actor } from "./ownership.js";
import { withManagedWork } from "./config/managed.js";
import type { LocalTerminalRow } from "./local-terminal-service.js";
import type { WorkDefinition } from "./work-definition-service.js";

type TaskRow = typeof tasks.$inferSelect;
type PodSessionRow = typeof interactiveSessions.$inferSelect;
type PersistentAgentRow = typeof persistentAgents.$inferSelect;
type JobRunRow = typeof workflowRuns.$inferSelect;
type LocalHostRow = typeof localHosts.$inferSelect;

/**
 * Who is asking: workspace-scoped kinds use the workspace, personal kinds the
 * user. Private work (an `owner_user_id`) is visible to its owner alone, and
 * read-only to a workspace admin (`isAdmin`) — see services/ownership.ts.
 */
export interface WorkScope {
  workspaceId: string | null;
  userId: string | null;
  isAdmin?: boolean;
}

/** The scope as the ownership rule's actor. */
const actorOf = (scope: WorkScope): Actor => ({
  userId: scope.userId,
  workspaceId: scope.workspaceId,
  isAdmin: scope.isAdmin ?? false,
});

/** Every row the Work list is built from. */
export interface WorkSources {
  tasks: TaskRow[];
  /** Scheduled Tasks, Jobs, and Local automations. */
  definitions: WorkDefinition[];
  localTerminals: LocalTerminalRow[];
  podSessions: PodSessionRow[];
  agents: PersistentAgentRow[];
  /** The caller's machines — names for rows that run on them. */
  hosts: Pick<LocalHostRow, "id" | "name">[];
  /** Job runs, each with its Job. */
  jobRuns: Array<{ run: JobRunRow; job: WorkDefinition }>;
  /** The definitions' triggers, and those that started a task or terminal. */
  triggers: TriggerRow[];
}

/** How many rows of each high-volume kind the list carries (the web's old fan-out limits). */
const TASK_LIMIT = 200;
const POD_SESSION_LIMIT = 100;

/** The Work list for whoever is asking, needs-you first. */
export async function listWork(scope: WorkScope): Promise<WorkRow[]> {
  const actor = actorOf(scope);
  // Workspace rows the caller may see: the organization's and their own
  // (every row for an admin).
  const visible = and(
    scope.workspaceId ? eq(workDefinitions.workspaceId, scope.workspaceId) : undefined,
    visibleOwner(workDefinitions.ownerUserId, actor),
  );
  const [taskRows, jobRuns, configs, jobs, automations, terminals, podSessions, agents, hosts] =
    await Promise.all([
      taskService.listTasks({
        workspaceId: scope.workspaceId,
        limit: TASK_LIMIT,
        visibleTo: actor,
      }),
      db
        .select({ run: workflowRuns, job: workDefinitions })
        .from(workflowRuns)
        .innerJoin(workDefinitions, eq(workDefinitions.id, workflowRuns.workflowId))
        .where(visible)
        .orderBy(desc(workflowRuns.createdAt))
        .limit(TASK_LIMIT),
      definitions.listDefinitions("repo-blueprint", visible),
      definitions.listDefinitions("standalone", visible),
      definitions.listDefinitions("local-blueprint", ownedBy(scope.userId)),
      terminalService.listTerminals(scope.userId),
      sessionService.listSessions({
        limit: POD_SESSION_LIMIT,
        userId: scope.userId ?? undefined,
      }),
      paService.listPersistentAgents(scope.workspaceId, actor),
      hostService.listHosts(scope.userId),
    ]);
  const defs = [...configs.slice(0, TASK_LIMIT), ...jobs.slice(0, TASK_LIMIT), ...automations];
  const runs = { tasks: taskRows, localTerminals: terminals, jobRuns };
  const rows = projectWork({
    ...runs,
    definitions: defs,
    podSessions,
    agents,
    hosts,
    triggers: await loadTriggers(
      defs.map((d) => d.id),
      triggerIdsOf(runs),
    ),
  });
  return nameOwners(rows);
}

/** Private rows carry their owner's name (what an admin's list shows). */
async function nameOwners(rows: WorkRow[]): Promise<WorkRow[]> {
  const names = await ownerNames(rows.map((r) => r.ownerUserId));
  return withManagedWork(
    rows.map((r) => (r.ownerUserId ? { ...r, ownerName: ownerNameFor(r.ownerUserId, names) } : r)),
  );
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

/** What the projectors look up across rows: machine names and triggers. */
interface Context {
  /** Where a row runs on a machine, named the way the list shows it. */
  machine(hostId: string | null, dir: string | null): WorkWhere;
  /** A definition's triggers, one per type (a ticket trigger per source). */
  triggersOf(definitionId: string): WorkTrigger[];
  /** What started a run: its ticket, else the trigger that fired it (when known). */
  startedBy(ticketSource: string | null | undefined, triggerId: unknown): WorkTrigger[] | undefined;
}

type TriggerRow = Pick<typeof workflowTriggers.$inferSelect, "id" | "type" | "targetId" | "config">;

/** One entry per distinct trigger type (a ticket trigger per source). */
function distinctTriggers(list: TriggerRow[]): WorkTrigger[] {
  const seen = new Set<string>();
  const out: WorkTrigger[] = [];
  for (const t of list) {
    const source = t.type === "ticket" ? ((t.config?.source as string | undefined) ?? null) : null;
    const key = `${t.type}:${source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source ? { type: t.type, source } : { type: t.type });
  }
  return out;
}

function context(hosts: WorkSources["hosts"], triggers: TriggerRow[]): Context {
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));
  const byTarget = new Map<string, TriggerRow[]>();
  const byId = new Map<string, TriggerRow>();
  for (const t of triggers) {
    byTarget.set(t.targetId, [...(byTarget.get(t.targetId) ?? []), t]);
    byId.set(t.id, t);
  }
  return {
    machine: (hostId, dir) => {
      // Only the caller's own machines are named; the id is kept either way
      // so the Machines page can group work by the machine it runs on.
      const name = hostName.get(hostId ?? "") ?? null;
      return {
        target: "machine",
        detail: [name, shortDir(dir)].filter(Boolean).join(" · ") || null,
        hostId: hostId ?? null,
        hostName: name,
        dir: dir ?? null,
      };
    },
    triggersOf: (id) => distinctTriggers(byTarget.get(id) ?? []),
    startedBy: (ticketSource, triggerId) => {
      if (ticketSource) return [{ type: "ticket", source: ticketSource }];
      const trigger = typeof triggerId === "string" ? byId.get(triggerId) : undefined;
      return trigger ? distinctTriggers([trigger]) : undefined;
    },
  };
}

/** The triggers rows refer to: every definition's, and those that started a run. */
async function loadTriggers(definitionIds: string[], triggerIds: string[]): Promise<TriggerRow[]> {
  if (definitionIds.length === 0 && triggerIds.length === 0) return [];
  return db
    .select({
      id: workflowTriggers.id,
      type: workflowTriggers.type,
      targetId: workflowTriggers.targetId,
      config: workflowTriggers.config,
    })
    .from(workflowTriggers)
    .where(
      or(
        definitionIds.length ? inArray(workflowTriggers.targetId, definitionIds) : undefined,
        triggerIds.length ? inArray(workflowTriggers.id, triggerIds) : undefined,
      ),
    );
}

/** The trigger ids a task or terminal says started it. */
function triggerIdsOf(
  src: Pick<WorkSources, "tasks" | "localTerminals"> & Partial<Pick<WorkSources, "jobRuns">>,
): string[] {
  const ids = [
    ...src.tasks.map((t) => (t.metadata as { triggerId?: unknown } | null)?.triggerId),
    ...src.localTerminals.map((t) => t.triggerId),
    ...(src.jobRuns ?? []).map(({ run }) => run.triggerId),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

/** On the owner's machine, or in a pod (named by its repo, when it has one). */
function whereOf(
  row: { runTarget: "cluster" | "local"; localHostId: string | null; localDir: string | null },
  repoUrl: string | null,
  at: Context,
): WorkWhere {
  return row.runTarget === "local"
    ? at.machine(row.localHostId, row.localDir)
    : { target: "pod", detail: shortRepo(repoUrl) };
}

function taskRow(t: TaskRow, at: Context): WorkRow {
  const [status, statusLabel] = taskStatus(t.state);
  return {
    key: `task-${t.id}`,
    source: "repo-task",
    id: t.id,
    href: `/tasks/${t.id}`,
    name: t.title,
    when: t.workId ? "on a trigger" : "now",
    where: whereOf(t, t.repoUrl, at),
    who: t.agentType ?? "claude-code",
    then: t.autoResume ? "until-merged" : "exits",
    status,
    statusLabel,
    note: t.prUrl ? `PR ${t.prUrl.split("/").pop()}` : null,
    prUrl: t.prUrl ?? null,
    prState: t.prState ?? null,
    triggers: at.startedBy(
      t.ticketSource,
      (t.metadata as { triggerId?: unknown } | null)?.triggerId,
    ),
    lastActivity: iso(t.updatedAt ?? t.createdAt),
    recurring: false,
    editHref: null,
    spawned: !!t.workId,
    ownerUserId: t.ownerUserId ?? null,
  };
}

function definitionRow(d: WorkDefinition, at: Context): WorkRow {
  const common = {
    id: d.id,
    name: d.name,
    ...definitionStatus(d.enabled),
    prUrl: null,
    triggers: at.triggersOf(d.id),
    lastActivity: iso(d.updatedAt ?? d.createdAt),
    recurring: true,
    editHref: `/work/${d.id}/edit`,
    spawned: false,
    // A Local automation is always its person's; that isn't the org / private
    // choice, so it carries no owner here.
    ownerUserId: d.kind === "local-blueprint" ? null : (d.ownerUserId ?? null),
  };
  switch (d.kind) {
    case "repo-blueprint":
      return {
        ...common,
        key: `blueprint-${d.id}`,
        source: "repo-blueprint",
        href: `/tasks/scheduled/${d.id}`,
        when: "on a trigger",
        where: whereOf(d, d.repoUrl, at),
        who: d.agentType ?? "claude-code",
        then: d.autoResume ? "until-merged" : "exits",
        note: d.autoResume ? "works each PR until it merges" : "opens a PR each run",
      };
    case "standalone":
      return {
        ...common,
        key: `job-${d.id}`,
        source: "standalone",
        href: `/jobs/${d.id}`,
        when: "on a trigger",
        where: whereOf(d, null, at),
        // No agent: the Job runs a shell command.
        who: d.agentType ?? "terminal",
        then: "exits",
        note: null,
      };
    case "local-blueprint":
      return {
        ...common,
        key: `automation-${d.id}`,
        source: "local-blueprint",
        href: `/local/automations/${d.id}`,
        when: "on an event",
        where: at.machine(d.localHostId, d.localDir),
        who: d.agentType ?? "terminal",
        then: d.localSessionMode === "headless" ? "exits" : "waits-for-me",
        note: null,
      };
  }
}

function terminalRow(t: LocalTerminalRow, at: Context): WorkRow {
  const [status, statusLabel] = terminalStatus(t);
  const spec = t.spec as { kind?: string; agent?: string; mode?: string };
  const interactive = spec.kind !== "agent" || spec.mode !== "headless";
  return {
    key: `terminal-${t.id}`,
    source: "local-terminal",
    id: t.id,
    href: `/local/${t.id}`,
    name: t.title ?? "Terminal",
    when: t.spawnedBy === "manual" || !t.spawnedBy ? "now" : t.spawnedBy,
    where: at.machine(t.hostId, t.dir),
    who: spec.kind === "agent" && spec.agent ? spec.agent : "terminal",
    then: interactive ? "waits-for-me" : "exits",
    status,
    statusLabel,
    note: t.attentionState === "needs_you" && t.attentionReason ? t.attentionReason : null,
    prUrl: null,
    triggers:
      t.spawnedBy === "ticket"
        ? [{ type: "ticket", source: t.ticketSource ?? null }]
        : t.spawnedBy === "trigger"
          ? at.startedBy(null, t.triggerId)
          : undefined,
    lastActivity: iso(t.lastActivityAt ?? t.updatedAt),
    // Ordered by when you last typed into it (else when it was made), so it
    // doesn't jump as its attention state flips.
    orderAt: iso(t.lastInteractedAt ?? t.createdAt),
    recurring: false,
    editHref: null,
    spawned: !!t.blueprintId || !!t.workflowRunId,
  };
}

function podSessionRow(s: PodSessionRow): WorkRow {
  const active = s.state === "active";
  return {
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
  };
}

function agentRow(a: PersistentAgentRow): WorkRow {
  const [status, statusLabel] = agentStatus(a);
  return {
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
    ownerUserId: a.ownerUserId ?? null,
  };
}

/** One run of a Job, as a row of its own. */
function jobRunRow(r: JobRunRow, job: WorkDefinition, at: Context): WorkRow {
  const [status, statusLabel] = taskStatus(r.state);
  return {
    key: `job-run-${r.id}`,
    source: "standalone",
    id: r.id,
    href: `/jobs/${job.id}/runs/${r.id}`,
    name: r.title ?? job.name,
    when: r.triggerId ? "on a trigger" : "now",
    where: whereOf(job, null, at),
    who: job.agentType ?? "terminal",
    then: "exits",
    status,
    statusLabel,
    note: r.errorMessage ?? null,
    prUrl: null,
    triggers: at.startedBy(null, r.triggerId),
    lastActivity: iso(r.updatedAt ?? r.createdAt),
    recurring: false,
    editHref: null,
    spawned: true,
    ownerUserId: r.ownerUserId ?? job.ownerUserId ?? null,
  };
}

/** Projects each source row onto a `WorkRow`. Pure; `listWork` feeds it. */
export function projectWork(src: WorkSources): WorkRow[] {
  const at = context(src.hosts, src.triggers);
  return sortWork([
    ...src.tasks.map((t) => taskRow(t, at)),
    ...src.jobRuns.map(({ run, job }) => jobRunRow(run, job, at)),
    ...src.definitions.map((d) => definitionRow(d, at)),
    // A terminal running a Task or a Job run is that run, which has its own
    // row above; hand-opened terminals and automation spawns only exist here.
    ...src.localTerminals
      .filter((t) => !t.taskId && !t.workflowRunId)
      .map((t) => terminalRow(t, at)),
    ...src.podSessions.map(podSessionRow),
    ...src.agents.map(agentRow),
  ]);
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
  const actor = actorOf(scope);
  const inWorkspace = (row: { workspaceId: string | null; ownerUserId?: string | null }) =>
    (!scope.workspaceId || !row.workspaceId || row.workspaceId === scope.workspaceId) &&
    canSee(row.ownerUserId, actor);
  /** The row's context: the caller's machines, and the triggers it names. */
  const at = async (definitionIds: string[], triggerIds: string[]) =>
    context(
      await hostService.listHosts(scope.userId),
      await loadTriggers(definitionIds, triggerIds),
    );
  const found = async (source: WorkSource, data: object, row: WorkRow): Promise<ResolvedWork> => ({
    source,
    data: data as Record<string, unknown>,
    row: (await nameOwners([row]))[0],
  });

  const task = await taskService.getTask(id);
  if (task) {
    if (!inWorkspace(task)) return null;
    return found(
      "repo-task",
      task,
      taskRow(task, await at([], triggerIdsOf({ tasks: [task], localTerminals: [] }))),
    );
  }

  const definition = await definitions.getDefinition(id);
  if (definition) {
    const visible =
      definition.kind === "local-blueprint"
        ? canAccessBlueprint({ userId: definition.ownerUserId }, scope.userId)
        : inWorkspace(definition);
    return visible
      ? found(definition.kind, definition, definitionRow(definition, await at([definition.id], [])))
      : null;
  }

  const run = await workflowService.getWorkflowRun(id);
  if (run) {
    const job = await definitions.getDefinition(run.workflowId, "standalone");
    if (!job || !inWorkspace(job)) return null;
    return found(
      "standalone",
      run,
      jobRunRow(
        run,
        job,
        await at([], triggerIdsOf({ tasks: [], localTerminals: [], jobRuns: [{ run, job }] })),
      ),
    );
  }

  const terminal = await terminalService.getTerminal(id);
  if (terminal) {
    // A terminal that executes a task or a Job run is that run, not work of its own.
    if (
      terminal.taskId ||
      terminal.workflowRunId ||
      !terminalService.canAccessTerminal(terminal, scope.userId)
    ) {
      return null;
    }
    const ctx = await at([], triggerIdsOf({ tasks: [], localTerminals: [terminal] }));
    return found("local-terminal", terminal, terminalRow(terminal, ctx));
  }

  const session = await sessionService.getSession(id);
  if (session) {
    if (scope.userId && session.userId && session.userId !== scope.userId) return null;
    return found("pod-session", session, podSessionRow(session));
  }

  const agent = await paService.getPersistentAgentScoped(id, scope.workspaceId, actor);
  if (agent) return found("persistent-agent", agent, agentRow(agent));

  return null;
}

/** How many runs `listRuns` returns. */
const RUN_LIMIT = 50;

/**
 * What a definition has started, newest first, as Work list rows: a
 * scheduled Task's tasks, a Job's runs, a Local automation's terminals.
 */
export async function listRuns(definition: WorkDefinition, scope: WorkScope): Promise<WorkRow[]> {
  // Runs say which of the definition's triggers started them.
  const at = context(
    await hostService.listHosts(scope.userId),
    await loadTriggers([definition.id], []),
  );
  switch (definition.kind) {
    case "repo-blueprint": {
      const rows = await taskService.listTasks({ workId: definition.id, limit: RUN_LIMIT });
      return rows.map((t) => taskRow(t, at));
    }
    case "standalone": {
      const rows = await workflowService.listWorkflowRuns(definition.id, RUN_LIMIT);
      return rows.map((r) => jobRunRow(r, definition, at));
    }
    case "local-blueprint": {
      const rows = await db
        .select()
        .from(localTerminals)
        .where(eq(localTerminals.blueprintId, definition.id))
        .orderBy(desc(localTerminals.createdAt))
        .limit(RUN_LIMIT);
      return rows.map((t) => terminalRow(t, at));
    }
  }
}
