/**
 * The audit trail (docs/audit.md): one function every part of Optio logs
 * "who did what, from where" through.
 *
 *   import { auditEvent } from "../services/audit.js";
 *
 *   void auditEvent({
 *     req,                                   // actor, workspace, client address
 *     action: "team.join.approve",           // <resource>.<verb>[.<detail>]
 *     details: { teamId, targetUserId },     // ids, names, small scalars only
 *   });
 *
 * Entries go to the action log (`optio_actions`, through `logAction`), so
 * the Activity feed, the Audit page, its export, the retention sweep and the
 * SIEM copy on stdout (`OPTIO_AUDIT_STDOUT=json`) all see them. `details`
 * keys must be on the action log's allowlist (`ACTION_PARAM_ALLOWLIST`; the
 * audit's own keys are in audit-params.ts): anything else is dropped at
 * write, so a secret passed by mistake is never stored. Never pass a token,
 * a password, a prompt or a request body.
 *
 * Auditing never fails or slows the action it records: the promise always
 * resolves, and callers normally don't wait for it (`void auditEvent(...)`).
 * New action names go in the catalog (`AUDIT_ACTION_LABELS`,
 * packages/shared/src/audit/actions.ts) so the Audit page names them.
 */
import type { FastifyRequest } from "fastify";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, users, workspaceMembers } from "../db/schema.js";
import { logger } from "../logger.js";
import { logAction } from "./optio-action-service.js";

export interface AuditEventInput {
  /** The action's dotted name (see `AUDIT_ACTION_LABELS`). */
  action: string;
  /** The request it came from: fills the actor, workspace and client address unless given below. */
  req?: FastifyRequest | null;
  /** Who did it; null = Optio itself (the reconciler) or nobody yet (a refused sign-in). */
  userId?: string | null;
  /** The workspace it happened in; null = deployment-wide (deployment admins only). */
  workspaceId?: string | null;
  /** The client address; defaults to `req.ip` (through the trusted proxy, OPTIO_TRUST_PROXY). */
  clientIp?: string | null;
  /** Ids, names and small scalars (allowlisted keys only; strings are cut to 300 characters). */
  details?: Record<string, unknown>;
  /** Default true. A refused or failed attempt is worth recording too. */
  success?: boolean;
}

const MAX_STRING = 300;

/** `details` without undefined values, with long strings cut (an error message, say). */
export function cleanDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

/** The client address of a request: Fastify's `req.ip`, which honours OPTIO_TRUST_PROXY. */
export function clientIpOf(req: FastifyRequest | null | undefined): string | null {
  const ip = req?.ip;
  return typeof ip === "string" && ip ? ip : null;
}

/** Record one audit entry. Never throws; resolves once it is written (or failed to be). */
export async function auditEvent(input: AuditEventInput): Promise<void> {
  try {
    const req = input.req ?? null;
    const userId = input.userId !== undefined ? input.userId : (req?.user?.id ?? null);
    const workspaceId =
      input.workspaceId !== undefined ? input.workspaceId : (req?.user?.workspaceId ?? null);
    await logAction({
      action: input.action,
      userId: userId ?? undefined,
      workspaceId,
      params: cleanDetails(input.details),
      success: input.success ?? true,
      clientIp: input.clientIp !== undefined ? input.clientIp : clientIpOf(req),
    });
  } catch (err) {
    logger.warn({ err, action: input.action }, "Audit entry could not be written");
  }
}

// ── Sign-in ────────────────────────────────────────────────────────────────

/**
 * The workspace a sign-in is recorded in: the one the person lands in (their
 * default, which the sign-in makes the organization's), else their first.
 */
async function signInWorkspace(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ ws: users.defaultWorkspaceId })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.ws) return user.ws;
  const [member] = await db
    .select({ ws: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  return member?.ws ?? null;
}

/**
 * An entry about one person made where nobody is signed in yet (the sign-in
 * routes): recorded in the request's workspace when there is one, else in
 * the one the person lands in.
 */
export async function auditPersonEvent(
  req: FastifyRequest,
  e: { action: string; userId: string; details?: Record<string, unknown> },
): Promise<void> {
  const workspaceId = req.user?.workspaceId ?? (await signInWorkspace(e.userId).catch(() => null));
  await auditEvent({ req, action: e.action, userId: e.userId, workspaceId, details: e.details });
}

/** `auth.sign_in`: someone signed in (`via` web or cli). */
export function auditSignIn(
  req: FastifyRequest,
  e: { provider: string; userId: string; via: "web" | "cli" },
): Promise<void> {
  return auditPersonEvent(req, {
    action: "auth.sign_in",
    userId: e.userId,
    details: { provider: e.provider, via: e.via },
  });
}

/**
 * `auth.sign_in.failure`: a sign-in that didn't happen, with the reason
 * (`invalid_credentials`, `group_not_allowed`, `domain_not_allowed`,
 * `invalid_state`, `provider_error`, …) and the name it was tried with.
 * Nobody is signed in, so it is deployment-wide (deployment admins see it).
 */
export function auditSignInFailure(
  req: FastifyRequest,
  e: { provider: string; reason: string; username?: string | null; email?: string | null },
): Promise<void> {
  return auditEvent({
    req,
    action: "auth.sign_in.failure",
    userId: null,
    workspaceId: null,
    success: false,
    details: {
      provider: e.provider,
      reason: e.reason,
      username: e.username ?? undefined,
      email: e.email ?? undefined,
    },
  });
}

// ── Tokens kept as secrets ─────────────────────────────────────────────────

const GATEWAY_TOKEN_NAMES = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);
const GIT_TOKEN_NAMES: Record<string, "gitlab" | "github"> = {
  GITLAB_TOKEN: "gitlab",
  GITLAB_USER_ACCESS_TOKEN: "gitlab",
  GITHUB_TOKEN: "github",
};

/**
 * Which token a secret name holds, for the audit: the model gateway's
 * (ANTHROPIC_AUTH_TOKEN), GitLab's, GitHub's,
 * an agent's own key, or none.
 */
export function tokenKindOf(name: string): "gateway" | "gitlab" | "github" | "agent" | null {
  if (GIT_TOKEN_NAMES[name]) return GIT_TOKEN_NAMES[name];
  if (name === "ANTHROPIC_AUTH_TOKEN") return "gateway";
  if (GATEWAY_TOKEN_NAMES.has(name)) {
    return "agent";
  }
  return null;
}

/**
 * `<kind>.token.set` / `.delete` when a secret write stores or removes a
 * token (a person's, a team's or the organization's); nothing for other
 * secrets, which `secret.upsert` / `secret.delete` already record.
 */
export function auditTokenSecret(
  req: FastifyRequest,
  op: "set" | "delete",
  e: {
    name: string;
    scope?: string | null;
    teamId?: string | null;
    /** Whose personal token it is, when that isn't the caller (an admin offboarding someone). */
    targetUserId?: string | null;
    success?: boolean;
  },
): Promise<void> {
  const kind = tokenKindOf(e.name);
  if (!kind) return Promise.resolve();
  const target = e.scope === "user" ? e.targetUserId : null;
  return auditEvent({
    req,
    action: `${kind}.token.${op}`,
    success: e.success,
    details: {
      name: e.name,
      scope: e.scope ?? "global",
      teamId: e.scope === "team" ? (e.teamId ?? undefined) : undefined,
      targetUserId: target && target !== req.user?.id ? target : undefined,
    },
  });
}

// ── Automatic merging ──────────────────────────────────────────────────────

/**
 * `auto_merge.confirm` when a write turns automatic merging on with the
 * confirmation dialog accepted, `auto_merge.off` when it turns it off (for
 * a row that had it on). Writes that leave it alone record nothing.
 */
export function auditAutoMergeSetting(
  req: FastifyRequest,
  change: { autoMerge?: boolean | null; autoMergeConfirmed?: boolean | null },
  target: { type: "repo" | "task" | "task_config" | "work"; id: string },
  previous?: { autoMerge?: boolean | null } | null,
): Promise<void> {
  if (change.autoMerge === true && change.autoMergeConfirmed === true) {
    return auditEvent({ req, action: "auto_merge.confirm", details: target });
  }
  if (change.autoMerge === false && previous?.autoMerge === true) {
    return auditEvent({ req, action: "auto_merge.off", details: target });
  }
  return Promise.resolve();
}

/**
 * The `{ autoMerge, autoMergeConfirmed }` a saved WorkSpec leaves on its
 * definition (work-write-service's `followThrough`): merging is on only for
 * "works until merged" with "merge when ready"; any other answer, another
 * Then included, turns it off.
 */
export function workSpecAutoMerge(spec: {
  then?: string;
  mergeWhenReady?: boolean;
  autoMergeConfirmed?: boolean;
}): { autoMerge: boolean; autoMergeConfirmed?: boolean } {
  return {
    autoMerge: spec.then === "until-merged" && spec.mergeWhenReady === true,
    autoMergeConfirmed: spec.autoMergeConfirmed,
  };
}

/**
 * `pr.merge` by the reconciler (`via: "auto"`). Optio is the actor.
 */
export async function auditAutoMerge(e: {
  taskId: string;
  prUrl: string;
  prNumber?: number;
}): Promise<void> {
  let workspaceId: string | null = null;
  try {
    const [task] = await db
      .select({
        workspaceId: tasks.workspaceId,
      })
      .from(tasks)
      .where(eq(tasks.id, e.taskId));
    workspaceId = task?.workspaceId ?? null;
  } catch (err) {
    logger.warn({ err, taskId: e.taskId }, "Audit: could not read the merge's workspace");
  }
  await auditEvent({
    action: "pr.merge",
    userId: null,
    workspaceId,
    clientIp: null,
    details: {
      via: "auto",
      taskId: e.taskId,
      prUrl: e.prUrl,
      prNumber: e.prNumber,
    },
  });
}

// ── The members' Activity feed ─────────────────────────────────────────────

/**
 * Actions only admins read: who signed in from where, who holds which key
 * or token, who exported the audit trail or changed its retention, and the
 * merges (their entries name merge requests and runs by url and id, which
 * the work-visibility rule may hide from a member). The Activity feed
 * leaves them out for members (`routes/activity.ts`); the Audit page is
 * admins' only.
 */
export const ADMIN_ONLY_ACTION_PREFIXES: readonly string[] = [
  "audit",
  "auth",
  "api_key",
  "gateway.token",
  "gitlab.token",
  "github.token",
  "agent.token",
  "pr.merge",
  "auto_merge",
];

/**
 * Actions that, written without a workspace, are deployment-wide: refused
 * sign-ins (with the name tried), the sign-ins of people in no workspace,
 * sign-in settings and deployment admins, the audit's own settings and
 * exports, and database restores (the dump's name). Only deployment admins
 * read those (`audit-visibility.ts`).
 */
export const DEPLOYMENT_WIDE_ACTION_PREFIXES: readonly string[] = [
  ...ADMIN_ONLY_ACTION_PREFIXES,
  "sign_in",
  // Database restores (services/database-restore-check.ts, no workspace).
  "database",
];

/** The LIKE pattern for "starts with `prefix.`" (`_` and `%` in the prefix taken literally). */
export function likeSubActions(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}.%`;
}

/** SQL: `col` names `action` or one of its sub-actions (`team` → `team`, `team.join.approve`). */
export function actionMatchesSql(col: SQL, action: string): SQL {
  return sql`(${col} = ${action} OR ${col} LIKE ${likeSubActions(action)})`;
}

/** SQL: `col` is not one of the admin-only actions (for the members' Activity feed). */
export function notAdminOnlyAction(col: SQL): SQL {
  const parts = ADMIN_ONLY_ACTION_PREFIXES.map((p) => actionMatchesSql(col, p));
  return sql`NOT (${sql.join(parts, sql` OR `)})`;
}

/**
 * SQL: the row is not a deployment-wide audit entry (no workspace, and one
 * of `DEPLOYMENT_WIDE_ACTION_PREFIXES`), for everyone but deployment admins.
 */
export function notDeploymentWideAction(workspaceCol: SQL, actionCol: SQL): SQL {
  const parts = DEPLOYMENT_WIDE_ACTION_PREFIXES.map((p) => actionMatchesSql(actionCol, p));
  return sql`NOT (${workspaceCol} IS NULL AND (${sql.join(parts, sql` OR `)}))`;
}
