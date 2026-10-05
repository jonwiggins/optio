/**
 * `kind: Work` — a Job, a scheduled Task, or a persistent agent, written
 * through the same `WorkSpec` path as the New work form (`createWork` /
 * `updateWork`), plus the columns the spec doesn't carry (`enabled`,
 * `params`, `limits`, `pods`). A manifest names the organization's resources
 * by name; this handler turns them into the ids the rows store, and back.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  kindOfSpec,
  SHELL_RUNTIME,
  slugify,
  MANIFEST_API_VERSION,
  type WorkDefinitionKind,
  type WorkManifest,
  type WorkManifestSpec,
  type WorkSettings,
  type WorkSpec,
  type WorkWhen,
} from "@optio/shared";
import { db } from "../../../db/client.js";
import { persistentAgents, workDefinitions } from "../../../db/schema.js";
import * as definitions from "../../work-definition-service.js";
import * as workWrite from "../../work-write-service.js";
import * as paService from "../../persistent-agent-service.js";
import * as triggerService from "../../trigger-service.js";
import {
  ManifestError,
  namesOf,
  repoFor,
  resolveNames,
  type ResolveContext,
  type ResourceTable,
} from "../context.js";
import { compact, fieldChanges, sameSet } from "../compare.js";
import { whenFromManifest, whenToManifest } from "./work-when.js";

export { whenFromManifest, whenToManifest };
import type { Identified, KindHandler } from "./index.js";

type Definition = definitions.WorkDefinition;
type Agent = typeof persistentAgents.$inferSelect;

export type WorkRow =
  | { table: "work_definitions"; row: Definition }
  | { table: "persistent_agents"; row: Agent };

type ManifestWorkKind = "standalone" | "repo-blueprint" | "persistent-agent";

/** The columns `WorkSpec` doesn't carry; undefined = not managed by the manifest. */
interface WorkExtras {
  enabled: boolean;
  paramsSchema?: Record<string, unknown> | null;
  maxTurns?: number | null;
  budgetUsd?: string | null;
  maxPodInstances?: number;
  maxAgentsPerPod?: number;
}

export interface DesiredWork {
  name: string;
  kind: ManifestWorkKind;
  spec: WorkSpec;
  /** A persistent agent's slug (its identity). */
  slug: string | null;
  extras: WorkExtras;
}

const NOUN: Record<ManifestWorkKind, string> = {
  standalone: "Job",
  "repo-blueprint": "scheduled Task",
  "persistent-agent": "agent",
};

const DEFINITION_KINDS: WorkDefinitionKind[] = ["standalone", "repo-blueprint"];

/** The trigger `updateWork` edits — the same one an export reads. */
async function currentTrigger(row: WorkRow) {
  const targetType =
    row.table === "persistent_agents"
      ? "persistent_agent"
      : definitions.TRIGGER_TARGET[row.row.kind];
  return workWrite.editedTrigger(await triggerService.listTriggers(targetType, row.row.id));
}

function sameTrigger(current: { type: string; config: unknown } | null, wanted: WorkWhen): boolean {
  if (wanted.type === "manual") return current === null;
  if (!current || current.type !== wanted.type) return false;
  const { secret: _secret, ...stored } = (current.config ?? {}) as Record<string, unknown>;
  return (
    fieldChanges(stored, wanted.config).length === 0 &&
    fieldChanges(wanted.config, stored).length === 0
  );
}

// ── Desire ──────────────────────────────────────────────────────────────────

function environmentSettings(
  env: WorkManifestSpec["environment"],
  ctx: ResolveContext,
): WorkSettings | null {
  if (!env) return null;
  return {
    connections: resolveNames(env.connections, ctx.connections, "connection"),
    mcpServers: resolveNames(env.mcpServers, ctx.mcpServers, "MCP server"),
    skills: resolveNames(env.skills, ctx.skills, "skill"),
    setupCommands: env.setupCommands ?? undefined,
    review: env.review ?? undefined,
    cautiousMode: env.cautiousMode ?? undefined,
    maxAutoResumes: env.maxAutoResumes ?? undefined,
  };
}

async function desire(m: WorkManifest, ctx: ResolveContext): Promise<DesiredWork> {
  const s = m.spec;
  if (s.what.prompt === undefined) {
    throw new ManifestError("what.promptFile must be read into what.prompt before an apply");
  }
  if (s.agent?.systemPromptFile !== undefined || s.agent?.agentsMdFile !== undefined) {
    throw new ManifestError("agent.*File fields must be read into their fields before an apply");
  }
  const then = s.then ?? "exits";
  const repo = repoFor(ctx, s.where?.repo, "where.repo");
  const spec: WorkSpec = {
    name: m.metadata.name,
    description: m.metadata.description ?? null,
    when: whenFromManifest(s.when),
    where: {
      runTarget: "cluster",
      repoUrl: repo?.repoUrl ?? null,
      repoBranch: s.where?.branch ?? null,
    },
    who: {
      runtime: s.who.runtime === SHELL_RUNTIME ? null : s.who.runtime,
      agentOptions: s.who.options ?? null,
      model: s.who.model ?? null,
    },
    what: { prompt: s.what.prompt, runTitle: s.what.runTitle ?? null },
    then,
    ...(s.mergeWhenReady !== undefined ? { mergeWhenReady: s.mergeWhenReady } : {}),
    ...(s.retries !== undefined ? { maxRetries: s.retries } : {}),
    ...(s.priority !== undefined ? { priority: s.priority } : {}),
    ...(s.agent
      ? {
          agent: {
            slug: s.agent.slug,
            systemPrompt: s.agent.systemPrompt ?? null,
            agentsMd: s.agent.agentsMd ?? null,
            podLifecycle: s.agent.podLifecycle,
          },
        }
      : {}),
    owner: "workspace",
    podSecrets: s.secrets ?? null,
    settings: environmentSettings(s.environment, ctx),
  };
  const kind = kindOfSpec(spec);
  if (kind === "repo-task") {
    throw new ManifestError(
      "A Task that runs once isn't configuration — add `when` to make it a scheduled Task, or drop `where.repo` to make it a Job",
    );
  }
  if (kind !== "standalone" && kind !== "repo-blueprint" && kind !== "persistent-agent") {
    throw new ManifestError(`This describes a ${kind}, which a manifest can't declare`);
  }
  if (then === "until-merged" && kind === "standalone") {
    throw new ManifestError("`then: until-merged` needs `where.repo`");
  }
  if (kind !== "persistent-agent" && s.agent) {
    throw new ManifestError("`agent` is for `then: waits-for-messages`");
  }
  const slug =
    kind === "persistent-agent" ? s.agent?.slug?.trim() || slugify(m.metadata.name) : null;
  if (kind === "persistent-agent" && !slug) {
    throw new ManifestError("Give the agent a name with letters or digits");
  }
  return {
    name: m.metadata.name,
    kind,
    spec,
    slug,
    extras: {
      enabled: s.enabled ?? true,
      paramsSchema: s.params,
      maxTurns: s.limits?.maxTurns,
      budgetUsd:
        s.limits?.budgetUsd === undefined
          ? undefined
          : s.limits.budgetUsd === null
            ? null
            : String(s.limits.budgetUsd),
      maxPodInstances: s.pods?.maxPodInstances,
      maxAgentsPerPod: s.pods?.maxAgentsPerPod,
    },
  };
}

// ── Rows ────────────────────────────────────────────────────────────────────

const tableOf = (d: DesiredWork): ResourceTable =>
  d.kind === "persistent-agent" ? "persistent_agents" : "work_definitions";

function wsOf(
  column: typeof workDefinitions.workspaceId | typeof persistentAgents.workspaceId,
  ws: string | null,
) {
  return ws ? eq(column, ws) : isNull(column);
}

async function find(d: DesiredWork, ctx: ResolveContext): Promise<WorkRow | null> {
  if (d.kind === "persistent-agent") {
    const row = await paService.getPersistentAgentBySlug(ctx.workspaceId, d.slug!);
    if (!row) return null;
    if (row.ownerUserId) {
      throw new ManifestError(
        `An agent with slug "${d.slug}" exists, but it is someone's private agent`,
      );
    }
    return { table: "persistent_agents", row };
  }
  const [row] = await db
    .select()
    .from(workDefinitions)
    .where(
      and(
        eq(workDefinitions.kind, d.kind),
        wsOf(workDefinitions.workspaceId, ctx.workspaceId),
        eq(workDefinitions.name, d.name),
      ),
    );
  if (!row) return null;
  if (row.ownerUserId) {
    throw new ManifestError(
      `A ${NOUN[d.kind]} named "${d.name}" exists, but it is someone's private work`,
    );
  }
  return { table: "work_definitions", row };
}

async function get(table: ResourceTable, id: string): Promise<WorkRow | null> {
  if (table === "persistent_agents") {
    const [row] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, id));
    return row ? { table, row } : null;
  }
  const row = await definitions.getDefinition(id);
  return row ? { table: "work_definitions", row } : null;
}

function identify(row: WorkRow): Identified {
  return { table: row.table, id: row.row.id, name: row.row.name, ownerUserId: row.row.ownerUserId };
}

function nounOf(row: WorkRow): string {
  if (row.table === "persistent_agents") return "an agent";
  return row.row.kind === "local-blueprint" ? "an automation" : `a ${NOUN[row.row.kind]}`;
}

function replaceReason(row: WorkRow, d: DesiredWork): string | null {
  const was = row.table === "persistent_agents" ? "persistent-agent" : row.row.kind;
  if (was === d.kind) return null;
  return `was ${nounOf(row)}, now a ${NOUN[d.kind]} — recreated (its run history doesn't carry over)`;
}

/** The extra columns as a patch — only the ones the manifest manages. */
function extrasPatch(d: DesiredWork): Record<string, unknown> {
  const e = d.extras;
  return {
    enabled: e.enabled,
    ...(e.paramsSchema !== undefined ? { paramsSchema: e.paramsSchema } : {}),
    ...(e.maxTurns !== undefined ? { maxTurns: e.maxTurns } : {}),
    ...(e.budgetUsd !== undefined ? { budgetUsd: e.budgetUsd } : {}),
    ...(e.maxPodInstances !== undefined ? { maxPodInstances: e.maxPodInstances } : {}),
    ...(e.maxAgentsPerPod !== undefined ? { maxAgentsPerPod: e.maxAgentsPerPod } : {}),
  };
}

function viaWorkError<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((err: unknown) => {
    if (err instanceof workWrite.WorkError) throw new ManifestError(err.message);
    throw err;
  });
}

async function diff(row: WorkRow, d: DesiredWork, ctx: ResolveContext): Promise<string[]> {
  const changes: string[] = [];
  const stored = row.row as unknown as Record<string, unknown>;
  if (row.table === "work_definitions") {
    const columns = await viaWorkError(() =>
      workWrite.definitionColumns(d.kind as WorkDefinitionKind, d.spec, ctx.actor),
    );
    changes.push(...fieldChanges(stored, columns as Record<string, unknown>));
  } else {
    const columns = await viaWorkError(() => workWrite.agentColumns(d.spec, ctx.actor));
    changes.push(
      ...fieldChanges(stored, { ...columns, podLifecycle: columns.podLifecycle ?? "sticky" }),
    );
  }
  if (!sameSet(row.row.podSecrets, d.spec.podSecrets)) changes.push("secrets");
  if (row.row.ownerUserId) changes.push("owner");
  const extras = extrasPatch(d);
  if (row.table === "persistent_agents") {
    delete extras.paramsSchema;
    delete extras.budgetUsd;
    delete extras.maxPodInstances;
    delete extras.maxAgentsPerPod;
  }
  changes.push(...fieldChanges(stored, extras));
  if (!sameTrigger(await currentTrigger(row), d.spec.when)) changes.push("when");
  return [...new Set(changes)];
}

async function applyExtras(row: WorkRow, d: DesiredWork, ctx: ResolveContext): Promise<void> {
  const patch = extrasPatch(d);
  if (row.table === "persistent_agents") {
    await paService.updatePersistentAgent(
      row.row.id,
      {
        enabled: d.extras.enabled,
        ...(d.extras.maxTurns != null ? { maxTurns: d.extras.maxTurns } : {}),
      },
      ctx.workspaceId,
    );
  } else {
    await definitions.updateDefinition(row.row.id, row.row.kind, patch);
  }
}

async function create(d: DesiredWork, ctx: ResolveContext): Promise<WorkRow> {
  const made = await viaWorkError(() => workWrite.createWork(d.spec, ctx.actor, { start: false }));
  const row = (await get(tableOf(d), made.id))!;
  await applyExtras(row, d, ctx);
  return (await get(tableOf(d), made.id))!;
}

async function update(row: WorkRow, d: DesiredWork, ctx: ResolveContext): Promise<WorkRow> {
  await viaWorkError(() => workWrite.updateWork(row.row.id, d.spec, ctx.actor));
  await applyExtras(row, d, ctx);
  return (await get(row.table, row.row.id))!;
}

async function remove(table: ResourceTable, id: string, ctx: ResolveContext): Promise<void> {
  if (table === "persistent_agents") {
    await paService.deletePersistentAgent(id, ctx.workspaceId);
    return;
  }
  const row = await definitions.getDefinition(id);
  if (row) await definitions.deleteDefinition(id, row.kind);
}

async function list(ctx: ResolveContext): Promise<WorkRow[]> {
  const defs = await db
    .select()
    .from(workDefinitions)
    .where(
      and(
        inArray(workDefinitions.kind, DEFINITION_KINDS),
        wsOf(workDefinitions.workspaceId, ctx.workspaceId),
        isNull(workDefinitions.ownerUserId),
      ),
    )
    .orderBy(workDefinitions.name);
  const agents = await db
    .select()
    .from(persistentAgents)
    .where(
      and(
        wsOf(persistentAgents.workspaceId, ctx.workspaceId),
        isNull(persistentAgents.ownerUserId),
      ),
    )
    .orderBy(persistentAgents.name);
  return [
    ...defs.map((row) => ({ table: "work_definitions" as const, row })),
    ...agents.map((row) => ({ table: "persistent_agents" as const, row })),
  ];
}

// ── Export ──────────────────────────────────────────────────────────────────

function environmentOf(
  settings: WorkSettings | null | undefined,
  ctx: ResolveContext,
): WorkManifestSpec["environment"] {
  if (!settings) return undefined;
  const env = compact({
    connections: namesOf(settings.connections, ctx.connectionById),
    mcpServers: namesOf(settings.mcpServers, ctx.mcpById),
    skills: namesOf(settings.skills, ctx.skillById),
    setupCommands: settings.setupCommands,
    review: settings.review,
    cautiousMode: settings.cautiousMode,
    maxAutoResumes: settings.maxAutoResumes,
  });
  return Object.keys(env).length ? env : undefined;
}

async function exportWork(row: WorkRow, ctx: ResolveContext): Promise<WorkManifest> {
  const when = whenToManifest(await currentTrigger(row));
  if (row.table === "persistent_agents") {
    const a = row.row;
    const repo = a.repoId ? ctx.repoById.get(a.repoId) : null;
    const spec: WorkManifestSpec = compact({
      when,
      where: repo ? compact({ repo: repo.repoUrl, branch: a.branch ?? undefined }) : undefined,
      who: compact({
        runtime: a.agentRuntime,
        options: a.agentOptions ?? undefined,
        model: a.model ?? undefined,
      }) as WorkManifestSpec["who"],
      what: { prompt: a.initialPrompt },
      then: "waits-for-messages",
      secrets: a.podSecrets ?? undefined,
      environment: environmentOf(a.settings, ctx),
      agent: compact({
        slug: a.slug === slugify(a.name) ? undefined : a.slug,
        systemPrompt: a.systemPrompt ?? undefined,
        agentsMd: a.agentsMd ?? undefined,
        podLifecycle: a.podLifecycle === "sticky" ? undefined : a.podLifecycle,
      }),
      limits: a.maxTurns === 50 ? undefined : { maxTurns: a.maxTurns },
      enabled: a.enabled ? undefined : false,
    }) as WorkManifestSpec;
    return {
      apiVersion: MANIFEST_API_VERSION,
      kind: "Work",
      metadata: compact({
        name: a.name,
        description: a.description ?? undefined,
      }) as WorkManifest["metadata"],
      spec,
    };
  }
  const d = row.row;
  const repoWork = d.kind === "repo-blueprint";
  const spec: WorkManifestSpec = compact({
    when,
    where: repoWork
      ? compact({ repo: d.repoUrl ?? undefined, branch: d.repoBranch ?? undefined })
      : undefined,
    who: compact({
      runtime: d.agentType ?? SHELL_RUNTIME,
      options: d.agentOptions ?? undefined,
      model: d.agentType ? (d.model ?? undefined) : undefined,
    }) as WorkManifestSpec["who"],
    what: compact({
      prompt: d.prompt,
      runTitle: d.runTitle ?? undefined,
    }) as WorkManifestSpec["what"],
    then: repoWork && d.autoResume ? "until-merged" : undefined,
    mergeWhenReady: repoWork && d.autoResume && d.autoMerge === false ? false : undefined,
    retries: d.maxRetries === (repoWork ? 3 : 1) ? undefined : d.maxRetries,
    priority: repoWork && d.priority !== 100 ? d.priority : undefined,
    secrets: d.podSecrets ?? undefined,
    environment: environmentOf(d.settings, ctx),
    params: d.paramsSchema ?? undefined,
    limits: compact({ maxTurns: d.maxTurns ?? undefined, budgetUsd: d.budgetUsd ?? undefined }),
    enabled: d.enabled ? undefined : false,
  }) as WorkManifestSpec;
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "Work",
    metadata: compact({
      name: d.name,
      description: d.description ?? undefined,
    }) as WorkManifest["metadata"],
    spec,
  };
}

export const workHandler: KindHandler<WorkManifest, DesiredWork, WorkRow> = {
  kind: "Work",
  desire,
  tableOf,
  find,
  get,
  identify,
  replaceReason,
  diff,
  create,
  update,
  remove,
  list,
  export: exportWork,
};
