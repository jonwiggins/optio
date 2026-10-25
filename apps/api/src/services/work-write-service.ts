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
  cleanWorkSettings,
  requireAutoMergeConfirmation,
  localAgentParams,
  kindOfSpec,
  modelProviderIdFrom,
  isSelfSecretTriggerType,
  remoteWorkspaceOf,
  REMOTE_WORKSPACE_PROVIDER_INFO,
  slugify,
  toLocalAgentKind,
  type PersistentAgentPodLifecycle,
  type LocalTerminalSpec,
  type TriggerTargetType,
  type WorkWhen,
  type WorkCreated,
  type WorkDefinitionKind,
  type WorkKind,
  type WorkSettings,
  type WorkSpec,
  withoutPrSettings,
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
import * as remoteWorkspaceService from "./remote-workspace-service.js";
import { planNewWork, planWorkUpdate, workChangeError, type WorkActor } from "./work-ownership.js";
import { getRepoByUrl, repoDefaultBranch } from "./repo-service.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { runtimeRefusal } from "./feature-guard.js";
import { mergeConfirmationRequired } from "./deployment-settings.js";

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
      return `/work/${id}`;
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
  // A Job with no agent runs its prompt as a shell command; the other
  // unattended kinds need an agent.
  const needsAgent =
    kind === "repo-task" || kind === "repo-blueprint" || kind === "persistent-agent";
  if (needsAgent && !spec.who.runtime) {
    throw new WorkError(400, `A ${NOUN[kind]} needs an agent`);
  }
  const unavailable = runtimeRefusal(spec.who.runtime);
  if (unavailable) throw new WorkError(400, unavailable);
  if ((needsAgent || kind === "standalone") && !spec.what.prompt.trim()) {
    throw new WorkError(
      400,
      `A ${NOUN[kind]} needs ${spec.who.runtime ? "a prompt" : "a command"}`,
    );
  }
  if (
    (kind === "repo-task" ||
      kind === "repo-blueprint" ||
      (kind === "pod-session" && !spec.who.runtime)) &&
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

/**
 * Work in a remote workspace (`where.remoteWorkspace`;
 * docs/remote-workspaces.md): `startWorkspace` starts the workspace and fills
 * `started` with the machine it pairs as, so the caller can let it go when
 * the work isn't created after all.
 */
export interface RemoteWorkspaceStart {
  startWorkspace?: boolean;
  started?: { hostId: string };
}

/** A pod or machine location for the kinds that run a headless agent (Tasks, Jobs). */
async function runLocation(
  spec: WorkSpec,
  kind: WorkKind,
  actor: Actor,
  remote: RemoteWorkspaceStart = {},
) {
  const launch = spec.where.runTarget === "local" ? remoteWorkspaceOf(spec.where) : null;
  let { localHostId, localDir } = spec.where;
  if (launch && remote.startWorkspace) {
    try {
      const started = await remoteWorkspaceService.startRemoteWorkspaceWork(launch, actor, {
        workName: spec.name,
        // The work's team and repo, for its agent policy (agent-policy.ts).
        policy: { owner: spec.owner ?? null, repoUrl: spec.where.repoUrl ?? null },
      });
      remote.started = { hostId: started.localHostId };
      localHostId = started.localHostId;
      localDir = localDir || started.localDir;
    } catch (err) {
      if (err instanceof remoteWorkspaceService.RemoteWorkspaceError) {
        throw new WorkError(err.status === 502 ? 400 : err.status, err.message);
      }
      throw err;
    }
  } else if (launch && !localHostId) {
    // Work on a trigger or a schedule: its workspace is made when it fires
    // (local-run-service wakes it from `remote_workspace_launch`), so only check now
    // what that will need.
    if (spec.who.runtime && !toLocalAgentKind(spec.who.runtime)) {
      throw new WorkError(
        400,
        `${spec.who.runtime} can't run on your machine — pick Claude Code, Codex, Cursor, Gemini, or OpenCode`,
      );
    }
    if (!actor.userId) {
      throw new WorkError(400, "Work in a remote workspace needs a signed-in person");
    }
    if (
      !(await remoteWorkspaceService.resolveConnectionFor(actor, {
        connectionId: launch.connectionId,
        provider: launch.provider,
      }))
    ) {
      const asked = launch.provider
        ? REMOTE_WORKSPACE_PROVIDER_INFO[launch.provider].label
        : "remote workspace";
      throw new WorkError(
        400,
        launch.connectionId
          ? `That ${asked} connection isn't available`
          : `No ${asked} connection — add one in Settings → Integrations → Remote workspaces`,
      );
    }
    return {
      runTarget: "local" as const,
      localHostId: null,
      localDir: localDir || launch.checkoutDir?.trim() || null,
      localSessionMode: "headless" as const,
      remoteWorkspaceLaunch: launch,
    };
  }
  const checked = await validateRunLocation(
    {
      runTarget: spec.where.runTarget,
      localHostId,
      localDir,
      localSessionMode: "headless",
      agentType: spec.who.runtime ?? undefined,
      repoUrl: kind === "standalone" ? null : spec.where.repoUrl,
    },
    actor.userId ?? undefined,
  );
  if (!checked.ok) {
    await letWorkspaceGo(remote);
    throw new WorkError(400, checked.error);
  }
  return { ...checked.location, remoteWorkspaceLaunch: launch };
}

/** Stop a workspace this request started for work that then wasn't created. */
async function letWorkspaceGo(remote: RemoteWorkspaceStart): Promise<void> {
  if (!remote.started) return;
  const { hostId } = remote.started;
  remote.started = undefined;
  await remoteWorkspaceService.cancelRemoteWorkspaceWork(hostId).catch(() => {});
}

/** The kinds that run with an owner's credentials (Tasks, Jobs, agents; in a pod or on a machine). */
const OWNED = new Set<WorkKind>(["repo-task", "repo-blueprint", "standalone", "persistent-agent"]);

/** Owner and pod secrets for new work, with its provider and secrets checked. */
async function plan(spec: WorkSpec, kind: WorkKind, actor: Actor) {
  if (!OWNED.has(kind)) {
    return { ownerUserId: actor.userId, ownerTeamId: null, podSecrets: null };
  }
  const planned = await planNewWork(spec, actor, {
    agentType: spec.who.runtime ?? "claude-code",
    agentOptions: spec.who.agentOptions,
    runsOn: spec.where.runTarget === "local" ? "local" : "pod",
  });
  if (!planned.ok) throw new WorkError(planned.status, planned.error);
  return {
    ownerUserId: planned.ownerUserId,
    ownerTeamId: planned.ownerTeamId,
    podSecrets: planned.podSecrets ?? null,
  };
}

/**
 * "Works until merged": resume on CI / reviews; merge by itself only when the
 * person asked for it (`mergeWhenReady`, default off) and confirmed it —
 * stamped now, or kept from an earlier confirmation (`confirmedBefore`).
 */
function followThrough(spec: WorkSpec, confirmedBefore?: Date | null) {
  if (spec.then !== "until-merged") {
    return { autoResume: null, autoMerge: null, autoMergeConfirmedAt: null };
  }
  const autoMerge = spec.mergeWhenReady === true;
  const confirmedAt = spec.autoMergeConfirmed === true ? new Date() : (confirmedBefore ?? null);
  return { autoResume: true, autoMerge, autoMergeConfirmedAt: autoMerge ? confirmedAt : null };
}

/**
 * Who confirmed the auto-merge a definition's columns carry: the actor when
 * this write stamped it, no one when merging is off. An edit that keeps an
 * earlier confirmation sets nothing, so whoever gave it stays named. (Not
 * part of `definitionColumns`: the config apply compares those, and a
 * person is not something a file names.)
 */
function confirmedBy(
  columns: Partial<WorkDefinitionValues>,
  spec: WorkSpec,
  actor: Actor,
): Partial<WorkDefinitionValues> {
  if (columns.autoMergeConfirmedAt === undefined) return {};
  if (columns.autoMergeConfirmedAt === null) return { autoMergeConfirmedBy: null };
  return spec.autoMergeConfirmed === true ? { autoMergeConfirmedBy: actor.userId ?? null } : {};
}

/**
 * Refuse a spec that turns merging on without the dialog, when the
 * deployment asks for it (shared work/auto-merge.ts); `current` is the saved
 * row an edit keeps.
 */
async function checkAutoMerge(
  spec: WorkSpec,
  current?: { autoMerge?: boolean | null; autoMergeConfirmedAt?: Date | null } | null,
) {
  const problem = requireAutoMergeConfirmation(
    {
      autoMerge: spec.then === "until-merged" ? spec.mergeWhenReady === true : undefined,
      autoMergeConfirmed: spec.autoMergeConfirmed,
    },
    current,
    await mergeConfirmationRequired(),
  );
  if (problem) throw new WorkError(400, problem);
}

/**
 * The environment settings a spec keeps (`WorkSettings`): pod work only — a
 * machine runs with its own configuration — and the PR follow-through only
 * for work that opens a PR. Nothing changed is stored as null.
 */
function settingsOf(spec: WorkSpec, kind: WorkKind): WorkSettings | null {
  if (spec.where.runTarget === "local") return null;
  return kind === "repo-task" || kind === "repo-blueprint"
    ? cleanWorkSettings(spec.settings)
    : withoutPrSettings(spec.settings);
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
 * caller's. Exported for the config apply, which compares a managed row
 * against what its manifest would write (services/config/kinds/work.ts).
 */
export async function definitionColumns(
  kind: WorkDefinitionKind,
  spec: WorkSpec,
  actor: Actor,
  /** The saved row's auto-merge confirmation an edit keeps. */
  autoMergeConfirmedBefore?: Date | null,
  /** A Job started now starts its remote workspace too. */
  remote: RemoteWorkspaceStart = {},
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
        ...(await runLocation(spec, kind, actor, remote)),
        agentType: spec.who.runtime,
        agentOptions: options(spec),
        repoUrl: spec.where.repoUrl,
        // Blank = the repo's default branch (#643).
        repoBranch:
          spec.where.repoBranch ||
          (await repoDefaultBranch(spec.where.repoUrl ?? "", actor.workspaceId)),
        maxRetries: spec.maxRetries ?? 3,
        priority: spec.priority ?? 100,
        ...followThrough(spec, autoMergeConfirmedBefore),
        settings: settingsOf(spec, kind),
      };
    case "standalone":
      return {
        ...common,
        ...(await runLocation(spec, kind, actor, remote)),
        // No runtime: the Job runs its prompt as a shell command.
        agentType: spec.who.runtime,
        model: spec.who.runtime ? (spec.who.model ?? null) : null,
        agentOptions: spec.who.runtime ? options(spec) : null,
        maxRetries: spec.maxRetries ?? 1,
        settings: settingsOf(spec, kind),
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

/**
 * A persistent agent's columns from a spec — identity (slug), runtime, prompts,
 * pod, repo checkout and environment. Ownership and `enabled` are the caller's.
 */
export async function agentColumns(spec: WorkSpec, actor: Actor) {
  const slug = spec.agent?.slug?.trim() || slugify(spec.name);
  if (!slug) throw new WorkError(400, "Give the agent a name with letters or digits");
  // An agent with a repo works in a checkout of it, turn after turn.
  const repo = spec.where.repoUrl
    ? await getRepoByUrl(spec.where.repoUrl, actor.workspaceId)
    : null;
  if (spec.where.repoUrl && !repo) throw new WorkError(400, "Pick one of your repos");
  return {
    slug,
    name: spec.name.trim(),
    description: spec.description?.trim() || null,
    agentRuntime: spec.who.runtime!,
    model: spec.who.model ?? null,
    agentOptions: options(spec),
    systemPrompt: spec.agent?.systemPrompt || null,
    agentsMd: spec.agent?.agentsMd || null,
    initialPrompt: spec.what.prompt.trim(),
    podLifecycle: spec.agent?.podLifecycle as PersistentAgentPodLifecycle | undefined,
    repoId: repo?.id ?? null,
    branch: repo ? spec.where.repoBranch || repo.defaultBranch : null,
    settings: settingsOf(spec, "persistent-agent"),
  };
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

/**
 * Create a piece of work from its attributes; a Job started now starts its
 * first run (unless `start: false` — the config apply declares Jobs, it
 * doesn't run them).
 */
export async function createWork(
  spec: WorkSpec,
  actor: Actor,
  opts: { start?: boolean } = {},
): Promise<WorkCreated> {
  const kind = kindOfSpec(spec);
  check(spec, kind);
  await checkAutoMerge(spec);
  const trigger = triggerOf(spec, kind);
  const owned = await plan(spec, kind, actor);
  const made = (id: string): WorkCreated => ({ kind, id, href: workHref(kind, id) });

  switch (kind) {
    case "repo-task": {
      const remote: RemoteWorkspaceStart = { startWorkspace: true };
      const { remoteWorkspaceLaunch, ...location } = await runLocation(spec, kind, actor, remote);
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
            settings: settingsOf(spec, kind),
            ...owned,
            ...location,
          },
          actor.userId ?? undefined,
        );
        if (remoteWorkspaceLaunch) {
          await remoteWorkspaceService.recordTaskLaunch(task.id, remoteWorkspaceLaunch);
        }
        return made(task.id);
      } catch (err) {
        await letWorkspaceGo(remote);
        if (err instanceof taskService.TaskInputError) throw new WorkError(400, err.message);
        throw err;
      }
    }

    case "repo-blueprint":
    case "standalone":
    case "local-blueprint": {
      // A Job that runs now starts its remote workspace now; anything else
      // waits for a trigger and can't start one yet (runLocation).
      const remote: RemoteWorkspaceStart = {
        startWorkspace: kind === "standalone" && !trigger && opts.start !== false,
      };
      const columns = await definitionColumns(kind, spec, actor, undefined, remote);
      let definition: WorkDefinition;
      let madeTriggerRow: triggerService.TriggerRow | null = null;
      try {
        definition = await db.transaction(async (tx) => {
          const row = await definitions.createDefinition(
            kind,
            {
              ...columns,
              ...confirmedBy(columns, spec, actor),
              name: columns.name!,
              prompt: columns.prompt!,
              workspaceId: actor.workspaceId,
              createdBy: actor.userId,
              ...owned,
            },
            tx,
          );
          if (trigger) {
            madeTriggerRow = await triggerService.createTrigger(
              { targetType: definitions.TRIGGER_TARGET[kind], targetId: row.id, ...trigger },
              tx,
            );
          }
          return row;
        });
      } catch (err) {
        await letWorkspaceGo(remote);
        conflict(err, kind, spec);
      }
      if (kind === "standalone" && !trigger && opts.start !== false) {
        const run = await workflowService.createWorkflowRun(definition.id);
        return {
          ...made(definition.id),
          run: { id: run.id, href: `/jobs/${definition.id}/runs/${run.id}` },
        };
      }
      return madeTriggerRow
        ? { ...made(definition.id), trigger: madeTrigger(madeTriggerRow) }
        : made(definition.id);
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
      // Agent sessions retain the harness, prompt and environment; terminals use the repo shell.
      const session = await sessionService.createSession({
        repoUrl: spec.where.repoUrl || undefined,
        repoBranch: spec.where.repoBranch,
        agentRuntime: spec.who.runtime,
        agentOptions: options(spec),
        initialPrompt: spec.what.prompt,
        settings: settingsOf(spec, kind),
        userId: actor.userId ?? undefined,
        workspaceId: actor.workspaceId,
        title: spec.name.trim(),
      });
      return made(session.id);
    }

    case "persistent-agent": {
      const columns = await agentColumns(spec, actor);
      let agent: Awaited<ReturnType<typeof paService.createPersistentAgent>>;
      let madeTriggerRow: triggerService.TriggerRow | null = null;
      try {
        agent = await db.transaction(async (tx) => {
          const row = await paService.createPersistentAgent(
            {
              ...columns,
              workspaceId: actor.workspaceId,
              createdBy: actor.userId,
              ...owned,
            },
            tx,
          );
          if (trigger) {
            madeTriggerRow = await triggerService.createTrigger(
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
      return madeTriggerRow
        ? { ...made(agent.id), trigger: madeTrigger(madeTriggerRow) }
        : made(agent.id);
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

/**
 * What a trigger keeps when its work is saved: the parts its config holds
 * that the attributes don't carry — a webhook's or a self-secret trigger's
 * (Pylon, Alertmanager, Datadog) shared secret, set through the trigger API
 * or minted on create. Dropping it would let unsigned requests start the
 * work. `updateTrigger` keeps the stored secret itself whenever the new
 * config carries none; this only makes the merge explicit, and strips a
 * client's `hasSecret` marker and empty `secret` so they never win over it.
 */
function kept(trigger: { type: string; config: unknown }): Record<string, unknown> {
  const config = (trigger.config ?? {}) as Record<string, unknown>;
  const secretBearing = trigger.type === "webhook" || isSelfSecretTriggerType(trigger.type);
  return secretBearing && typeof config.secret === "string" && config.secret
    ? { secret: config.secret }
    : {};
}

/**
 * What a create answers about the trigger it made: its id, and — for a
 * self-secret trigger, whose secret is minted on create — the secret, this
 * once. Every later read shows `hasSecret` instead.
 */
function madeTrigger(row: triggerService.TriggerRow): NonNullable<WorkCreated["trigger"]> {
  const secret = (row.config as Record<string, unknown> | null)?.secret;
  return isSelfSecretTriggerType(row.type) && typeof secret === "string" && secret
    ? { id: row.id, secret }
    : { id: row.id };
}

/** The client's config without the read-side `hasSecret` marker and an empty `secret`. */
function wantedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { hasSecret: _hasSecret, ...rest } = config;
  if (typeof rest.secret !== "string" || !rest.secret) delete rest.secret;
  return rest;
}

/** The trigger an edit replaces: the first enabled one, else the first (the form shows the same one). */
export function editedTrigger<T extends { enabled: boolean }>(triggers: T[]): T | null {
  return triggers.find((t) => t.enabled) ?? triggers[0] ?? null;
}

/**
 * Save the one trigger an edit replaces (`editedTrigger`): patched in place
 * when the type is the same (a webhook keeps its path and secret, a schedule
 * its id), replaced when it changes, removed for "now" (`wanted` null). Other
 * triggers are left alone.
 */
async function saveEditedTrigger(
  targetType: TriggerTargetType,
  targetId: string,
  wanted: { type: WorkWhen["type"]; config: Record<string, unknown> } | null,
  tx: Parameters<typeof triggerService.listTriggers>[2],
): Promise<triggerService.TriggerRow | null> {
  const current = editedTrigger(await triggerService.listTriggers(targetType, targetId, tx));
  if (!wanted) {
    if (current) await triggerService.deleteTrigger(current.id, tx);
    return null;
  }
  if (current && current.type === wanted.type) {
    const config = { ...kept(current), ...wantedConfig(wanted.config) };
    await triggerService.updateTrigger(current.id, { config }, tx);
    return null;
  }
  // A new trigger row: returned so a minted secret (Pylon) can be shown once.
  const made = await triggerService.createTrigger({ targetType, targetId, ...wanted }, tx);
  if (current) await triggerService.deleteTrigger(current.id, tx);
  return made;
}

/** A persistent agent in the actor's workspace that they may see. */
async function getOwnAgent(id: string, actor: Actor) {
  // The whole actor: its teams and the workspace's visibility mode decide too.
  return paService.getPersistentAgentScoped(id, actor.workspaceId, actor);
}

/**
 * Save a definition — or a persistent agent — from its attributes. Its kind
 * is fixed: the answers are read for the saved kind, and ones it can't take
 * are refused. The one trigger the form edits follows the answer
 * (`saveEditedTrigger`). Row and trigger change together.
 */
export async function updateWork(id: string, spec: WorkSpec, actor: Actor): Promise<WorkCreated> {
  const existing = await getOwnDefinition(id, actor);
  if (!existing) {
    const agent = await getOwnAgent(id, actor);
    if (!agent) throw new WorkError(404, "Work not found");
    return updateAgentWork(agent, spec, actor);
  }
  // The saved kind stays, and the answers are read for it. The form keeps an
  // edit from moving it (`kindLock`), but a row can load at a point that
  // derives elsewhere — a scheduled Task with no trigger reads as "now", a
  // headless automation as a Job — and still saves as what it is.
  const kind = existing.kind;
  check(spec, kind);
  // Saving it on again keeps the earlier confirmation; turning it on asks.
  const confirmedBefore = existing.autoMerge === true ? existing.autoMergeConfirmedAt : null;
  await checkAutoMerge(spec, existing);
  const wanted = triggerOf(spec, kind);
  const columns = await definitionColumns(kind, spec, actor, confirmedBefore);
  Object.assign(columns, confirmedBy(columns, spec, actor));
  keepPinnedRemoteWorkspaceHost(columns, existing);
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
    columns.ownerTeamId = planned.ownerTeamId;
    if (planned.podSecrets !== undefined) columns.podSecrets = planned.podSecrets;
  }
  const targetType = definitions.TRIGGER_TARGET[kind];

  let madeTriggerRow: triggerService.TriggerRow | null = null;
  try {
    await db.transaction(async (tx) => {
      await definitions.updateDefinition(id, kind, columns, tx);
      madeTriggerRow = await saveEditedTrigger(targetType, id, wanted, tx);
    });
  } catch (err) {
    conflict(err, kind, spec);
  }
  const result: WorkCreated = { kind, id, href: workHref(kind, id) };
  return madeTriggerRow ? { ...result, trigger: madeTrigger(madeTriggerRow) } : result;
}

/** A remote-workspace launch with its unset fields dropped and its keys in order, to compare two. */
function launchKey(launch: unknown): string {
  const tidy = (v: unknown): unknown => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== null && x !== undefined && x !== "")
      .map(([k, x]) => [k, tidy(x)] as const)
      .filter(([, x]) => !(x && typeof x === "object" && Object.keys(x).length === 0))
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  };
  return JSON.stringify(tidy(launch));
}

/**
 * Saving an edit with the same remote workspace keeps the machine its first
 * firing paired (local-run-service pins it on the definition), so the next
 * firing wakes that workspace instead of creating another one.
 */
export function keepPinnedRemoteWorkspaceHost(
  columns: Partial<WorkDefinitionValues>,
  existing: Pick<WorkDefinition, "remoteWorkspaceLaunch" | "localHostId" | "localDir">,
): void {
  if (!columns.remoteWorkspaceLaunch || !existing.remoteWorkspaceLaunch || columns.localHostId) {
    return;
  }
  if (!existing.localHostId) return;
  if (launchKey(columns.remoteWorkspaceLaunch) !== launchKey(existing.remoteWorkspaceLaunch)) {
    return;
  }
  columns.localHostId = existing.localHostId;
  if (!columns.localDir) columns.localDir = existing.localDir ?? null;
}

/** Save a persistent agent from its attributes (Then stays "waits for messages"). */
async function updateAgentWork(
  agent: NonNullable<Awaited<ReturnType<typeof getOwnAgent>>>,
  spec: WorkSpec,
  actor: Actor,
): Promise<WorkCreated> {
  const kind: WorkKind = "persistent-agent";
  check(spec, kind);
  const wanted = triggerOf(spec, kind);
  const columns = await agentColumns(spec, actor);
  const planned = await planWorkUpdate(
    agent,
    { owner: spec.owner, podSecrets: spec.podSecrets, agentOptions: spec.who.agentOptions },
    actor,
    { agentType: spec.who.runtime ?? "claude-code", runsOn: "pod", touchesRuntime: true },
  );
  if (!planned.ok) throw new WorkError(planned.status, planned.error);
  try {
    await db.transaction(async (tx) => {
      await paService.updatePersistentAgent(
        agent.id,
        {
          ...columns,
          ownerUserId: planned.ownerUserId,
          ownerTeamId: planned.ownerTeamId,
          ...(planned.podSecrets !== undefined ? { podSecrets: planned.podSecrets } : {}),
        },
        actor.workspaceId,
        tx,
      );
      await saveEditedTrigger("persistent_agent", agent.id, wanted, tx);
    });
  } catch (err) {
    conflict(err, kind, spec);
  }
  return { kind, id: agent.id, href: workHref(kind, agent.id) };
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
  definition: Pick<WorkDefinition, "kind" | "ownerUserId"> & { ownerTeamId?: string | null },
  actor: Actor,
  action: "edit" | "run" | "delete",
): Promise<void> {
  // A Local automation is only ever visible to its owner (getOwnDefinition).
  if (definition.kind === "local-blueprint") return;
  const problem = await workChangeError(
    definition.ownerUserId,
    actor,
    action,
    definition.ownerTeamId,
  );
  if (problem) throw new WorkError(403, problem);
}
