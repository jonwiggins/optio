import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { installedSkillFiles, installedSkills } from "../db/schema.js";
import { usableBy, visibleOwner, type Actor } from "./ownership.js";
import type {
  CreateInstalledSkillInput,
  InstalledSkillConfig,
  InstalledSkillManifest,
  UpdateInstalledSkillInput,
} from "@optio/shared";
import { workspaceOrDeploymentDefault } from "./deployment-defaults.js";

const DEFAULT_REF = "main";
const DEFAULT_SUBPATH = ".";

/**
 * Installed skills in a workspace. With `viewer`, only those they may see: the
 * organization's and their own (an admin sees every one) — services/ownership.ts.
 */
export async function listInstalledSkills(
  scope?: string,
  workspaceId?: string | null,
  viewer?: Actor,
): Promise<InstalledSkillConfig[]> {
  const conditions = [];
  if (scope) conditions.push(eq(installedSkills.scope, scope));
  const inWorkspace = await workspaceOrDeploymentDefault(
    installedSkills.workspaceId,
    installedSkills.deploymentDefault,
    workspaceId,
  );
  if (inWorkspace) conditions.push(inWorkspace);
  if (viewer) {
    const visible = visibleOwner(installedSkills.ownerUserId, viewer);
    if (visible) conditions.push(visible);
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
  input: CreateInstalledSkillInput & { ownerUserId?: string | null },
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
      ownerUserId: input.ownerUserId ?? null,
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
  // Changing ref or subpath invalidates the resolved SHA, in the same
  // statement as the change: the skill is due (`dueSkillIds`) the moment the
  // new ref is visible, and a sync of the old ref still in flight finds the
  // ref moved and records nothing (`recordSyncResult`).
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

/** One file of a synced skill, as the sync worker read it from the clone. */
export interface SyncedSkillFile {
  relativePath: string;
  content: Buffer;
  executable: boolean;
}

/**
 * The marker row every successful sync writes beside the skill's files
 * (content: the resolved commit). "Synced at this commit" is this row, not
 * "some file exists", so a skill with no files at all is still synced, and
 * the reader skips it. A skill file of the same name at the skill's root is
 * not synced (the sync worker skips it).
 */
export const SKILL_SYNC_SENTINEL = ".optio-synced";

/**
 * Records a sync — only while the skill's ref and subpath are still the
 * ones the sync resolved (false, and nothing written, otherwise): on
 * success the row's manifest, **the files themselves**
 * (`installed_skill_files`, replaced whole) and the sentinel in one
 * transaction, so a run spawned on any instance reads a complete set at the
 * recorded commit. The inserts upsert on (skill_id, path): two syncs of one
 * skill that overlap (each deleting before the other's rows are visible)
 * both succeed rather than one failing on the primary key.
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
        files: readonly SyncedSkillFile[];
      }
    | { ok: false; error: string },
  /** The ref and subpath the sync read from the row (and resolved). */
  synced: { ref: string; subpath: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // A sync is only good for the ref and subpath it resolved. If a PATCH
    // moved the skill meanwhile, write nothing: the PATCH left it due, and
    // the next sync-due takes the new ref (a sync-one the PATCH queued may
    // have been absorbed by this very job). FOR UPDATE: a PATCH that lands
    // now waits for this commit, then makes the skill due again.
    const [current] = await tx
      .select({ id: installedSkills.id })
      .from(installedSkills)
      .where(
        and(
          eq(installedSkills.id, id),
          eq(installedSkills.ref, synced.ref),
          eq(installedSkills.subpath, synced.subpath),
        ),
      )
      .for("update");
    if (!current) return false;

    if (!result.ok) {
      await tx
        .update(installedSkills)
        .set({
          lastSyncError: result.error,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(installedSkills.id, id));
      return true;
    }

    const rows = [
      ...result.files
        .filter((f) => f.relativePath !== SKILL_SYNC_SENTINEL)
        .map((f) => ({
          skillId: id,
          path: f.relativePath,
          content: f.content,
          executable: f.executable,
          resolvedSha: result.resolvedSha,
        })),
      {
        skillId: id,
        path: SKILL_SYNC_SENTINEL,
        content: Buffer.from(result.resolvedSha),
        executable: false,
        resolvedSha: result.resolvedSha,
      },
    ];
    await tx.delete(installedSkillFiles).where(eq(installedSkillFiles.skillId, id));
    await tx
      .insert(installedSkillFiles)
      .values(rows)
      .onConflictDoUpdate({
        target: [installedSkillFiles.skillId, installedSkillFiles.path],
        set: {
          content: sql`excluded.content`,
          executable: sql`excluded.executable`,
          resolvedSha: sql`excluded.resolved_sha`,
        },
      });
    await tx
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
    return true;
  });
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
  /** The work's owner: a private skill reaches only its owner's work. */
  ownerUserId?: string | null,
): Promise<InstalledSkillConfig[]> {
  const conditions = [
    eq(installedSkills.enabled, true),
    or(eq(installedSkills.scope, "global"), eq(installedSkills.scope, repoUrl))!,
    usableBy(installedSkills.ownerUserId, ownerUserId),
  ];
  const inWorkspace = await workspaceOrDeploymentDefault(
    installedSkills.workspaceId,
    installedSkills.deploymentDefault,
    workspaceId,
  );
  if (inWorkspace) conditions.push(inWorkspace);

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
    deploymentDefault: row.deploymentDefault,
    ownerUserId: row.ownerUserId,
    agentTypes: row.agentTypes ?? null,
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
