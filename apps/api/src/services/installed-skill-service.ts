import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { installedSkills } from "../db/schema.js";
import type {
  CreateInstalledSkillInput,
  InstalledSkillConfig,
  InstalledSkillManifest,
  UpdateInstalledSkillInput,
} from "@optio/shared";

const DEFAULT_REF = "main";
const DEFAULT_SUBPATH = ".";

export async function listInstalledSkills(
  scope?: string,
  workspaceId?: string | null,
): Promise<InstalledSkillConfig[]> {
  const conditions = [];
  if (scope) conditions.push(eq(installedSkills.scope, scope));
  if (workspaceId) {
    conditions.push(
      or(eq(installedSkills.workspaceId, workspaceId), isNull(installedSkills.workspaceId))!,
    );
  }
  const query =
    conditions.length > 0
      ? db
          .select()
          .from(installedSkills)
          .where(and(...conditions))
      : db.select().from(installedSkills);
  const rows = await query;
  return rows.map(mapRow);
}

export async function getInstalledSkill(id: string): Promise<InstalledSkillConfig | null> {
  const [row] = await db.select().from(installedSkills).where(eq(installedSkills.id, id));
  return row ? mapRow(row) : null;
}

export async function createInstalledSkill(
  input: CreateInstalledSkillInput,
  workspaceId?: string | null,
): Promise<InstalledSkillConfig> {
  const [row] = await db
    .insert(installedSkills)
    .values({
      name: input.name,
      description: input.description ?? undefined,
      sourceType: "git",
      sourceUrl: input.sourceUrl,
      ref: input.ref?.trim() || DEFAULT_REF,
      subpath: normalizeSubpath(input.subpath),
      scope: input.repoUrl ?? "global",
      repoUrl: input.repoUrl ?? undefined,
      workspaceId: workspaceId ?? undefined,
      agentTypes: input.agentTypes && input.agentTypes.length > 0 ? input.agentTypes : null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return mapRow(row);
}

export async function updateInstalledSkill(
  id: string,
  input: UpdateInstalledSkillInput,
): Promise<InstalledSkillConfig> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.ref !== undefined) updates.ref = input.ref?.trim() || DEFAULT_REF;
  if (input.subpath !== undefined) updates.subpath = normalizeSubpath(input.subpath);
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.agentTypes !== undefined) {
    updates.agentTypes = input.agentTypes && input.agentTypes.length > 0 ? input.agentTypes : null;
  }
  // Changing ref or subpath invalidates the resolved SHA — sync worker will
  // refresh on the next pass.
  if (input.ref !== undefined || input.subpath !== undefined) {
    updates.resolvedSha = null;
    updates.lastSyncError = null;
  }

  const [row] = await db
    .update(installedSkills)
    .set(updates)
    .where(eq(installedSkills.id, id))
    .returning();
  return mapRow(row);
}

export async function deleteInstalledSkill(id: string): Promise<void> {
  await db.delete(installedSkills).where(eq(installedSkills.id, id));
}

/**
 * Mark a skill's sync result. Used by the sync worker.
 */
export async function recordSyncResult(
  id: string,
  result:
    | {
        ok: true;
        resolvedSha: string;
        manifest: InstalledSkillManifest;
        hasExecutableFiles: boolean;
        totalSizeBytes: number;
      }
    | { ok: false; error: string },
): Promise<void> {
  if (result.ok) {
    await db
      .update(installedSkills)
      .set({
        resolvedSha: result.resolvedSha,
        cachedManifest: result.manifest,
        hasExecutableFiles: result.hasExecutableFiles,
        totalSizeBytes: result.totalSizeBytes,
        lastSyncedAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(installedSkills.id, id));
  } else {
    await db
      .update(installedSkills)
      .set({
        lastSyncError: result.error,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(installedSkills.id, id));
  }
}

/**
 * Get all enabled installed skills applicable to a task. Mirrors
 * `skill-service.getSkillsForTask`: scope is `global` or the task's repoUrl;
 * skills with a non-empty `agentTypes` are filtered to the executing agent.
 * Skills without a `resolvedSha` (never successfully synced) are excluded so
 * we never try to materialize from an empty cache.
 */
export async function getInstalledSkillsForTask(
  repoUrl: string,
  workspaceId?: string | null,
  agentType?: string | null,
): Promise<InstalledSkillConfig[]> {
  const conditions = [
    eq(installedSkills.enabled, true),
    or(eq(installedSkills.scope, "global"), eq(installedSkills.scope, repoUrl))!,
  ];
  if (workspaceId) {
    conditions.push(
      or(eq(installedSkills.workspaceId, workspaceId), isNull(installedSkills.workspaceId))!,
    );
  }

  const rows = await db
    .select()
    .from(installedSkills)
    .where(and(...conditions));

  const byName = new Map<string, InstalledSkillConfig>();
  for (const row of rows) {
    const config = mapRow(row);
    if (!config.resolvedSha) continue;
    if (!matchesAgent(config.agentTypes ?? null, agentType ?? null)) continue;
    const existing = byName.get(config.name);
    if (!existing || (config.scope !== "global" && existing.scope === "global")) {
      byName.set(config.name, config);
    }
  }
  return Array.from(byName.values());
}

function matchesAgent(agentTypes: string[] | null, agentType: string | null): boolean {
  if (!agentTypes || agentTypes.length === 0) return true;
  if (!agentType) return false;
  return agentTypes.includes(agentType);
}

/**
 * Reject `..` segments and absolute paths. Empty / "." normalizes to ".".
 */
function normalizeSubpath(raw?: string): string {
  if (!raw) return DEFAULT_SUBPATH;
  const trimmed = raw.replace(/^\/+/, "").trim();
  if (!trimmed || trimmed === ".") return DEFAULT_SUBPATH;
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "..")) {
    throw new Error(`invalid subpath: ${raw}`);
  }
  return parts.filter((p) => p !== ".").join("/") || DEFAULT_SUBPATH;
}

function mapRow(row: typeof installedSkills.$inferSelect): InstalledSkillConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.sourceType as "git",
    sourceUrl: row.sourceUrl,
    ref: row.ref,
    resolvedSha: row.resolvedSha,
    subpath: row.subpath,
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    agentTypes: (row.agentTypes as string[] | null) ?? null,
    enabled: row.enabled,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
    cachedManifest: (row.cachedManifest as InstalledSkillManifest | null) ?? null,
    hasExecutableFiles: row.hasExecutableFiles,
    totalSizeBytes: row.totalSizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
