/**
 * Everything a piece of work can be connected to, as one list: provider
 * connections, bare secrets ("credentials only"), and hand-written MCP
 * servers ("tools only"). The "Connected to" picker in the work form and the
 * Connections page both read it, so a row looks the same in both: a logo, a
 * name, whose it is, what it gives the agent. Storage stays three tables;
 * `kind` says which one a toggle changes.
 *
 * Deployment secrets (identity tokens, Optio's settings, git sign-in) are
 * not things work connects to, so they are left out — Settings shows them.
 */
import type { ConnectionPart, WorkEnvironmentEntry } from "@optio/shared";
import { getConnectionsForTask, listConnections } from "./connection-service.js";
import { getMcpServersForTask, listMcpServers } from "./mcp-server-service.js";
import {
  isDeploymentSecret,
  listVisibleSecrets,
  mayUseDeploymentSecrets,
  WORKSPACE_SECRET_SCOPE,
} from "./secret-service.js";
import { canSee, withOwnerNames, type Actor } from "./ownership.js";
import { managedByMap } from "./config/managed.js";

/** Whether a row is the deployment's (no workspace) and shared with every workspace. */
function deploymentFlags(row: {
  workspaceId?: string | null;
  deploymentDefault?: boolean | null;
}): Pick<WorkEnvironmentEntry, "deployment" | "deploymentDefault"> {
  return row.workspaceId ? {} : { deployment: true, deploymentDefault: !!row.deploymentDefault };
}

export interface CatalogWork {
  /** The repo the work runs in; null for work with no checkout. */
  repoUrl: string | null;
  agentType: string;
  /** Null = organization work; set = personal work (its owner's own rows reach it). */
  ownerUserId: string | null;
}

const SECRET_PARTS: ConnectionPart[] = ["credentials"];
const MCP_PARTS: ConnectionPart[] = ["tools"];

/**
 * The catalog `actor` may see. With `forWork`, the entries that are on by
 * default for that work are marked (`default`) — a connection assigned to
 * its repo and agent, a global or repo MCP server; a secret is never on by
 * default, pod secrets are always an explicit pick.
 */
export async function connectionCatalog(
  actor: Actor,
  forWork?: CatalogWork,
): Promise<WorkEnvironmentEntry[]> {
  const workspaceId = actor.workspaceId;
  const [conns, servers, secrets, defaultConns, defaultServers, deployment] = await Promise.all([
    listConnections(workspaceId),
    listMcpServers(undefined, workspaceId, actor),
    listVisibleSecrets(actor),
    forWork
      ? getConnectionsForTask(
          forWork.repoUrl ?? "",
          forWork.agentType,
          workspaceId,
          forWork.ownerUserId,
        )
      : Promise.resolve([]),
    forWork
      ? getMcpServersForTask(forWork.repoUrl ?? "", workspaceId, forWork.ownerUserId)
      : Promise.resolve([]),
    mayUseDeploymentSecrets(workspaceId),
  ]);
  const connOn = new Set(defaultConns.map((c) => c.connectionId));
  const serverOn = new Set(defaultServers.map((s) => s.id));
  const isPrivate = (ownerUserId: string | null | undefined) => !!ownerUserId;

  const connectionEntries: WorkEnvironmentEntry[] = conns
    .filter((c) => canSee(c.ownerUserId, actor))
    .map((c) => ({
      kind: "connection" as const,
      id: c.id,
      name: c.name,
      detail: c.provider?.name ?? null,
      icon: c.provider?.icon ?? null,
      parts: c.parts,
      providerSlug: c.provider?.slug ?? null,
      providerName: c.provider?.name ?? null,
      status: c.status,
      enabled: c.enabled,
      scope: connOn.has(c.id) ? "assigned" : "workspace",
      default: connOn.has(c.id),
      ownerUserId: c.ownerUserId ?? null,
      ...deploymentFlags(c),
      ...(isPrivate(c.ownerUserId) ? { private: true } : {}),
    }));

  const serverEntries: WorkEnvironmentEntry[] = servers.map((s) => ({
    kind: "mcpServer" as const,
    id: s.id,
    name: s.name,
    detail: [s.command, ...s.args].join(" "),
    icon: null,
    parts: MCP_PARTS,
    providerSlug: null,
    providerName: "MCP server",
    enabled: s.enabled,
    scope: s.scope === "global" ? "global" : "repo",
    default: serverOn.has(s.id),
    ownerUserId: s.ownerUserId ?? null,
    ...deploymentFlags(s),
    ...(isPrivate(s.ownerUserId) ? { private: true } : {}),
  }));

  // One entry per secret name and owner (a global row and the viewer's own
  // of the same name are two things to pick).
  const seen = new Set<string>();
  const secretEntries: WorkEnvironmentEntry[] = [];
  // The workspace's own row of a name before the deployment's: it is the one
  // work resolves (retrieveSecretWithFallback).
  const ordered = [...secrets].sort(
    (x, y) =>
      Number(y.scope === WORKSPACE_SECRET_SCOPE) - Number(x.scope === WORKSPACE_SECRET_SCOPE),
  );
  for (const s of ordered) {
    if (isDeploymentSecret(s.name)) continue;
    // The deployment's global secrets are pickable only where it allows.
    if (s.scope === "global" && !deployment) continue;
    const owner = s.ownerUserId ?? null;
    const key = `${owner ?? ""}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repoScoped =
      s.scope !== "global" &&
      s.scope !== WORKSPACE_SECRET_SCOPE &&
      s.scope !== "user" &&
      !s.scope.startsWith("user:");
    secretEntries.push({
      kind: "secret",
      id: s.name,
      name: s.name,
      detail: repoScoped ? s.scope : "Secret",
      icon: null,
      parts: SECRET_PARTS,
      providerSlug: null,
      providerName: "Secret",
      enabled: true,
      // "workspace": the workspace's own organization secret; "global": the deployment's.
      scope: repoScoped
        ? "repo"
        : owner
          ? "private"
          : s.scope === WORKSPACE_SECRET_SCOPE
            ? "workspace"
            : "global",
      default: false,
      ownerUserId: owner,
      ...(owner ? { private: true } : {}),
      ...(!owner && s.scope === "global"
        ? { deployment: true, deploymentDefault: !!s.deploymentDefault }
        : {}),
    });
  }

  // Rows a configuration directory manages carry the Managed chip here too.
  const [managedConns, managedServers] = await Promise.all([
    managedByMap(
      "connections",
      connectionEntries.map((e) => e.id),
    ),
    managedByMap(
      "mcp_servers",
      serverEntries.map((e) => e.id),
    ),
  ]);
  for (const e of connectionEntries) {
    const m = managedConns.get(e.id);
    if (m) e.managedBy = m;
  }
  for (const e of serverEntries) {
    const m = managedServers.get(e.id);
    if (m) e.managedBy = m;
  }

  const named = await withOwnerNames([...connectionEntries, ...serverEntries, ...secretEntries]);
  return named
    .map((e) => ({ ...e, ownerName: e.ownerName ?? null }))
    .sort(
      (a, b) =>
        Number(b.default) - Number(a.default) ||
        a.name.localeCompare(b.name) ||
        a.kind.localeCompare(b.kind),
    );
}
