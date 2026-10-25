/**
 * Remote workspaces (docs/remote-workspaces.md): Optio starts a piece of work
 * in a workspace a provider hosts — Coder, GitHub Codespaces, Daytona, E2B
 * (services/remote-workspaces/). The workspace pairs itself with Optio as a
 * machine (`local_hosts`, origin = the provider) and the agent runs there as
 * Local work does on a paired laptop.
 *
 *   POST /api/work (where.remoteWorkspace) ─► startRemoteWorkspaceWork()
 *     preparePairing(): a PAT "<provider>:<workspace>" + a pre-registered host
 *       row (dirs = [the checkout]) + the pairing bundle
 *     the provider's create() / start() with the bundle (template parameters,
 *       a codespace secret, or the start script run in the sandbox)
 *     ─► { localHostId, localDir }: the run is created at once and parks
 *        (pending/host_offline) until the workspace's daemon says hello
 *   the watcher (startRemoteWorkspaceWatcher) ─► fails the parked run when
 *     the workspace fails or the host never comes online in
 *     OPTIO_REMOTE_WORKSPACE_START_TIMEOUT_MS
 *   a re-run / retry / resume / a definition's firing ─►
 *     wakeRemoteWorkspaceWork() (local-run-service, at dispatch): start the
 *     stopped workspace again with a fresh bundle, or create one from the
 *     launch when it's gone
 *   a Job run settles / a Task reaches completed, failed or cancelled ─►
 *     onRemoteWorkspaceRunEnded() / onRemoteWorkspaceTaskSettled(): stop (or
 *     delete) the workspace, revoke the pairing PAT, mark the host offline;
 *     one nothing ran in for OPTIO_REMOTE_WORKSPACE_IDLE_STOP_MS is let go
 *     by the watcher
 *
 * A connection (`remote_workspace_connections`) follows the scope rule of
 * services/ownership.ts: the organization's, a team's, a person's — one of
 * each per provider; work uses the person's, else their team's, else the
 * organization's. Its token is sealed on the row and never leaves the server.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  REMOTE_WORKSPACE_PROVIDER_INFO,
  TERMINAL_TASK_STATES,
  TaskState,
  isRemoteWorkspaceProvider,
  parseIntEnv,
  remoteWorkspaceNameError,
  type LocalHostDir,
  type RemoteWorkspaceLaunch,
  type RemoteWorkspaceProviderId,
} from "@optio/shared";
import { db } from "../db/client.js";
import {
  apiKeys,
  localHosts,
  localTerminals,
  remoteWorkspaceConnections,
  tasks,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import {
  recordRemoteWorkspaceStartFailure,
  recordRemoteWorkspaceStarted,
  siteMetricsOn,
} from "../telemetry/site-metrics.js";
import { createApiKey, revokeApiKey } from "./api-key-service.js";
import { getHost, markHostOffline, type LocalHostRow } from "./local-host-service.js";
import * as relay from "./local-relay.js";
import { publicApiOrigin } from "./oauth/provider.js";
import {
  OwnerError,
  canChange,
  changeRefusal,
  ownerColumnsForNew,
  withOwnerNames,
  type Actor,
} from "./ownership.js";
import { decrypt, encrypt } from "./secret-service.js";
import { remoteWorkspacePolicyParameters, teamOfOwner } from "./agent-policy.js";
import { teamMembershipsOf } from "./team-service.js";
import { minutes, remoteWorkspaceStartTimeoutMs } from "./remote-workspaces/coder.js";
import { providerFor } from "./remote-workspaces/registry.js";
import { startScriptEnv } from "./remote-workspaces/start-script.js";
import {
  RemoteWorkspaceError,
  type PairingBundle,
  type PairingDelivery,
  type RemoteWorkspace,
  type RemoteWorkspaceClient,
} from "./remote-workspaces/types.js";

export { RemoteWorkspaceError, remoteWorkspaceStartTimeoutMs };
export type { PairingBundle };

/** A paired workspace nothing ran in for this long is stopped (the watcher). */
export function remoteWorkspaceIdleStopMs(): number {
  return Math.max(
    60_000,
    parseIntEnv(
      "OPTIO_REMOTE_WORKSPACE_IDLE_STOP_MS",
      parseIntEnv("OPTIO_CODER_IDLE_STOP_MS", 2 * 60 * 60_000),
    ),
  );
}

const label = (provider: string) =>
  isRemoteWorkspaceProvider(provider) ? REMOTE_WORKSPACE_PROVIDER_INFO[provider].label : provider;
const noun = (provider: string) =>
  isRemoteWorkspaceProvider(provider)
    ? REMOTE_WORKSPACE_PROVIDER_INFO[provider].workspaceNoun
    : "workspace";
/** "a Coder workspace", "a codespace", "an E2B sandbox", … */
const aWorkspace = (provider: string) => {
  const title = isRemoteWorkspaceProvider(provider)
    ? REMOTE_WORKSPACE_PROVIDER_INFO[provider].workspaceTitle
    : "remote workspace";
  return `${/^[aeiou]/i.test(title) ? "an" : "a"} ${title}`;
};
/** "The Coder workspace", "The codespace", "The Daytona sandbox", … */
const theWorkspace = (provider: string) =>
  `The ${
    isRemoteWorkspaceProvider(provider)
      ? REMOTE_WORKSPACE_PROVIDER_INFO[provider].workspaceTitle
      : "remote workspace"
  }`;

/** A machine that is a remote workspace (origin = its provider), not one a person paired. */
export const isRemoteWorkspaceHost = (host: Pick<LocalHostRow, "origin">): boolean =>
  isRemoteWorkspaceProvider(host.origin);

// ── Connections ─────────────────────────────────────────────────────────────

export type RemoteWorkspaceConnectionRow = typeof remoteWorkspaceConnections.$inferSelect;

/** A connection as the API returns it: no token, only its last four characters. */
export interface RemoteWorkspaceConnectionView {
  id: string;
  provider: RemoteWorkspaceProviderId;
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  ownerName?: string | null;
  ownerTeamName?: string | null;
  name: string;
  url: string;
  hasToken: boolean;
  tokenHint: string | null;
  caPem: string | null;
  insecureSkipVerify: boolean;
  organizationId: string | null;
  templateId: string | null;
  templateVersionId: string | null;
  templateName: string | null;
  defaultParameters: Record<string, string>;
  ttlMs: number | null;
  deleteWhenDone: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
  enabled: boolean;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toConnectionView(
  row: RemoteWorkspaceConnectionRow & { ownerName?: string | null; ownerTeamName?: string | null },
  actor: Actor,
): RemoteWorkspaceConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerTeamId: row.ownerTeamId,
    ownerName: row.ownerName ?? null,
    ownerTeamName: row.ownerTeamName ?? null,
    name: row.name,
    url: row.url,
    hasToken: !!row.encryptedToken,
    tokenHint: row.tokenHint,
    caPem: row.caPem,
    insecureSkipVerify: row.insecureSkipVerify,
    organizationId: row.organizationId,
    templateId: row.templateId,
    templateVersionId: row.templateVersionId,
    templateName: row.templateName,
    defaultParameters: row.defaultParameters ?? {},
    ttlMs: row.ttlMs,
    deleteWhenDone: row.deleteWhenDone,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastError: row.lastError,
    enabled: row.enabled,
    canEdit: mayChangeConnection(row, actor),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The token's AAD. Every provider's row is sealed under the label the first
 * rows (Coder's) were sealed under, so tokens stored before providers were
 * generalized still open.
 */
function tokenAAD(id: string): Buffer {
  return Buffer.from(`coder_connection|${id}`);
}

function sealToken(id: string, token: string) {
  const blob = encrypt(token, tokenAAD(id));
  return {
    encryptedToken: blob.ciphertext,
    tokenIv: blob.iv,
    tokenAuthTag: blob.authTag,
    tokenHint: token.length > 8 ? token.slice(-4) : null,
  };
}

function openToken(row: RemoteWorkspaceConnectionRow): string | null {
  if (!row.encryptedToken || !row.tokenIv || !row.tokenAuthTag) return null;
  return decrypt(
    { alg: 1, iv: row.tokenIv, ciphertext: row.encryptedToken, authTag: row.tokenAuthTag },
    tokenAAD(row.id),
    `${label(row.provider)} connection ${row.name}`,
  );
}

/** The API the connection reaches: its own URL, else the provider's default. */
export function connectionUrl(row: Pick<RemoteWorkspaceConnectionRow, "provider" | "url">): string {
  return row.url || REMOTE_WORKSPACE_PROVIDER_INFO[row.provider].defaultUrl || "";
}

/** A client for the connection's provider, as its token's account. */
export function clientFor(row: RemoteWorkspaceConnectionRow): RemoteWorkspaceClient {
  const token = openToken(row);
  if (!token) {
    throw new RemoteWorkspaceError(
      `The ${label(row.provider)} connection ${row.name} has no token`,
    );
  }
  return providerFor(row.provider).client({
    url: connectionUrl(row),
    token,
    caPem: row.caPem,
    insecureSkipVerify: row.insecureSkipVerify,
    organizationId: row.organizationId,
  });
}

/**
 * The rows `actor` sees: their workspace's organization rows, their teams'
 * and their own. Another person's token is theirs alone — an admin doesn't
 * see it either (unlike the general rule): it would only show a name. A
 * team's is its members' only — not its creator's once they leave the team
 * (`visibleOwner` would match the creator in owner_user_id).
 */
export function visibleConnections(actor: Actor) {
  const teamIds = actor.teamIds ?? [];
  return and(
    actor.workspaceId
      ? eq(remoteWorkspaceConnections.workspaceId, actor.workspaceId)
      : isNull(remoteWorkspaceConnections.workspaceId),
    or(
      isNull(remoteWorkspaceConnections.ownerUserId),
      ...(actor.userId
        ? [
            and(
              eq(remoteWorkspaceConnections.ownerUserId, actor.userId),
              isNull(remoteWorkspaceConnections.ownerTeamId),
            ),
          ]
        : []),
      ...(teamIds.length > 0 ? [inArray(remoteWorkspaceConnections.ownerTeamId, teamIds)] : []),
    ),
  );
}

/** The organization's needs an admin, a team's its team admins, a person's that person. */
export function mayChangeConnection(
  row: Pick<RemoteWorkspaceConnectionRow, "ownerUserId" | "ownerTeamId">,
  actor: Actor,
  action: "edit" | "delete" = "edit",
): boolean {
  return canChange(row.ownerUserId, actor, actor.isAdmin, action, {
    ownerTeamId: row.ownerTeamId,
    orgNeeds: "admin",
  });
}

/**
 * The connection work uses: the person's own, else a team's (the work's
 * team first), else the organization's. Disabled rows don't count.
 */
export function pickConnection<
  T extends Pick<RemoteWorkspaceConnectionRow, "ownerUserId" | "ownerTeamId" | "enabled">,
>(rows: T[], actor: Actor, teamId?: string | null): T | null {
  const usable = rows.filter((r) => r.enabled);
  const mine = usable.find(
    (r) => !r.ownerTeamId && !!r.ownerUserId && r.ownerUserId === actor.userId,
  );
  if (mine) return mine;
  const teams = actor.teamIds ?? [];
  const team =
    (teamId ? usable.find((r) => r.ownerTeamId === teamId) : undefined) ??
    usable.find((r) => !!r.ownerTeamId && teams.includes(r.ownerTeamId));
  if (team) return team;
  return usable.find((r) => !r.ownerUserId && !r.ownerTeamId) ?? null;
}

export async function listConnections(
  actor: Actor,
  opts: { provider?: RemoteWorkspaceProviderId } = {},
): Promise<RemoteWorkspaceConnectionView[]> {
  const rows = await db
    .select()
    .from(remoteWorkspaceConnections)
    .where(
      and(
        visibleConnections(actor),
        opts.provider ? eq(remoteWorkspaceConnections.provider, opts.provider) : undefined,
      ),
    )
    .orderBy(remoteWorkspaceConnections.name);
  return (await withOwnerNames(rows)).map((r) => toConnectionView(r, actor));
}

export async function getVisibleConnection(
  id: string,
  actor: Actor,
): Promise<RemoteWorkspaceConnectionRow | null> {
  const [row] = await db
    .select()
    .from(remoteWorkspaceConnections)
    .where(and(eq(remoteWorkspaceConnections.id, id), visibleConnections(actor)));
  return row ?? null;
}

/**
 * The connection work started by `actor` uses: the one named (if they see
 * it, and it is the provider asked for), else the one that applies — of the
 * provider asked for, or of any provider (by provider, in the catalog's
 * order, within the same scope).
 */
export async function resolveConnectionFor(
  actor: Actor,
  opts: {
    connectionId?: string | null;
    teamId?: string | null;
    provider?: RemoteWorkspaceProviderId | null;
  } = {},
): Promise<RemoteWorkspaceConnectionRow | null> {
  if (opts.connectionId) {
    const row = await getVisibleConnection(opts.connectionId, actor);
    if (opts.provider && row?.provider !== opts.provider) return null;
    return row?.enabled ? row : null;
  }
  const rows = await db
    .select()
    .from(remoteWorkspaceConnections)
    .where(
      and(
        visibleConnections(actor),
        opts.provider ? eq(remoteWorkspaceConnections.provider, opts.provider) : undefined,
      ),
    );
  return pickConnection(
    [...rows].sort((a, b) => a.provider.localeCompare(b.provider)),
    actor,
    opts.teamId,
  );
}

export interface RemoteWorkspaceConnectionInput {
  name?: string;
  url?: string;
  /** Write-only. Absent on an update keeps the stored one. */
  token?: string;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  organizationId?: string | null;
  templateId?: string | null;
  templateVersionId?: string | null;
  templateName?: string | null;
  defaultParameters?: Record<string, string>;
  ttlMs?: number | null;
  deleteWhenDone?: boolean;
  enabled?: boolean;
  owner?: string;
}

function editableColumns(
  input: RemoteWorkspaceConnectionInput,
): Partial<typeof remoteWorkspaceConnections.$inferInsert> {
  const out: Partial<typeof remoteWorkspaceConnections.$inferInsert> = {};
  if (input.name !== undefined) out.name = input.name.trim();
  if (input.url !== undefined) out.url = input.url.trim().replace(/\/+$/, "");
  if (input.caPem !== undefined) out.caPem = input.caPem?.trim() || null;
  if (input.insecureSkipVerify !== undefined) out.insecureSkipVerify = input.insecureSkipVerify;
  if (input.organizationId !== undefined) out.organizationId = input.organizationId || null;
  if (input.templateId !== undefined) out.templateId = input.templateId || null;
  if (input.templateVersionId !== undefined)
    out.templateVersionId = input.templateVersionId || null;
  if (input.templateName !== undefined) out.templateName = input.templateName || null;
  if (input.defaultParameters !== undefined) out.defaultParameters = input.defaultParameters;
  if (input.ttlMs !== undefined) out.ttlMs = input.ttlMs;
  if (input.deleteWhenDone !== undefined) out.deleteWhenDone = input.deleteWhenDone;
  if (input.enabled !== undefined) out.enabled = input.enabled;
  return out;
}

function scopeTaken(
  provider: RemoteWorkspaceProviderId,
  owner: { ownerUserId: string | null; ownerTeamId: string | null },
): RemoteWorkspaceError {
  const scope = owner.ownerTeamId ? "this team" : owner.ownerUserId ? "you" : "the organization";
  return new RemoteWorkspaceError(
    `There is already a ${label(provider)} connection for ${scope}`,
    409,
  );
}

export async function createConnection(
  input: RemoteWorkspaceConnectionInput & {
    provider: RemoteWorkspaceProviderId;
    name: string;
    url: string;
    token: string;
  },
  actor: Actor,
): Promise<RemoteWorkspaceConnectionView> {
  const provider = input.provider;
  const what = `${label(provider)} connection`;
  let owner: { ownerUserId: string | null; ownerTeamId: string | null };
  try {
    owner = ownerColumnsForNew(input.owner, actor);
  } catch (err) {
    if (err instanceof OwnerError) throw new RemoteWorkspaceError(err.message, 403);
    throw err;
  }
  if (
    REMOTE_WORKSPACE_PROVIDER_INFO[provider].personalOnly &&
    (!owner.ownerUserId || owner.ownerTeamId)
  ) {
    throw new RemoteWorkspaceError(
      `A ${what} is a person's own: its pairing secrets reach every ${noun(provider)} of the ` +
        "token's account, so it can't serve a team or the organization",
    );
  }
  if (!mayChangeConnection(owner, actor)) {
    throw new RemoteWorkspaceError(
      changeRefusal(owner.ownerUserId, what, "admin", owner.ownerTeamId),
      403,
    );
  }
  const id = randomUUID();
  try {
    const [row] = await db
      .insert(remoteWorkspaceConnections)
      .values({
        ...editableColumns(input),
        id,
        provider,
        name: input.name.trim(),
        url: input.url.trim().replace(/\/+$/, ""),
        workspaceId: actor.workspaceId,
        createdBy: actor.userId,
        ...owner,
        ...sealToken(id, input.token.trim()),
      })
      .returning();
    return toConnectionView(row, actor);
  } catch (err) {
    if (isUniqueViolation(err)) throw scopeTaken(provider, owner);
    throw err;
  }
}

async function changeableConnection(
  id: string,
  actor: Actor,
  action: "edit" | "delete" = "edit",
): Promise<RemoteWorkspaceConnectionRow> {
  const row = await getVisibleConnection(id, actor);
  if (!row) throw new RemoteWorkspaceError("Connection not found", 404);
  if (!mayChangeConnection(row, actor, action)) {
    throw new RemoteWorkspaceError(
      changeRefusal(row.ownerUserId, `${label(row.provider)} connection`, "admin", row.ownerTeamId),
      403,
    );
  }
  return row;
}

export async function updateConnection(
  id: string,
  input: RemoteWorkspaceConnectionInput,
  actor: Actor,
): Promise<RemoteWorkspaceConnectionView> {
  const row = await changeableConnection(id, actor);
  if (
    input.url !== undefined &&
    !input.url.trim() &&
    !REMOTE_WORKSPACE_PROVIDER_INFO[row.provider].defaultUrl
  ) {
    throw new RemoteWorkspaceError(`A ${label(row.provider)} connection needs its URL`);
  }
  const [updated] = await db
    .update(remoteWorkspaceConnections)
    .set({
      ...editableColumns(input),
      ...(input.token?.trim() ? sealToken(row.id, input.token.trim()) : {}),
      updatedAt: new Date(),
    })
    .where(eq(remoteWorkspaceConnections.id, id))
    .returning();
  return toConnectionView(updated, actor);
}

/** Remove a connection; answers the row it removed (its name and owner, for the audit trail). */
export async function deleteConnection(
  id: string,
  actor: Actor,
): Promise<RemoteWorkspaceConnectionRow> {
  const row = await changeableConnection(id, actor, "delete");
  await db.delete(remoteWorkspaceConnections).where(eq(remoteWorkspaceConnections.id, id));
  return row;
}

/** The Test button: whom the token signs in as. A failure is an answer, not an error. */
export async function testConnection(
  id: string,
  actor: Actor,
): Promise<
  { ok: true; user: { username: string; email?: string } } | { ok: false; error: string }
> {
  const row = await changeableConnection(id, actor);
  let result:
    | { ok: true; user: { username: string; email?: string } }
    | { ok: false; error: string };
  try {
    const me = await clientFor(row).whoami();
    result = {
      ok: true,
      user: { username: me.username, ...(me.email !== undefined ? { email: me.email } : {}) },
    };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await db
    .update(remoteWorkspaceConnections)
    .set({ lastTestedAt: new Date(), lastError: result.ok ? null : result.error.slice(0, 1000) })
    .where(eq(remoteWorkspaceConnections.id, id));
  return result;
}

/** A client for a connection `actor` sees (the template and workspace pickers). */
export async function clientForVisible(id: string, actor: Actor): Promise<RemoteWorkspaceClient> {
  const row = await getVisibleConnection(id, actor);
  if (!row) throw new RemoteWorkspaceError("Connection not found", 404);
  return clientFor(row);
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/** The parameter that names the checkout (every provider). */
export const CHECKOUT_PARAMETER = "optio_checkout_dir";
/** The pairing PAT outlives the workspace's TTL by this much. */
const PAIRING_GRACE_MS = 60 * 60_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;

/**
 * Mint the pairing PAT (`<provider>:<workspace>`, expiring an hour after the
 * workspace's TTL) and register the machine before it exists — origin = the
 * provider, the checkout as its one directory, so the run validates and
 * parks now. An existing workspace's row is reused, its old token revoked.
 */
export async function preparePairing(
  conn: RemoteWorkspaceConnectionRow,
  actor: Actor,
  opts: { workspaceName: string; checkoutDir: string; host?: LocalHostRow | null },
): Promise<{ bundle: PairingBundle; host: LocalHostRow; tokenId: string }> {
  const userId = actor.userId;
  if (!userId) {
    throw new RemoteWorkspaceError(
      `Work in ${aWorkspace(conn.provider)} needs a signed-in person: it pairs with your token`,
    );
  }
  const expiresAt = new Date(Date.now() + (conn.ttlMs ?? DEFAULT_TTL_MS) + PAIRING_GRACE_MS);
  const pat = await createApiKey(userId, `${conn.provider}:${opts.workspaceName}`, expiresAt);
  const dir: LocalHostDir = { path: opts.checkoutDir };
  let host: LocalHostRow;
  if (opts.host) {
    if (opts.host.pairingTokenId) {
      await revokeApiKey(opts.host.pairingTokenId, userId).catch(() => false);
    }
    const dirs = (opts.host.dirs ?? []).some((d) => d.path === dir.path)
      ? opts.host.dirs
      : [...(opts.host.dirs ?? []), dir];
    [host] = await db
      .update(localHosts)
      .set({
        pairingTokenId: pat.tokenId,
        remoteWorkspaceConnectionId: conn.id,
        dirs,
        updatedAt: new Date(),
      })
      .where(eq(localHosts.id, opts.host.id))
      .returning();
  } else {
    const id = randomUUID();
    [host] = await db
      .insert(localHosts)
      .values({
        id,
        userId,
        workspaceId: actor.workspaceId,
        name: opts.workspaceName,
        hostname: `${conn.provider}:${id}`,
        platform: "linux",
        dirs: [dir],
        origin: conn.provider,
        remoteWorkspaceConnectionId: conn.id,
        remoteWorkspaceName: opts.workspaceName,
        pairingTokenId: pat.tokenId,
      })
      .returning();
  }
  return {
    bundle: {
      OPTIO_SERVER: publicApiOrigin(),
      OPTIO_TOKEN: pat.token,
      OPTIO_LOCAL_HOST_ID: host.id,
    },
    host,
    tokenId: pat.tokenId,
  };
}

/** A name every provider takes (letters, digits, single hyphens; at most 32). */
export function workspaceNameFor(
  workName: string | null | undefined,
  suffix = randomUUID().slice(0, 6),
): string {
  const slug = (workName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32 - "optio--".length - suffix.length)
    .replace(/-+$/g, "");
  return slug ? `optio-${slug}-${suffix}` : `optio-${suffix}`;
}

export interface RemoteWorkspaceStarted {
  localHostId: string;
  localDir: string;
  connectionId: string;
  workspaceId: string;
  workspaceName: string;
}

/** The checkout, as an absolute path in the workspace (refused otherwise). */
function checkoutPath(dir: string): string {
  const path = dir.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.split("/").includes("..")) {
    throw new RemoteWorkspaceError(`${path} isn't an absolute path in the workspace`);
  }
  return path;
}

/**
 * Start the workspace a piece of work runs in and return the machine and
 * directory to run it on. Returns as soon as the provider accepted the
 * workspace: the run parks until the workspace's daemon says hello (the
 * watcher fails it if that never happens).
 */
export async function startRemoteWorkspaceWork(
  launch: RemoteWorkspaceLaunch,
  actor: Actor,
  opts: {
    workName?: string | null;
    teamId?: string | null;
    /** The work's owner and repo, for its agent policy (agent-policy.ts). */
    policy?: { owner?: string | null; repoUrl?: string | null };
  } = {},
): Promise<RemoteWorkspaceStarted> {
  const asked = launch.provider ? label(launch.provider) : "remote workspace";
  if (!actor.userId) {
    throw new RemoteWorkspaceError(
      `Work in ${launch.provider ? aWorkspace(launch.provider) : "a remote workspace"} needs a ` +
        "signed-in person: it pairs with your token",
    );
  }
  const conn = await resolveConnectionFor(actor, {
    connectionId: launch.connectionId,
    teamId: opts.teamId,
    provider: launch.provider,
  });
  if (!conn) {
    throw new RemoteWorkspaceError(
      launch.connectionId
        ? `That ${asked} connection isn't available`
        : `No ${asked} connection — add one in Settings → Integrations → Remote workspaces`,
    );
  }
  const provider = providerFor(conn.provider);
  const client = clientFor(conn);
  const named = launch.checkoutDir?.trim() || conn.defaultParameters?.[CHECKOUT_PARAMETER] || "";
  const workParameters = launch.parameters ?? {};
  const fromWork = provider.templateFromParameters?.(workParameters) ?? null;
  const checkoutFor = (templateId: string | null) =>
    checkoutPath(
      named ||
        provider.defaultCheckoutDir({
          templateId,
          parameters: { ...(conn.defaultParameters ?? {}), ...workParameters },
        }),
    );
  let checkoutDir = checkoutFor(launch.templateId || fromWork || conn.templateId);
  // The agent policy, for workspaces that apply it (agent-policy.ts).
  const policy = await remoteWorkspacePolicyParameters({
    workspaceId: actor.workspaceId,
    ownerTeamId: opts.teamId ?? teamOfOwner(opts.policy?.owner),
    repoUrl: opts.policy?.repoUrl ?? launch.parameters?.repo_url,
  });

  if (launch.workspaceId) {
    const ws = await client.workspace(launch.workspaceId);
    // The token's own workspaces only: a token that can see others' (an
    // owner at the provider) mustn't start a person's workspace for someone
    // else.
    if (provider.checksOwner) {
      const me = await client.whoami();
      if (ws.ownerId !== me.id) {
        throw new RemoteWorkspaceError(
          `${theWorkspace(conn.provider)} ${ws.name} isn't ${me.username}'s — pick one from the list`,
          403,
        );
      }
    }
    if (!named) checkoutDir = checkoutFor(ws.templateId);
    // On a shared connection every workspace is the token's account's at the
    // provider: one Optio paired as another person's machine stays theirs.
    const paired = await db
      .select()
      .from(localHosts)
      .where(and(eq(localHosts.remoteWorkspaceId, ws.id), eq(localHosts.origin, conn.provider)));
    if (paired.some((h) => h.userId !== actor.userId)) {
      throw new RemoteWorkspaceError(
        `${theWorkspace(conn.provider)} ${ws.name} is another person's machine in Optio — pick ` +
          "one of yours, or start a new one",
        403,
      );
    }
    const known = paired[0];
    const declared = await client.parameters(ws.templateVersionId ?? ws.templateId ?? "");
    if (known && ws.status === "running" && (await relay.isHostOnline(known.id))) {
      // Running and paired already: the run starts there now. No new token
      // and no rebuild (which would restart whatever runs in it), and Optio
      // leaves the workspace running afterwards — it didn't start it.
      if (!(known.dirs ?? []).some((d) => d.path === checkoutDir)) {
        await db
          .update(localHosts)
          .set({ dirs: [...(known.dirs ?? []), { path: checkoutDir }], updatedAt: new Date() })
          .where(eq(localHosts.id, known.id));
      }
      return {
        localHostId: known.id,
        localDir: checkoutDir,
        connectionId: conn.id,
        workspaceId: ws.id,
        workspaceName: ws.name,
      };
    }
    const pairing = await preparePairing(conn, actor, {
      workspaceName: ws.name,
      checkoutDir,
      host: known ?? null,
    });
    const delivery = deliveryFor(conn, {
      declared,
      wanted: { ...launch.parameters, ...policy },
      bundle: pairing.bundle,
      checkoutDir,
      workspaceName: ws.name,
      templateName: ws.templateName ?? undefined,
    });
    try {
      await client.start(ws, delivery);
      await db
        .update(localHosts)
        .set({ remoteWorkspaceId: ws.id, remoteWorkspaceName: ws.name, updatedAt: new Date() })
        .where(eq(localHosts.id, pairing.host.id));
    } catch (err) {
      await abandonPairing(pairing, actor, { keepHost: !!known });
      throw err;
    }
    runStartScriptWhenReady(client, ws.id, delivery.env, pairing.host.id);
    return {
      localHostId: pairing.host.id,
      localDir: checkoutDir,
      connectionId: conn.id,
      workspaceId: ws.id,
      workspaceName: ws.name,
    };
  }

  const templateNoun = REMOTE_WORKSPACE_PROVIDER_INFO[conn.provider].templateNoun;
  const templateId = launch.templateId || fromWork || conn.templateId;
  let templateVersionId =
    launch.templateVersionId || (launch.templateId || fromWork ? null : conn.templateVersionId);
  if (!templateVersionId && !templateId) {
    throw new RemoteWorkspaceError(
      `Pick a ${templateNoun} — the ${label(conn.provider)} connection ${conn.name} has no ` +
        `default ${templateNoun}`,
    );
  }
  if (!templateVersionId) templateVersionId = await client.activeVersion(templateId!);
  const name = launch.name?.trim() || workspaceNameFor(opts.workName);
  const nameError = remoteWorkspaceNameError(conn.provider, name);
  if (nameError) {
    throw new RemoteWorkspaceError(
      `"${name}" isn't ${aWorkspace(conn.provider)} name: ${nameError.toLowerCase()}`,
    );
  }
  const declared = await client.parameters(templateVersionId);
  const pairing = await preparePairing(conn, actor, { workspaceName: name, checkoutDir });
  const delivery = deliveryFor(conn, {
    declared,
    wanted: { ...(conn.defaultParameters ?? {}), ...(launch.parameters ?? {}), ...policy },
    bundle: pairing.bundle,
    checkoutDir,
    workspaceName: name,
    templateName: conn.templateName ?? undefined,
  });
  let ws: RemoteWorkspace;
  try {
    ws = await client.create({ ...delivery, templateVersionId, name });
    await db
      .update(localHosts)
      .set({ remoteWorkspaceId: ws.id, remoteWorkspaceName: ws.name, updatedAt: new Date() })
      .where(eq(localHosts.id, pairing.host.id));
  } catch (err) {
    await abandonPairing(pairing, actor, { keepHost: false });
    throw err;
  }
  logger.info(
    { hostId: pairing.host.id, workspaceId: ws.id, connectionId: conn.id, provider: conn.provider },
    "remote workspace: created for work",
  );
  runStartScriptWhenReady(client, ws.id, delivery.env, pairing.host.id);
  return {
    localHostId: pairing.host.id,
    localDir: checkoutDir,
    connectionId: conn.id,
    workspaceId: ws.id,
    workspaceName: ws.name,
  };
}

/** Everything a create or a start hands the provider. */
function deliveryFor(
  conn: RemoteWorkspaceConnectionRow,
  input: Omit<PairingDelivery, "env" | "ttlMs"> & { workspaceName: string },
): PairingDelivery {
  const { workspaceName, ...rest } = input;
  return {
    ...rest,
    ttlMs: conn.ttlMs,
    env: startScriptEnv({
      bundle: input.bundle,
      checkoutDir: input.checkoutDir,
      hostname: workspaceName,
      parameters: input.wanted,
    }),
  };
}

/** Undo a pairing whose workspace the provider refused: the token goes, and a row made for it. */
async function abandonPairing(
  pairing: { host: LocalHostRow; tokenId: string },
  actor: Actor,
  opts: { keepHost: boolean },
): Promise<void> {
  try {
    if (actor.userId) await revokeApiKey(pairing.tokenId, actor.userId);
    if (opts.keepHost) {
      await db
        .update(localHosts)
        .set({ pairingTokenId: null })
        .where(eq(localHosts.id, pairing.host.id));
    } else {
      await db.delete(localHosts).where(eq(localHosts.id, pairing.host.id));
    }
  } catch (err) {
    logger.warn({ err, hostId: pairing.host.id }, "remote workspace: failed to undo a pairing");
  }
}

// ── The start script, for providers whose workspace doesn't run it itself ───

const startScripts = new Set<Promise<void>>();

/**
 * For a provider that starts Optio's daemon by running the start script in
 * the workspace (Daytona, E2B): wait in the background until the workspace
 * is ready, then run it. The request that started the workspace doesn't
 * wait; a script that never runs (the workspace failed, the API restarted)
 * leaves the run parked until the watcher fails it with the reason.
 */
function runStartScriptWhenReady(
  client: RemoteWorkspaceClient,
  workspaceId: string,
  env: Record<string, string>,
  hostId: string,
): void {
  if (!client.runStartScript) return;
  const run = (async () => {
    const deadline = Date.now() + remoteWorkspaceStartTimeoutMs();
    for (;;) {
      const ws = await client.workspace(workspaceId);
      if (ws.problem) throw new RemoteWorkspaceError(ws.problem, 409);
      if (ws.ready) return client.runStartScript!(ws, env);
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, startScriptPollMs));
    }
  })()
    .catch((err) =>
      logger.warn({ err, hostId, workspaceId }, "remote workspace: the start script didn't run"),
    )
    .finally(() => startScripts.delete(run));
  startScripts.add(run);
}

let startScriptPollMs = 3_000;

/** Tests: wait for the start scripts under way (and poll faster while they do). */
export async function startScriptsSettledForTests(pollMs = 5): Promise<void> {
  startScriptPollMs = pollMs;
  while (startScripts.size > 0) await Promise.all([...startScripts]);
}

/**
 * Work that started a workspace and then wasn't created (a name taken, a
 * rejected trigger): stop the workspace and let go of its pairing.
 */
export async function cancelRemoteWorkspaceWork(hostId: string): Promise<void> {
  const host = await getHost(hostId);
  if (host && isRemoteWorkspaceHost(host)) {
    await endRemoteWorkspacePairing(host, "the work wasn't created");
  }
}

/** Record the launch on the task a remote-workspace run is (for re-runs). */
export async function recordTaskLaunch(
  taskId: string,
  launch: RemoteWorkspaceLaunch,
): Promise<void> {
  await db.update(tasks).set({ remoteWorkspaceLaunch: launch }).where(eq(tasks.id, taskId));
}

// ── Re-runs, retries, resumes and firings ───────────────────────────────────

/** The machine and directory a run in a remote workspace goes to. */
export interface RemoteWorkspaceRunPlace {
  localHostId: string;
  localDir: string;
}

export interface WakeRemoteWorkspaceInput {
  /** What started the work: the run's `remote_workspace_launch`, else its definition's. */
  launch: RemoteWorkspaceLaunch | null | undefined;
  /** The run's machine and directory as stored (no machine: no workspace made yet). */
  localHostId: string | null;
  localDir: string | null;
  /** Whose work it is: the workspace pairs with their token. */
  userId: string | null;
  workspaceId: string | null;
  teamId?: string | null;
  workName?: string | null;
  /**
   * Store a machine made now on the run (and its definition), under CAS on
   * the one it had; returns the place the run has afterwards — another
   * dispatcher's when it stored one first.
   */
  pin(
    place: RemoteWorkspaceRunPlace,
    previousHostId: string | null,
  ): Promise<RemoteWorkspaceRunPlace>;
}

/**
 * A run of work that runs in a remote workspace, at dispatch (a re-run, a
 * retry, an automatic resume, a definition's firing). Optio stops the
 * workspace between runs, so its machine is usually offline by then: start
 * the workspace again with a fresh pairing bundle — or, when it is gone or
 * was never made, create one from the launch — and return where the run
 * goes. The run then parks until the daemon says hello, and the watcher
 * fails it if that never happens. Null: nothing to do (no launch, not a
 * remote workspace, online, or a start already under way).
 */
export async function wakeRemoteWorkspaceWork(
  input: WakeRemoteWorkspaceInput,
): Promise<RemoteWorkspaceRunPlace | null> {
  if (!input.launch) return null;
  const host = input.localHostId ? await getHost(input.localHostId) : null;
  if (host && !isRemoteWorkspaceHost(host)) return null;
  if (host && ((await relay.isHostOnline(host.id)) || (await pairingUnderWay(host)))) return null;
  const actor = await workActor(
    host?.userId ?? input.userId,
    host?.workspaceId ?? input.workspaceId,
  );
  const opts = { workName: input.workName, teamId: input.teamId };
  let launch: RemoteWorkspaceLaunch = input.launch;
  if (host?.remoteWorkspaceId) {
    // One dispatcher wakes it; the others park on it as it is.
    const [claimed] = await db
      .update(localHosts)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(localHosts.id, host.id),
          sql`date_trunc('milliseconds', ${localHosts.updatedAt}) = ${host.updatedAt.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: localHosts.id });
    if (!claimed) return null;
    launch = {
      ...launch,
      connectionId: host.remoteWorkspaceConnectionId ?? launch.connectionId,
      workspaceId: host.remoteWorkspaceId,
    };
  }
  let started: RemoteWorkspaceStarted;
  try {
    started = await startRemoteWorkspaceWork(launch, actor, opts);
  } catch (err) {
    if (!(err instanceof RemoteWorkspaceError && err.status === 404 && launch.workspaceId)) {
      // Runs that parked on it while this one woke it would wait forever.
      if (host) {
        await failParkedRuns(host, err instanceof Error ? err.message : String(err), {
          queued: false,
        });
      }
      throw err;
    }
    // The workspace is gone at its provider: a new one from the launch's template.
    if (host) await revokeRemoteWorkspacePairing(host).catch(() => false);
    started = await startRemoteWorkspaceWork({ ...launch, workspaceId: null }, actor, opts);
  }
  logger.info(
    { hostId: started.localHostId, workspaceId: started.workspaceId, was: host?.id ?? null },
    "remote workspace: woken for a run",
  );
  const place = { localHostId: started.localHostId, localDir: input.localDir ?? started.localDir };
  if (place.localHostId === input.localHostId) return place;
  const placed = await input.pin(place, input.localHostId);
  // Another dispatcher made one first: this one goes.
  if (placed.localHostId !== place.localHostId) {
    await cancelRemoteWorkspaceWork(place.localHostId);
  }
  return placed;
}

/**
 * A start Optio asked for is still coming up: the pairing token is live,
 * the daemon hasn't said hello with it, and the start timeout hasn't passed
 * (after that the watcher fails what waits).
 */
async function pairingUnderWay(host: LocalHostRow, now = Date.now()): Promise<boolean> {
  if (!host.pairingTokenId) return false;
  const [key] = await db
    .select({ createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, host.pairingTokenId));
  if (!key || key.revokedAt) return false;
  // Seen since it was minted: the workspace paired, and has stopped since.
  if (host.lastSeenAt && host.lastSeenAt >= key.createdAt) return false;
  return now - key.createdAt.getTime() < remoteWorkspaceStartTimeoutMs();
}

/**
 * A machine's daemon said hello (ws/local-daemon.ts), `host` as it was just
 * before. When it is a remote workspace Optio started and this is the first
 * hello with its pairing token: the deployment's monitoring records how long the
 * start took (telemetry/site-metrics.ts, docs/observability.md "Prometheus
 * endpoint and dashboard"), and a provider that handed the bundle over in something
 * that outlives the start (Codespaces' secret) drops it. A reconnect,
 * another machine: nothing, not even a read. Never throws.
 */
export async function noteRemoteWorkspaceHello(
  host: Pick<
    LocalHostRow,
    | "origin"
    | "pairingTokenId"
    | "lastSeenAt"
    | "remoteWorkspaceId"
    | "remoteWorkspaceName"
    | "remoteWorkspaceConnectionId"
  >,
  now = Date.now(),
): Promise<void> {
  if (!isRemoteWorkspaceProvider(host.origin) || !host.pairingTokenId) return;
  const release = providerFor(host.origin).releasesPairing === true;
  if (!release && !siteMetricsOn()) return;
  try {
    const [key] = await db
      .select({ createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, host.pairingTokenId));
    if (!key || key.revokedAt) return;
    if (host.lastSeenAt && host.lastSeenAt >= key.createdAt) return;
    recordRemoteWorkspaceStarted(host.origin, (now - key.createdAt.getTime()) / 1000);
    if (release) await releaseBundle(host);
  } catch (err) {
    logger.debug({ err }, "remote workspace: the first hello wasn't noted");
  }
}

/** Drop what carried a host's pairing bundle at its provider (Codespaces' secret). */
async function releaseBundle(
  host: Pick<
    LocalHostRow,
    "origin" | "remoteWorkspaceId" | "remoteWorkspaceName" | "remoteWorkspaceConnectionId"
  >,
  conn?: RemoteWorkspaceConnectionRow,
): Promise<void> {
  if (!isRemoteWorkspaceProvider(host.origin) || !providerFor(host.origin).releasesPairing) return;
  if (!host.remoteWorkspaceId || !host.remoteWorkspaceConnectionId) return;
  const row =
    conn ??
    (
      await db
        .select()
        .from(remoteWorkspaceConnections)
        .where(eq(remoteWorkspaceConnections.id, host.remoteWorkspaceConnectionId))
    )[0];
  if (!row) return;
  await clientFor(row)
    .releasePairing?.({
      id: host.remoteWorkspaceId,
      name: host.remoteWorkspaceName ?? host.remoteWorkspaceId,
    })
    .catch((err) =>
      logger.warn(
        { err, workspaceId: host.remoteWorkspaceId },
        "remote workspace: failed to drop the pairing secret",
      ),
    );
}

/** The work's owner as the request that started it would have them: their teams in the workspace. */
async function workActor(userId: string | null, workspaceId: string | null): Promise<Actor> {
  const mine = userId && workspaceId ? await teamMembershipsOf(userId, workspaceId) : [];
  return {
    userId,
    workspaceId,
    isAdmin: false,
    teamIds: mine.map((m) => m.teamId),
    adminTeamIds: mine.filter((m) => m.role === "admin").map((m) => m.teamId),
  };
}

// ── The end of a run ────────────────────────────────────────────────────────

/**
 * Let go of a remote workspace's machine: clear its pairing (once — the CAS
 * on the token id makes a second caller a no-op), revoke the PAT, stop or
 * delete the workspace (the connection's `deleteWhenDone`) and mark the
 * host offline. Returns whether this call did it.
 */
export async function endRemoteWorkspacePairing(host: LocalHostRow, why: string): Promise<boolean> {
  if (!(await revokeRemoteWorkspacePairing(host))) return false;
  if (host.remoteWorkspaceId && host.remoteWorkspaceConnectionId) {
    const [conn] = await db
      .select()
      .from(remoteWorkspaceConnections)
      .where(eq(remoteWorkspaceConnections.id, host.remoteWorkspaceConnectionId));
    if (conn) {
      const transition = conn.deleteWhenDone ? "delete" : "stop";
      try {
        const client = clientFor(conn);
        if (conn.deleteWhenDone) await client.remove(host.remoteWorkspaceId);
        else await client.stop(host.remoteWorkspaceId);
        logger.info(
          { hostId: host.id, workspaceId: host.remoteWorkspaceId, transition, why },
          "remote workspace: let go",
        );
      } catch (err) {
        logger.warn(
          { err, hostId: host.id, workspaceId: host.remoteWorkspaceId, transition },
          "remote workspace: failed to stop the workspace",
        );
      }
      await releaseBundle(host, conn);
    }
  }
  await markHostOffline(host.id).catch(() => {});
  return true;
}

/**
 * Clear a remote workspace's pairing and revoke its PAT — once: the CAS on
 * the token id makes a second caller a no-op. Returns whether this call did it.
 */
export async function revokeRemoteWorkspacePairing(
  host: Pick<LocalHostRow, "id" | "userId" | "pairingTokenId">,
): Promise<boolean> {
  if (!host.pairingTokenId) return false;
  const [claimed] = await db
    .update(localHosts)
    .set({ pairingTokenId: null, updatedAt: new Date() })
    .where(and(eq(localHosts.id, host.id), eq(localHosts.pairingTokenId, host.pairingTokenId)))
    .returning({ id: localHosts.id });
  if (!claimed) return false;
  if (host.userId) {
    await revokeApiKey(host.pairingTokenId, host.userId).catch((err) =>
      logger.warn({ err, hostId: host.id }, "remote workspace: failed to revoke the pairing token"),
    );
  }
  return true;
}

/**
 * A workspace someone stopped (Machines → Stop workspace): the machines it
 * paired as lose their pairing tokens and go offline.
 */
export async function releaseWorkspacePairings(
  connectionId: string,
  workspaceId: string,
): Promise<void> {
  const hosts = await db
    .select()
    .from(localHosts)
    .where(
      and(
        eq(localHosts.remoteWorkspaceConnectionId, connectionId),
        eq(localHosts.remoteWorkspaceId, workspaceId),
        ne(localHosts.origin, "machine"),
      ),
    );
  for (const host of hosts) {
    await revokeRemoteWorkspacePairing(host);
    await markHostOffline(host.id).catch(() => {});
  }
}

type TerminalLike = Pick<
  typeof localTerminals.$inferSelect,
  "id" | "hostId" | "state" | "taskId" | "workflowRunId"
>;

/**
 * Called by local-run-service when a linked run's terminal is dead: a remote
 * workspace whose runs are all done lets its workspace go. A Task's run
 * counts as done only once the task is completed, failed or cancelled — one
 * that opened a PR may still resume there (CI, a review); the watcher stops
 * a workspace left idle instead. Cheap for every other host (one read).
 */
export async function onRemoteWorkspaceRunEnded(terminal: TerminalLike): Promise<void> {
  if (terminal.state !== "exited" && terminal.state !== "error") return;
  if (!terminal.taskId && !terminal.workflowRunId) return;
  const host = await getHost(terminal.hostId);
  if (!host || !isRemoteWorkspaceHost(host) || !host.pairingTokenId) return;
  if (terminal.taskId && !(await taskSettled(terminal.taskId))) return;
  await letGoUnlessBusy(host, "its run ended");
}

/**
 * Called by task-service when a local Task reaches completed, failed or
 * cancelled: the remote workspace it ran in goes, unless another run still
 * uses it.
 */
export async function onRemoteWorkspaceTaskSettled(hostId: string): Promise<void> {
  const host = await getHost(hostId);
  if (!host || !isRemoteWorkspaceHost(host) || !host.pairingTokenId) return;
  await letGoUnlessBusy(host, "its task settled");
}

async function taskSettled(taskId: string): Promise<boolean> {
  const [task] = await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, taskId));
  return !task || (TERMINAL_TASK_STATES as readonly string[]).includes(task.state);
}

async function letGoUnlessBusy(host: LocalHostRow, why: string): Promise<void> {
  // Another run still uses the workspace (or waits for it): keep it.
  const [busy] = await db
    .select({ id: localTerminals.id })
    .from(localTerminals)
    .where(
      and(
        eq(localTerminals.hostId, host.id),
        inArray(localTerminals.state, ["pending", "launching", "running"]),
        sql`(${localTerminals.taskId} IS NOT NULL OR ${localTerminals.workflowRunId} IS NOT NULL)`,
      ),
    )
    .limit(1);
  if (busy) return;
  // A Task that may still resume here (a PR waiting on CI or a review) keeps
  // it too; the watcher stops it once it sits idle.
  const [open] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.localHostId, host.id),
        sql`${tasks.state} NOT IN ('completed', 'failed', 'cancelled')`,
      ),
    )
    .limit(1);
  if (open) return;
  await endRemoteWorkspacePairing(host, why);
}

// ── The watcher ─────────────────────────────────────────────────────────────

/**
 * One pass: every remote workspace still waiting for its daemon (pairing
 * token live, not seen since it was minted). A workspace that failed, or one
 * that didn't come online within `OPTIO_REMOTE_WORKSPACE_START_TIMEOUT_MS`,
 * fails the runs parked on it with the reason and is let go.
 */
export async function sweepStartingRemoteWorkspaces(now = Date.now()): Promise<number> {
  const waiting = await db
    .select({ host: localHosts, pairedAt: apiKeys.createdAt })
    .from(localHosts)
    .innerJoin(apiKeys, eq(apiKeys.id, localHosts.pairingTokenId))
    .where(
      and(
        ne(localHosts.origin, "machine"),
        isNull(apiKeys.revokedAt),
        sql`(${localHosts.lastSeenAt} IS NULL OR ${localHosts.lastSeenAt} < ${apiKeys.createdAt})`,
      ),
    );
  let failed = 0;
  for (const { host, pairedAt } of waiting) {
    try {
      const problem = await startProblem(host, pairedAt, now);
      if (!problem) continue;
      recordRemoteWorkspaceStartFailure(host.origin); // the deployment's monitoring (telemetry/site-metrics.ts)
      await failParkedRuns(host, problem);
      await endRemoteWorkspacePairing(host, problem);
      failed++;
    } catch (err) {
      logger.warn(
        { err, hostId: host.id },
        "remote workspace: watcher pass failed for a workspace",
      );
    }
  }
  return failed;
}

/**
 * The other pass: a paired remote workspace (its daemon said hello with the
 * live token) that nothing ran in for `OPTIO_REMOTE_WORKSPACE_IDLE_STOP_MS`
 * (2 h) — no live terminal, none that ended since, no Task queued or running
 * there — is let go. A Task waiting on its PR keeps it until then; its
 * resume starts it again (wakeRemoteWorkspaceWork).
 */
export async function sweepIdleRemoteWorkspaces(now = Date.now()): Promise<number> {
  const idleMs = remoteWorkspaceIdleStopMs();
  const since = new Date(now - idleMs).toISOString();
  const idle = await db
    .select({ host: localHosts })
    .from(localHosts)
    .innerJoin(apiKeys, eq(apiKeys.id, localHosts.pairingTokenId))
    .where(
      and(
        ne(localHosts.origin, "machine"),
        isNull(apiKeys.revokedAt),
        sql`${localHosts.lastSeenAt} >= ${apiKeys.createdAt}`,
        sql`${apiKeys.createdAt} < ${since}::timestamptz`,
        sql`NOT EXISTS (SELECT 1 FROM local_terminals lt WHERE lt.host_id = ${localHosts.id}
              AND (lt.state IN ('pending', 'launching', 'running')
                OR COALESCE(lt.ended_at, lt.updated_at) >= ${since}::timestamptz))`,
        sql`NOT EXISTS (SELECT 1 FROM tasks t WHERE t.local_host_id = ${localHosts.id}
              AND t.state IN ('queued', 'provisioning', 'running'))`,
      ),
    );
  let stopped = 0;
  for (const { host } of idle) {
    try {
      if (await endRemoteWorkspacePairing(host, `idle for ${minutes(idleMs)}`)) stopped++;
    } catch (err) {
      logger.warn({ err, hostId: host.id }, "remote workspace: idle stop failed for a workspace");
    }
  }
  return stopped;
}

async function startProblem(
  host: LocalHostRow,
  pairedAt: Date,
  now: number,
): Promise<string | null> {
  const name = host.remoteWorkspaceName ?? host.name;
  if (host.remoteWorkspaceId && host.remoteWorkspaceConnectionId) {
    const [conn] = await db
      .select()
      .from(remoteWorkspaceConnections)
      .where(eq(remoteWorkspaceConnections.id, host.remoteWorkspaceConnectionId));
    if (conn) {
      try {
        const problem = (await clientFor(conn).workspace(host.remoteWorkspaceId)).problem;
        if (problem) return problem;
      } catch (err) {
        if (err instanceof RemoteWorkspaceError && err.status === 404) {
          return `${theWorkspace(host.origin)} ${name} is gone`;
        }
        // The provider unreachable for a moment: the timeout still applies.
      }
    }
  }
  const timeoutMs = remoteWorkspaceStartTimeoutMs();
  if (now - pairedAt.getTime() < timeoutMs) return null;
  return (
    `${theWorkspace(host.origin)} ${name} didn't pair with Optio within ${minutes(timeoutMs)} — ` +
    "check the workspace's startup log (/tmp/optio-local.log) and that it reaches Optio at " +
    `${publicApiOrigin()}`
  );
}

/** Fail what waits on the host: its parked terminals (which settle their runs), and queued Tasks not yet dispatched. */
async function failParkedRuns(
  host: LocalHostRow,
  message: string,
  opts: { queued?: boolean } = {},
): Promise<void> {
  const { handleSpawnError } = await import("./local-terminal-service.js");
  const parked = await db
    .select({ id: localTerminals.id })
    .from(localTerminals)
    .where(and(eq(localTerminals.hostId, host.id), eq(localTerminals.state, "pending")));
  for (const t of parked) await handleSpawnError(host.id, t.id, message);
  if (opts.queued === false) return;
  const queued = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(eq(tasks.localHostId, host.id), eq(tasks.state, "queued"), isNull(tasks.localTerminalId)),
    );
  if (queued.length > 0) {
    const taskService = await import("./task-service.js");
    for (const t of queued) {
      await taskService.updateTaskResult(t.id, undefined, message);
      await taskService.tryTransitionTask(
        t.id,
        TaskState.FAILED,
        "remote_workspace_start_failed",
        message,
      );
    }
  }
  logger.info(
    { hostId: host.id, terminals: parked.length, tasks: queued.length, message },
    "remote workspace: failed parked runs",
  );
}

/**
 * The periodic sweep (`OPTIO_REMOTE_WORKSPACE_WATCH_INTERVAL_MS`, 30 s), one
 * instance at a time under the `poller:remote-workspace-watch` lease.
 * Started when the server listens (server.ts).
 */
export function startRemoteWorkspaceWatcher(): { close(): void } {
  const intervalMs = Math.max(
    5_000,
    parseIntEnv(
      "OPTIO_REMOTE_WORKSPACE_WATCH_INTERVAL_MS",
      parseIntEnv("OPTIO_CODER_WATCH_INTERVAL_MS", 30_000),
    ),
  );
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void import("./poller-lease.js")
      .then(({ underPollerLease }) =>
        underPollerLease("remote-workspace-watch", async () => {
          await sweepStartingRemoteWorkspaces();
          await sweepIdleRemoteWorkspaces();
        }),
      )
      .catch((err) => logger.warn({ err }, "remote workspace: watcher sweep failed"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
