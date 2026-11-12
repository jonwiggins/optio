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
 * - The deployment's GitLab credentials (the global `GITLAB_TOKEN` /
 *   `GITLAB_TOKEN_<HOST>` secrets, the same names in the API's environment,
 *   the setup wizard's `GITLAB_HOST`) serve the founding workspace and
 *   callers with no workspace. Other workspaces use them only when the
 *   operator sets `OPTIO_GITLAB_SHARE_DEPLOYMENT_CREDENTIALS=true` (the
 *   behaviour before workspaces had their own).
 * - A workspace may only name a host the operator allows credentials to go
 *   to: gitlab.com or one listed in `GITLAB_HOSTS` / `OPTIO_GITLAB_HOSTS`.
 */
import { and, asc, eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets, workspaceGitlabServers } from "../db/schema.js";
import { deleteSecret, retrieveSecret, storeSecret } from "./secret-service.js";
import { foundingWorkspaceId } from "./founding-workspace.js";

/** The secrets scope workspace GitLab tokens are stored under. */
const WORKSPACE_SECRET_SCOPE = "workspace";

/** The env switch that shares the deployment's GitLab credentials with every workspace. */
const SHARE_DEPLOYMENT_GITLAB_ENV = "OPTIO_GITLAB_SHARE_DEPLOYMENT_CREDENTIALS";

/** `GITLAB_TOKEN_<HOST>`: the host and port upper-cased, punctuation as underscores. */
export function gitLabTokenNameForHost(host: string): string {
  return `GITLAB_TOKEN_${host
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

const HOST_RE =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/**
 * A typed host as stored: lower-case `host[:port]`, no scheme, path or
 * trailing slash, and no `:443`. Null when it isn't a host name.
 */
export function normalizeGitLabHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "");
  h = h.replace(/[/?#].*$/, "");
  h = h.replace(/:443$/, "");
  if (!h || h.includes("@") || !HOST_RE.test(h)) return null;
  const port = h.match(/:(\d+)$/)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
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

/** Whether a workspace may name this host (see the module comment). */
function isAllowedWorkspaceGitLabHost(host: string): boolean {
  const h = normalizeGitLabHost(host);
  return !!h && operatorGitLabHosts().includes(h);
}

/**
 * Whether work in `workspaceId` may use the deployment's GitLab credentials:
 * callers with no workspace, the founding workspace, and — only with the
 * operator's switch — every other one.
 */
export async function mayUseDeploymentGitLab(
  workspaceId: string | null | undefined,
): Promise<boolean> {
  if (!workspaceId) return true;
  if (process.env[SHARE_DEPLOYMENT_GITLAB_ENV] === "true") return true;
  return (await foundingWorkspaceId()) === workspaceId;
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
    const res = await guardedFetch(`https://${host}/api/v4/user`, {
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
  const host = normalizeGitLabHost(input.host);
  if (!host) throw new WorkspaceGitLabError(`"${input.host}" isn't a host name`);
  if (!isAllowedWorkspaceGitLabHost(host)) {
    throw new WorkspaceGitLabError(
      `${host} isn't a GitLab server this deployment sends credentials to. ` +
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
