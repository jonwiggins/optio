/**
 * `kind: Connection` — an external service integration. Its provider's config
 * schema marks the fields that hold credentials (`format: "secret"`); a
 * manifest writes those as `${{SECRET_NAME}}` references and never values,
 * and an export writes the reference back (never a stored literal). The
 * provider and the scope can't change in place: either recreates the row.
 */
import {
  MANIFEST_API_VERSION,
  normalizeRepoUrl,
  type Connection,
  type ConnectionManifest,
  type ConnectionProvider,
} from "@optio/shared";
import {
  createAssignment,
  createConnection,
  deleteAssignment,
  deleteConnection,
  getConnection,
  getProviderBySlug,
  listConnections,
  listProviders,
  updateConnection,
} from "../../connection-service.js";
import {
  ManifestError,
  PLANNED_ID,
  repoFor,
  requireSecret,
  secretReference,
  type ResolveContext,
  type ResourceTable,
} from "../context.js";
import { compact, fieldChanges, norm } from "../compare.js";
import type { Identified, KindHandler } from "./index.js";

interface DesiredAssignment {
  repoId: string | null;
  agentTypes: string[];
  permission: string;
}

interface DesiredConnection {
  name: string;
  providerId: string;
  providerSlug: string;
  config: Record<string, unknown>;
  repoUrl: string | null;
  enabled: boolean;
  assignments: DesiredAssignment[];
}

/** The config keys a provider marks as credentials. */
function secretFields(
  provider: Pick<ConnectionProvider, "configSchema"> | null | undefined,
): Set<string> {
  const props = (
    provider?.configSchema as { properties?: Record<string, { format?: string }> } | null
  )?.properties;
  return new Set(
    Object.entries(props ?? {})
      .filter(([, def]) => def?.format === "secret")
      .map(([key]) => key),
  );
}

async function desire(m: ConnectionManifest, ctx: ResolveContext): Promise<DesiredConnection> {
  const s = m.spec;
  const provider = await getProviderBySlug(s.provider, ctx.workspaceId);
  if (!provider) throw new ManifestError(`provider: no connection provider "${s.provider}"`);
  const secrets = secretFields(provider);
  const config = { ...(s.config ?? {}) };
  for (const [key, value] of Object.entries(config)) {
    const ref = secretReference(value);
    if (ref) {
      requireSecret(ctx, ref, `config.${key}`);
    } else if (secrets.has(key) && value !== undefined && value !== null && value !== "") {
      throw new ManifestError(
        `config.${key} holds a credential — store it as a secret and write \${{SECRET_NAME}} here`,
      );
    }
  }
  const repo = repoFor(ctx, s.repo, "repo");
  const assignments = (s.assignments ?? []).map((a, i) => ({
    repoId: repoFor(ctx, a.repo, `assignments[${i}].repo`)?.id ?? null,
    agentTypes: [...(a.agentTypes ?? [])].sort(),
    permission: a.permission ?? "read",
  }));
  return {
    name: m.metadata.name,
    providerId: provider.id,
    providerSlug: provider.slug,
    config,
    repoUrl: repo ? normalizeRepoUrl(repo.repoUrl) : null,
    enabled: s.enabled ?? true,
    assignments,
  };
}

async function workspaceRows(ctx: ResolveContext): Promise<Connection[]> {
  const rows = await listConnections(ctx.workspaceId);
  return rows.filter((r) => (r.workspaceId ?? null) === ctx.workspaceId);
}

async function find(d: DesiredConnection, ctx: ResolveContext): Promise<Connection | null> {
  const rows = (await workspaceRows(ctx)).filter((r) => r.name === d.name);
  const org = rows.find((r) => !r.ownerUserId) ?? null;
  if (!org && rows.length) {
    throw new ManifestError(
      `A connection named "${d.name}" exists, but it is someone's private connection`,
    );
  }
  return org ? getConnection(org.id) : null;
}

async function get(_table: ResourceTable, id: string): Promise<Connection | null> {
  return getConnection(id);
}

function identify(row: Connection): Identified {
  return { table: "connections", id: row.id, name: row.name, ownerUserId: row.ownerUserId ?? null };
}

function replaceReason(row: Connection, d: DesiredConnection): string | null {
  if (row.providerId !== d.providerId) return "its provider changed — recreated";
  const was = row.repoUrl ? normalizeRepoUrl(row.repoUrl) : null;
  return norm(was) === norm(d.repoUrl) ? null : "its scope (repo / workspace) changed — recreated";
}

const assignmentKey = (a: {
  repoId?: string | null;
  agentTypes?: string[] | null;
  permission?: string | null;
  enabled?: boolean;
}) =>
  `${a.repoId ?? ""}|${[...(a.agentTypes ?? [])].sort().join(",")}|${a.permission ?? "read"}|${a.enabled === false ? "off" : "on"}`;

function assignmentsDiffer(row: Connection, d: DesiredConnection): boolean {
  const have = (row.assignments ?? []).map(assignmentKey).sort();
  const want = d.assignments.map(assignmentKey).sort();
  return have.length !== want.length || have.some((k, i) => k !== want[i]);
}

async function diff(row: Connection, d: DesiredConnection): Promise<string[]> {
  const changes = fieldChanges(row as unknown as Record<string, unknown>, {
    name: d.name,
    config: d.config,
    enabled: d.enabled,
  });
  if (assignmentsDiffer(row, d)) changes.push("assignments");
  if (row.ownerUserId) changes.push("owner");
  return changes;
}

async function create(d: DesiredConnection, ctx: ResolveContext): Promise<Connection> {
  return createConnection(
    {
      name: d.name,
      providerId: d.providerId,
      config: d.config,
      repoUrl: d.repoUrl ?? undefined,
      scope: d.repoUrl ?? "global",
      enabled: d.enabled,
      ownerUserId: null,
      assignments: d.assignments,
    },
    ctx.workspaceId,
  );
}

async function update(row: Connection, d: DesiredConnection): Promise<Connection> {
  await updateConnection(row.id, { name: d.name, config: d.config, enabled: d.enabled });
  const have = new Map((row.assignments ?? []).map((a) => [assignmentKey(a), a]));
  const want = new Map(d.assignments.map((a) => [assignmentKey(a), a]));
  for (const [key, a] of have) if (!want.has(key)) await deleteAssignment(a.id);
  for (const [key, a] of want) if (!have.has(key)) await createAssignment(row.id, a);
  return (await getConnection(row.id)) ?? row;
}

async function remove(_table: ResourceTable, id: string): Promise<void> {
  await deleteConnection(id);
}

async function list(ctx: ResolveContext): Promise<Connection[]> {
  const rows = (await workspaceRows(ctx)).filter((r) => !r.ownerUserId);
  const full = await Promise.all(rows.map((r) => getConnection(r.id)));
  return full.filter((r): r is Connection => !!r).sort((a, b) => a.name.localeCompare(b.name));
}

async function exportConnection(row: Connection, ctx: ResolveContext): Promise<ConnectionManifest> {
  const provider =
    row.provider ??
    (await listProviders(ctx.workspaceId)).find((p) => p.id === row.providerId) ??
    null;
  const secrets = secretFields(provider);
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.config ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    // A stored credential never leaves the row: the reference the pod falls
    // back to (the secret named like the key) stands in for it.
    config[key] = secrets.has(key) && !secretReference(value) ? `\${{${key}}}` : value;
  }
  const assignments = (row.assignments ?? []).map((a) =>
    compact({
      repo: a.repoId ? ctx.repoById.get(a.repoId)?.repoUrl : undefined,
      agentTypes: a.agentTypes?.length ? a.agentTypes : undefined,
      permission: a.permission === "read" ? undefined : (a.permission as "write" | "full"),
    }),
  );
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: "Connection",
    metadata: { name: row.name },
    spec: compact({
      provider: provider?.slug ?? row.providerId,
      config: Object.keys(config).length ? config : undefined,
      repo: row.repoUrl ?? undefined,
      enabled: row.enabled ? undefined : false,
      assignments: assignments.length ? assignments : undefined,
    }) as ConnectionManifest["spec"],
  };
}

export const connectionHandler: KindHandler<ConnectionManifest, DesiredConnection, Connection> = {
  kind: "Connection",
  stub: (d, ctx) => {
    ctx.connections.set(d.name, { id: PLANNED_ID, name: d.name } as Connection);
  },
  desire,
  tableOf: () => "connections",
  find,
  get,
  identify,
  replaceReason,
  diff,
  create,
  update,
  remove,
  list,
  export: exportConnection,
};
