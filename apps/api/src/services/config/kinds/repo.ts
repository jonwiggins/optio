/**
 * `kind: Repo` — a repository's registration and the settings the manifest
 * names. Its identity is the URL. Only the settings a manifest spells out are
 * managed: a repo has dozens, and an organization shouldn't have to declare
 * every agent model to pin its review policy.
 */
import {
  MANIFEST_API_VERSION,
  normalizeRepoUrl,
  parseRepoUrl,
  type RepoManifest,
} from "@optio/shared";
import {
  createRepo,
  deleteRepo,
  getRepo,
  getRepoByUrl,
  listRepos,
  updateRepo,
  type RepoRecord,
} from "../../repo-service.js";
import { REPO_SETTING_KEYS } from "../../../schemas/config.js";
import { PLANNED_ID, type ResolveContext, type ResourceTable } from "../context.js";
import { compact, fieldChanges } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

interface DesiredRepo {
  name: string;
  url: string;
  /** `owner/repo`, from the URL. */
  fullName: string;
  /** Only the settings the manifest names. */
  settings: Record<string, unknown>;
}

type UpdateData = Parameters<typeof updateRepo>[1];

async function desire(m: RepoManifest): Promise<DesiredRepo> {
  const { url, ...rest } = m.spec;
  const parsed = parseRepoUrl(url);
  const settings: Record<string, unknown> = {};
  for (const key of REPO_SETTING_KEYS) {
    if (rest[key] !== undefined) settings[key] = rest[key];
  }
  return {
    name: m.metadata.name,
    url: normalizeRepoUrl(url),
    fullName: parsed ? `${parsed.owner}/${parsed.repo}` : m.metadata.name,
    settings,
  };
}

async function find(d: DesiredRepo, ctx: ResolveContext): Promise<RepoRecord | null> {
  return getRepoByUrl(d.url, ctx.workspaceId);
}

async function get(_table: ResourceTable, id: string): Promise<RepoRecord | null> {
  return getRepo(id);
}

function identify(row: RepoRecord): Identified {
  return { table: "repos", id: row.id, name: row.fullName, ownerUserId: null };
}

async function diff(row: RepoRecord, d: DesiredRepo): Promise<string[]> {
  return fieldChanges(row as unknown as Record<string, unknown>, d.settings);
}

async function create(d: DesiredRepo, ctx: ResolveContext): Promise<RepoRecord> {
  const made = await createRepo({
    repoUrl: d.url,
    fullName: d.fullName,
    defaultBranch:
      typeof d.settings.defaultBranch === "string" ? d.settings.defaultBranch : undefined,
    workspaceId: ctx.workspaceId,
  });
  const rest = { ...d.settings };
  delete rest.defaultBranch;
  if (Object.keys(rest).length === 0) return made;
  return (await updateRepo(made.id, rest as UpdateData)) ?? made;
}

async function update(row: RepoRecord, d: DesiredRepo): Promise<RepoRecord> {
  return (await updateRepo(row.id, d.settings as UpdateData)) ?? row;
}

async function remove(_table: ResourceTable, id: string): Promise<void> {
  await deleteRepo(id);
}

async function list(ctx: ResolveContext): Promise<RepoRecord[]> {
  return (await listRepos(ctx.workspaceId)).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** The settings an export writes: every manageable one that is set. */
async function exportRepo(row: RepoRecord): Promise<RepoManifest> {
  const record = row as unknown as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  for (const key of REPO_SETTING_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    settings[key] = value;
  }
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "Repo",
    metadata: { name: row.fullName },
    spec: { url: row.repoUrl, ...compact(settings) },
  };
}

export const repoHandler: KindHandler<RepoManifest, DesiredRepo, RepoRecord> = {
  kind: "Repo",
  stub: (d, ctx) => {
    const planned = {
      id: PLANNED_ID,
      repoUrl: d.url,
      fullName: d.fullName,
      defaultBranch:
        typeof d.settings.defaultBranch === "string" ? d.settings.defaultBranch : "main",
    } as RepoRecord;
    ctx.repos.set(d.url, planned);
    ctx.repoById.set(PLANNED_ID, planned);
  },
  desire,
  tableOf: () => "repos",
  find,
  get,
  identify,
  replaceReason: () => null,
  diff,
  create,
  update,
  remove,
  list,
  export: exportRepo,
};
