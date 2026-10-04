/**
 * `kind: Skill` — a custom skill (its files in the manifest, `custom_skills`)
 * or a marketplace skill (cloned from a git source, `installed_skills`). The
 * two share one namespace in a manifest; switching between them, or changing
 * the scope, recreates the row.
 */
import {
  MANIFEST_API_VERSION,
  normalizeRepoUrl,
  type CustomSkillConfig,
  type CustomSkillFile,
  type CustomSkillLayout,
  type InstalledSkillConfig,
  type SkillManifest,
} from "@optio/shared";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  updateSkill,
} from "../../skill-service.js";
import {
  createInstalledSkill,
  deleteInstalledSkill,
  getInstalledSkill,
  listInstalledSkills,
  updateInstalledSkill,
} from "../../installed-skill-service.js";
import {
  ManifestError,
  PLANNED_ID,
  repoFor,
  type ResolveContext,
  type ResourceTable,
} from "../context.js";
import { compact, fieldChanges, norm, sameSet } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

export type SkillRow =
  | { table: "custom_skills"; row: CustomSkillConfig }
  | { table: "installed_skills"; row: InstalledSkillConfig };

interface DesiredBase {
  name: string;
  description: string | null;
  repoUrl: string | null;
  agentTypes: string[] | null;
  enabled: boolean;
}

export type DesiredSkill = DesiredBase &
  (
    | {
        table: "custom_skills";
        prompt: string;
        layout: CustomSkillLayout;
        files: CustomSkillFile[] | null;
      }
    | { table: "installed_skills"; sourceUrl: string; ref: string; subpath: string }
  );

const DEFAULT_REF = "main";

/** What installed-skill-service stores for a subpath: no leading `./`, no trailing `/`, `.` for the root. */
function normalizeSubpath(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

function filesOf(files: Record<string, string> | undefined): CustomSkillFile[] | null {
  if (!files) return null;
  const list = Object.entries(files)
    .map(([relativePath, content]) => ({ relativePath, content }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return list.length ? list : null;
}

async function desire(m: SkillManifest, ctx: ResolveContext): Promise<DesiredSkill> {
  const s = m.spec;
  const repo = repoFor(ctx, s.repo, "repo");
  const base: DesiredBase = {
    name: m.metadata.name,
    description: m.metadata.description ?? null,
    repoUrl: repo ? normalizeRepoUrl(repo.repoUrl) : null,
    agentTypes: s.agentTypes?.length ? [...s.agentTypes].sort() : null,
    enabled: s.enabled ?? true,
  };
  if (s.source) {
    return {
      ...base,
      table: "installed_skills",
      sourceUrl: s.source.url,
      ref: s.source.ref?.trim() || DEFAULT_REF,
      subpath: normalizeSubpath(s.source.path),
    };
  }
  if (s.prompt === undefined) {
    throw new ManifestError("promptFile / filesFrom must be read into prompt before an apply");
  }
  const files = filesOf(s.files);
  const layout: CustomSkillLayout = s.layout ?? (files ? "skill-dir" : "commands");
  return {
    ...base,
    table: "custom_skills",
    prompt: s.prompt,
    layout,
    files: layout === "skill-dir" ? (files ?? []) : null,
  };
}

async function workspaceRows(ctx: ResolveContext): Promise<SkillRow[]> {
  const [custom, installed] = await Promise.all([
    listSkills(undefined, ctx.workspaceId),
    listInstalledSkills(undefined, ctx.workspaceId),
  ]);
  const ws = ctx.workspaceId;
  return [
    ...custom
      .filter((r) => (r.workspaceId ?? null) === ws)
      .map((row) => ({ table: "custom_skills" as const, row })),
    ...installed
      .filter((r) => (r.workspaceId ?? null) === ws)
      .map((row) => ({ table: "installed_skills" as const, row })),
  ];
}

async function find(d: DesiredSkill, ctx: ResolveContext): Promise<SkillRow | null> {
  const rows = (await workspaceRows(ctx)).filter((r) => r.row.name === d.name);
  const org = rows.find((r) => !r.row.ownerUserId) ?? null;
  if (!org && rows.length) {
    throw new ManifestError(`A skill named "${d.name}" exists, but it is someone's private skill`);
  }
  return org;
}

async function get(table: ResourceTable, id: string): Promise<SkillRow | null> {
  if (table === "installed_skills") {
    const row = await getInstalledSkill(id);
    return row ? { table, row } : null;
  }
  const row = await getSkill(id);
  return row ? { table: "custom_skills", row } : null;
}

function identify(row: SkillRow): Identified {
  return {
    table: row.table,
    id: row.row.id,
    name: row.row.name,
    ownerUserId: row.row.ownerUserId ?? null,
  };
}

function replaceReason(row: SkillRow, d: DesiredSkill): string | null {
  if (row.table !== d.table) {
    return d.table === "installed_skills"
      ? "was a custom skill, now a marketplace skill — recreated"
      : "was a marketplace skill, now a custom skill — recreated";
  }
  const was = row.row.repoUrl ? normalizeRepoUrl(row.row.repoUrl) : null;
  return norm(was) === norm(d.repoUrl) ? null : "its scope (repo / workspace) changed — recreated";
}

async function diff(row: SkillRow, d: DesiredSkill): Promise<string[]> {
  const changes: string[] = [];
  const stored = row.row as unknown as Record<string, unknown>;
  changes.push(
    ...fieldChanges(stored, { name: d.name, description: d.description, enabled: d.enabled }),
  );
  if (!sameSet(row.row.agentTypes, d.agentTypes)) changes.push("agentTypes");
  if (row.table === "custom_skills" && d.table === "custom_skills") {
    changes.push(
      ...fieldChanges(stored, {
        prompt: d.prompt,
        layout: d.layout,
        files: d.layout === "skill-dir" ? (d.files ?? []) : null,
      }),
    );
  } else if (row.table === "installed_skills" && d.table === "installed_skills") {
    changes.push(
      ...fieldChanges(stored, { sourceUrl: d.sourceUrl, ref: d.ref, subpath: d.subpath }),
    );
  }
  if (row.row.ownerUserId) changes.push("owner");
  return changes;
}

async function create(d: DesiredSkill, ctx: ResolveContext): Promise<SkillRow> {
  if (d.table === "installed_skills") {
    const row = await createInstalledSkill(
      {
        name: d.name,
        description: d.description ?? undefined,
        sourceUrl: d.sourceUrl,
        ref: d.ref,
        subpath: d.subpath,
        repoUrl: d.repoUrl ?? undefined,
        agentTypes: d.agentTypes ?? undefined,
        enabled: d.enabled,
        ownerUserId: null,
      },
      ctx.workspaceId,
    );
    return { table: "installed_skills", row };
  }
  const row = await createSkill(
    {
      name: d.name,
      description: d.description ?? undefined,
      prompt: d.prompt,
      repoUrl: d.repoUrl ?? undefined,
      layout: d.layout,
      files: d.files ?? undefined,
      agentTypes: d.agentTypes ?? undefined,
      enabled: d.enabled,
      ownerUserId: null,
    },
    ctx.workspaceId,
  );
  return { table: "custom_skills", row };
}

async function update(row: SkillRow, d: DesiredSkill): Promise<SkillRow> {
  if (row.table === "installed_skills" && d.table === "installed_skills") {
    const updated = await updateInstalledSkill(row.row.id, {
      name: d.name,
      description: d.description,
      ref: d.ref,
      subpath: d.subpath,
      agentTypes: d.agentTypes,
      enabled: d.enabled,
    });
    return { table: "installed_skills", row: updated };
  }
  if (row.table === "custom_skills" && d.table === "custom_skills") {
    const updated = await updateSkill(row.row.id, {
      name: d.name,
      description: d.description,
      prompt: d.prompt,
      layout: d.layout,
      files: d.files,
      agentTypes: d.agentTypes,
      enabled: d.enabled,
    });
    return { table: "custom_skills", row: updated };
  }
  throw new ManifestError("a skill can't change between custom and marketplace in place");
}

async function remove(table: ResourceTable, id: string): Promise<void> {
  if (table === "installed_skills") await deleteInstalledSkill(id);
  else await deleteSkill(id);
}

async function list(ctx: ResolveContext): Promise<SkillRow[]> {
  return (await workspaceRows(ctx))
    .filter((r) => !r.row.ownerUserId)
    .sort((a, b) => a.row.name.localeCompare(b.row.name));
}

async function exportSkill(row: SkillRow): Promise<SkillManifest> {
  const common = {
    agentTypes: row.row.agentTypes?.length ? row.row.agentTypes : undefined,
    repo: row.row.repoUrl ?? undefined,
    enabled: row.row.enabled ? undefined : false,
  };
  const spec: SkillManifest["spec"] =
    row.table === "installed_skills"
      ? (compact({
          source: compact({
            url: row.row.sourceUrl,
            ref: row.row.ref === DEFAULT_REF ? undefined : row.row.ref,
            path: row.row.subpath === "." ? undefined : row.row.subpath,
          }),
          ...common,
        }) as SkillManifest["spec"])
      : (compact({
          prompt: row.row.prompt,
          layout: row.row.layout === "commands" ? undefined : row.row.layout,
          files: row.row.files?.length
            ? Object.fromEntries(row.row.files.map((f) => [f.relativePath, f.content]))
            : undefined,
          ...common,
        }) as SkillManifest["spec"]);
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "Skill",
    metadata: compact({
      name: row.row.name,
      description: row.row.description ?? undefined,
    }) as SkillManifest["metadata"],
    spec,
  };
}

export const skillHandler: KindHandler<SkillManifest, DesiredSkill, SkillRow> = {
  kind: "Skill",
  stub: (d, ctx) => {
    ctx.skills.set(d.name, { table: d.table, id: PLANNED_ID, name: d.name });
  },
  desire,
  tableOf: (d) => d.table,
  find,
  get,
  identify,
  replaceReason,
  diff,
  create,
  update,
  remove,
  list,
  export: exportSkill,
};
