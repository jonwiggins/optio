/**
 * `kind: Repo` — a repository's registration and the settings the manifest
 * names. Its identity is the URL. Only the settings a manifest spells out are
 * managed: a repo has dozens, and an organization shouldn't have to declare
 * every agent model to pin its review policy.
 */
import {
  MANIFEST_API_VERSION,
  isAutoMergeConfirmed,
  normalizeRepoUrl,
  parseRepoUrl,
  requireAutoMergeConfirmation,
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
import {
  presetAvailable,
  ImagePresetUnavailableError,
  availablePresets,
} from "../../image-presets.js";
import { platformRefusal } from "../../feature-guard.js";
import { mergeConfirmationRequired } from "../../deployment-settings.js";
import { ManifestError, PLANNED_ID, type ResolveContext, type ResourceTable } from "../context.js";
import { compact, fieldChanges } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

interface DesiredRepo {
  name: string;
  url: string;
  /** `owner/repo`, from the URL. */
  fullName: string;
  /** Only the settings the manifest names. */
  settings: Record<string, unknown>;
  /** The file confirms `autoMerge: true` (its spelling of the dialog). */
  autoMergeConfirmed: boolean;
}

type UpdateData = Parameters<typeof updateRepo>[1];

async function desire(m: RepoManifest): Promise<DesiredRepo> {
  const { url, autoMergeConfirmed, ...rest } = m.spec;
  const parsed = parseRepoUrl(url);
  // A git platform the deployment leaves out (OPTIO_GIT_PLATFORMS).
  const refusal = platformRefusal(parsed?.platform);
  if (refusal) throw new ManifestError(refusal);
  const settings: Record<string, unknown> = {};
  for (const key of REPO_SETTING_KEYS) {
    if (rest[key] !== undefined) settings[key] = rest[key];
  }
  // Only a preset whose image this deployment has (image-presets.ts).
  const preset = settings.imagePreset;
  if (typeof preset === "string" && preset && !presetAvailable(preset)) {
    throw new ManifestError(new ImagePresetUnavailableError(preset, availablePresets()).message);
  }
  // When the deployment asks for the confirmation, a file alone never turns
  // merging on: `autoMerge: true` names the confirmation too (shared
  // work/auto-merge.ts).
  const unconfirmed = requireAutoMergeConfirmation(
    {
      autoMerge: settings.autoMerge as boolean | undefined,
      autoMergeConfirmed: autoMergeConfirmed === true,
    },
    undefined,
    await mergeConfirmationRequired(),
  );
  if (unconfirmed) throw new ManifestError(`${unconfirmed} (autoMergeConfirmed: true)`);
  return {
    name: m.metadata.name,
    url: normalizeRepoUrl(url),
    fullName: parsed ? `${parsed.owner}/${parsed.repo}` : m.metadata.name,
    settings,
    autoMergeConfirmed: autoMergeConfirmed === true,
  };
}

/**
 * The confirmation stamp a write adds: kept when the row is already on and
 * confirmed, now when the file turns it on, cleared when it turns it off.
 * The apply writes as the organization, so there's no one to name.
 */
function autoMergePatch(row: RepoRecord | null, d: DesiredRepo): Record<string, unknown> {
  if (d.settings.autoMerge === undefined) return {};
  if (d.settings.autoMerge !== true)
    return { autoMergeConfirmedAt: null, autoMergeConfirmedBy: null };
  if (row && isAutoMergeConfirmed(row)) return {};
  return { autoMergeConfirmedAt: new Date(), autoMergeConfirmedBy: null };
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
  const changes = fieldChanges(row as unknown as Record<string, unknown>, d.settings);
  if (
    d.settings.autoMerge === true &&
    !isAutoMergeConfirmed(row) &&
    (await mergeConfirmationRequired())
  ) {
    changes.push("autoMergeConfirmed");
  }
  return changes;
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
  return (await updateRepo(made.id, { ...rest, ...autoMergePatch(null, d) } as UpdateData)) ?? made;
}

async function update(row: RepoRecord, d: DesiredRepo): Promise<RepoRecord> {
  return (
    (await updateRepo(row.id, { ...d.settings, ...autoMergePatch(row, d) } as UpdateData)) ?? row
  );
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
  // On but never confirmed exports unconfirmed: re-applying it asks for the confirmation.
  if (settings.autoMerge === true && isAutoMergeConfirmed(row)) settings.autoMergeConfirmed = true;
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
