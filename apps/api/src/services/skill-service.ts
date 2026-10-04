import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { customSkills } from "../db/schema.js";
import { usableBy, visibleOwner, type Actor } from "./ownership.js";
import type {
  CreateCustomSkillInput,
  CustomSkillConfig,
  CustomSkillFile,
  CustomSkillLayout,
  UpdateCustomSkillInput,
} from "@optio/shared";

const VALID_LAYOUTS: readonly CustomSkillLayout[] = ["commands", "skill-dir"] as const;

function normalizeLayout(value: unknown): CustomSkillLayout {
  return VALID_LAYOUTS.includes(value as CustomSkillLayout)
    ? (value as CustomSkillLayout)
    : "commands";
}

/**
 * Skills in a workspace. With `viewer`, only those they may see: the
 * organization's and their own (an admin sees every one) — services/ownership.ts.
 */
export async function listSkills(
  scope?: string,
  workspaceId?: string | null,
  viewer?: Actor,
): Promise<CustomSkillConfig[]> {
  const conditions = [];
  if (scope) conditions.push(eq(customSkills.scope, scope));
  if (workspaceId) {
    conditions.push(
      or(eq(customSkills.workspaceId, workspaceId), isNull(customSkills.workspaceId))!,
    );
  }
  if (viewer) {
    const visible = visibleOwner(customSkills.ownerUserId, viewer);
    if (visible) conditions.push(visible);
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(customSkills)
          .where(and(...conditions))
      : db.select().from(customSkills);
  const rows = await query;
  return rows.map(mapRow);
}

export async function getSkill(id: string): Promise<CustomSkillConfig | null> {
  const [row] = await db.select().from(customSkills).where(eq(customSkills.id, id));
  return row ? mapRow(row) : null;
}

export async function createSkill(
  input: CreateCustomSkillInput & { ownerUserId?: string | null },
  workspaceId?: string | null,
): Promise<CustomSkillConfig> {
  const layout = normalizeLayout(input.layout);
  const [row] = await db
    .insert(customSkills)
    .values({
      name: input.name,
      description: input.description ?? undefined,
      prompt: input.prompt,
      scope: input.repoUrl ?? "global",
      repoUrl: input.repoUrl ?? undefined,
      ownerUserId: input.ownerUserId ?? null,
      workspaceId: workspaceId ?? undefined,
      layout,
      files: layout === "skill-dir" ? (input.files ?? []) : null,
      agentTypes: input.agentTypes && input.agentTypes.length > 0 ? input.agentTypes : null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return mapRow(row);
}

export async function updateSkill(
  id: string,
  input: UpdateCustomSkillInput,
): Promise<CustomSkillConfig> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.prompt !== undefined) updates.prompt = input.prompt;
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.layout !== undefined) updates.layout = normalizeLayout(input.layout);
  if (input.files !== undefined) updates.files = input.files;
  if (input.agentTypes !== undefined) {
    updates.agentTypes = input.agentTypes && input.agentTypes.length > 0 ? input.agentTypes : null;
  }

  const [row] = await db
    .update(customSkills)
    .set(updates)
    .where(eq(customSkills.id, id))
    .returning();
  return mapRow(row);
}

export async function deleteSkill(id: string): Promise<void> {
  await db.delete(customSkills).where(eq(customSkills.id, id));
}

/**
 * Get all enabled skills for a task (global + repo-scoped) optionally filtered
 * by the executing agent's type. Repo-scoped skills with the same name override
 * global ones. Skills with `agentTypes` set that don't include the current
 * agent are excluded; skills with no `agentTypes` apply to all agents.
 */
export async function getSkillsForTask(
  repoUrl: string,
  workspaceId?: string | null,
  agentType?: string | null,
  /** The work's owner: a private skill reaches only its owner's work. */
  ownerUserId?: string | null,
): Promise<CustomSkillConfig[]> {
  const conditions = [
    eq(customSkills.enabled, true),
    or(eq(customSkills.scope, "global"), eq(customSkills.scope, repoUrl))!,
    usableBy(customSkills.ownerUserId, ownerUserId),
  ];
  if (workspaceId) {
    conditions.push(
      or(eq(customSkills.workspaceId, workspaceId), isNull(customSkills.workspaceId))!,
    );
  }

  const rows = await db
    .select()
    .from(customSkills)
    .where(and(...conditions));

  // Repo-scoped skills override global ones with the same name. Apply agent-type
  // filtering after the per-name dedupe so a more specific (repo) skill that
  // doesn't match the agent doesn't accidentally hide a matching global one.
  const byName = new Map<string, CustomSkillConfig>();
  for (const row of rows) {
    const config = mapRow(row);
    if (!skillMatchesAgent(config, agentType)) continue;
    const existing = byName.get(config.name);
    if (!existing || (config.scope !== "global" && existing.scope === "global")) {
      byName.set(config.name, config);
    }
  }
  return Array.from(byName.values());
}

function skillMatchesAgent(skill: CustomSkillConfig, agentType?: string | null): boolean {
  if (!skill.agentTypes || skill.agentTypes.length === 0) return true;
  if (!agentType) return false;
  return skill.agentTypes.includes(agentType);
}

/**
 * Build setup files for custom skills, in the layout each skill declares.
 *
 *  - "commands"   → `.claude/commands/<name>.md` containing the prompt.
 *  - "skill-dir"  → `.claude/skills/<name>/SKILL.md` containing the prompt,
 *                   plus any `files` entries resolved under that directory.
 *
 * Extra-file paths are sanitized: leading slashes are stripped and `..`
 * segments are rejected so a malformed entry can't escape the skill dir.
 */
export function buildSkillSetupFiles(
  skills: CustomSkillConfig[],
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const skill of skills) {
    if (skill.layout === "skill-dir") {
      const baseDir = `.claude/skills/${skill.name}`;
      out.push({ path: `${baseDir}/SKILL.md`, content: skill.prompt });
      for (const f of skill.files ?? []) {
        const sanitized = sanitizeRelativePath(f.relativePath);
        if (!sanitized) continue;
        out.push({ path: `${baseDir}/${sanitized}`, content: f.content });
      }
    } else {
      out.push({ path: `.claude/commands/${skill.name}.md`, content: skill.prompt });
    }
  }
  return out;
}

function sanitizeRelativePath(input: string): string | null {
  const trimmed = input.replace(/^\/+/, "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

function mapRow(row: typeof customSkills.$inferSelect): CustomSkillConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    scope: row.scope,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    layout: normalizeLayout(row.layout),
    files: (row.files as CustomSkillFile[] | null) ?? null,
    agentTypes: (row.agentTypes as string[] | null) ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
