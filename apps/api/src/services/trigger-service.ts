/**
 * Triggers — the *When* of any definition. One CRUD over `workflow_triggers`
 * for every target type (a Job, a scheduled Task, a Local automation, a
 * persistent agent, a PR review): the routes for each target call in here,
 * so a schedule, a webhook path, a ticket filter, or a GitHub / Slack /
 * Linear event behaves the same whatever it starts. Firing is the
 * dispatcher's job (`trigger-dispatch.ts`).
 */
import { and, desc, eq, lte } from "drizzle-orm";
import {
  GITHUB_EVENT_KINDS,
  GITHUB_PERSONAL_EVENT_KINDS,
  LINEAR_EVENT_KINDS,
  LINEAR_PERSONAL_EVENT_KINDS,
  TRIGGER_TYPES_FOR_TARGET,
  type TriggerTargetType,
  type TriggerType,
} from "@optio/shared";
import { db } from "../db/client.js";
import { workflowTriggers } from "../db/schema.js";
import { computeNextFire } from "../utils/cron.js";

export type TriggerRow = typeof workflowTriggers.$inferSelect;

/** Slack channel ids look like C0123ABCD. */
const SLACK_CHANNEL_ID = /^[A-Z][A-Z0-9]{5,}$/;

/**
 * What a trigger's config must carry for its type — the rules every create
 * and update route enforces, in one place. Returns the problem, or null.
 */
export function validateTriggerConfig(
  type: string,
  config: Record<string, unknown> | undefined,
): string | null {
  if (type === "schedule" && typeof config?.cronExpression !== "string") {
    return "Schedule triggers require config.cronExpression";
  }
  if (type === "webhook" && (typeof config?.path !== "string" || !config.path)) {
    return "Webhook triggers require config.path";
  }
  if (type === "ticket" && typeof config?.source !== "string") {
    return "Ticket triggers require config.source";
  }
  if (type === "github") {
    if (config?.events !== undefined) {
      if (!Array.isArray(config.events)) return "github.events must be an array";
      const bad = config.events.find((e) => !GITHUB_EVENT_KINDS.includes(e));
      if (bad) return `Unknown GitHub event kind: ${String(bad)}`;
    }
    const personal = (config?.events as string[] | undefined)?.some((e) =>
      (GITHUB_PERSONAL_EVENT_KINDS as readonly string[]).includes(e),
    );
    if (
      (personal || !config?.events) &&
      (typeof config?.login !== "string" || !config.login.trim())
    ) {
      return "GitHub triggers need config.login (a GitHub username) for review / mention / assign events";
    }
    if (
      config?.repos !== undefined &&
      (!Array.isArray(config.repos) || config.repos.some((r) => typeof r !== "string"))
    ) {
      return "github.repos must be an array of owner/name";
    }
  }
  if (type === "slack") {
    if (typeof config?.channelId !== "string" || !SLACK_CHANNEL_ID.test(config.channelId)) {
      return "Slack triggers require config.channelId (e.g. C0123ABCD)";
    }
  }
  if (type === "linear") {
    if (config?.events !== undefined) {
      if (!Array.isArray(config.events)) return "linear.events must be an array";
      const bad = config.events.find((e) => !LINEAR_EVENT_KINDS.includes(e));
      if (bad) return `Unknown Linear event kind: ${String(bad)}`;
    }
    const personal = (config?.events as string[] | undefined)?.some((e) =>
      (LINEAR_PERSONAL_EVENT_KINDS as readonly string[]).includes(e),
    );
    if (
      (personal || !config?.events) &&
      (typeof config?.user !== "string" || !config.user.trim())
    ) {
      return "Linear triggers need config.user (a Linear name, handle, or user id) for assign / mention events";
    }
  }
  return null;
}

export async function listTriggers(
  targetType: TriggerTargetType,
  targetId: string,
): Promise<TriggerRow[]> {
  return db
    .select()
    .from(workflowTriggers)
    .where(
      and(eq(workflowTriggers.targetType, targetType), eq(workflowTriggers.targetId, targetId)),
    )
    .orderBy(desc(workflowTriggers.createdAt));
}

export async function getTrigger(id: string): Promise<TriggerRow | null> {
  const [row] = await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, id));
  return row ?? null;
}

/** The trigger, only if it belongs to this target (a route's `:id/triggers/:triggerId`). */
export async function getTriggerFor(
  targetType: TriggerTargetType,
  targetId: string,
  id: string,
): Promise<TriggerRow | null> {
  const row = await getTrigger(id);
  return row && row.targetType === targetType && row.targetId === targetId ? row : null;
}

/** An enabled webhook trigger by its `config.path`, whatever it targets. */
export async function getWebhookTriggerByPath(path: string): Promise<TriggerRow | null> {
  const rows = await db.select().from(workflowTriggers).where(eq(workflowTriggers.type, "webhook"));
  return rows.find((t) => (t.config as Record<string, unknown> | null)?.path === path) ?? null;
}

async function assertWebhookPathFree(path: string, exceptId?: string): Promise<void> {
  const rows = await db.select().from(workflowTriggers).where(eq(workflowTriggers.type, "webhook"));
  const clash = rows.find(
    (t) => t.id !== exceptId && (t.config as Record<string, unknown> | null)?.path === path,
  );
  if (clash) throw new Error("duplicate_webhook_path");
}

export interface CreateTriggerInput {
  targetType: TriggerTargetType;
  targetId: string;
  type: TriggerType | string;
  config?: Record<string, unknown> | null;
  paramMapping?: Record<string, unknown> | null;
  enabled?: boolean;
}

/**
 * Attach a trigger. Throws `unsupported_type` when the target can't take the
 * type and `duplicate_webhook_path` when the path is in use — the routes map
 * both to a 4xx. A schedule gets its first `next_fire_at` here so the poller
 * picks it up.
 */
export async function createTrigger(input: CreateTriggerInput): Promise<TriggerRow> {
  const allowed = TRIGGER_TYPES_FOR_TARGET[input.targetType] as readonly string[];
  if (!allowed.includes(input.type)) throw new Error("unsupported_type");
  const config = input.config ?? {};
  if (input.type === "webhook" && typeof config.path === "string") {
    await assertWebhookPathFree(config.path);
  }
  const enabled = input.enabled ?? true;
  const nextFireAt =
    input.type === "schedule" && enabled && typeof config.cronExpression === "string"
      ? computeNextFire(config.cronExpression)
      : null;
  const [row] = await db
    .insert(workflowTriggers)
    .values({
      // Legacy FK for workflow_runs.trigger_id joins: mirrors target_id for Jobs.
      workflowId: input.targetType === "job" ? input.targetId : null,
      targetType: input.targetType,
      targetId: input.targetId,
      type: input.type,
      config,
      paramMapping: input.paramMapping ?? null,
      enabled,
      nextFireAt,
    })
    .returning();
  return row;
}

export interface UpdateTriggerInput {
  config?: Record<string, unknown> | null;
  paramMapping?: Record<string, unknown> | null;
  enabled?: boolean;
}

/**
 * Patch a trigger. A schedule's `next_fire_at` follows the change: a new
 * cron reschedules, re-enabling reschedules, disabling clears it.
 */
export async function updateTrigger(
  id: string,
  input: UpdateTriggerInput,
): Promise<TriggerRow | null> {
  const existing = await getTrigger(id);
  if (!existing) return null;
  if (existing.type === "webhook" && input.config && typeof input.config.path === "string") {
    await assertWebhookPathFree(input.config.path, id);
  }
  const updates: Partial<typeof workflowTriggers.$inferInsert> = { updatedAt: new Date() };
  if (input.config !== undefined) updates.config = input.config;
  if (input.paramMapping !== undefined) updates.paramMapping = input.paramMapping;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (existing.type === "schedule") {
    const config =
      input.config !== undefined ? input.config : (existing.config as Record<string, unknown>);
    const enabled = input.enabled ?? existing.enabled;
    const cron = config?.cronExpression;
    updates.nextFireAt = enabled && typeof cron === "string" ? computeNextFire(cron) : null;
  }
  const [row] = await db
    .update(workflowTriggers)
    .set(updates)
    .where(eq(workflowTriggers.id, id))
    .returning();
  return row ?? null;
}

export async function deleteTrigger(id: string): Promise<boolean> {
  const deleted = await db.delete(workflowTriggers).where(eq(workflowTriggers.id, id)).returning();
  return deleted.length > 0;
}

/** Every enabled trigger of one type, across targets — what a firing fans out over. */
export async function listEnabledTriggersOfType(type: TriggerType): Promise<TriggerRow[]> {
  return db
    .select()
    .from(workflowTriggers)
    .where(and(eq(workflowTriggers.type, type), eq(workflowTriggers.enabled, true)));
}

/** Enabled schedule triggers whose `next_fire_at` has passed, whatever they target. */
export async function listDueScheduleTriggers(): Promise<TriggerRow[]> {
  return db
    .select()
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.type, "schedule"),
        eq(workflowTriggers.enabled, true),
        lte(workflowTriggers.nextFireAt, new Date()),
      ),
    );
}

/** Move a schedule past this tick so the next poll doesn't fire it again. */
export async function advanceSchedule(id: string, cronExpression: string): Promise<void> {
  const now = new Date();
  await db
    .update(workflowTriggers)
    .set({ lastFiredAt: now, nextFireAt: computeNextFire(cronExpression), updatedAt: now })
    .where(eq(workflowTriggers.id, id));
}

export async function markTriggerFired(id: string): Promise<void> {
  await db
    .update(workflowTriggers)
    .set({ lastFiredAt: new Date() })
    .where(eq(workflowTriggers.id, id));
}

// ── Ticket triggers ─────────────────────────────────────────────────────────

export interface TicketFiring {
  source: string;
  externalId: string;
  title: string;
  body?: string;
  labels?: string[];
  url?: string;
}

/** The params a ticket trigger hands its target, whatever the target. */
export function ticketTriggerParams(ticket: TicketFiring): Record<string, string> {
  return {
    ticketSource: ticket.source,
    ticketExternalId: ticket.externalId,
    ticketTitle: ticket.title,
    ticketBody: ticket.body ?? "",
    ticketUrl: ticket.url ?? "",
    ticketLabels: (ticket.labels ?? []).join(","),
  };
}

/** True when a ticket trigger's config (`source`, any-match `labels`) matches the ticket. */
export function ticketTriggerMatches(
  config: Record<string, unknown>,
  ticket: { source: string; labels?: string[] },
): boolean {
  if (config.source && config.source !== ticket.source) return false;
  const required = Array.isArray(config.labels) ? (config.labels as string[]) : null;
  if (required && required.length > 0 && !required.some((l) => ticket.labels?.includes(l))) {
    return false;
  }
  return true;
}
