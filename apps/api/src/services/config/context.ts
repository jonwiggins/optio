/**
 * What an apply resolves manifest names against: the workspace's repos (by
 * URL), connections, MCP servers and skills (by name), and the secrets a pod
 * may be given (by name). Loaded once per apply and reloaded after each kind
 * writes, so a Work manifest can use the connection declared next to it.
 */
import {
  normalizeRepoUrl,
  SECRET_REFERENCE,
  type Connection,
  type IdOverrides,
  type McpServerConfig,
  type NameOverrides,
} from "@optio/shared";
import type { WorkActor } from "../work-ownership.js";
import { listRepos, type RepoRecord } from "../repo-service.js";
import { listConnections } from "../connection-service.js";
import { listMcpServers } from "../mcp-server-service.js";
import { listSkills } from "../skill-service.js";
import { listInstalledSkills } from "../installed-skill-service.js";
import { listPickableSecrets } from "../secret-service.js";

/** The tables a managed resource can live in (`config_objects.resource_table`). */
export const RESOURCE_TABLES = [
  "work_definitions",
  "persistent_agents",
  "prompt_templates",
  "repos",
  "mcp_servers",
  "custom_skills",
  "installed_skills",
  "connections",
] as const;
export type ResourceTable = (typeof RESOURCE_TABLES)[number];

/** The id a dry run gives a row it would create (handlers' `stub`); never written. */
export const PLANNED_ID = "00000000-0000-4000-8000-000000000000";

/** A problem with one manifest: reported for it, the apply goes on. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface SkillRef {
  table: "custom_skills" | "installed_skills";
  id: string;
  name: string;
}

export interface ResolveContext {
  workspaceId: string | null;
  /** The apply writes as the organization: no user, admin rights. */
  actor: WorkActor;
  /** Repos by normalized URL. */
  repos: Map<string, RepoRecord>;
  repoById: Map<string, RepoRecord>;
  /** The organization's connections, MCP servers and skills, by name. */
  connections: Map<string, Connection>;
  connectionById: Map<string, Connection>;
  mcpServers: Map<string, McpServerConfig>;
  mcpById: Map<string, McpServerConfig>;
  skills: Map<string, SkillRef>;
  skillById: Map<string, SkillRef>;
  /** Secrets a pod in this workspace may be given, by name. */
  secretNames: Set<string>;
  /** Read everything again (after a kind created rows). */
  reload(): Promise<void>;
}

export async function loadContext(workspaceId: string | null): Promise<ResolveContext> {
  const ctx: ResolveContext = {
    workspaceId,
    actor: { userId: null, workspaceId, isAdmin: true },
    repos: new Map(),
    repoById: new Map(),
    connections: new Map(),
    connectionById: new Map(),
    mcpServers: new Map(),
    mcpById: new Map(),
    skills: new Map(),
    skillById: new Map(),
    secretNames: new Set(),
    reload: () => fill(ctx),
  };
  await fill(ctx);
  return ctx;
}

async function fill(ctx: ResolveContext): Promise<void> {
  const ws = ctx.workspaceId;
  const [repos, connections, mcpServers, customSkills, installedSkills, secrets] =
    await Promise.all([
      listRepos(ws),
      listConnections(ws),
      listMcpServers(undefined, ws),
      listSkills(undefined, ws),
      listInstalledSkills(undefined, ws),
      listPickableSecrets(ws, null),
    ]);
  ctx.repos = new Map(repos.map((r) => [normalizeRepoUrl(r.repoUrl), r]));
  ctx.repoById = new Map(repos.map((r) => [r.id, r]));
  const org = <T extends { ownerUserId?: string | null }>(rows: T[]) =>
    rows.filter((r) => !r.ownerUserId);
  ctx.connections = new Map(org(connections).map((c) => [c.name, c]));
  ctx.connectionById = new Map(org(connections).map((c) => [c.id, c]));
  ctx.mcpServers = new Map(org(mcpServers).map((s) => [s.name, s]));
  ctx.mcpById = new Map(org(mcpServers).map((s) => [s.id, s]));
  const skills: SkillRef[] = [
    ...org(customSkills).map((s) => ({ table: "custom_skills" as const, id: s.id, name: s.name })),
    ...org(installedSkills).map((s) => ({
      table: "installed_skills" as const,
      id: s.id,
      name: s.name,
    })),
  ];
  ctx.skills = new Map(skills.map((s) => [s.name, s]));
  ctx.skillById = new Map(skills.map((s) => [s.id, s]));
  ctx.secretNames = new Set(secrets.filter((s) => s.owner === "workspace").map((s) => s.name));
}

/** Names → ids for a `WorkSettings` override; an unknown name is the manifest's error. */
export function resolveNames(
  overrides: NameOverrides | undefined,
  byName: Map<string, { id: string }>,
  what: string,
): IdOverrides | undefined {
  if (!overrides) return undefined;
  const ids = (names: string[] | undefined) =>
    names?.map((name) => {
      const found = byName.get(name);
      if (!found) throw new ManifestError(`Unknown ${what} "${name}"`);
      return found.id;
    });
  const add = ids(overrides.add);
  const remove = ids(overrides.remove);
  if (!add?.length && !remove?.length) return undefined;
  return { ...(add?.length ? { add } : {}), ...(remove?.length ? { remove } : {}) };
}

/** Ids → names for an export; ids of things since deleted are dropped. */
export function namesOf(
  overrides: IdOverrides | undefined,
  byId: Map<string, { name: string }>,
): NameOverrides | undefined {
  if (!overrides) return undefined;
  const names = (ids: string[] | undefined) =>
    ids?.map((id) => byId.get(id)?.name).filter((n): n is string => !!n);
  const add = names(overrides.add);
  const remove = names(overrides.remove);
  if (!add?.length && !remove?.length) return undefined;
  return { ...(add?.length ? { add } : {}), ...(remove?.length ? { remove } : {}) };
}

/** The repo a manifest names, which must be registered in the workspace. */
export function repoFor(
  ctx: ResolveContext,
  url: string | null | undefined,
  field: string,
): RepoRecord | null {
  if (!url) return null;
  const repo = ctx.repos.get(normalizeRepoUrl(url));
  if (!repo) {
    throw new ManifestError(
      `${field}: ${url} isn't a repo of this workspace — add a Repo manifest for it, or register it under Repos`,
    );
  }
  return repo;
}

/** The secret name a `${{NAME}}` value refers to, or null for a plain value. */
export function secretReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = SECRET_REFERENCE.exec(value);
  return match ? match[1] : null;
}

/** A secret the workspace's pods may be given — else the manifest's error. */
export function requireSecret(ctx: ResolveContext, name: string, field: string): void {
  if (!ctx.secretNames.has(name)) {
    throw new ManifestError(
      `${field}: no secret named "${name}" in this workspace — add it under Secrets first`,
    );
  }
}

/** Every `${{NAME}}` in a bag of strings must name an existing secret. */
export function requireSecretReferences(
  ctx: ResolveContext,
  values: Record<string, unknown> | string[] | null | undefined,
  field: string,
): void {
  if (!values) return;
  const entries = Array.isArray(values)
    ? values.map((v, i) => [String(i), v] as const)
    : Object.entries(values);
  for (const [key, value] of entries) {
    const name = secretReference(value);
    if (name) requireSecret(ctx, name, `${field}.${key}`);
  }
}
