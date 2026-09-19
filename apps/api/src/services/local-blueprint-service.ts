/**
 * Local Blueprints: reusable terminal specs spawned by triggers (webhook,
 * schedule, ticket, manual). Rows in `local_blueprints`; triggers live in the
 * generic `workflow_triggers` table with target_type = "local_blueprint".
 *
 * Command safety: trigger payloads never carry commands. Params substitute
 * into the user-authored commandTemplate via renderTemplateString, and every
 * substituted value is shell-single-quoted first — write templates without
 * extra quotes around params (`claude {{prompt}}`, not `claude "{{prompt}}"`).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  shellQuote,
  type LocalAgentKind,
  type LocalAgentSessionMode,
  type LocalTerminalSpec,
  type LocalTriggerType,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localBlueprints, workflowTriggers } from "../db/schema.js";
import { logger } from "../logger.js";
import { computeNextFire } from "../utils/cron.js";
import {
  getPromptTemplateById,
  renderTemplateString,
  resolveTemplateConditionals,
} from "./prompt-template-service.js";
import { isAuthDisabled } from "./oauth/index.js";
import {
  findHostDirForRepo,
  getHost,
  listHosts,
  pickOnlineHost,
  type LocalHostRow,
} from "./local-host-service.js";
import { createTerminal, type LocalTerminalRow } from "./local-terminal-service.js";

export type LocalBlueprintRow = typeof localBlueprints.$inferSelect;

function ownedBy(userId: string | null | undefined) {
  return userId ? eq(localBlueprints.userId, userId) : isNull(localBlueprints.userId);
}

export function canAccessBlueprint(
  blueprint: LocalBlueprintRow,
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
  commandTemplate: string;
  /** Saved prompt (Prompts library) that replaces commandTemplate as the agent prompt. */
  promptTemplateId?: string | null;
  agent?: LocalAgentKind | null;
  spawnMode?: "auto" | "hold";
  /** Agent spawns only: stay open for chat (default) or exit when the turn is done. */
  sessionMode?: LocalAgentSessionMode;
}

/**
 * Where a blueprint runs. `dir` and `repoUrl` are both optional: an event
 * trigger (GitHub / Linear) can carry the repo, and as a last resort the
 * host's first allowlisted dir is used — see resolveBlueprintDir.
 */
export async function createBlueprint(input: CreateBlueprintInput): Promise<LocalBlueprintRow> {
  const [row] = await db
    .insert(localBlueprints)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description,
      hostId: input.hostId,
      dir: input.dir,
      repoUrl: input.repoUrl,
      commandTemplate: input.commandTemplate,
      promptTemplateId: input.promptTemplateId ?? null,
      agent: input.agent ?? null,
      spawnMode: input.spawnMode ?? "auto",
      sessionMode: input.sessionMode ?? "interactive",
    })
    .returning();
  return row;
}

export async function getBlueprint(id: string): Promise<LocalBlueprintRow | null> {
  const [row] = await db.select().from(localBlueprints).where(eq(localBlueprints.id, id));
  return row ?? null;
}

export async function listBlueprints(
  userId: string | null | undefined,
): Promise<LocalBlueprintRow[]> {
  return db
    .select()
    .from(localBlueprints)
    .where(ownedBy(userId))
    .orderBy(desc(localBlueprints.createdAt));
}

export async function updateBlueprint(
  id: string,
  updates: Partial<
    Pick<
      CreateBlueprintInput,
      "name" | "commandTemplate" | "promptTemplateId" | "agent" | "spawnMode" | "sessionMode"
    > & {
      description: string | null;
      hostId: string | null;
      dir: string | null;
      repoUrl: string | null;
      enabled: boolean;
    }
  >,
): Promise<LocalBlueprintRow | null> {
  const [row] = await db
    .update(localBlueprints)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(localBlueprints.id, id))
    .returning();
  return row ?? null;
}

export async function deleteBlueprint(id: string): Promise<boolean> {
  await db
    .delete(workflowTriggers)
    .where(
      and(eq(workflowTriggers.targetType, "local_blueprint"), eq(workflowTriggers.targetId, id)),
    );
  const deleted = await db.delete(localBlueprints).where(eq(localBlueprints.id, id)).returning();
  return deleted.length > 0;
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
    /** Terminal title override (defaults to the blueprint name). */
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
    };
  } else {
    // Command mode: params are shell-single-quoted before substitution so a
    // trigger payload can never inject shell syntax. `{{#if}}` blocks are
    // decided on the raw values first — a quoted empty string is `''`, which
    // would otherwise read as present.
    const quotedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawParams)) {
      quotedParams[key] = shellQuote(String(value));
    }
    const command = renderTemplateString(
      resolveTemplateConditionals(template, rawParams),
      quotedParams,
    ).trim();
    if (!command) throw new Error("Blueprint command rendered empty");
    spec = { kind: "command", command };
  }

  return createTerminal({
    host,
    userId: blueprint.userId,
    workspaceId: blueprint.workspaceId,
    dir,
    spec,
    title: opts.title ?? blueprint.name,
    spawnedBy: opts.spawnedBy ?? (opts.triggerId ? "trigger" : "blueprint"),
    blueprintId: blueprint.id,
    triggerId: opts.triggerId,
    ticket: opts.ticket,
    hold: blueprint.spawnMode === "hold",
  });
}

// ── Trigger CRUD (workflow_triggers with target_type = "local_blueprint") ──

export async function listBlueprintTriggers(blueprintId: string) {
  return db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "local_blueprint"),
        eq(workflowTriggers.targetId, blueprintId),
      ),
    )
    .orderBy(desc(workflowTriggers.createdAt));
}

export async function createBlueprintTrigger(input: {
  blueprintId: string;
  type: LocalTriggerType;
  config?: Record<string, unknown>;
  paramMapping?: Record<string, unknown>;
  enabled?: boolean;
}) {
  if (input.type === "webhook" && typeof input.config?.path === "string") {
    const conflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    if (conflicts.some((t) => (t.config as Record<string, unknown>)?.path === input.config!.path)) {
      throw new Error("duplicate_webhook_path");
    }
  }
  const enabled = input.enabled ?? true;
  let nextFireAt: Date | null = null;
  if (input.type === "schedule" && enabled && typeof input.config?.cronExpression === "string") {
    nextFireAt = computeNextFire(input.config.cronExpression);
  }
  const [trigger] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: null,
      targetType: "local_blueprint",
      targetId: input.blueprintId,
      type: input.type,
      config: input.config ?? {},
      paramMapping: input.paramMapping,
      enabled,
      nextFireAt,
    })
    .returning();
  return trigger;
}

export async function updateBlueprintTrigger(
  id: string,
  input: {
    config?: Record<string, unknown>;
    paramMapping?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  const [existing] = await db
    .select()
    .from(workflowTriggers)
    .where(and(eq(workflowTriggers.id, id), eq(workflowTriggers.targetType, "local_blueprint")));
  if (!existing) return null;

  // Enforce webhook path uniqueness on update too (create already does).
  if (input.config && typeof input.config.path === "string") {
    const conflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    if (
      conflicts.some(
        (t) => t.id !== id && (t.config as Record<string, unknown>)?.path === input.config!.path,
      )
    ) {
      throw new Error("duplicate_webhook_path");
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.config !== undefined) updates.config = input.config;
  if (input.paramMapping !== undefined) updates.paramMapping = input.paramMapping;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  if (existing.type === "schedule") {
    const newConfig =
      input.config !== undefined
        ? input.config
        : (existing.config as Record<string, unknown> | null);
    const newEnabled = input.enabled ?? existing.enabled;
    const cronExpression = newConfig?.cronExpression;
    updates.nextFireAt =
      newEnabled && typeof cronExpression === "string" ? computeNextFire(cronExpression) : null;
  }

  const [updated] = await db
    .update(workflowTriggers)
    .set(updates)
    .where(eq(workflowTriggers.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteBlueprintTrigger(id: string): Promise<boolean> {
  const deleted = await db
    .delete(workflowTriggers)
    .where(and(eq(workflowTriggers.id, id), eq(workflowTriggers.targetType, "local_blueprint")))
    .returning();
  return deleted.length > 0;
}

/**
 * Fire enabled `ticket` triggers targeting local blueprints. Mirrors
 * taskConfigService.fireTicketTriggers: optional config.source equality and
 * config.labels any-match.
 */
export async function fireLocalTicketTriggers(ticket: {
  source: string;
  externalId: string;
  title: string;
  body?: string;
  labels?: string[];
  url?: string;
}): Promise<Array<{ triggerId: string; terminalId: string }>> {
  const candidates = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.targetType, "local_blueprint"),
        eq(workflowTriggers.type, "ticket"),
        eq(workflowTriggers.enabled, true),
      ),
    );

  const results: Array<{ triggerId: string; terminalId: string }> = [];
  for (const trigger of candidates) {
    const config = (trigger.config ?? {}) as Record<string, unknown>;
    if (config.source && config.source !== ticket.source) continue;
    const requiredLabels = Array.isArray(config.labels) ? (config.labels as string[]) : null;
    if (requiredLabels && requiredLabels.length > 0) {
      if (!requiredLabels.some((l) => ticket.labels?.includes(l))) continue;
    }

    try {
      const blueprint = await getBlueprint(trigger.targetId);
      if (!blueprint || !blueprint.enabled) continue;
      const terminal = await spawnFromBlueprint(blueprint, {
        triggerId: trigger.id,
        spawnedBy: "ticket",
        // Link the terminal back to the ticket so the UI can show the ticket
        // chip and the terminal appears in the ticket's context.
        ticket: { source: ticket.source, externalId: ticket.externalId, url: ticket.url },
        params: {
          ticketSource: ticket.source,
          ticketExternalId: ticket.externalId,
          ticketTitle: ticket.title,
          ticketBody: ticket.body ?? "",
          ticketUrl: ticket.url ?? "",
          ticketLabels: (ticket.labels ?? []).join(","),
        },
      });
      results.push({ triggerId: trigger.id, terminalId: terminal.id });
      logger.info(
        { triggerId: trigger.id, blueprintId: trigger.targetId, terminalId: terminal.id },
        "Fired ticket trigger for local blueprint",
      );
    } catch (err) {
      logger.warn(
        { err, triggerId: trigger.id, blueprintId: trigger.targetId },
        "Failed to fire local blueprint ticket trigger",
      );
    }
  }
  return results;
}
