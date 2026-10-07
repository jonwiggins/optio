/**
 * Local Blueprints: reusable terminal specs spawned by triggers —
 * `local-blueprint` work definitions (rows in work_definitions, CRUD in
 * work-definition-service), kept here in the shape /api/local/blueprints has
 * always returned (`toLocalBlueprint`). Triggers live in the generic
 * `workflow_triggers` table with target_type = "local_blueprint" (CRUD in
 * trigger-service, firing in trigger-dispatch).
 *
 * Command safety: trigger payloads never carry commands. Params reach the
 * user-authored commandTemplate through renderCommandTemplate: each value is
 * a shell variable assigned on the first line, and each `{{param}}` only
 * references it, so a value is never parsed as shell code — bare, inside
 * double quotes, or inside single quotes.
 */
import { modelProviderIdFrom } from "@optio/shared";
import { eq, isNull } from "drizzle-orm";
import {
  localAgentParams,
  type LocalAgentKind,
  type LocalAgentSessionMode,
  type LocalTerminalSpec,
} from "@optio/shared";
import { workDefinitions } from "../db/schema.js";
import * as definitions from "./work-definition-service.js";
import type { WorkDefinition, WorkDefinitionValues } from "./work-definition-service.js";
import { logger } from "../logger.js";
import {
  getPromptTemplateById,
  renderCommandTemplate,
  renderRunTitle,
  renderTemplateString,
} from "./prompt-template-service.js";
import { isAuthDisabled } from "./oauth/index.js";
import {
  canAccessHost,
  findHostDirForRepo,
  getHost,
  listHosts,
  pickOnlineHost,
  type LocalHostRow,
} from "./local-host-service.js";
import { createTerminal, type LocalTerminalRow } from "./local-terminal-service.js";
import { providerSelectionError } from "./model-provider-service.js";
import { credentialSelectionError } from "./agent-credential-service.js";

/** A Local automation as /api/local/blueprints has always returned it. */
export function toLocalBlueprint(d: WorkDefinition) {
  return {
    id: d.id,
    userId: d.ownerUserId,
    workspaceId: d.workspaceId,
    name: d.name,
    description: d.description,
    hostId: d.localHostId,
    dir: d.localDir,
    repoUrl: d.repoUrl,
    baseBranch: d.repoBranch,
    commandTemplate: d.prompt,
    runTitle: d.runTitle,
    promptTemplateId: d.promptTemplateId,
    agent: d.agentType as LocalAgentKind | null,
    spawnMode: d.spawnMode,
    sessionMode: d.localSessionMode ?? "interactive",
    agentOptions: d.agentOptions,
    enabled: d.enabled,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export type LocalBlueprintRow = ReturnType<typeof toLocalBlueprint>;

/** The automations a person owns (none: the unowned rows of auth-disabled dev). */
export function ownedBy(userId: string | null | undefined) {
  return userId ? eq(workDefinitions.ownerUserId, userId) : isNull(workDefinitions.ownerUserId);
}

export function canAccessBlueprint(
  blueprint: Pick<LocalBlueprintRow, "userId">,
  userId: string | null | undefined,
): boolean {
  if (blueprint.userId) return blueprint.userId === (userId ?? null);
  return isAuthDisabled();
}

export interface CreateBlueprintInput {
  userId: string | null;
  workspaceId: string | null;
  name: string;
  description?: string;
  hostId?: string;
  dir?: string;
  repoUrl?: string;
  /** Agent spawns work on a new branch off this base and open a PR; unset = the dir as it is. */
  baseBranch?: string | null;
  commandTemplate: string;
  /** `{{param}}` template each spawned terminal is titled from; null = the blueprint name. */
  runTitle?: string | null;
  /** Saved prompt (Prompts library) that replaces commandTemplate as the agent prompt. */
  promptTemplateId?: string | null;
  agent?: LocalAgentKind | null;
  spawnMode?: "auto" | "hold";
  /** Agent spawns only: stay open for chat (default) or exit when the turn is done. */
  sessionMode?: LocalAgentSessionMode;
  /**
   * Agent spawns: per-run agent parameters keyed like the provider catalog
   * (model, effort, Claude Code's permission mode). Null = the machine's own.
   */
  agentOptions?: Record<string, string | boolean> | null;
}

/**
 * What a create / update must carry: for an agent, a prompt (or a saved
 * prompt that exists) and a model provider the person may use on their
 * machine; and a host the person owns. With no agent the command may be
 * empty — the automation opens a shell. Returns the problem, or null.
 */
export async function checkBlueprint(
  body: {
    commandTemplate?: string;
    promptTemplateId?: string | null;
    hostId?: string | null;
    agent?: string | null;
    agentOptions?: Record<string, unknown> | null;
  },
  owner: { userId: string | null | undefined; workspaceId: string | null },
): Promise<string | null> {
  if (body.agent && !body.commandTemplate?.trim() && !body.promptTemplateId) {
    return "Give the agent a prompt, or pick a saved prompt";
  }
  if (body.promptTemplateId) {
    const saved = await getPromptTemplateById(body.promptTemplateId);
    if (!saved) return "Saved prompt not found";
  }
  if (body.hostId) {
    const host = await getHost(body.hostId);
    if (!host || !canAccessHost(host, owner.userId)) return "Host not found";
  }
  if (body.agent) {
    const use = {
      agentType: body.agent,
      agentOptions: body.agentOptions,
      workspaceId: owner.workspaceId,
      ownerUserId: owner.userId ?? null,
      runsOn: "local" as const,
    };
    return (await providerSelectionError(use)) ?? (await credentialSelectionError(use));
  }
  return null;
}

/**
 * Where a blueprint runs. `dir` and `repoUrl` are both optional: an event
 * trigger (GitHub / Linear) can carry the repo, and as a last resort the
 * host's first allowlisted dir is used — see resolveBlueprintDir.
 */
export async function createBlueprint(input: CreateBlueprintInput): Promise<LocalBlueprintRow> {
  const row = await definitions.createDefinition("local-blueprint", {
    ownerUserId: input.userId,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description,
    runTarget: "local",
    localHostId: input.hostId,
    localDir: input.dir,
    repoUrl: input.repoUrl,
    repoBranch: input.baseBranch ?? null,
    prompt: input.commandTemplate,
    runTitle: input.runTitle?.trim() || null,
    promptTemplateId: input.promptTemplateId ?? null,
    agentType: input.agent ?? null,
    spawnMode: input.spawnMode ?? "auto",
    localSessionMode: input.sessionMode ?? "interactive",
    agentOptions: cleanAgentOptions(input.agentOptions),
  });
  return toLocalBlueprint(row);
}

/** Drop blank values; an empty map is stored as null (the machine's own defaults). */
function cleanAgentOptions(
  options: Record<string, string | boolean> | null | undefined,
): Record<string, string | boolean> | null {
  if (!options) return null;
  const out = Object.fromEntries(
    Object.entries(options).filter(([, v]) => typeof v === "boolean" || v.trim() !== ""),
  );
  return Object.keys(out).length > 0 ? out : null;
}

export async function getBlueprint(id: string): Promise<LocalBlueprintRow | null> {
  const row = await definitions.getDefinition(id, "local-blueprint");
  return row && toLocalBlueprint(row);
}

export async function listBlueprints(
  userId: string | null | undefined,
): Promise<LocalBlueprintRow[]> {
  const rows = await definitions.listDefinitions("local-blueprint", ownedBy(userId));
  return rows.map(toLocalBlueprint);
}

export type UpdateBlueprintInput = Partial<
  Pick<
    CreateBlueprintInput,
    | "name"
    | "commandTemplate"
    | "runTitle"
    | "promptTemplateId"
    | "agent"
    | "spawnMode"
    | "sessionMode"
    | "baseBranch"
    | "agentOptions"
  > & {
    description: string | null;
    hostId: string | null;
    dir: string | null;
    repoUrl: string | null;
    enabled: boolean;
  }
>;

export async function updateBlueprint(
  id: string,
  updates: UpdateBlueprintInput,
): Promise<LocalBlueprintRow | null> {
  const {
    hostId,
    dir,
    baseBranch,
    commandTemplate,
    agent,
    sessionMode,
    runTitle,
    agentOptions,
    ...rest
  } = updates;
  const patch: Partial<WorkDefinitionValues> = {
    ...rest,
    ...(hostId !== undefined ? { localHostId: hostId } : {}),
    ...(dir !== undefined ? { localDir: dir } : {}),
    ...(baseBranch !== undefined ? { repoBranch: baseBranch } : {}),
    ...(commandTemplate !== undefined ? { prompt: commandTemplate } : {}),
    ...(agent !== undefined ? { agentType: agent } : {}),
    ...(sessionMode !== undefined ? { localSessionMode: sessionMode } : {}),
    ...(runTitle !== undefined ? { runTitle: runTitle?.trim() || null } : {}),
    ...(agentOptions !== undefined ? { agentOptions: cleanAgentOptions(agentOptions) } : {}),
  };
  const row = await definitions.updateDefinition(id, "local-blueprint", patch);
  return row && toLocalBlueprint(row);
}

/** Delete a Local automation and its triggers; terminals it spawned stay. */
export async function deleteBlueprint(id: string): Promise<boolean> {
  return definitions.deleteDefinition(id, "local-blueprint");
}

/**
 * Dir resolution for a spawn: the blueprint's explicit dir → the allowlisted
 * dir whose git remote matches the blueprint's repoUrl → the dir matching the
 * event's repo (`repoUrlHint`, e.g. the PR's repository) → the host's first
 * allowlisted dir, but only for events that name no repo (Slack, manual). A
 * repo the host doesn't have — pinned or from the event — is null: running
 * "review PR #12 of acme/api" inside an unrelated checkout is worse than not
 * running.
 */
export function resolveBlueprintDir(
  blueprint: Pick<LocalBlueprintRow, "dir" | "repoUrl">,
  host: LocalHostRow,
  repoUrlHint?: string,
): string | null {
  if (blueprint.dir) return blueprint.dir;
  if (blueprint.repoUrl) {
    const byRepo = findHostDirForRepo(host, blueprint.repoUrl);
    if (byRepo) return byRepo;
  }
  if (repoUrlHint) {
    const byHint = findHostDirForRepo(host, repoUrlHint);
    if (byHint) return byHint;
  }
  if (blueprint.repoUrl || repoUrlHint) return null;
  return host.dirs?.[0]?.path ?? null;
}

/**
 * The template text a spawn renders: the linked saved prompt when the
 * blueprint has one (and it still exists), else the inline commandTemplate.
 */
async function effectiveTemplate(blueprint: LocalBlueprintRow): Promise<string> {
  if (blueprint.promptTemplateId) {
    const saved = await getPromptTemplateById(blueprint.promptTemplateId);
    if (saved) return saved.template;
    logger.warn(
      { blueprintId: blueprint.id, promptTemplateId: blueprint.promptTemplateId },
      "Blueprint's saved prompt no longer exists — falling back to its inline template",
    );
  }
  return blueprint.commandTemplate;
}

/**
 * Spawn a terminal from a blueprint. Host resolution: pinned host → the
 * owner's most recently seen online host → any host of the owner (parks
 * pending until it comes online). Dir resolution: see resolveBlueprintDir.
 */
export async function spawnFromBlueprint(
  blueprint: LocalBlueprintRow,
  opts: {
    params?: Record<string, unknown>;
    triggerId?: string;
    spawnedBy?: "trigger" | "blueprint" | "ticket";
    ticket?: { source: string; externalId: string; url?: string };
    /** Repo the triggering event was about; used when the blueprint pins no dir. */
    repoUrlHint?: string;
    /**
     * What the firing is about ("ENG-12 Login is broken"). The title is the
     * blueprint's runTitle rendered with the params when it has one, else
     * "<name> · <this>", else the blueprint name.
     */
    title?: string;
  } = {},
): Promise<LocalTerminalRow> {
  if (!blueprint.enabled) throw new Error("Blueprint is disabled");

  let host: LocalHostRow | null = null;
  if (blueprint.hostId) {
    host = await getHost(blueprint.hostId);
    // The routes check this on create/update too; re-check here so a stale
    // or hand-edited row can never run someone's automation on another
    // user's machine.
    if (host && host.userId && host.userId !== blueprint.userId) {
      throw new Error("Blueprint host belongs to another user");
    }
  } else {
    host = await pickOnlineHost(blueprint.userId);
    if (!host) {
      const all = await listHosts(blueprint.userId);
      all.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
      host = all[0] ?? null;
    }
  }
  if (!host) throw new Error("No local host available for this blueprint");

  const dir = resolveBlueprintDir(blueprint, host, opts.repoUrlHint);
  if (!dir) {
    throw new Error(
      opts.repoUrlHint && !blueprint.dir && !blueprint.repoUrl
        ? `Host "${host.name}" has no folder for ${opts.repoUrlHint} — add the checkout to its dir list`
        : `No directory on host "${host.name}" matches this blueprint (dir unset, repo not in the host's dir list)`,
    );
  }

  const template = await effectiveTemplate(blueprint);
  const rawParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    rawParams[key] = String(value ?? "");
  }

  let spec: LocalTerminalSpec;
  if (blueprint.agent) {
    // Agent mode: the rendered template is the prompt, passed to the agent as
    // a single argv element (the daemon shell-quotes the whole prompt), so
    // params are substituted raw rather than shell-quoted.
    const prompt = renderTemplateString(template, rawParams).trim();
    spec = {
      kind: "agent",
      agent: blueprint.agent,
      prompt: prompt || undefined,
      mode: blueprint.sessionMode ?? "interactive",
      ...localAgentParams(blueprint.agent, blueprint.agentOptions),
      ...(blueprint.baseBranch ? { baseBranch: blueprint.baseBranch } : {}),
    };
  } else {
    // Command mode: the command with its params shell-quoted, so a trigger
    // payload can never inject shell syntax (renderCommandTemplate). No
    // command opens a shell in the directory that waits for you.
    const command = renderCommandTemplate(template, rawParams);
    spec = command ? { kind: "command", command } : { kind: "shell" };
  }

  return createTerminal({
    host,
    userId: blueprint.userId,
    workspaceId: blueprint.workspaceId,
    dir,
    spec,
    title: blueprint.runTitle
      ? renderRunTitle(blueprint.runTitle, rawParams, blueprint.name)
      : opts.title
        ? `${blueprint.name} · ${opts.title}`
        : blueprint.name,
    spawnedBy: opts.spawnedBy ?? (opts.triggerId ? "trigger" : "blueprint"),
    blueprintId: blueprint.id,
    triggerId: opts.triggerId,
    ticket: opts.ticket,
    hold: blueprint.spawnMode === "hold",
    ...(blueprint.agent ? { modelProviderId: modelProviderIdFrom(blueprint.agentOptions) } : {}),
  });
}
