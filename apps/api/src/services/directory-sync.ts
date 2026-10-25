/**
 * The directory sync (docs/directory-sync.md): Optio applies a person's
 * directory groups when they sign in, and a session lives up to 30 days —
 * so without this, someone removed from Active Directory, or from the admin
 * group, kept their rights, team secrets and API keys for weeks, and their
 * schedules kept running because they never signed in again.
 *
 * Every interval (15 minutes to a day; Settings → Access → Directory sync,
 * or `OPTIO_DIRECTORY_SYNC*`) one run at a time (a lease) re-reads every
 * LDAP-sourced person's entry — found by the identity stored at their
 * sign-in, then checked against the user filter — and groups through the
 * LDAP sign-in's own service bind and settings (services/auth/ldap.ts):
 *
 * - **Still allowed** (the entry is there, Active Directory doesn't mark it
 *   disabled, and the sign-in's own rule — required groups, allowed domains,
 *   `accessDecision` — lets them in): their groups are applied the way a
 *   sign-in applies them (`completeSignIn`: deployment admin and organization
 *   admin from the admin groups, the workspaces their groups open, the
 *   group-mapped teams), plus the group-mapped teams of every other
 *   workspace they are in; the workspaces a group put them in and no group
 *   of theirs opens any more, they leave; their name and email follow the
 *   directory. One the sync had disabled is enabled again
 *   (services/offboarding.ts).
 * - **A leaver** (no entry with their identity, or the user filter no longer
 *   finds it; `userAccountControl` ACCOUNTDISABLE; out of every required
 *   group; or an email domain no longer allowed): the account is disabled
 *   (`disableUser`: sessions and API keys revoked, own automations paused),
 *   what the directory gave them is taken back (admin roles, group-mapped
 *   teams), and their workspaces' and teams' admins are told.
 *
 * Safety: a directory that can't be reached or read changes nobody; a
 * person whose lookup fails is counted as an error and left alone; a run
 * that would disable more than `OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT`
 * (25) percent of the people it checked (and more than three) is **held** —
 * it changes nobody, and a deployment admin looks and runs it again with
 * "Disable them anyway"; a held or failed run emails the deployment admins
 * (once per change, `directory.sync_stopped`); and the last enabled
 * deployment admin is never disabled. People who sign in with OpenID
 * Connect or SAML aren't read here: their provider checks them at every
 * sign-in, and SCIM provisioning (services/scim.ts) lets the identity
 * provider push leavers and groups through the same steps.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import type { LdapSignInSettings, SignInAccessSettings } from "@optio/shared";
import { db } from "../db/client.js";
import {
  directorySyncRuns,
  teamMembers,
  userIdentities,
  users,
  workspaceMembers,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { auditEvent } from "./audit.js";
import {
  LdapAuthError,
  openLdapDirectory,
  type DirectoryEntry,
  type LdapDirectory,
  type LdapUser,
} from "./auth/ldap.js";
import { getDeploymentSetting, setDeploymentSetting } from "./deployment-settings.js";
import { INSTANCE_ID } from "./instance.js";
import { LeaseLostError, withLease } from "./lease-service.js";
import { notify } from "./notify.js";
import {
  activeTeamsOf,
  announceDisabled,
  announceEnabled,
  disableUser,
  enableUser,
  type DisableReason,
} from "./offboarding.js";
import {
  accessDecision,
  completeSignIn,
  listDeploymentAdmins,
  resolveProviderConfig,
  type ResolvedProviderConfig,
} from "./sign-in-config-service.js";
import { leaveWorkspacesByGroups } from "./workspace-groups.js";

// ── Settings ────────────────────────────────────────────────────────────────

export const DIRECTORY_SYNC_ENABLED_KEY = "directorySync.enabled";
export const DIRECTORY_SYNC_INTERVAL_KEY = "directorySync.intervalMinutes";
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_INTERVAL_MINUTES = 30;
export const DEFAULT_MAX_DISABLE_PERCENT = 25;
/** Runs kept for the Settings card. */
const RUNS_KEPT = 50;
export const LEASE_KEY = "directory-sync";

export interface DirectorySyncEnv {
  enabled: boolean;
  intervalMinutes: number;
  maxDisablePercent: number;
}

/** A whole number of minutes within the bounds, else null. */
export function validInterval(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return n >= MIN_INTERVAL_MINUTES && n <= MAX_INTERVAL_MINUTES ? n : null;
}

/** The deployment's own defaults (chart `auth.directorySync.*`). */
export function envDirectorySync(env: NodeJS.ProcessEnv = process.env): DirectorySyncEnv {
  const raw = env.OPTIO_DIRECTORY_SYNC?.trim().toLowerCase();
  const pct = Number(env.OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT?.trim());
  return {
    enabled: raw === "true" || raw === "1" || raw === "yes",
    intervalMinutes:
      validInterval(env.OPTIO_DIRECTORY_SYNC_INTERVAL_MINUTES) ?? DEFAULT_INTERVAL_MINUTES,
    maxDisablePercent:
      env.OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT?.trim() && Number.isFinite(pct)
        ? Math.min(100, Math.max(0, pct))
        : DEFAULT_MAX_DISABLE_PERCENT,
  };
}

export interface DirectorySyncSettings {
  enabled: boolean;
  intervalMinutes: number;
  /** Where each comes from: saved in the app, or the deployment's environment. */
  source: { enabled: "app" | "environment"; intervalMinutes: "app" | "environment" };
  environment: DirectorySyncEnv;
  maxDisablePercent: number;
}

export async function directorySyncSettings(): Promise<DirectorySyncSettings> {
  const env = envDirectorySync();
  const storedEnabled = await getDeploymentSetting(DIRECTORY_SYNC_ENABLED_KEY);
  const storedInterval = validInterval(await getDeploymentSetting(DIRECTORY_SYNC_INTERVAL_KEY));
  return {
    enabled: typeof storedEnabled === "boolean" ? storedEnabled : env.enabled,
    intervalMinutes: storedInterval ?? env.intervalMinutes,
    source: {
      enabled: typeof storedEnabled === "boolean" ? "app" : "environment",
      intervalMinutes: storedInterval !== null ? "app" : "environment",
    },
    environment: env,
    maxDisablePercent: env.maxDisablePercent,
  };
}

export class DirectorySyncError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "DirectorySyncError";
  }
}

/** Save what a deployment admin changed; null puts a value back to the environment's. */
export async function saveDirectorySyncSettings(
  input: { enabled?: boolean | null; intervalMinutes?: number | null },
  byUserId: string | null,
): Promise<DirectorySyncSettings> {
  if (input.intervalMinutes !== undefined && input.intervalMinutes !== null) {
    if (validInterval(input.intervalMinutes) === null) {
      throw new DirectorySyncError(
        `The interval is a whole number of minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`,
      );
    }
  }
  if (input.enabled !== undefined) {
    await setDeploymentSetting(DIRECTORY_SYNC_ENABLED_KEY, input.enabled, byUserId);
  }
  if (input.intervalMinutes !== undefined) {
    await setDeploymentSetting(DIRECTORY_SYNC_INTERVAL_KEY, input.intervalMinutes, byUserId);
  }
  return directorySyncSettings();
}

// ── What the directory says about one person ────────────────────────────────

export type DirectoryVerdict =
  | { kind: "active"; entry: LdapUser }
  | { kind: "leaver"; reason: Exclude<DisableReason, "admin"> }
  /** Nothing is changed for them; the run lists them as "couldn't be checked". */
  | { kind: "unchecked"; why: string };

/** Why a person's entry couldn't be judged against the user filter (`userFilter: "unknown"`). */
export const FILTER_UNKNOWN =
  "the LDAP user filter doesn't find their entry by their username, and their entry has no " +
  "value of the attributes the filter matches the sign-in name against — check the user filter";

/**
 * The entry found is the person's own: the identity stored at sign-in
 * (objectGUID / entryUUID, or the DN where the directory has neither).
 */
export function sameEntry(storedExternalId: string, found: LdapUser): boolean {
  return (
    storedExternalId === found.externalId ||
    storedExternalId.toLowerCase() === found.dn.toLowerCase()
  );
}

/**
 * The rule, without the database: what a person's directory entry (null:
 * none) means under the LDAP sign-in's settings — the same `accessDecision`
 * a sign-in makes (LDAP emails are the organization's own, so vouched for).
 * An entry the user filter no longer finds (`userFilter: "excludes"`) is
 * one a sign-in can't reach: gone, as far as Optio is concerned.
 */
export function verdictFor(
  user: { externalId: string },
  found: (LdapUser & { userFilter?: DirectoryEntry["userFilter"] }) | null,
  config: { allowedDomains: string[]; settings?: SignInAccessSettings | null },
): DirectoryVerdict {
  if (!found || !sameEntry(user.externalId, found)) return { kind: "leaver", reason: "gone" };
  if (found.accountDisabled) return { kind: "leaver", reason: "disabled_in_directory" };
  if (found.userFilter === "excludes") return { kind: "leaver", reason: "gone" };
  if (found.userFilter === "unknown") return { kind: "unchecked", why: FILTER_UNKNOWN };
  const decision = accessDecision(
    { email: found.email, emailVerified: !!found.email, groups: found.groups },
    { allowedDomains: config.allowedDomains, settings: config.settings },
  );
  if (decision === "group_not_allowed") return { kind: "leaver", reason: "not_in_required_group" };
  if (decision !== "allowed") return { kind: "leaver", reason: "domain_not_allowed" };
  return { kind: "active", entry: found };
}

/**
 * Whether a run that would newly disable `leavers` of the `checked` people
 * looks like a broken directory or filter rather than people leaving: more
 * than three, and more than `maxPercent` percent.
 */
export function shouldHold(checked: number, leavers: number, maxPercent: number): boolean {
  if (maxPercent >= 100) return false;
  return leavers > Math.max(3, Math.floor((checked * maxPercent) / 100));
}

// ── Applying it ─────────────────────────────────────────────────────────────

type UserRow = typeof users.$inferSelect;

/** What a person's access looks like now, to tell whether a run changed it. */
async function accessSnapshot(userId: string): Promise<string> {
  const [u] = await db
    .select({
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      deploymentAdmin: users.deploymentAdmin,
      groups: users.ssoGroups,
    })
    .from(users)
    .where(eq(users.id, userId));
  const ws = await db
    .select({ id: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const tm = await db
    .select({ id: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.status, "active")));
  return JSON.stringify({
    ...u,
    groups: [...(u?.groups ?? [])].map((g) => g.toLowerCase()).sort(),
    ws: ws.map((w) => `${w.id}:${w.role}`).sort(),
    tm: tm.map((t) => `${t.id}:${t.role}`).sort(),
  });
}

/** The group-mapped teams of every workspace the person is in (sign-in reaches only some). */
async function syncTeamsEverywhere(userId: string, groups: string[]): Promise<void> {
  const { syncTeamsFromGroups } = await import("./team-service.js");
  const memberOf = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  for (const ws of memberOf) {
    await syncTeamsFromGroups(userId, ws.id, groups).catch((err) =>
      logger.warn({ err, userId, workspaceId: ws.id }, "directory sync: team sync failed"),
    );
  }
}

/**
 * Apply a person's directory groups the way a sign-in through `provider`
 * would (its admin groups, the workspaces their groups open, the
 * group-mapped teams), and also take away what a sign-in never does: the
 * workspaces a group put them in and none opens any more, and the
 * group-mapped teams of every workspace they are in. The LDAP sync and SCIM
 * provisioning (services/scim.ts) both apply groups through this.
 */
export async function applyDirectoryGroups(
  user: { id: string; email: string },
  provider: string,
  groups: string[],
): Promise<void> {
  await completeSignIn(
    { id: user.id, email: user.email },
    { provider, groups },
    {
      directorySync: true,
    },
  );
  // Sign-in only ever adds: the workspaces a group put them in and none of
  // their groups opens any more, they leave (services/workspace-groups.ts).
  await leaveWorkspacesByGroups(user.id, groups);
  await syncTeamsEverywhere(user.id, groups);
}

/** Apply an allowed person's entry and groups; true when their access changed. */
async function applyEntry(user: UserRow, entry: LdapUser): Promise<boolean> {
  const before = await accessSnapshot(user.id);
  const email = entry.email || user.email;
  const displayName = entry.displayName || user.displayName;
  const username = entry.username || user.username;
  if (email !== user.email || displayName !== user.displayName || username !== user.username) {
    await db
      .update(users)
      .set({ email, displayName, username, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  await applyDirectoryGroups({ id: user.id, email }, "ldap", entry.groups);
  return (await accessSnapshot(user.id)) !== before;
}

/**
 * Take back what the directory gave a leaver: admin roles that came from the
 * admin groups and the group-mapped teams. Memberships made by hand stay
 * (the account is disabled; they return if it is enabled).
 */
export async function stripDirectoryAccess(
  user: { id: string; email: string },
  provider = "ldap",
): Promise<void> {
  await completeSignIn(
    { id: user.id, email: user.email },
    { provider, groups: [] },
    { directorySync: true, join: false },
  );
  await syncTeamsEverywhere(user.id, []);
}

/** The enabled deployment admins (flagged in the app, or by OPTIO_DEPLOYMENT_ADMINS). */
async function enabledDeploymentAdminIds(): Promise<Set<string>> {
  return new Set((await listDeploymentAdmins({ enabledOnly: true })).map((a) => a.id));
}

function ldapSettingsOf(config: ResolvedProviderConfig) {
  const s = config.settings as LdapSignInSettings;
  return {
    url: s.url,
    startTls: s.startTls,
    caPem: s.caPem,
    insecureSkipVerify: s.insecureSkipVerify,
    bindDn: s.bindDn,
    bindPassword: config.clientSecret,
    userBaseDn: s.userBaseDn,
    userFilter: s.userFilter,
    usernameAttribute: s.usernameAttribute,
    emailAttribute: s.emailAttribute,
    displayNameAttribute: s.displayNameAttribute,
    groupMode: s.groupMode,
    groupBaseDn: s.groupBaseDn,
    groupFilter: s.groupFilter,
  };
}

// ── A run ───────────────────────────────────────────────────────────────────

export type RunOutcome =
  | "unchanged"
  | "changed"
  | "disabled"
  | "enabled"
  | "still_disabled"
  | "would_disable"
  | "kept_last_admin"
  | "error";

export interface RunDetail {
  userId: string;
  email: string;
  outcome: RunOutcome;
  reason?: string;
}

export interface DirectorySyncRunView {
  id: string;
  trigger: "schedule" | "manual";
  startedBy: string | null;
  status: "running" | "ok" | "held" | "failed";
  checked: number;
  changed: number;
  disabled: number;
  enabled: number;
  errors: number;
  error: string | null;
  details: RunDetail[];
  startedAt: string;
  finishedAt: string | null;
}

function runView(row: typeof directorySyncRuns.$inferSelect): DirectorySyncRunView {
  return {
    id: row.id,
    trigger: row.trigger,
    startedBy: row.startedBy,
    status: row.status,
    checked: row.checked,
    changed: row.changed,
    disabled: row.disabled,
    enabled: row.enabled,
    errors: row.errors,
    error: row.error,
    details: (row.details ?? []) as RunDetail[],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function lastDirectorySyncRun(): Promise<DirectorySyncRunView | null> {
  const [row] = await db
    .select()
    .from(directorySyncRuns)
    .orderBy(desc(directorySyncRuns.startedAt))
    .limit(1);
  return row ? runView(row) : null;
}

/** Whether LDAP sign-in is set up (in the app or by the environment): the sync needs it. */
export async function ldapConfigured(): Promise<boolean> {
  return !!(await resolveProviderConfig("ldap").catch(() => null));
}

export const LDAP_NEEDED =
  "Directory sync reads LDAP / Active Directory, and LDAP sign-in isn't set up. " +
  "People who sign in with OpenID Connect are checked by their provider at every sign-in.";

/** A run that would disable more people than the limit allows: it changes nobody. */
class HeldError extends Error {
  constructor(leavers: number, checked: number, pct: number) {
    super(
      `This run would disable ${leavers} of the ${checked} people it checked (more than ${pct}%), ` +
        `so it changed nobody. Check the LDAP settings and the directory; if they are right, ` +
        `run it again with "Disable them anyway".`,
    );
    this.name = "HeldError";
  }
}

export interface RunOptions {
  trigger: "schedule" | "manual";
  startedBy?: string | null;
  /** Go ahead although the run would disable more people than the limit allows. */
  force?: boolean;
  /** Tests: the directory to read instead of the LDAP sign-in's. */
  directory?: LdapDirectory;
}

interface Counts {
  checked: number;
  changed: number;
  disabled: number;
  enabled: number;
  errors: number;
}

/**
 * One run: under the lease (a `DirectorySyncError` 409 when another is in
 * progress), recorded in `directory_sync_runs` and the audit trail
 * (`directory.sync`). Returns the run.
 *
 * Each run holds the lease under a holder of its own: the lease's default
 * holder is the instance, and the same holder takes a lease again — so a
 * scheduled tick and a "Run now" on one instance would both have run.
 */
export async function runDirectorySync(opts: RunOptions): Promise<DirectorySyncRunView> {
  let result: DirectorySyncRunView | null;
  try {
    result = await withLease(LEASE_KEY, () => runUnderLease(opts), {
      ttlMs: 120_000,
      holder: `${INSTANCE_ID}:${randomUUID()}`,
    });
  } catch (err) {
    if (err instanceof LeaseLostError) {
      throw new DirectorySyncError("The directory sync lost its lock while running", 409);
    }
    throw err;
  }
  if (!result) throw new DirectorySyncError("A directory sync is running now", 409);
  return result;
}

async function runUnderLease(opts: RunOptions): Promise<DirectorySyncRunView> {
  // Under the lease, any other "running" row belongs to a run whose instance stopped.
  await db
    .update(directorySyncRuns)
    .set({ status: "failed", error: "stopped before it finished", finishedAt: new Date() })
    .where(eq(directorySyncRuns.status, "running"));
  const [run] = await db
    .insert(directorySyncRuns)
    .values({ trigger: opts.trigger, startedBy: opts.startedBy ?? null })
    .returning();
  const counts: Counts = { checked: 0, changed: 0, disabled: 0, enabled: 0, errors: 0 };
  const details: RunDetail[] = [];
  let status: DirectorySyncRunView["status"] = "ok";
  let error: string | null = null;
  try {
    status = await syncOnce(opts, counts, details);
  } catch (err) {
    // Held (too many leavers at once) or failed (the directory couldn't be
    // read): either way nobody was changed.
    status = err instanceof HeldError ? "held" : "failed";
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ status, error }, "Directory sync changed nobody");
  }
  const [done] = await db
    .update(directorySyncRuns)
    .set({ status, error, ...counts, details, finishedAt: new Date() })
    .where(eq(directorySyncRuns.id, run!.id))
    .returning();
  if (status === "held" || status === "failed") {
    await tellAdminsItStopped(done!, opts.startedBy ?? null).catch((err) =>
      logger.warn({ err }, "directory sync: telling the admins it stopped failed"),
    );
  }
  void auditEvent({
    action: "directory.sync",
    userId: opts.startedBy ?? null,
    workspaceId: null,
    clientIp: null,
    success: status === "ok",
    details: { trigger: opts.trigger, status, ...counts },
  });
  await pruneRuns();
  logger.info({ status, ...counts, trigger: opts.trigger }, "Directory sync run");
  return runView(done!);
}

/**
 * A held or failed run changed nobody, and the runs after it will do the
 * same until someone looks — so leavers would keep their access unnoticed.
 * The deployment admins are told when the sync *becomes* held or failed
 * (the run before it ended otherwise), not at every run; whoever pressed
 * "Run now" saw it already.
 */
async function tellAdminsItStopped(
  run: typeof directorySyncRuns.$inferSelect,
  startedBy: string | null,
): Promise<void> {
  const [previous] = await db
    .select({ status: directorySyncRuns.status })
    .from(directorySyncRuns)
    .where(and(ne(directorySyncRuns.id, run.id), ne(directorySyncRuns.status, "running")))
    .orderBy(desc(directorySyncRuns.startedAt))
    .limit(1);
  if (previous?.status === run.status) return;
  const admins = [...(await enabledDeploymentAdminIds())].filter((id) => id !== startedBy);
  if (admins.length === 0) return;
  const held = run.status === "held";
  await notify({
    kind: "directory.sync_stopped",
    toUserIds: admins,
    workspaceId: null,
    subject: held
      ? "The directory sync is holding: it would disable too many people"
      : "The directory sync can't read the directory",
    body: [
      // A held run's error already says how many and what to do.
      held ? "" : "The directory sync failed, so it changed nobody.",
      run.error ?? "",
      `Until a run succeeds, people who left keep their sessions, API keys and schedules. ` +
        `Look at the run in Settings → Access → Directory sync: fix the LDAP settings or the ` +
        `directory${held ? `, or run it with "Disable them anyway" if the list is right` : ""}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    link: "/settings#directory-sync",
  });
}

async function pruneRuns(): Promise<void> {
  const keep = db
    .select({ id: directorySyncRuns.id })
    .from(directorySyncRuns)
    .orderBy(desc(directorySyncRuns.startedAt))
    .limit(RUNS_KEPT);
  await db
    .delete(directorySyncRuns)
    .where(notInArray(directorySyncRuns.id, keep))
    .catch(() => {});
}

/**
 * The accounts that sign in through LDAP: created by an LDAP sign-in, or
 * holding an LDAP identity linked to them (`user_identities`, with
 * `OPTIO_LINK_ACCOUNTS_BY_EMAIL`) — those are looked up by that identity.
 */
async function ldapAccounts(): Promise<UserRow[]> {
  const own = await db.select().from(users).where(eq(users.provider, "ldap"));
  const linked = await db
    .select({ user: users, externalId: userIdentities.externalId })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, "ldap"), ne(users.provider, "ldap")));
  const seen = new Set<string>();
  return [...own, ...linked.map((l) => ({ ...l.user, externalId: l.externalId }))]
    .filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Read everyone first, then apply — so a run that would disable too many can stop untouched. */
async function syncOnce(
  opts: RunOptions,
  counts: Counts,
  details: RunDetail[],
): Promise<DirectorySyncRunView["status"]> {
  const config = await resolveProviderConfig("ldap");
  if (!config) throw new Error(LDAP_NEEDED);
  const people = await ldapAccounts();

  // Phase 1: read the directory (nothing changes yet).
  const directory = opts.directory ?? (await openLdapDirectory(ldapSettingsOf(config)));
  const verdicts: Array<{ user: UserRow; verdict: DirectoryVerdict }> = [];
  try {
    for (const user of people) {
      if (user.disabledAt && user.disabledReason === "admin") continue; // an admin's call
      counts.checked++;
      let found: DirectoryEntry | null;
      try {
        found = await directory.lookup({ externalId: user.externalId, username: user.username });
      } catch (err) {
        // The directory went away: stop, change nobody.
        if (err instanceof LdapAuthError && err.code === "connection") throw err;
        counts.errors++;
        details.push({
          userId: user.id,
          email: user.email,
          outcome: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      verdicts.push({ user, verdict: verdictFor(user, found, config) });
    }
  } finally {
    if (!opts.directory) await directory.close();
  }

  const newLeavers = verdicts.filter((v) => v.verdict.kind === "leaver" && !v.user.disabledAt);
  const settings = await directorySyncSettings();
  if (!opts.force && shouldHold(counts.checked, newLeavers.length, settings.maxDisablePercent)) {
    for (const { user, verdict } of newLeavers) {
      details.push({
        userId: user.id,
        email: user.email,
        outcome: "would_disable",
        reason: verdict.kind === "leaver" ? verdict.reason : undefined,
      });
    }
    throw new HeldError(newLeavers.length, counts.checked, settings.maxDisablePercent);
  }

  // Phase 2: apply.
  for (const { user, verdict } of verdicts) {
    try {
      if (verdict.kind === "unchecked") {
        counts.errors++;
        details.push({
          userId: user.id,
          email: user.email,
          outcome: "error",
          reason: verdict.why,
        });
        continue;
      }
      if (verdict.kind === "active") {
        let outcome: RunOutcome = "unchanged";
        if (user.disabledAt) {
          const enabled = await enableUser(user.id, { onlyDirectoryReasons: true });
          if (enabled) {
            counts.enabled++;
            outcome = "enabled";
            void announceEnabled(enabled, { via: "directory" });
          }
        }
        const changed = await applyEntry(user, verdict.entry);
        if (changed && outcome === "unchanged") {
          counts.changed++;
          outcome = "changed";
        }
        if (outcome !== "unchanged") details.push({ userId: user.id, email: user.email, outcome });
        continue;
      }
      if (user.disabledAt) {
        details.push({
          userId: user.id,
          email: user.email,
          outcome: "still_disabled",
          reason: user.disabledReason ?? undefined,
        });
        continue;
      }
      const admins = await enabledDeploymentAdminIds();
      if (admins.has(user.id) && admins.size <= 1) {
        counts.errors++;
        details.push({
          userId: user.id,
          email: user.email,
          outcome: "kept_last_admin",
          reason: `${verdict.reason}; the last deployment admin is never disabled — make someone else one first`,
        });
        continue;
      }
      const teamsBefore = await activeTeamsOf(user.id);
      const account = await disableUser(user.id, { reason: verdict.reason });
      if (!account) continue; // disabled meanwhile
      await stripDirectoryAccess(user);
      counts.disabled++;
      details.push({
        userId: user.id,
        email: user.email,
        outcome: "disabled",
        reason: verdict.reason,
      });
      await announceDisabled(account, { via: "directory", teamsBefore });
    } catch (err) {
      counts.errors++;
      details.push({
        userId: user.id,
        email: user.email,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.warn({ err, userId: user.id }, "directory sync: applying one person failed");
    }
  }
  return "ok";
}

/**
 * The worker's tick: run when the sync is on, LDAP sign-in is set up and the
 * interval has passed since the last run started (a "Run now" counts).
 */
export async function runDirectorySyncIfDue(
  now = new Date(),
): Promise<"ran" | "off" | "not_due" | "no_ldap" | "busy"> {
  const settings = await directorySyncSettings();
  if (!settings.enabled) return "off";
  const [last] = await db
    .select({ startedAt: directorySyncRuns.startedAt })
    .from(directorySyncRuns)
    .orderBy(desc(directorySyncRuns.startedAt))
    .limit(1);
  if (last && now.getTime() - last.startedAt.getTime() < settings.intervalMinutes * 60_000) {
    return "not_due";
  }
  if (!(await ldapConfigured())) return "no_ldap";
  try {
    await runDirectorySync({ trigger: "schedule" });
    return "ran";
  } catch (err) {
    if (err instanceof DirectorySyncError && err.status === 409) return "busy";
    throw err;
  }
}
