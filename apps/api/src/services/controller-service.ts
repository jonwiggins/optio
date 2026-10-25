/** The controller's deliberately small work surface. Every lookup has an
 * exact tenant predicate (including the null/local tenant) and an owner
 * check before it reaches an existing mutation or run service. No arbitrary
 * HTTP, SQL, secrets, shell access, or workspace switching is exposed.
 */
import { and, desc, eq, ilike, or, type Column } from "drizzle-orm";
import { type WorkSpec, type TriggerTargetType } from "@optio/shared";
import { db } from "../db/client.js";
import {
  workRuns,
  workDefinitions,
  persistentAgents,
  persistentAgentTurns,
  prReviews,
  prReviewRuns,
  repos,
  interactiveSessions,
  localTerminals,
  localTerminalTranscripts,
} from "../db/schema.js";
import { visibleWork } from "./work-visibility.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import * as workWrite from "./work-write-service.js";
import * as definitions from "./work-definition-service.js";
import * as pa from "./persistent-agent-service.js";
import * as triggers from "./trigger-service.js";
import { createWorkflowRun } from "./workflow-service.js";
import { instantiateTask } from "./task-config-service.js";
import { listLogs, type LogOwner } from "./run-log-service.js";
import { transcriptRowToEntry } from "./local-terminal-service.js";

import {
  ControllerError,
  tenant,
  requireManage,
  requireVisible,
  requireChange,
} from "./controller-access.js";
export { ControllerError, tenant, requireManage, requireVisible } from "./controller-access.js";
export {
  controllerInbox,
  sendControllerMessage,
  listControllerAgents,
} from "./controller-collaboration.js";

export async function getControllerWork(p: ControllerPrincipal, id: string) {
  const [run] = await db.select().from(workRuns).where(eq(workRuns.id, id));
  if (run) {
    requireVisible(p, run);
    return { kind: "run" as const, data: run };
  }
  const definition = await definitions.getDefinition(id);
  if (definition) {
    requireVisible(p, definition);
    if (
      definition.kind === "local-blueprint" &&
      (!p.run?.sessionId || definition.ownerUserId !== p.actor.userId)
    )
      throw new ControllerError(404, "Work not found");
    return { kind: "definition" as const, data: definition };
  }
  const agent = await pa.getPersistentAgentUnscoped(id);
  if (agent) {
    requireVisible(p, agent);
    return { kind: "agent" as const, data: agent };
  }
  const [review] = await db.select().from(prReviews).where(eq(prReviews.id, id));
  if (review) {
    requireVisible(p, review);
    return { kind: "review" as const, data: review };
  }
  throw new ControllerError(404, "Work not found");
}

/** Explicit output fields keep pod internals and incidental metadata out of prompts. */
export function describeWork(work: Awaited<ReturnType<typeof getControllerWork>>, detail = true) {
  const r = work.data;
  const common = { id: r.id, kind: work.kind, createdAt: r.createdAt, updatedAt: r.updatedAt };
  switch (work.kind) {
    case "run": {
      const r = work.data;
      return {
        ...common,
        name: r.title,
        source: r.kind,
        state: r.state,
        workId: r.workId,
        runTarget: r.runTarget,
        localTerminalId: r.localTerminalId,
        href: r.kind === "repo" ? `/tasks/${r.id}` : `/jobs/${r.workId}/runs/${r.id}`,
        ownerUserId: r.ownerUserId,
        prUrl: r.prUrl,
        prState: r.prState,
        ...(detail
          ? {
              prompt: r.prompt,
              resultSummary: r.resultSummary,
              errorMessage: r.errorMessage,
              prChecksStatus: r.prChecksStatus,
              prReviewStatus: r.prReviewStatus,
              ...usage(r),
            }
          : {}),
      };
    }
    case "definition": {
      const r = work.data;
      return {
        ...common,
        name: r.name,
        source: r.kind,
        enabled: r.enabled,
        ownerUserId: r.ownerUserId,
        href:
          r.kind === "local-blueprint"
            ? `/local/automations/${r.id}`
            : r.kind === "standalone"
              ? `/jobs/${r.id}`
              : `/tasks/scheduled/${r.id}`,
        ...(detail
          ? {
              description: r.description,
              prompt: r.prompt,
              promptTemplateId: r.promptTemplateId,
              paramsSchema: r.paramsSchema,
              spawnMode: r.spawnMode,
              repoUrl: r.repoUrl,
              repoBranch: r.repoBranch,
              agentType: r.agentType,
              model: r.model,
              agentOptions: r.agentOptions,
              runTitle: r.runTitle,
              runTarget: r.runTarget,
              hostId: r.localHostId,
              dir: r.localDir,
              sessionMode: r.localSessionMode,
              maxRetries: r.maxRetries,
              priority: r.priority,
              autoResume: r.autoResume,
              autoMerge: r.autoMerge,
              podSecrets: r.podSecrets,
              settings: r.settings,
              controllerAccess: r.settings?.controllerAccess ?? "off",
            }
          : {}),
      };
    }
    case "agent": {
      const r = work.data;
      return {
        ...common,
        name: r.name,
        slug: r.slug,
        state: r.state,
        enabled: r.enabled,
        ownerUserId: r.ownerUserId,
        href: `/agents/${r.id}`,
        ...(detail
          ? {
              description: r.description,
              agentRuntime: r.agentRuntime,
              model: r.model,
              agentOptions: r.agentOptions,
              systemPrompt: r.systemPrompt,
              initialPrompt: r.initialPrompt,
              promptTemplateId: r.promptTemplateId,
              repoId: r.repoId,
              branch: r.branch,
              podLifecycle: r.podLifecycle,
              settings: r.settings,
              lastTurnAt: r.lastTurnAt,
              controllerAccess: r.settings?.controllerAccess ?? "off",
            }
          : {}),
      };
    }
    case "review": {
      const r = work.data;
      return {
        ...common,
        name: r.prUrl,
        state: r.state,
        prUrl: r.prUrl,
        href: `/reviews/${r.id}`,
        ...(detail
          ? {
              verdict: r.verdict,
              summary: r.summary,
              fileComments: r.fileComments,
              errorMessage: r.errorMessage,
            }
          : {}),
      };
    }
  }
}

function usage(r: {
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costBasis: string | null;
  modelUsed: string | null;
}) {
  return {
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    costBasis: r.costBasis,
    modelUsed: r.modelUsed,
  };
}

export async function listControllerWork(
  p: ControllerPrincipal,
  input: {
    kind?: "run" | "definition" | "agent" | "review";
    search?: string;
    limit: number;
    offset: number;
  },
) {
  const { kind, search, limit, offset } = input;
  const cap = offset + limit + 1;
  const ws = p.actor.workspaceId;
  const matches = (column: Column) => (search ? ilike(column, `%${search}%`) : undefined);
  const [runs, defs, agents, reviews] = await Promise.all([
    !kind || kind === "run"
      ? db
          .select()
          .from(workRuns)
          .where(
            and(
              tenant(workRuns.workspaceId, ws),
              visibleWork(workRuns.ownerUserId, workRuns.ownerTeamId, workRuns.createdBy, p.actor),
              matches(workRuns.title),
            ),
          )
          .orderBy(desc(workRuns.createdAt), desc(workRuns.id))
          .limit(cap)
      : [],
    !kind || kind === "definition"
      ? db
          .select()
          .from(workDefinitions)
          .where(
            and(
              tenant(workDefinitions.workspaceId, ws),
              visibleWork(
                workDefinitions.ownerUserId,
                workDefinitions.ownerTeamId,
                workDefinitions.createdBy,
                p.actor,
              ),
              or(
                eq(workDefinitions.kind, "standalone"),
                eq(workDefinitions.kind, "repo-blueprint"),
                p.run?.sessionId
                  ? and(
                      eq(workDefinitions.kind, "local-blueprint"),
                      tenant(workDefinitions.ownerUserId, p.actor.userId),
                    )
                  : undefined,
              ),
              matches(workDefinitions.name),
            ),
          )
          .orderBy(desc(workDefinitions.createdAt), desc(workDefinitions.id))
          .limit(cap)
      : [],
    !kind || kind === "agent"
      ? db
          .select()
          .from(persistentAgents)
          .where(
            and(
              tenant(persistentAgents.workspaceId, ws),
              visibleWork(
                persistentAgents.ownerUserId,
                persistentAgents.ownerTeamId,
                persistentAgents.createdBy,
                p.actor,
              ),
              matches(persistentAgents.name),
            ),
          )
          .orderBy(desc(persistentAgents.createdAt), desc(persistentAgents.id))
          .limit(cap)
      : [],
    !kind || kind === "review"
      ? db
          .select()
          .from(prReviews)
          .where(and(tenant(prReviews.workspaceId, ws), matches(prReviews.prUrl)))
          .orderBy(desc(prReviews.createdAt), desc(prReviews.id))
          .limit(cap)
      : [],
  ]);
  const rows = [
    ...runs.map((data) => describeWork({ kind: "run", data }, false)),
    ...defs.map((data) => describeWork({ kind: "definition", data }, false)),
    ...agents.map((data) => describeWork({ kind: "agent", data }, false)),
    ...reviews.map((data) => describeWork({ kind: "review", data }, false)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return {
    rows: rows.slice(offset, offset + limit),
    nextOffset: rows.length > offset + limit ? offset + limit : null,
  };
}

export async function listControllerRepos(p: ControllerPrincipal, limit: number, offset: number) {
  // A principal with no workspace (auth disabled: the Ask Optio session and
  // PAT clients carry none) sees every repo, the way `GET /api/repos` and
  // `getRepoByUrl` treat a missing workspace — a repo row always has one,
  // so the tenant filter would otherwise list nothing to create work in.
  const rows = await db
    .select({
      id: repos.id,
      name: repos.fullName,
      repoUrl: repos.repoUrl,
      defaultBranch: repos.defaultBranch,
    })
    .from(repos)
    .where(p.actor.workspaceId ? eq(repos.workspaceId, p.actor.workspaceId) : undefined)
    .orderBy(repos.fullName, repos.id)
    .limit(limit + 1)
    .offset(offset);
  return { repos: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}

function checkSpec(p: ControllerPrincipal, spec: WorkSpec) {
  requireManage(p);
  // Only a person, in the web form's dialog, confirms automatic merging: a
  // tool call never does (work-write-service then refuses mergeWhenReady
  // unless the saved work was already confirmed).
  const { autoMergeConfirmed: _confirmed, ...unconfirmed } = spec;
  spec = unconfirmed;
  if (!p.run?.sessionId && (spec.where.runTarget !== "cluster" || spec.then === "waits-for-me"))
    throw new ControllerError(
      400,
      "Controller tools create headless pod work and persistent agents; use the UI for interactive sessions and machines",
    );
  if (p.run) {
    // A private agent cannot hand its instructions/settings to org work,
    // and org work cannot acquire a person's identity. Controller access
    // defaults to off; a managing agent may explicitly delegate its access
    // to work within this same boundary.
    spec = {
      ...spec,
      owner: p.actor.userId ? "me" : "workspace",
    };
  }
  return spec;
}

export async function createControllerWork(p: ControllerPrincipal, spec: WorkSpec) {
  return workWrite.createWork(checkSpec(p, spec), p.actor);
}
export async function updateControllerWork(p: ControllerPrincipal, id: string, spec: WorkSpec) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "definition")
    throw new ControllerError(400, "Only recurring definitions can be edited with this tool");
  if (p.run && work.data.ownerUserId !== p.actor.userId)
    throw new ControllerError(403, "An agent may only edit definitions with its own owner");
  // An edit preserves an existing definition's controller grant. Delegated
  // access is chosen at creation, or changed by its human owner.
  const checked = checkSpec(p, spec);
  if (p.run)
    checked.settings = {
      ...checked.settings,
      controllerAccess: work.data.settings?.controllerAccess ?? "off",
    };
  return workWrite.updateWork(id, checked, p.actor);
}

export async function setControllerWorkEnabled(
  p: ControllerPrincipal,
  id: string,
  enabled: boolean,
) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "definition")
    throw new ControllerError(400, "Use this tool for recurring definitions");
  await definitions.updateDefinition(id, work.data.kind, { enabled });
  return { id, enabled };
}

export async function runControllerWork(
  p: ControllerPrincipal,
  id: string,
  params?: Record<string, unknown>,
) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  if (work.kind !== "definition")
    throw new ControllerError(
      400,
      "Run a recurring definition; use send_message to wake a persistent agent",
    );
  if (!work.data.enabled)
    throw new ControllerError(409, "Work is disabled; enable it before running");
  if (work.data.kind === "local-blueprint") {
    const { toLocalBlueprint, spawnFromBlueprint } = await import("./local-blueprint-service.js");
    const terminal = await spawnFromBlueprint(toLocalBlueprint(work.data), { params });
    return {
      workId: id,
      sessionId: terminal.id,
      state: terminal.state,
      href: `/work/${terminal.id}`,
    };
  }
  const run =
    work.data.kind === "standalone"
      ? await createWorkflowRun(id, { params })
      : await instantiateTask(id, { params });
  return { workId: id, runId: run.id, state: run.state };
}

export async function triggerTarget(p: ControllerPrincipal, id: string, write: boolean) {
  const work = await getControllerWork(p, id);
  if (write) requireChange(p, work.data);
  let targetType: TriggerTargetType;
  if (work.kind === "definition") targetType = definitions.TRIGGER_TARGET[work.data.kind];
  else if (work.kind === "agent") targetType = "persistent_agent";
  else if (work.kind === "review") targetType = "pr_review";
  else
    throw new ControllerError(
      400,
      "Schedules attach to recurring definitions or persistent agents",
    );
  return { targetType, targetId: id };
}
export async function listControllerTriggers(p: ControllerPrincipal, id: string) {
  const target = await triggerTarget(p, id, false);
  return { triggers: triggers.publicTriggers(await triggers.listTriggers(target.targetType, id)) };
}
export async function setControllerSchedule(
  p: ControllerPrincipal,
  input: { id: string; triggerId?: string; cron: string; timezone: string; enabled: boolean },
) {
  const target = await triggerTarget(p, input.id, true);
  const config = { cronExpression: input.cron, timezone: input.timezone };
  const problem = triggers.validateTriggerConfig("schedule", config);
  if (problem) throw new ControllerError(400, problem);
  if (input.triggerId) {
    const existing = await triggers.getTriggerFor(target.targetType, input.id, input.triggerId);
    if (!existing || existing.type !== "schedule")
      throw new ControllerError(404, "Schedule not found");
    const trigger = await triggers.updateTrigger(existing.id, { config, enabled: input.enabled });
    return { trigger: trigger && triggers.publicTrigger(trigger) };
  }
  return {
    trigger: triggers.publicTrigger(
      await triggers.createTrigger({ ...target, type: "schedule", config, enabled: input.enabled }),
    ),
  };
}
export async function deleteControllerSchedule(
  p: ControllerPrincipal,
  id: string,
  triggerId: string,
) {
  const target = await triggerTarget(p, id, true);
  const existing = await triggers.getTriggerFor(target.targetType, id, triggerId);
  if (!existing || existing.type !== "schedule")
    throw new ControllerError(404, "Schedule not found");
  await triggers.deleteTrigger(existing.id);
  return { deleted: true, triggerId };
}

export async function listControllerRuns(
  p: ControllerPrincipal,
  id: string,
  limit: number,
  offset: number,
) {
  const work = await getControllerWork(p, id);
  let rows: unknown[];
  if (work.kind === "definition" && work.data.kind === "local-blueprint") {
    const terminals = await db
      .select()
      .from(localTerminals)
      .where(
        and(
          eq(localTerminals.blueprintId, id),
          tenant(localTerminals.workspaceId, p.actor.workspaceId),
          tenant(localTerminals.userId, p.actor.userId),
        ),
      )
      .orderBy(desc(localTerminals.createdAt), desc(localTerminals.id))
      .limit(limit + 1)
      .offset(offset);
    rows = terminals.map((t) => ({
      id: t.id,
      kind: "session",
      state: t.state,
      title: t.title,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      errorMessage: t.errorMessage,
      href: `/work/${t.id}`,
      historyTool: "optio_get_session_history",
    }));
  } else if (work.kind === "definition") {
    rows = await db
      .select()
      .from(workRuns)
      .where(
        and(
          eq(workRuns.workId, id),
          tenant(workRuns.workspaceId, p.actor.workspaceId),
          visibleWork(workRuns.ownerUserId, workRuns.ownerTeamId, workRuns.createdBy, p.actor),
        ),
      )
      .orderBy(desc(workRuns.createdAt), desc(workRuns.id))
      .limit(limit + 1)
      .offset(offset);
    rows = (rows as Array<typeof workRuns.$inferSelect>).map((data) =>
      describeWork({ kind: "run", data }),
    );
  } else if (work.kind === "agent") {
    rows = (
      await db
        .select()
        .from(persistentAgentTurns)
        .where(eq(persistentAgentTurns.agentId, id))
        .orderBy(desc(persistentAgentTurns.turnNumber))
        .limit(limit + 1)
        .offset(offset)
    ).map((r) => ({
      id: r.id,
      agentId: id,
      turnNumber: r.turnNumber,
      state: r.haltReason ?? "running",
      summary: r.summary,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      ...usage(r),
    }));
  } else if (work.kind === "review") {
    rows = (
      await db
        .select()
        .from(prReviewRuns)
        .where(eq(prReviewRuns.prReviewId, id))
        .orderBy(desc(prReviewRuns.createdAt), desc(prReviewRuns.id))
        .limit(limit + 1)
        .offset(offset)
    ).map((r) => ({
      id: r.id,
      reviewId: id,
      state: r.state,
      resultSummary: r.resultSummary,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      ...usage(r),
    }));
  } else rows = offset === 0 ? [describeWork(work)] : [];
  return { runs: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}

export async function controllerLogs(
  p: ControllerPrincipal,
  id: string,
  opts: {
    limit: number;
    offset: number;
    search?: string;
    logType?: string;
    source?: "auto" | "execution" | "conversation";
  },
) {
  let owner: LogOwner;
  const turn = await pa.getPersistentAgentTurn(id);
  if (turn) {
    await getControllerWork(p, turn.agentId);
    owner = { persistentAgentTurnId: id };
  } else {
    const [reviewRun] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, id));
    if (reviewRun) {
      await getControllerWork(p, reviewRun.prReviewId);
      owner = { prReviewRunId: id };
    } else {
      const work = await getControllerWork(p, id);
      if (work.kind !== "run") throw new ControllerError(400, "Use a run id from list_runs");
      if (work.data.runTarget === "local" && opts.source !== "execution") {
        const terminalId = work.data.localTerminalId;
        if (terminalId) {
          // A run's soft pointer must never expose a different owner's conversation.
          const [terminal] = await db
            .select({ id: localTerminals.id })
            .from(localTerminals)
            .where(
              and(
                eq(localTerminals.id, terminalId),
                tenant(localTerminals.workspaceId, work.data.workspaceId),
                tenant(localTerminals.userId, work.data.ownerUserId),
              ),
            );
          if (!terminal) throw new ControllerError(404, "Run conversation not found");
          const rows = await db
            .select()
            .from(localTerminalTranscripts)
            .where(
              and(
                eq(localTerminalTranscripts.terminalId, terminalId),
                opts.logType ? eq(localTerminalTranscripts.kind, opts.logType) : undefined,
                opts.search
                  ? or(
                      ilike(localTerminalTranscripts.text, `%${opts.search}%`),
                      ilike(localTerminalTranscripts.detail, `%${opts.search}%`),
                    )
                  : undefined,
              ),
            )
            .orderBy(localTerminalTranscripts.seq)
            .limit(opts.limit + 1)
            .offset(opts.offset);
          return {
            source: "conversation",
            localTerminalId: terminalId,
            href: `/work/${terminalId}`,
            note: "Saved Local conversation. Use source=execution for lifecycle and error logs.",
            logs: rows.slice(0, opts.limit).map((r) => {
              const entry = transcriptRowToEntry(r);
              const content = entry.detail ? `${entry.text}\n${entry.detail}` : entry.text;
              return {
                id: `${terminalId}:${r.seq}`,
                seq: r.seq,
                timestamp: r.at ?? r.createdAt,
                stream: entry.role,
                source: entry.source,
                logType: r.kind,
                toolName: r.toolName,
                isError: r.isError,
                content: content.slice(0, 8000),
                truncated: content.length > 8000,
              };
            }),
            nextOffset: rows.length > opts.limit ? opts.offset + opts.limit : null,
          };
        }
        if (opts.source === "conversation")
          throw new ControllerError(409, "This run has no linked Local conversation yet");
      } else if (opts.source === "conversation") {
        throw new ControllerError(400, "Conversation logs require a Local run");
      }
      owner = { taskId: id };
    }
  }
  if (opts.source === "conversation")
    throw new ControllerError(400, "Conversation logs require a Local run");
  const rows = await listLogs(owner, { ...opts, limit: opts.limit + 1 });
  return {
    source: "execution",
    logs: rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      stream: r.stream,
      logType: r.logType,
      content: r.content.slice(0, 8000),
      truncated: r.content.length > 8000,
    })),
    nextOffset: rows.length > opts.limit ? opts.offset + opts.limit : null,
  };
}

/** Interactive operators can discover the sessions they create, inside the same tenant/owner. */
export async function listControllerSessions(
  p: ControllerPrincipal,
  opts: { id?: string; search?: string; limit?: number } = {},
) {
  if (!p.run?.sessionId) return [];
  const [sessions, terminals] = await Promise.all([
    db
      .select()
      .from(interactiveSessions)
      .where(
        and(
          tenant(interactiveSessions.workspaceId, p.actor.workspaceId),
          tenant(interactiveSessions.userId, p.actor.userId),
          opts.id ? eq(interactiveSessions.id, opts.id) : undefined,
          opts.search ? ilike(interactiveSessions.title, `%${opts.search}%`) : undefined,
        ),
      )
      .orderBy(desc(interactiveSessions.createdAt), desc(interactiveSessions.id))
      .limit(opts.limit ?? 500),
    db
      .select()
      .from(localTerminals)
      .where(
        and(
          tenant(localTerminals.workspaceId, p.actor.workspaceId),
          tenant(localTerminals.userId, p.actor.userId),
          opts.id ? eq(localTerminals.id, opts.id) : undefined,
          opts.search ? ilike(localTerminals.title, `%${opts.search}%`) : undefined,
        ),
      )
      .orderBy(desc(localTerminals.createdAt), desc(localTerminals.id))
      .limit(opts.limit ?? 500),
  ]);
  return [
    ...sessions.map((s) => ({
      id: s.id,
      kind: "session",
      name: s.title,
      state: s.state,
      runtime: s.agentRuntime ?? "claude-code",
      runTarget: "cluster",
      canMessage:
        p.access === "manage" &&
        s.state === "active" &&
        s.id !== p.run?.sessionId &&
        !!(s.agentRuntime || s.podId),
      messageTool: "optio_send_session_message",
      href: `/work/${s.id}`,
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    })),
    ...terminals.map((s) => ({
      id: s.id,
      kind: "session",
      name: s.title,
      state: s.state,
      runtime: (s.spec as { agent?: string }).agent,
      runTarget: "local",
      canMessage: p.access === "manage" && s.state === "running" && s.spec.kind === "agent",
      messageTool: "optio_send_session_message",
      href: `/work/${s.id}`,
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    })),
  ];
}
