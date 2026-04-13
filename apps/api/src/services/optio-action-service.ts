import { eq, desc, and, gte, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioActions, users } from "../db/schema.js";
import type { OptioAction } from "@optio/shared";
import { publishEvent } from "./event-bus.js";

// ── Sensitive key patterns to strip from params ─────────────────────────────

const SENSITIVE_KEYS = /token|secret|password|key|credential|auth/i;

/** Remove sensitive fields from a params object before persisting. */
function sanitizeParams(
  params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!params) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SENSITIVE_KEYS.test(k)) {
      clean[k] = "[REDACTED]";
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

// ── Write ───────────────────────────────────────────────────────────────────

export interface LogActionInput {
  userId?: string;
  action: string;
  params?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  success: boolean;
  conversationSnippet?: string | null;
}

/**
 * Record an Optio agent action in the audit trail.
 * Params are sanitized to strip any sensitive values before storage.
 */
export async function logAction(input: LogActionInput): Promise<OptioAction> {
  const [row] = await db
    .insert(optioActions)
    .values({
      userId: input.userId,
      action: input.action,
      params: sanitizeParams(input.params),
      result: input.result ?? null,
      success: input.success,
      conversationSnippet: input.conversationSnippet ?? null,
    })
    .returning();

  // Publish real-time activity event (non-blocking)
  const [resourceType] = input.action.split(".");
  publishEvent({
    type: "activity:new",
    action: input.action,
    userId: input.userId,
    resourceType,
    resourceId: (input.params?.id ?? input.result?.id) as string | undefined,
    summary: `${input.action} ${input.success ? "succeeded" : "failed"}`,
    timestamp: new Date().toISOString(),
  }).catch(() => {});

  return row as unknown as OptioAction;
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface ListActionsInput {
  userId?: string;
  action?: string;
  success?: boolean;
  after?: Date;
  before?: Date;
  limit?: number;
  offset?: number;
}

/**
 * List Optio actions with optional filters, ordered newest-first.
 * Joins user info for display.
 */
export async function listActions(
  filters: ListActionsInput = {},
): Promise<{ actions: OptioAction[]; total: number }> {
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = filters.offset ?? 0;

  const conditions: SQL[] = [];
  if (filters.userId) {
    conditions.push(eq(optioActions.userId, filters.userId));
  }
  if (filters.action) {
    conditions.push(eq(optioActions.action, filters.action));
  }
  if (filters.success !== undefined) {
    conditions.push(eq(optioActions.success, filters.success));
  }
  if (filters.after) {
    conditions.push(gte(optioActions.createdAt, filters.after));
  }
  if (filters.before) {
    conditions.push(lte(optioActions.createdAt, filters.before));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: optioActions.id,
        userId: optioActions.userId,
        action: optioActions.action,
        params: optioActions.params,
        result: optioActions.result,
        success: optioActions.success,
        conversationSnippet: optioActions.conversationSnippet,
        createdAt: optioActions.createdAt,
        userName: users.displayName,
        userAvatar: users.avatarUrl,
      })
      .from(optioActions)
      .leftJoin(users, eq(optioActions.userId, users.id))
      .where(where)
      .orderBy(desc(optioActions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<string>`count(*)::text` })
      .from(optioActions)
      .where(where),
  ]);

  const total = parseInt(countResult[0]?.count ?? "0", 10);

  const actions: OptioAction[] = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    action: row.action,
    params: row.params,
    result: row.result,
    success: row.success,
    conversationSnippet: row.conversationSnippet,
    createdAt: row.createdAt,
    user: row.userId
      ? { id: row.userId, displayName: row.userName!, avatarUrl: row.userAvatar }
      : undefined,
  }));

  return { actions, total };
}
