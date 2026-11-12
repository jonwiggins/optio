/**
 * A workspace's own GitLab servers (Workspace Settings → GitLab).
 *
 * Each workspace signs in to GitLab with its own credentials: one row in
 * `workspace_gitlab_servers` per (workspace, host), and the token as a
 * `secrets` row — scope "workspace", name `GITLAB_TOKEN_<HOST>`, bound to
 * the workspace — so it is encrypted with the workspace in its AAD and
 * rotated with every other secret. Nothing here returns a token to a caller
 * outside the API.
 *
 * The rules (docs/workspace-gitlab.md):
 * - A workspace's token is read for that workspace alone. No other
 *   workspace, and no deployment-level caller, ever falls back to it.
 * - The deployment's GitLab configuration (the global `GITLAB_TOKEN` /
 *   `GITLAB_TOKEN_<HOST>` / `GITLAB_HOST` secrets) follows the rule for
 *   every deployment row (services/deployment-defaults.ts, docs/scope.md):
 *   the founding workspace and callers with no workspace read all of it,
 *   any other workspace only what a deployment admin shares as a deployment
 *   default. The same token names in the API's environment can't be shared
 *   and serve the founding workspace alone.
 * - A workspace may only name a host the operator allows credentials to go
 *   to: gitlab.com or one listed in `GITLAB_HOSTS` / `OPTIO_GITLAB_HOSTS`.
 */
import { and, asc, eq, desc, isNull, like, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets, workspaceGitlabServers } from "../db/schema.js";
import {
  WORKSPACE_SECRET_SCOPE,
  deleteSecret,
  retrieveSecret,
  storeSecret,
} from "./secret-service.js";
import { readsAllDeploymentRows } from "./deployment-defaults.js";

/** `input` without a leading `http://` / `https://` (any case). */
function withoutScheme(input: string): string {
  const lower = input.toLowerCase();
  for (const scheme of ["https://", "http://"]) {
    if (lower.startsWith(scheme)) return input.slice(scheme.length);
  }
  return input;
}

/** `input` without trailing slashes (a loop: no backtracking regex on typed input). */
function withoutTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input[end - 1] === "/") end--;
  return input.slice(0, end);
}

/** `GITLAB_TOKEN_<HOST>`: the host and port upper-cased, punctuation as underscores. */
export function gitLabTokenNameForHost(host: string): string {
  return `GITLAB_TOKEN_${withoutTrailingSlashes(withoutScheme(host.trim()))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

/** One DNS label: 1-63 of a-z, 0-9 and "-", not starting or ending with "-". */
function isHostLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/.test(label) &&
    !label.startsWith("-") &&
    !label.endsWith("-")
  );
}

/**
 * A typed host as stored: lower-case `host[:port]`, no scheme, path or
 * trailing slash, and no `:443`. Null when it isn't a host name. Parsed by
 * hand rather than with one big regex, so a long typed value can't make it
 * backtrack.
 */
export function normalizeGitLabHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = withoutScheme(input.trim().toLowerCase());
  const cut = h.search(/[/?#]/);
  if (cut >= 0) h = h.slice(0, cut);
  if (h.endsWith(":443")) h = h.slice(0, -":443".length);
  if (!h || h.length > 259) return null;
  const parts = h.split(":");
  if (parts.length > 2) return null;
  const [name, port] = parts;
  if (port !== undefined) {
    if (!/^[0-9]{1,5}$/.test(port)) return null;
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
  }
  if (name.length > 253 || !name.split(".").every(isHostLabel)) return null;
  return h;
}

/** The hosts the operator lets GitLab credentials go to: gitlab.com and `GITLAB_HOSTS`. */
export function operatorGitLabHosts(): string[] {
  const listed = [process.env.GITLAB_HOSTS, process.env.OPTIO_GITLAB_HOSTS]
    .flatMap((v) => (v ?? "").split(","))
    .map((h) => normalizeGitLabHost(h))
    .filter((h): h is string => !!h);
  return [...new Set(["gitlab.com", ...listed])];
}

/**
 * The operator-listed host a workspace named, or null when it may not name
 * it (see the module comment). The value returned is the operator's own
 * entry, never the typed one, so nothing a person typed reaches a URL.
 */
function allowedWorkspaceGitLabHost(host: string): string | null {
  const h = normalizeGitLabHost(host);
  if (!h) return null;
  return operatorGitLabHosts().find((listed) => listed === h) ?? null;
}

/**
 * One of the deployment's GitLab secrets (`GITLAB_TOKEN`, `GITLAB_TOKEN_<HOST>`,
 * `GITLAB_HOST`) as `workspaceId` may read it: any deployment row for the
 * founding workspace and callers with no workspace, else only one a
 * deployment admin shares as a deployment default. Never a workspace's own
 * row: a workspace admin can't name a host the deployment trusts. `env`:
 * also the API's environment, which can't be shared, for the founding
 * workspace only.
 */
export async function deploymentGitLabSecret(
  name: string,
  workspaceId: string | null | undefined,
  opts: { env?: boolean } = {},
): Promise<string | null> {
  const all = await readsAllDeploymentRows(workspaceId);
  const stored = await retrieveSecret(name, "global", undefined, undefined, {
    sharedOnly: !all,
  }).catch(() => null);
  if (stored) return stored;
  return all && opts.env ? process.env[name] || null : null;
}

/** The setup wizard's deployment-wide GitLab host, where `workspaceId` may use it. */
export async function deploymentGitLabHost(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  return deploymentGitLabSecret("GITLAB_HOST", workspaceId);
}

/**
 * Whether work in `workspaceId` falls back to the deployment's GitLab token:
 * it reads every deployment row, or a deployment admin shared a GitLab
 * token with every workspace.
 */
export async function usesDeploymentGitLab(
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (await readsAllDeploymentRows(workspaceId)) return true;
  const [row] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.scope, "global"),
        isNull(secrets.workspaceId),
        eq(secrets.deploymentDefault, true),
        or(eq(secrets.name, "GITLAB_TOKEN"), like(secrets.name, "GITLAB\\_TOKEN\\_%")),
      ),
    )
    .limit(1);
  return !!row;
}

export interface WorkspaceGitLabServer {
  id: string;
  host: string;
  accountUsername: string | null;
  accountName: string | null;
  isDefault: boolean;
  hasToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The workspace's GitLab servers, the default first. */
export async function listWorkspaceGitLabServers(
  workspaceId: string,
): Promise<WorkspaceGitLabServer[]> {
  const rows = await db
    .select()
    .from(workspaceGitlabServers)
    .where(eq(workspaceGitlabServers.workspaceId, workspaceId))
    .orderBy(desc(workspaceGitlabServers.isDefault), asc(workspaceGitlabServers.createdAt));
  if (rows.length === 0) return [];
  const tokens = await db
    .select({ name: secrets.name })
    .from(secrets)
    .where(and(eq(secrets.scope, WORKSPACE_SECRET_SCOPE), eq(secrets.workspaceId, workspaceId)));
  const names = new Set(tokens.map((t) => t.name));
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    accountUsername: r.accountUsername,
    accountName: r.accountName,
    isDefault: r.isDefault,
    hasToken: names.has(gitLabTokenNameForHost(r.host)),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** The hosts the workspace has set up, the default first. */
export async function workspaceGitLabHosts(
  workspaceId: string | null | undefined,
): Promise<string[]> {
  if (!workspaceId) return [];
  const rows = await db
    .select({ host: workspaceGitlabServers.host })
    .from(workspaceGitlabServers)
    .where(eq(workspaceGitlabServers.workspaceId, workspaceId))
    .orderBy(desc(workspaceGitlabServers.isDefault), asc(workspaceGitlabServers.createdAt));
  return rows.map((r) => r.host);
}

/** Whether any workspace has a GitLab server set up (the setup wizard's "git token" step). */
export async function anyWorkspaceGitLabServer(): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceGitlabServers.id })
    .from(workspaceGitlabServers)
    .limit(1);
  return !!row;
}

/**
 * The workspace's own token for `host`, or null. Read for this workspace
 * only: the lookup is by (name, scope "workspace", workspace id) and the
 * value's AAD binds that workspace, so another workspace's row can't open.
 */
export async function workspaceGitLabToken(
  workspaceId: string | null | undefined,
  host: string | null | undefined,
): Promise<string | null> {
  const h = normalizeGitLabHost(host);
  if (!workspaceId || !h) return null;
  const [row] = await db
    .select({ id: workspaceGitlabServers.id })
    .from(workspaceGitlabServers)
    .where(
      and(eq(workspaceGitlabServers.workspaceId, workspaceId), eq(workspaceGitlabServers.host, h)),
    );
  if (!row) return null;
  return retrieveSecret(gitLabTokenNameForHost(h), WORKSPACE_SECRET_SCOPE, workspaceId).catch(
    () => null,
  );
}

export class WorkspaceGitLabError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** Who a token signs in as on `host` (GitLab's `/api/v4/user`), or why it doesn't. */
type GitLabTokenCheck =
  { valid: true; username: string; name: string | null } | { valid: false; error: string };

export type GitLabTokenChecker = (host: string, token: string) => Promise<GitLabTokenCheck>;

/** Ask the server who the token is, through the outbound guard. */
const checkGitLabToken: GitLabTokenChecker = async (host, token) => {
  const { guardedFetch } = await import("../utils/outbound-url.js");
  try {
    // Only an operator-listed host reaches here (allowedWorkspaceGitLabHost).
    const listed = operatorGitLabHosts().find((h) => h === host);
    if (!listed) return { valid: false, error: `${host} isn't an allowed GitLab server` };
    const res = await guardedFetch(new URL("/api/v4/user", `https://${listed}`), {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
      redirect: "error",
    });
    if (!res.ok) return { valid: false, error: `GitLab returned ${res.status}` };
    const user = (await res.json()) as { username?: string; name?: string | null };
    if (!user.username) return { valid: false, error: "GitLab did not say who the token is" };
    return { valid: true, username: user.username, name: user.name ?? null };
  } catch (err) {
    return {
      valid: false,
      error: `Could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * Add a server to the workspace, or replace its token. The host must be one
 * the operator allows; the token must sign in there (checked before anything
 * is stored). The first server becomes the default.
 */
export async function saveWorkspaceGitLabServer(
  workspaceId: string,
  input: { host: string; token: string; isDefault?: boolean },
  opts: { userId?: string | null; check?: GitLabTokenChecker } = {},
): Promise<WorkspaceGitLabServer> {
  const typed = normalizeGitLabHost(input.host);
  if (!typed) throw new WorkspaceGitLabError(`"${input.host}" isn't a host name`);
  const host = allowedWorkspaceGitLabHost(typed);
  if (!host) {
    throw new WorkspaceGitLabError(
      `${typed} isn't a GitLab server this deployment sends credentials to. ` +
        "A deployment operator must add it to GITLAB_HOSTS first.",
    );
  }
  const token = input.token.trim();
  if (!token) throw new WorkspaceGitLabError("A token is required");
  const check = await (opts.check ?? checkGitLabToken)(host, token);
  if (!check.valid)
    throw new WorkspaceGitLabError(`The token didn't sign in to ${host}: ${check.error}`);

  await storeSecret(gitLabTokenNameForHost(host), token, WORKSPACE_SECRET_SCOPE, workspaceId);
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: workspaceGitlabServers.id })
      .from(workspaceGitlabServers)
      .where(eq(workspaceGitlabServers.workspaceId, workspaceId));
    const makeDefault = input.isDefault === true || existing.length === 0;
    if (makeDefault) {
      await tx
        .update(workspaceGitlabServers)
        .set({ isDefault: false })
        .where(eq(workspaceGitlabServers.workspaceId, workspaceId));
    }
    await tx
      .insert(workspaceGitlabServers)
      .values({
        workspaceId,
        host,
        accountUsername: check.username,
        accountName: check.name,
        isDefault: makeDefault,
        createdBy: opts.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [workspaceGitlabServers.workspaceId, workspaceGitlabServers.host],
        set: {
          accountUsername: check.username,
          accountName: check.name,
          ...(makeDefault ? { isDefault: true } : {}),
          updatedAt: new Date(),
        },
      });
  });
  const saved = (await listWorkspaceGitLabServers(workspaceId)).find((s) => s.host === host);
  if (!saved) throw new Error("GitLab server vanished while saving");
  return saved;
}

async function serverRow(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(workspaceGitlabServers)
    .where(
      and(eq(workspaceGitlabServers.id, id), eq(workspaceGitlabServers.workspaceId, workspaceId)),
    );
  if (!row) throw new WorkspaceGitLabError("GitLab server not found", 404);
  return row;
}

/** Make one of the workspace's servers its default. */
export async function setDefaultWorkspaceGitLabServer(
  workspaceId: string,
  id: string,
): Promise<void> {
  await serverRow(workspaceId, id);
  await db.transaction(async (tx) => {
    await tx
      .update(workspaceGitlabServers)
      .set({ isDefault: false })
      .where(eq(workspaceGitlabServers.workspaceId, workspaceId));
    await tx
      .update(workspaceGitlabServers)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(workspaceGitlabServers.id, id));
  });
}

/** Remove a server and its token; another server becomes the default. */
export async function removeWorkspaceGitLabServer(workspaceId: string, id: string): Promise<void> {
  const row = await serverRow(workspaceId, id);
  await deleteSecret(gitLabTokenNameForHost(row.host), WORKSPACE_SECRET_SCOPE, workspaceId).catch(
    () => {},
  );
  await db.transaction(async (tx) => {
    await tx.delete(workspaceGitlabServers).where(eq(workspaceGitlabServers.id, id));
    if (!row.isDefault) return;
    const [next] = await tx
      .select({ id: workspaceGitlabServers.id })
      .from(workspaceGitlabServers)
      .where(eq(workspaceGitlabServers.workspaceId, workspaceId))
      .orderBy(asc(workspaceGitlabServers.createdAt))
      .limit(1);
    if (next) {
      await tx
        .update(workspaceGitlabServers)
        .set({ isDefault: true })
        .where(eq(workspaceGitlabServers.id, next.id));
    }
  });
}
