import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowTriggers } from "../db/schema.js";

export async function listTriggers(workflowId: string) {
  return db
    .select()
    .from(workflowTriggers)
    .where(eq(workflowTriggers.workflowId, workflowId))
    .orderBy(desc(workflowTriggers.createdAt));
}

export async function getTrigger(id: string) {
  const [trigger] = await db.select().from(workflowTriggers).where(eq(workflowTriggers.id, id));
  return trigger ?? null;
}

export async function createTrigger(input: {
  workflowId: string;
  type: string;
  config?: Record<string, unknown>;
  paramMapping?: Record<string, unknown>;
  enabled?: boolean;
}) {
  // Check at-most-one-per-type constraint at the application level
  const existing = await db
    .select()
    .from(workflowTriggers)
    .where(
      and(eq(workflowTriggers.workflowId, input.workflowId), eq(workflowTriggers.type, input.type)),
    );
  if (existing.length > 0) {
    throw new Error("duplicate_type");
  }

  // Check webhook path uniqueness
  if (input.type === "webhook" && input.config?.path) {
    const path = input.config.path as string;
    const conflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    const pathConflict = conflicts.find(
      (t) => (t.config as Record<string, unknown>)?.path === path,
    );
    if (pathConflict) {
      throw new Error("duplicate_webhook_path");
    }
  }

  const [trigger] = await db
    .insert(workflowTriggers)
    .values({
      workflowId: input.workflowId,
      type: input.type,
      config: input.config ?? {},
      paramMapping: input.paramMapping,
      enabled: input.enabled ?? true,
    })
    .returning();
  return trigger;
}

export async function updateTrigger(
  id: string,
  input: {
    config?: Record<string, unknown>;
    paramMapping?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  // Check webhook path uniqueness if updating config on a webhook trigger
  if (input.config && typeof input.config.path === "string") {
    const conflicts = await db
      .select()
      .from(workflowTriggers)
      .where(eq(workflowTriggers.type, "webhook"));
    const pathConflict = conflicts.find(
      (t) => t.id !== id && (t.config as Record<string, unknown>)?.path === input.config!.path,
    );
    if (pathConflict) {
      throw new Error("duplicate_webhook_path");
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.config !== undefined) updates.config = input.config;
  if (input.paramMapping !== undefined) updates.paramMapping = input.paramMapping;
  if (input.enabled !== undefined) updates.enabled = input.enabled;

  const [updated] = await db
    .update(workflowTriggers)
    .set(updates)
    .where(eq(workflowTriggers.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteTrigger(id: string): Promise<boolean> {
  const deleted = await db.delete(workflowTriggers).where(eq(workflowTriggers.id, id)).returning();
  return deleted.length > 0;
}
