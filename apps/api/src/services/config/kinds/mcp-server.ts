/**
 * `kind: McpServer` — an MCP server the workspace's pods get. Env values may
 * be `${{SECRET_NAME}}` references (resolved in the pod, never stored here as
 * values); the secret has to exist. Its scope (a repo or the workspace) can't
 * change in place, so a scope change recreates the row.
 */
import {
  MANIFEST_API_VERSION,
  normalizeRepoUrl,
  type McpServerConfig,
  type McpServerManifest,
} from "@optio/shared";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from "../../mcp-server-service.js";
import {
  ManifestError,
  PLANNED_ID,
  repoFor,
  requireSecretReferences,
  type ResolveContext,
  type ResourceTable,
} from "../context.js";
import { compact, fieldChanges, norm } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

interface DesiredMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string> | null;
  installCommand: string | null;
  repoUrl: string | null;
  enabled: boolean;
}

const envOf = (env: Record<string, string> | null | undefined) =>
  env && Object.keys(env).length ? env : null;

async function desire(m: McpServerManifest, ctx: ResolveContext): Promise<DesiredMcpServer> {
  const s = m.spec;
  requireSecretReferences(ctx, s.env, "env");
  requireSecretReferences(ctx, s.args, "args");
  const repo = repoFor(ctx, s.repo, "repo");
  return {
    name: m.metadata.name,
    command: s.command,
    args: s.args ?? [],
    env: envOf(s.env),
    installCommand: s.installCommand ?? null,
    repoUrl: repo ? normalizeRepoUrl(repo.repoUrl) : null,
    enabled: s.enabled ?? true,
  };
}

async function workspaceRows(ctx: ResolveContext): Promise<McpServerConfig[]> {
  const rows = await listMcpServers(undefined, ctx.workspaceId);
  return rows.filter((r) => (r.workspaceId ?? null) === ctx.workspaceId);
}

async function find(d: DesiredMcpServer, ctx: ResolveContext): Promise<McpServerConfig | null> {
  const rows = await workspaceRows(ctx);
  const row = rows.find((r) => r.name === d.name && !r.ownerUserId) ?? null;
  if (!row && rows.some((r) => r.name === d.name)) {
    throw new ManifestError(
      `An MCP server named "${d.name}" exists, but it is someone's private server`,
    );
  }
  return row;
}

async function get(_table: ResourceTable, id: string): Promise<McpServerConfig | null> {
  return getMcpServer(id);
}

function identify(row: McpServerConfig): Identified {
  return { table: "mcp_servers", id: row.id, name: row.name, ownerUserId: row.ownerUserId ?? null };
}

function replaceReason(row: McpServerConfig, d: DesiredMcpServer): string | null {
  const was = row.repoUrl ? normalizeRepoUrl(row.repoUrl) : null;
  return norm(was) === norm(d.repoUrl) ? null : "its scope (repo / workspace) changed — recreated";
}

async function diff(row: McpServerConfig, d: DesiredMcpServer): Promise<string[]> {
  const changes = fieldChanges(
    { ...row, env: envOf(row.env) },
    {
      name: d.name,
      command: d.command,
      args: d.args,
      env: d.env,
      installCommand: d.installCommand,
      enabled: d.enabled,
    },
  );
  if (row.ownerUserId) changes.push("owner");
  return changes;
}

async function create(d: DesiredMcpServer, ctx: ResolveContext): Promise<McpServerConfig> {
  return createMcpServer(
    {
      name: d.name,
      command: d.command,
      args: d.args,
      env: d.env ?? undefined,
      installCommand: d.installCommand ?? undefined,
      repoUrl: d.repoUrl ?? undefined,
      enabled: d.enabled,
      ownerUserId: null,
    },
    ctx.workspaceId,
  );
}

async function update(row: McpServerConfig, d: DesiredMcpServer): Promise<McpServerConfig> {
  return (
    (await updateMcpServer(row.id, {
      name: d.name,
      command: d.command,
      args: d.args,
      env: d.env,
      installCommand: d.installCommand,
      enabled: d.enabled,
    })) ?? row
  );
}

async function remove(_table: ResourceTable, id: string): Promise<void> {
  await deleteMcpServer(id);
}

async function list(ctx: ResolveContext): Promise<McpServerConfig[]> {
  return (await workspaceRows(ctx))
    .filter((r) => !r.ownerUserId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function exportServer(row: McpServerConfig): Promise<McpServerManifest> {
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "McpServer",
    metadata: { name: row.name },
    spec: compact({
      command: row.command,
      args: row.args.length ? row.args : undefined,
      env: envOf(row.env) ?? undefined,
      installCommand: row.installCommand ?? undefined,
      repo: row.repoUrl ?? undefined,
      enabled: row.enabled ? undefined : false,
    }) as McpServerManifest["spec"],
  };
}

export const mcpServerHandler: KindHandler<McpServerManifest, DesiredMcpServer, McpServerConfig> = {
  kind: "McpServer",
  stub: (d, ctx) => {
    ctx.mcpServers.set(d.name, { id: PLANNED_ID, name: d.name } as McpServerConfig);
  },
  desire,
  tableOf: () => "mcp_servers",
  find,
  get,
  identify,
  replaceReason,
  diff,
  create,
  update,
  remove,
  list,
  export: exportServer,
};
