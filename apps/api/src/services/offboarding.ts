import { notify } from "./notify.js";
import { listDeploymentAdmins } from "./sign-in-config-service.js";
/**
 * Disabling and enabling an account (docs/directory-sync.md) — what happens
 * when someone leaves, whether the directory sync noticed
 * (services/directory-sync.ts) or a deployment admin did it by hand:
 *
 * - `users.disabled_at` is set. A disabled account can't sign in (the
 *   sign-in routes refuse it with a clear message, `signInAccountCheck`),
 *   and every session, API key (the CLI's and MCP clients' too) and
 *   WebSocket upgrade token it had is revoked; session and API-key
 *   validation also refuse a disabled account, should one be minted later.
 * - Their own automations — work definitions they own personally (no team)
 *   that a schedule or another non-manual trigger starts, and their
 *   persistent agents — are paused (`enabled = false`) and listed in
 *   `paused_automations` with the reason, for an admin to hand over. Work
 *   already running or queued is left to finish; a team's work stays the
 *   team's.
 *
 * Enabling reverses it: the account signs in again (with new sessions and
 * keys; the old ones stay revoked) and the automations Optio paused come back
 * on, unless someone changed them since. The directory sync enables only
 * what it disabled itself; an admin's "disabled by hand" stays until an
 * admin enables the account.
 */
import { canSee, type Actor } from "./ownership.js";
import type { FastifyRequest } from "fastify";
import { and, eq, ne, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  apiKeys,
  pausedAutomations,
  persistentAgents,
  sessions,
  users,
  workDefinitions,
  workflowTriggers,
  workspaceMembers,
  wsUpgradeTokens,
} from "../db/schema.js";
import { logger } from "../logger.js";

/** Why an account is disabled: what the directory said, or an admin's hand. */
export type DisableReason =
  "gone" | "disabled_in_directory" | "not_in_required_group" | "domain_not_allowed" | "admin";

/** The reasons the directory sync sets — and so may take back. */
export const DIRECTORY_REASONS: readonly DisableReason[] = [
  "gone",
  "disabled_in_directory",
  "not_in_required_group",
  "domain_not_allowed",
];

export const DISABLE_REASON_LABEL: Record<DisableReason, string> = {
  gone: "no longer in the directory",
  disabled_in_directory: "disabled in Active Directory",
  not_in_required_group: "no longer in a group allowed to use Optio",
  domain_not_allowed: "their email domain is no longer allowed",
  admin: "disabled by an administrator",
};

/** What the sign-in routes show a disabled account. */
export const ACCOUNT_DISABLED_MESSAGE =
  "Your Optio account is disabled. Ask an Optio administrator if you should still have access.";

export function isDisableReason(v: unknown): v is DisableReason {
  return typeof v === "string" && v in DISABLE_REASON_LABEL;
}

/** Who did it: the directory sync, a deployment admin, or the person's own sign-in. */
export type AccountChangeVia = "directory" | "admin" | "sign_in";

export interface PausedAutomation {
  targetType: "work_definition" | "persistent_agent";
  targetId: string;
  workspaceId: string | null;
  name: string;
  kind: string;
}

export interface DisabledAccount {
  userId: string;
  email: string;
  displayName: string;
  reason: DisableReason;
  revokedSessions: number;
  revokedApiKeys: number;
  paused: PausedAutomation[];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The page about a paused automation (workspace admins may open a private one, read-only). */
export function automationPath(a: Pick<PausedAutomation, "targetType" | "targetId" | "kind">) {
  if (a.targetType === "persistent_agent") return `/agents/${a.targetId}`;
  if (a.kind === "standalone") return `/jobs/${a.targetId}`;
  if (a.kind === "local-blueprint") return `/local/automations/${a.targetId}`;
  return `/tasks/scheduled/${a.targetId}`;
}

const KIND_LABEL: Record<string, string> = {
  "repo-blueprint": "scheduled Task",
  standalone: "Job",
  "local-blueprint": "Local automation",
  "persistent-agent": "persistent agent",
};

/**
 * Pause what `userId` owns personally and would start by itself: enabled work
 * definitions with an enabled trigger other than `manual`, and enabled
 * persistent agents. Records each in `paused_automations`.
 */
async function pauseAutomationsIn(
  tx: Tx,
  userId: string,
  reason: DisableReason,
): Promise<PausedAutomation[]> {
  const defs = await tx
    .select({
      id: workDefinitions.id,
      name: workDefinitions.name,
      kind: workDefinitions.kind,
      workspaceId: workDefinitions.workspaceId,
    })
    .from(workDefinitions)
    .where(
      and(
        eq(workDefinitions.ownerUserId, userId),
        eq(workDefinitions.enabled, true),
        sql`EXISTS (SELECT 1 FROM ${workflowTriggers} t
                    WHERE t.target_id = ${workDefinitions.id}
                      AND t.type <> 'manual' AND t.enabled)`,
      ),
    );
  const agents = await tx
    .select({
      id: persistentAgents.id,
      name: persistentAgents.name,
      workspaceId: persistentAgents.workspaceId,
    })
    .from(persistentAgents)
    .where(and(eq(persistentAgents.ownerUserId, userId), eq(persistentAgents.enabled, true)));
  const now = new Date();
  if (defs.length > 0) {
    await tx
      .update(workDefinitions)
      .set({ enabled: false, updatedAt: now })
      .where(
        inArray(
          workDefinitions.id,
          defs.map((d) => d.id),
        ),
      );
  }
  if (agents.length > 0) {
    await tx
      .update(persistentAgents)
      .set({ enabled: false, updatedAt: now })
      .where(
        inArray(
          persistentAgents.id,
          agents.map((a) => a.id),
        ),
      );
  }
  const paused: PausedAutomation[] = [
    ...defs.map((d) => ({
      targetType: "work_definition" as const,
      targetId: d.id,
      workspaceId: d.workspaceId,
      name: d.name,
      kind: d.kind,
    })),
    ...agents.map((a) => ({
      targetType: "persistent_agent" as const,
      targetId: a.id,
      workspaceId: a.workspaceId,
      name: a.name,
      kind: "persistent-agent",
    })),
  ];
  if (paused.length > 0) {
    await tx
      .insert(pausedAutomations)
      .values(paused.map((p) => ({ ...p, userId, reason, pausedAt: now })))
      .onConflictDoNothing();
  }
  return paused;
}

/**
 * Disable `userId`: set `disabled_at`, revoke every session, API key and
 * WebSocket token, pause their own automations — one transaction. Null when
 * the account doesn't exist or is already disabled (nothing changes).
 */
export async function disableUser(
  userId: string,
  opts: { reason: DisableReason; byUserId?: string | null },
): Promise<DisabledAccount | null> {
  const account: DisabledAccount | null = await db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({
        disabledAt: new Date(),
        disabledReason: opts.reason,
        disabledBy: opts.byUserId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .returning({ id: users.id, email: users.email, displayName: users.displayName });
    if (!user) return null;
    const ended = await tx
      .delete(sessions)
      .where(eq(sessions.userId, userId))
      .returning({ id: sessions.id });
    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    await tx.delete(wsUpgradeTokens).where(eq(wsUpgradeTokens.userId, userId));
    const paused = await pauseAutomationsIn(tx, userId, opts.reason);
    return {
      userId,
      email: user.email,
      displayName: user.displayName,
      reason: opts.reason,
      revokedSessions: ended.length,
      revokedApiKeys: revoked.length,
      paused,
    };
  });
  return account;
}

export interface EnabledAccount {
  userId: string;
  email: string;
  displayName: string;
  /** The reason it had been disabled for. */
  wasReason: DisableReason | null;
  resumed: PausedAutomation[];
}

/**
 * Enable `userId` again and switch back on the automations Optio paused for
 * them (those still paused; one someone switched on or deleted meanwhile is
 * left alone). `onlyDirectoryReasons`: the directory sync's call — an
 * account an admin disabled by hand stays disabled; `onlyReasons`: only an
 * account disabled for one of these reasons.
 * Null when nothing changed.
 */
export async function enableUser(
  userId: string,
  opts: { onlyDirectoryReasons?: boolean; onlyReasons?: readonly DisableReason[] } = {},
): Promise<EnabledAccount | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ reason: users.disabledReason })
      .from(users)
      .where(and(eq(users.id, userId), isNotNull(users.disabledAt)))
      .for("update");
    if (!before) return null;
    if (opts.onlyDirectoryReasons && !DIRECTORY_REASONS.includes(before.reason as DisableReason)) {
      return null;
    }
    if (opts.onlyReasons && !opts.onlyReasons.includes(before.reason as DisableReason)) {
      return null;
    }
    const [user] = await tx
      .update(users)
      .set({ disabledAt: null, disabledReason: null, disabledBy: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, displayName: users.displayName });
    const open = await tx
      .update(pausedAutomations)
      .set({ resumedAt: new Date() })
      .where(and(eq(pausedAutomations.userId, userId), isNull(pausedAutomations.resumedAt)))
      .returning();
    const resumed: PausedAutomation[] = [];
    for (const row of open) {
      const back =
        row.targetType === "persistent_agent"
          ? await tx
              .update(persistentAgents)
              .set({ enabled: true, updatedAt: new Date() })
              .where(
                and(
                  eq(persistentAgents.id, row.targetId),
                  eq(persistentAgents.enabled, false),
                  eq(persistentAgents.updatedAt, row.pausedAt),
                ),
              )
              .returning({ id: persistentAgents.id })
          : await tx
              .update(workDefinitions)
              .set({ enabled: true, updatedAt: new Date() })
              .where(
                and(
                  eq(workDefinitions.id, row.targetId),
                  eq(workDefinitions.enabled, false),
                  eq(workDefinitions.updatedAt, row.pausedAt),
                ),
              )
              .returning({ id: workDefinitions.id });
      if (back.length > 0) {
        resumed.push({
          targetType: row.targetType,
          targetId: row.targetId,
          workspaceId: row.workspaceId,
          name: row.name,
          kind: row.kind,
        });
      }
    }
    return {
      userId,
      email: user!.email,
      displayName: user!.displayName,
      wasReason: isDisableReason(before.reason) ? before.reason : null,
      resumed,
    };
  });
}

async function workspacesOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.id);
}

async function workspaceAdmins(workspaceId: string, except: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "admin"),
        ne(workspaceMembers.userId, except),
      ),
    );
  return rows.map((r) => r.id);
}

function automationLines(list: PausedAutomation[]): string {
  return list
    .map((a) => `  - ${a.name} (${KIND_LABEL[a.kind] ?? a.kind}): ${automationPath(a)}`)
    .join("\n");
}

export async function announceDisabled(
  account: DisabledAccount,
  ctx: {
    via: AccountChangeVia;
    req?: FastifyRequest | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  try {
    const who = `${account.displayName} (${account.email})`;
    const why = DISABLE_REASON_LABEL[account.reason];
    const workspaceIds = await workspacesOf(account.userId);
    const told = new Set<string>([account.userId, ...(ctx.actorUserId ? [ctx.actorUserId] : [])]);
    // The Settings card is for deployment admins only; a workspace admin
    // gets their workspace's members instead.
    const deploymentAdmins = new Set(
      (await listDeploymentAdmins({ enabledOnly: true })).map((a) => a.id),
    );
    for (const ws of workspaceIds) {
      const here = account.paused.filter((p) => p.workspaceId === ws);
      const admins = (await workspaceAdmins(ws, account.userId)).filter((id) => !told.has(id));
      admins.forEach((id) => told.add(id));
      if (admins.length === 0) continue;
      const body = [
        `${who} can no longer use Optio: ${why}.`,
        `Their sessions and API keys were revoked. Work of theirs already running or queued finishes; nothing new starts for them.`,
        here.length > 0
          ? `Optio paused their own automations in this workspace:\n${automationLines(here)}\nRecreate the ones still needed under a team or the organization, then delete these.`
          : `They had no scheduled or triggered automations of their own in this workspace.`,
      ].join("\n\n");
      const byLink = new Map<string, string[]>();
      for (const id of admins) {
        const link = deploymentAdmins.has(id) ? "/settings#directory-sync" : "/workspace-settings";
        byLink.set(link, [...(byLink.get(link) ?? []), id]);
      }
      for (const [link, toUserIds] of byLink) {
        await notify({
          kind: "user.offboarded",
          toUserIds,
          workspaceId: ws,
          subject: `${account.displayName} can no longer use Optio`,
          body,
          link,
        });
      }
    }
  } catch (err) {
    logger.warn(
      { err, userId: account.userId },
      "offboarding: announcing a disabled account failed",
    );
  }
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/**
 * The account a sign-in would land in, by the rule `createSession` uses: the
 * same provider identity, or one linked to an account (`byIdentity`); else — with linking
 * by email on — the one account with the same email the provider asserted.
 */
async function accountForSignIn(
  provider: string,
  profile: {
    externalId: string;
    email: string;
    emailVerified?: boolean;
    emailVerifiedByProvider?: boolean;
  },
  link: SignInLink,
) {
  const pick = (u: typeof users.$inferSelect) => ({
    id: u.id,
    provider: u.provider,
    disabledAt: u.disabledAt,
    disabledReason: u.disabledReason,
  });
  const { findAccountByIdentity } = await import("./session-service.js");
  const same = await findAccountByIdentity(provider, profile.externalId);
  if (same) return { ...pick(same), byIdentity: true };
  const asserted = profile.emailVerifiedByProvider ?? profile.emailVerified;
  if (!link.linkByEmail || !asserted || !profile.email) return null;
  const byEmail = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${profile.email.toLowerCase()}`)
    .limit(2);
  return byEmail.length === 1 ? { ...pick(byEmail[0]!), byIdentity: false } : null;
}

/** The one account with this (verified) email, when it is disabled. */
async function disabledByEmail(profile: { email: string; emailVerified?: boolean }) {
  if (!profile.emailVerified || !profile.email) return false;
  const byEmail = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${profile.email.toLowerCase()}`)
    .limit(2);
  return byEmail.length === 1 && !!byEmail[0]!.disabledAt;
}

/** How a sign-in may reach an existing account beyond its own identity (session-service.ts). */
export interface SignInLink {
  linkByEmail?: boolean;
}

/**
 * Whether a vouched-for sign-in may go ahead, called after the provider's
 * own checks (allowed domains, required groups) passed. A disabled account
 * is refused — except one the directory sync disabled, signing in through
 * LDAP as the same directory entry (the identity stored at their last
 * sign-in): the directory has just let them in again (their password bound,
 * their groups re-read), so the account is enabled on the spot, as the next
 * sync would. Another entry with the same email — the account re-created,
 * or the address given to someone new — is refused: whether it may take
 * over the leaver's account, automations and private work is an admin's
 * call (Settings → Access → Directory sync → Enable). Never throws: a
 * database error lets the sign-in through to the session code, which
 * refuses a disabled account anyway.
 */
export async function signInAccountCheck(
  provider: string,
  profile: {
    externalId: string;
    email: string;
    emailVerified?: boolean;
    emailVerifiedByProvider?: boolean;
  },
  req?: FastifyRequest | null,
  link: SignInLink = {},
): Promise<"allowed" | "account_disabled"> {
  try {
    const account = await accountForSignIn(provider, profile, link);
    // A sign-in that would make a new account: no other door for someone
    // disabled — a disabled account with the same verified email refuses it.
    if (!account) return (await disabledByEmail(profile)) ? "account_disabled" : "allowed";
    if (!account.disabledAt) return "allowed";
    const directoryDisabled = DIRECTORY_REASONS.includes(account.disabledReason as DisableReason);
    if (provider === "ldap" && account.byIdentity && directoryDisabled) {
      const enabled = await enableUser(account.id, { onlyDirectoryReasons: true });
      if (enabled) {
        logger.info(
          { userId: account.id },
          "Account enabled again: the directory let them sign in",
        );
        return "allowed";
      }
    }
    return "account_disabled";
  } catch (err) {
    logger.warn({ err, provider }, "offboarding: the sign-in account check failed");
    return "allowed";
  }
}

// ── The admins' view ─────────────────────────────────────────────────────────

export interface DisabledPersonView {
  id: string;
  email: string;
  displayName: string;
  disabledAt: string;
  reason: DisableReason | null;
  reasonLabel: string;
  byHand: boolean;
  disabledBy: { id: string; displayName: string } | null;
  /** The paused automations the viewer may see (workspace admins of their workspace). */
  paused: Array<{ name: string; kind: string; path: string; workspaceId: string | null }>;
  /** Paused automations in workspaces the viewer doesn't administer. */
  pausedHidden: number;
}

/**
 * Everyone disabled now, newest first, for a deployment admin's Settings
 * card, with the automations Optio paused for them — named only where the
 * viewer may see them (`canSeeWork`: a workspace admin of that workspace,
 * since they are private work); the rest counted. `viewerId` null: auth is
 * off (local development), everything is shown.
 */
export async function listDisabledPeople(
  viewerId: string | null,
  limit = 200,
): Promise<DisabledPersonView[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      disabledAt: users.disabledAt,
      reason: users.disabledReason,
      disabledBy: users.disabledBy,
    })
    .from(users)
    .where(isNotNull(users.disabledAt))
    .orderBy(sql`${users.disabledAt} DESC`)
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const byIds = [...new Set(rows.map((r) => r.disabledBy).filter((x): x is string => !!x))];
  const names = byIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, byIds))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.displayName]));
  const paused = await db
    .select()
    .from(pausedAutomations)
    .where(and(inArray(pausedAutomations.userId, ids), isNull(pausedAutomations.resumedAt)));
  const actors = new Map<string, Awaited<ReturnType<typeof actorFor>>>();
  const mayView = async (ownerId: string, workspaceId: string | null) => {
    if (viewerId === null) return true;
    if (!workspaceId) return false;
    if (!actors.has(workspaceId)) actors.set(workspaceId, await actorFor(viewerId, workspaceId));
    const actor = actors.get(workspaceId);
    return !!actor && canSee(ownerId, actor);
  };
  const out: DisabledPersonView[] = [];
  for (const r of rows) {
    const mine = paused.filter((p) => p.userId === r.id);
    const shown: DisabledPersonView["paused"] = [];
    let hidden = 0;
    for (const p of mine) {
      if (await mayView(r.id, p.workspaceId)) {
        shown.push({
          name: p.name,
          kind: p.kind,
          path: automationPath(p),
          workspaceId: p.workspaceId,
        });
      } else hidden++;
    }
    const reason = isDisableReason(r.reason) ? r.reason : null;
    out.push({
      id: r.id,
      email: r.email,
      displayName: r.displayName,
      disabledAt: r.disabledAt!.toISOString(),
      reason,
      reasonLabel: reason ? DISABLE_REASON_LABEL[reason] : "disabled",
      byHand: reason === "admin",
      disabledBy: r.disabledBy
        ? { id: r.disabledBy, displayName: nameOf.get(r.disabledBy) ?? "someone" }
        : null,
      paused: shown,
      pausedHidden: hidden,
    });
  }
  return out;
}

async function actorFor(userId: string, workspaceId: string): Promise<Actor | null> {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return member ? { userId, workspaceId, isAdmin: member.role === "admin" } : null;
}
