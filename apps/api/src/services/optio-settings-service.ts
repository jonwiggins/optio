import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioSettings } from "../db/schema.js";
import type { OptioSettings, UpdateOptioSettingsInput } from "@optio/shared";

/**
 * Get settings for a workspace. Returns the settings row or sensible defaults
 * if none exists yet.
 */
export async function getSettings(workspaceId?: string | null): Promise<OptioSettings> {
  const conditions = [];
  if (workspaceId) {
    conditions.push(
      or(eq(optioSettings.workspaceId, workspaceId), isNull(optioSettings.workspaceId))!,
    );
  }

  const rows = await (conditions.length > 0
    ? db
        .select()
        .from(optioSettings)
        .where(and(...conditions))
    : db.select().from(optioSettings));

  // Prefer workspace-specific row, fall back to global (null workspace) row
  const wsRow = rows.find((r) => r.workspaceId === workspaceId);
  const globalRow = rows.find((r) => r.workspaceId === null);
  const row = wsRow ?? globalRow;

  if (row) return mapRow(row);

  // Return defaults (no row in DB yet)
  return {
    id: "",
    model: "sonnet",
    systemPrompt: "",
    enabledTools: [],
    confirmWrites: true,
    maxTurns: 20,
    defaultReviewAgentType: null,
    defaultReviewModel: null,
    workspaceId: workspaceId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Upsert settings for a workspace. Creates if doesn't exist, updates if it does.
 */
export async function upsertSettings(
  input: UpdateOptioSettingsInput,
  workspaceId?: string | null,
): Promise<OptioSettings> {
  // Check for existing row
  const conditions = workspaceId
    ? [eq(optioSettings.workspaceId, workspaceId)]
    : [isNull(optioSettings.workspaceId)];

  const [existing] = await db
    .select()
    .from(optioSettings)
    .where(and(...conditions));

  if (existing) {
    // Update existing row
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.model !== undefined) updates.model = input.model;
    if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
    if (input.enabledTools !== undefined) updates.enabledTools = input.enabledTools;
    if (input.confirmWrites !== undefined) updates.confirmWrites = input.confirmWrites;
    if (input.maxTurns !== undefined) updates.maxTurns = input.maxTurns;
    if (input.defaultReviewAgentType !== undefined)
      updates.defaultReviewAgentType = input.defaultReviewAgentType;
    if (input.defaultReviewModel !== undefined)
      updates.defaultReviewModel = input.defaultReviewModel;

    const [row] = await db
      .update(optioSettings)
      .set(updates)
      .where(eq(optioSettings.id, existing.id))
      .returning();
    return mapRow(row);
  } else {
    // Create new row
    const [row] = await db
      .insert(optioSettings)
      .values({
        model: input.model ?? "sonnet",
        systemPrompt: input.systemPrompt ?? "",
        enabledTools: input.enabledTools ?? [],
        confirmWrites: input.confirmWrites ?? true,
        maxTurns: input.maxTurns ?? 20,
        defaultReviewAgentType: input.defaultReviewAgentType ?? null,
        defaultReviewModel: input.defaultReviewModel ?? null,
        workspaceId: workspaceId ?? undefined,
      })
      .returning();
    return mapRow(row);
  }
}

function mapRow(row: typeof optioSettings.$inferSelect): OptioSettings {
  return {
    id: row.id,
    model: row.model,
    systemPrompt: row.systemPrompt,
    enabledTools: row.enabledTools,
    confirmWrites: row.confirmWrites,
    maxTurns: row.maxTurns,
    defaultReviewAgentType: row.defaultReviewAgentType ?? null,
    defaultReviewModel: row.defaultReviewModel ?? null,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
