/**
 * Work — the write side of the one noun the UI shows: create any kind of
 * work from its five attributes (`POST /api/work`), save a saved
 * definition's edits (`PATCH /api/work/:id`), and delete one
 * (`DELETE /api/work/:id`). The kind is derived from the answers
 * (`kindOfSpec`, shared with the New work form), never sent. Each kind is
 * created by its own service; a definition (or a persistent agent) and its
 * trigger are written in one transaction, so a rejected trigger leaves
 * nothing behind.
 */
import {
  localAgentParams,
  kindOfSpec,
  modelProviderIdFrom,
  slugify,
  toLocalAgentKind,
  type PersistentAgentPodLifecycle,
  type LocalTerminalSpec,
  type WorkCreated,
  type WorkDefinitionKind,
  type WorkKind,
  type WorkSpec,
} from "@optio/shared";
import { db } from "../db/client.js";
import * as definitions from "./work-definition-service.js";
import type { WorkDefinition, WorkDefinitionValues } from "./work-definition-service.js";
import * as triggerService from "./trigger-service.js";
import * as taskService from "./task-service.js";
import * as workflowService from "./workflow-service.js";
import * as blueprintService from "./local-blueprint-service.js";
import * as hostService from "./local-host-service.js";
import * as terminalService from "./local-terminal-service.js";
import * as sessionService from "./interactive-session-service.js";
import * as paService from "./persistent-agent-service.js";
import { validateRunLocation } from "./local-run-service.js";
import { planNewWork, planWorkUpdate, workChangeError, type WorkActor } from "./work-ownership.js";
import { isUniqueViolation } from "../utils/db-errors.js";

/** A request the caller has to fix: the route answers with `status`. */
export class WorkError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    /** 409s: which uniqueness the work ran into (the form retries an automatic name on `name_taken`). */
    readonly details?: "name_taken" | "webhook_path_taken",
  ) {
    super(message);
  }
}

/** Who is writing (an admin may delete someone's personal work). */
export type Actor = WorkActor;

const NOUN: Record<WorkKind, string> = {
  "repo-task": "Task",
  "repo-blueprint": "scheduled Task",
  standalone: "Job",
  "local-blueprint": "automation",
  "local-terminal": "terminal",
  "pod-session": "session",
  "persistent-agent": "agent",
};

/** The page about a piece of work. */
export function workHref(kind: WorkKind, id: string): string {
  switch (kind) {
    case "repo-task":
      return `/tasks/${id}`;
    case "repo-blueprint":
      return `/tasks/scheduled/${id}`;
    case "standalone":
      return `/jobs/${id}`;
    case "local-blueprint":
      return `/local/automations/${id}`;
    case "local-terminal":
      return `/local/${id}`;
    case "pod-session":
      return `/sessions/${id}`;
    case "persistent-agent":
      return `/agents/${id}`;
  }
}

// ── Checking a spec ─────────────────────────────────────────────────────────

/** The kinds something other than "now" can start: definitions and persistent agents. */
const TRIGGERABLE = new Set<WorkKind>([
  "repo-blueprint",
  "standalone",
  "local-blueprint",
  "persistent-agent",
]);

/** The trigger a spec asks for, checked; null for "now". */
function triggerOf(spec: WorkSpec, kind: WorkKind) {
  if (spec.when.type === "manual") return null;
  if (!TRIGGERABLE.has(kind)) {
    throw new WorkError(400, `A ${NOUN[kind]} can't be started by a trigger`);
  }
  const problem = triggerService.validateTriggerConfig(spec.when.type, spec.when.config);
  if (problem) throw new WorkError(400, problem);
  return { type: spec.when.type, config: spec.when.config };
}

function check(spec: WorkSpec, kind: WorkKind): void {
  const needsAgent =
    kind === "repo-task" ||
    kind === "repo-blueprint" ||
    kind === "standalone" ||
    kind === "persistent-agent";
  if (needsAgent && !spec.who.runtime) {
    throw new WorkError(400, `A ${NOUN[kind]} needs an agent`);
  }
  if (needsAgent && !spec.what.prompt.trim()) {
    throw new WorkError(400, `A ${NOUN[kind]} needs a prompt`);
  }
  if (
    (kind === "repo-task" || kind === "repo-blueprint" || kind === "pod-session") &&
    !spec.where.repoUrl
  ) {
    throw new WorkError(400, `A ${NOUN[kind]} needs a repo`);
  }
  if ((kind === "local-blueprint" || kind === "local-terminal") && spec.who.runtime) {
    if (!toLocalAgentKind(spec.who.runtime)) {
      throw new WorkError(
        400,
        `${spec.who.runtime} can't run on your machine — pick Claude Code, Codex, Cursor, Gemini, or OpenCode`,
      );
    }
  }
}

/** A pod or machine location for the kinds that run a headless agent (Tasks, Jobs). */
async function runLocation(spec: WorkSpec, kind: WorkKind, actor: Actor) {
  const checked = await validateRunLocation(
    {
      runTarget: spec.where.runTarget,
      localHostId: spec.where.localHostId,
      localDir: spec.where.localDir,
      localSessionMode: "headless",
      agentType: spec.who.runtime ?? undefined,
      repoUrl: kind === "standalone" ? null : spec.where.repoUrl,
    },
    actor.userId ?? undefined,
  );
  if (!checked.ok) throw new WorkError(400, checked.error);
  return checked.location;
}

/** The kinds that run with an owner's credentials (Tasks, Jobs, agents; in a pod or on a machine). */
const OWNED = new Set<WorkKind>(["repo-task", "repo-blueprint", "standalone", "persistent-agent"]);

/** Owner and pod secrets for new work, with its provider and secrets checked. */
async function plan(spec: WorkSpec, kind: WorkKind, actor: Actor) {
  if (!OWNED.has(kind)) return { ownerUserId: actor.userId, podSecrets: null };
  const planned = await planNewWork(spec, actor, {
    agentType: spec.who.runtime ?? "claude-code",
    agentOptions: spec.who.agentOptions,
    runsOn: spec.where.runTarget === "local" ? "local" : "pod",
  });
  if (!planned.ok) throw new WorkError(planned.status, planned.error);
  return { ownerUserId: planned.ownerUserId, podSecrets: planned.podSecrets ?? null };
}

/** "Works until merged": resume on CI / reviews, and merge unless you'd rather. */
function followThrough(spec: WorkSpec) {
  return spec.then === "until-merged"
    ? { autoResume: true, autoMerge: spec.mergeWhenReady ?? true }
    : { autoResume: null, autoMerge: null };
}

/** Only the options that are set; an empty set is the defaults (null). */
function options(spec: WorkSpec): Record<string, string | boolean> | null {
  const set = Object.entries(spec.who.agentOptions ?? {}).filter(
    ([, v]) => typeof v === "boolean" || v.trim() !== "",
  );
  return set.length > 0 ? Object.fromEntries(set) : null;
}

/**
 * The definition columns a spec sets — one mapping for create and edit, per
 * kind. Ownership (workspace, owner, creator) and `enabled` are the
 * caller's.
 */
async function definitionColumns(
  kind: WorkDefinitionKind,
  spec: WorkSpec,
  actor: Actor,
): Promise<Partial<WorkDefinitionValues>> {
  const common = {
    name: spec.name.trim(),
    description: spec.description?.trim() || null,
    prompt: spec.what.prompt.trim(),
    runTitle: spec.what.runTitle?.trim() || null,
  };
  switch (kind) {
    case "repo-blueprint":
      return {
        ...common,
        ...(await runLocation(spec, kind, actor)),
        agentType: spec.who.runtime,
        agentOptions: options(spec),
        repoUrl: spec.where.repoUrl,
        repoBranch: spec.where.repoBranch || "main",
        maxRetries: spec.maxRetries ?? 3,
        priority: spec.priority ?? 100,
        ...followThrough(spec),
      };
    case "standalone":
      return {
        ...common,
        ...(await runLocation(spec, kind, actor)),
        agentType: spec.who.runtime,
        model: spec.who.model ?? null,
        agentOptions: options(spec),
        maxRetries: spec.maxRetries ?? 1,
      };
    case "local-blueprint": {
      const problem = await blueprintService.checkBlueprint(
        {
          commandTemplate: common.prompt,
          hostId: spec.where.localHostId,
          agent: spec.who.runtime,
          agentOptions: spec.who.agentOptions,
        },
        actor,
      );
      if (problem) throw new WorkError(400, problem);
      return {
        ...common,
        runTarget: "local",
        localHostId: spec.where.localHostId || null,
        localDir: spec.where.localDir || null,
        repoUrl: spec.where.repoUrl || null,
        // "New branch": spawns wrap the prompt with branch + PR instructions off this base.
        repoBranch: spec.where.repoBranch || null,
        agentType: spec.who.runtime,
        agentOptions: spec.who.runtime ? options(spec) : null,
        localSessionMode: spec.then === "waits-for-me" ? "interactive" : "headless",
      };
    }
  }
}

function conflict(err: unknown, kind: WorkKind, spec: WorkSpec): never {
  if (err instanceof Error && err.message === "duplicate_webhook_path") {
    const path = spec.when.type === "manual" ? "" : String(spec.when.config.path ?? "");
    throw new WorkError(409, `Webhook path "${path}" is already in use`, "webhook_path_taken");
  }
  if (err instanceof Error && err.message === "unsupported_type") {
    throw new WorkError(400, `A ${NOUN[kind]} can't take a "${spec.when.type}" trigger`);
  }
  if (isUniqueViolation(err)) {
    const what =
      kind === "persistent-agent"
        ? `An agent "${spec.agent?.slug || spec.name}"`
        : `A ${NOUN[kind]} named "${spec.name}"`;
    throw new WorkError(409, `${what} already exists`, "name_taken");
  }
  throw err;
}

// ── Create ──────────────────────────────────────────────────────────────────

/** Create a piece of work from its attributes; a Job started now starts its first run. */
export async function createWork(spec: WorkSpec, actor: Actor): Promise<WorkCreated> {
  const kind = kindOfSpec(spec);
  check(spec, kind);
  const trigger = triggerOf(spec, kind);
  const owned = await plan(spec, kind, actor);
  const made = (id: string): WorkCreated => ({ kind, id, href: workHref(kind, id) });

  switch (kind) {
    case "repo-task": {
      const location = await runLocation(spec, kind, actor);
      try {
        const task = await taskService.submitTask(
          {
            title: spec.name.trim(),
            prompt: spec.what.prompt.trim(),
            repoUrl: spec.where.repoUrl!,
            repoBranch: spec.where.repoBranch || undefined,
            agentType: spec.who.runtime,
            maxRetries: spec.maxRetries,
            priority: spec.priority,
            ...(spec.then === "until-merged" ? followThrough(spec) : {}),
            ...(options(spec) ? { metadata: { agentOptions: options(spec) } } : {}),
            dependsOn: spec.dependsOn,
            workspaceId: actor.workspaceId,
            ...owned,
            ...location,
          },
          actor.userId ?? undefined,
        );
        return made(task.id);
      } catch (err) {
        if (err instanceof taskService.TaskInputError) throw new WorkError(400, err.message);
        throw err;
      }
    }

    case "repo-blueprint":
    case "standalone":
    case "local-blueprint": {
      const columns = await definitionColumns(kind, spec, actor);
      let definition: WorkDefinition;
      try {
        definition = await db.transaction(async (tx) => {
          const row = await definitions.createDefinition(
            kind,
            {
              ...columns,
              name: columns.name!,
              prompt: columns.prompt!,
              workspaceId: actor.workspaceId,
              createdBy: actor.userId,
              ...owned,
            },
            tx,
          );
          if (trigger) {
            await triggerService.createTrigger(
              { targetType: definitions.TRIGGER_TARGET[kind], targetId: row.id, ...trigger },
              tx,
            );
          }
          return row;
        });
      } catch (err) {
        conflict(err, kind, spec);
      }
      if (kind === "standalone" && !trigger) {
        const run = await workflowService.createWorkflowRun(definition.id);
        return {
          ...made(definition.id),
          run: { id: run.id, href: `/jobs/${definition.id}/runs/${run.id}` },
        };
      }
      return made(definition.id);
    }

    case "local-terminal": {
      const host = spec.where.localHostId
        ? await hostService.getHost(spec.where.localHostId)
        : null;
      if (!host || !hostService.canAccessHost(host, actor.userId)) {
        throw new WorkError(400, "Pick one of your machines");
      }
      if (!spec.where.localDir) throw new WorkError(400, "Pick a folder on the machine");
      const runtime = spec.who.runtime ? toLocalAgentKind(spec.who.runtime)! : null;
      const prompt = spec.what.prompt.trim();
      const terminalSpec: LocalTerminalSpec = runtime
        ? {
            kind: "agent",
            agent: runtime,
            ...(prompt ? { prompt } : {}),
            // Model, effort, and the permission mode.
            ...localAgentParams(runtime, options(spec)),
            // "New branch": the prompt is wrapped with branch + PR instructions off this base.
            ...(spec.where.repoBranch ? { baseBranch: spec.where.repoBranch } : {}),
          }
        : { kind: "shell" };
      try {
        const terminal = await terminalService.createTerminal({
          host,
          userId: actor.userId,
          workspaceId: actor.workspaceId,
          dir: spec.where.localDir,
          spec: terminalSpec,
          title: spec.name.trim(),
          spawnedBy: "manual",
          modelProviderId: runtime ? modelProviderIdFrom(spec.who.agentOptions) : undefined,
        });
        return made(terminal.id);
      } catch (err) {
        throw new WorkError(400, err instanceof Error ? err.message : String(err));
      }
    }

    case "pod-session": {
      // A terminal plus a Claude Code chat in a repo pod: only the repo and the name travel.
      const session = await sessionService.createSession({
        repoUrl: spec.where.repoUrl!,
        userId: actor.userId ?? undefined,
        workspaceId: actor.workspaceId,
        title: spec.name.trim(),
      });
      return made(session.id);
    }

    case "persistent-agent": {
      const slug = spec.agent?.slug?.trim() || slugify(spec.name);
      if (!slug) throw new WorkError(400, "Give the agent a name with letters or digits");
      let agent: Awaited<ReturnType<typeof paService.createPersistentAgent>>;
      try {
        agent = await db.transaction(async (tx) => {
          const row = await paService.createPersistentAgent(
            {
              slug,
              name: spec.name.trim(),
              description: spec.description?.trim() || undefined,
              agentRuntime: spec.who.runtime!,
              model: spec.who.model ?? null,
              agentOptions: options(spec),
              systemPrompt: spec.agent?.systemPrompt || null,
              agentsMd: spec.agent?.agentsMd || null,
              initialPrompt: spec.what.prompt.trim(),
              podLifecycle: spec.agent?.podLifecycle as PersistentAgentPodLifecycle | undefined,
              workspaceId: actor.workspaceId,
              createdBy: actor.userId,
              ...owned,
            },
            tx,
          );
          if (trigger) {
            await triggerService.createTrigger(
              { targetType: "persistent_agent", targetId: row.id, ...trigger },
              tx,
            );
          }
          return row;
        });
      } catch (err) {
        conflict(err, kind, spec);
      }
      // First wake — the initial prompt, once the agent (and its trigger) exist.
      await paService.wakeAgent({
        agentId: agent.id,
        source: "initial",
        body: spec.what.prompt.trim(),
        senderType: "system",
        senderId: paService.buildSenderId({ type: "system", label: "optio-init" }),
        senderName: "Optio",
      });
      return made(agent.id);
    }
  }
}

// ── Edit / delete a definition ──────────────────────────────────────────────

/** A definition the actor may change: their workspace's, or their own automation. */
export async function getOwnDefinition(id: string, actor: Actor): Promise<WorkDefinition | null> {
  const definition = await definitions.getDefinition(id);
  if (!definition) return null;
  if (definition.kind === "local-blueprint") {
    return blueprintService.canAccessBlueprint({ userId: definition.ownerUserId }, actor.userId)
      ? definition
      : null;
  }
  const ws = definition.workspaceId;
  return !actor.workspaceId || !ws || ws === actor.workspaceId ? definition : null;
}

/** The trigger an edit replaces: the first enabled one, else the first (the form shows the same one). */
export function editedTrigger<T extends { enabled: boolean }>(triggers: T[]): T | null {
  return triggers.find((t) => t.enabled) ?? triggers[0] ?? null;
}

/**
 * Save a definition from its attributes. Its kind is fixed: answers that
 * would make it another kind are refused. The one trigger the form edits
 * follows the answer — patched in place when the type is the same (a webhook
 * keeps its path, a schedule its id), replaced when it changes, removed for
 * "now" — and other triggers are left alone. Row and trigger change together.
 */
export async function updateWork(id: string, spec: WorkSpec, actor: Actor): Promise<WorkCreated> {
  const existing = await getOwnDefinition(id, actor);
  if (!existing) throw new WorkError(404, "Work not found");
  const kind = existing.kind;
  const asked = kindOfSpec(spec);
  if (asked !== kind) {
    throw new WorkError(
      400,
      `These answers would make it a ${NOUN[asked]}; a saved ${NOUN[kind]} stays one`,
    );
  }
  check(spec, kind);
  const wanted = triggerOf(spec, kind);
  const columns = await definitionColumns(kind, spec, actor);
  if (kind !== "local-blueprint") {
    // Personal work is its owner's to change; the owner and secrets follow the answers.
    const planned = await planWorkUpdate(
      existing,
      { owner: spec.owner, podSecrets: spec.podSecrets, agentOptions: spec.who.agentOptions },
      actor,
      {
        agentType: spec.who.runtime ?? "claude-code",
        runsOn: spec.where.runTarget === "local" ? "local" : "pod",
        touchesRuntime: true,
      },
    );
    if (!planned.ok) throw new WorkError(planned.status, planned.error);
    columns.ownerUserId = planned.ownerUserId;
    if (planned.podSecrets !== undefined) columns.podSecrets = planned.podSecrets;
  }
  const targetType = definitions.TRIGGER_TARGET[kind];

  try {
    await db.transaction(async (tx) => {
      await definitions.updateDefinition(id, kind, columns, tx);
      const current = editedTrigger(await triggerService.listTriggers(targetType, id, tx));
      if (!wanted) {
        if (current) await triggerService.deleteTrigger(current.id, tx);
      } else if (current && current.type === wanted.type) {
        await triggerService.updateTrigger(current.id, { config: wanted.config }, tx);
      } else {
        await triggerService.createTrigger({ targetType, targetId: id, ...wanted }, tx);
        if (current) await triggerService.deleteTrigger(current.id, tx);
      }
    });
  } catch (err) {
    conflict(err, kind, spec);
  }
  return { kind, id, href: workHref(kind, id) };
}

/**
 * Delete a definition and its triggers (a Job's runs go with it; spawned
 * tasks and terminals stay). Personal work is its owner's, or an admin's,
 * to delete.
 */
export async function deleteWork(id: string, actor: Actor): Promise<boolean> {
  const existing = await getOwnDefinition(id, actor);
  if (!existing) return false;
  await assertMayChange(existing, actor, "delete");
  return definitions.deleteDefinition(id, existing.kind);
}

/** Throws 403 unless the actor may change this definition (personal work is its owner's). */
export async function assertMayChange(
  definition: Pick<WorkDefinition, "kind" | "ownerUserId">,
  actor: Actor,
  action: "edit" | "run" | "delete",
): Promise<void> {
  // A Local automation is only ever visible to its owner (getOwnDefinition).
  if (definition.kind === "local-blueprint") return;
  const problem = await workChangeError(definition.ownerUserId, actor, action);
  if (problem) throw new WorkError(403, problem);
}
