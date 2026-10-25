import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioSettings } from "../db/schema.js";
import {
  DEFAULT_OPTIO_AGENT_MODEL,
  ALL_OPTIO_TOOL_NAMES,
  parseReviewDepth,
  type OptioSettings,
  type ReviewDepth,
  type UpdateOptioSettingsInput,
} from "@optio/shared";

/**
 * The workspace's code-review defaults (Settings → Code review), beside the
 * review agent and model the shared settings type already has: when a
 * review starts on a repo that is switched on without saying, how deep it
 * goes, and the test command for repos without their own.
 */
export interface ReviewDefaults {
  reviewTrigger: "on_ci_pass" | "on_pr" | "manual";
  reviewDepth: ReviewDepth;
  reviewTestCommand: string | null;
}

export type WorkspaceSettings = OptioSettings & ReviewDefaults;

export type UpdateWorkspaceSettingsInput = UpdateOptioSettingsInput & Partial<ReviewDefaults>;

const REVIEW_DEFAULTS: ReviewDefaults = {
  reviewTrigger: "on_ci_pass",
  reviewDepth: "thorough",
  reviewTestCommand: null,
};

function parseReviewTrigger(raw: unknown): ReviewDefaults["reviewTrigger"] {
  return raw === "on_pr" || raw === "manual" ? raw : "on_ci_pass";
}

/**
 * Get settings for a workspace. Returns the settings row or sensible defaults
 * if none exists yet.
 */
export async function getSettings(workspaceId?: string | null): Promise<WorkspaceSettings> {
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
    agentRuntime: "claude-code",
    agentOptions: {},
    model: DEFAULT_OPTIO_AGENT_MODEL,
    systemPrompt: "",
    enabledTools: [],
    confirmWrites: true,
    maxTurns: 20,
    defaultReviewAgentType: null,
    defaultReviewModel: null,
    ...REVIEW_DEFAULTS,
    workspaceId: workspaceId ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Upsert settings for a workspace. Creates if doesn't exist, updates if it does.
 */
export async function upsertSettings(
  input: UpdateWorkspaceSettingsInput,
  workspaceId?: string | null,
): Promise<WorkspaceSettings> {
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
    if (input.agentRuntime !== undefined) updates.agentRuntime = input.agentRuntime;
    if (input.agentOptions !== undefined) updates.agentOptions = input.agentOptions;
    if (input.model !== undefined) updates.model = input.model;
    if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
    if (input.enabledTools !== undefined) updates.enabledTools = input.enabledTools;
    if (input.confirmWrites !== undefined) updates.confirmWrites = input.confirmWrites;
    if (input.maxTurns !== undefined) updates.maxTurns = input.maxTurns;
    if (input.defaultReviewAgentType !== undefined)
      updates.defaultReviewAgentType = input.defaultReviewAgentType;
    if (input.defaultReviewModel !== undefined)
      updates.defaultReviewModel = input.defaultReviewModel;
    if (input.reviewTrigger !== undefined) updates.reviewTrigger = input.reviewTrigger;
    if (input.reviewDepth !== undefined) updates.reviewDepth = input.reviewDepth;
    if (input.reviewTestCommand !== undefined)
      updates.reviewTestCommand = input.reviewTestCommand?.trim() || null;

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
        agentRuntime: input.agentRuntime ?? "claude-code",
        agentOptions: input.agentOptions ?? {},
        model: input.model ?? DEFAULT_OPTIO_AGENT_MODEL,
        systemPrompt: input.systemPrompt ?? "",
        enabledTools: input.enabledTools ?? [],
        confirmWrites: input.confirmWrites ?? true,
        maxTurns: input.maxTurns ?? 20,
        defaultReviewAgentType: input.defaultReviewAgentType ?? null,
        defaultReviewModel: input.defaultReviewModel ?? null,
        reviewTrigger: input.reviewTrigger ?? REVIEW_DEFAULTS.reviewTrigger,
        reviewDepth: input.reviewDepth ?? REVIEW_DEFAULTS.reviewDepth,
        reviewTestCommand: input.reviewTestCommand?.trim() || null,
        workspaceId: workspaceId ?? undefined,
      })
      .returning();
    return mapRow(row);
  }
}

function mapRow(row: typeof optioSettings.$inferSelect): WorkspaceSettings {
  return {
    id: row.id,
    agentRuntime: row.agentRuntime,
    agentOptions: row.agentOptions,
    model: row.model,
    systemPrompt: row.systemPrompt,
    enabledTools: ALL_OPTIO_TOOL_NAMES.every((name) => row.enabledTools.includes(name))
      ? []
      : row.enabledTools,
    confirmWrites: row.confirmWrites,
    maxTurns: row.maxTurns,
    defaultReviewAgentType: row.defaultReviewAgentType ?? null,
    defaultReviewModel: row.defaultReviewModel ?? null,
    reviewTrigger: parseReviewTrigger(row.reviewTrigger),
    reviewDepth: parseReviewDepth(row.reviewDepth) ?? REVIEW_DEFAULTS.reviewDepth,
    reviewTestCommand: row.reviewTestCommand ?? null,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
