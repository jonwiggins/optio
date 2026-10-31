/** LDAP directory synchronization and account offboarding.
 * Lookup errors leave the affected account unchanged; unavailable directories
 * and held bulk runs change nobody. Runs record their operator and force flag.
 * Notification delivery and SCIM provisioning are separate features.
 */
import { logAction } from "./optio-action-service.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import type { LdapSignInSettings, SignInAccessSettings } from "@optio/shared";
import { db } from "../db/client.js";
import { directorySyncRuns, userIdentities, users, workspaceMembers } from "../db/schema.js";
import { logger } from "../logger.js";
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
import {
  LastDeploymentAdminError,
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
/** Why a person found by name couldn't be matched to their stored identity (`identityUnreadable`). */
export const IDENTITY_UNREADABLE =
  "their directory entry, found by their username, shows no objectGUID or entryUUID to match " +
  "the identity stored at sign-in — check that the service account may read it";

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
  found:
    | (LdapUser & {
        userFilter?: DirectoryEntry["userFilter"];
        identityUnreadable?: DirectoryEntry["identityUnreadable"];
      })
    | null,
  config: { allowedDomains: string[]; settings?: SignInAccessSettings | null },
): DirectoryVerdict {
  if (found?.identityUnreadable) return { kind: "unchecked", why: IDENTITY_UNREADABLE };
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
  return JSON.stringify({
    ...u,
    groups: [...(u?.groups ?? [])].map((g) => g.toLowerCase()).sort(),
    ws: ws.map((w) => `${w.id}:${w.role}`).sort(),
  });
}

/** The group-mapped teams of every workspace the person is in (sign-in reaches only some). */
/**
 * Apply a person's directory groups the way a sign-in through `provider`
 * would (its admin groups, the workspaces their groups open, the
 * group-mapped teams), and also take away what a sign-in never does: the
 * workspaces a group put them in and none opens any more, and the
 * group-mapped teams of every workspace they are in. The LDAP sync and SCIM
 * provisioning (services/scim.ts) both apply groups through this.
 */
export async function applyDirectoryGroups(
  user: { id: string; email: string; emailVerified?: boolean },
  provider: string,
  groups: string[],
  groupProvider = provider,
): Promise<void> {
  await completeSignIn(
    { id: user.id, email: user.email, emailVerified: user.emailVerified === true, provider },
    { provider, groups },
    {
      directorySync: true,
      groupProvider,
    },
  );
}

/** Apply an allowed person's entry and groups; true when their access changed. */
async function applyEntry(user: UserRow, entry: LdapUser): Promise<boolean> {
  const before = await accessSnapshot(user.id);
  const email = entry.email || user.email;
  const displayName = entry.displayName || user.displayName;
  const username = entry.username || user.username;
  const emailVerified = entry.email ? true : user.emailVerified;
  if (
    email !== user.email ||
    displayName !== user.displayName ||
    username !== user.username ||
    emailVerified !== user.emailVerified
  ) {
    await db
      .update(users)
      .set({ email, emailVerified, displayName, username, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  await applyDirectoryGroups(
    { id: user.id, email, emailVerified: !!entry.email },
    "ldap",
    entry.groups,
  );
  return (await accessSnapshot(user.id)) !== before;
}

/**
 * Take back what the directory gave a leaver: admin roles that came from the
 * admin groups and the group-mapped teams. Memberships made by hand stay
 * (the account is disabled; they return if it is enabled).
 */
export async function stripDirectoryAccess(
  user: { id: string; email: string; emailVerified?: boolean },
  provider = "ldap",
  groupProvider = provider,
): Promise<void> {
  await completeSignIn(
    { id: user.id, email: user.email, emailVerified: user.emailVerified === true, provider },
    { provider, groups: [] },
    { directorySync: true, join: false, groupProvider },
  );
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
  forced: boolean;
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
    forced: row.forced,
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
    .values({
      trigger: opts.trigger,
      startedBy: opts.startedBy ?? null,
      forced: opts.force === true,
    })
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
  await logAction({
    userId: opts.startedBy ?? undefined,
    action: "directory.sync",
    params: {},
    result: {
      runId: run!.id,
      forced: opts.force === true,
      trigger: opts.trigger,
      status,
      ...counts,
    },
    success: status === "ok",
    ...(error ? { error } : {}),
  }).catch((err) => logger.warn({ err, runId: run!.id }, "Recording directory sync action failed"));
  await pruneRuns();
  logger.info({ status, ...counts, trigger: opts.trigger }, "Directory sync run");
  return runView(done!);
}

/** Keep a bounded history of completed runs. */
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
      const keptLastAdmin = () => {
        counts.errors++;
        details.push({
          userId: user.id,
          email: user.email,
          outcome: "kept_last_admin",
          reason: `${verdict.reason}; the last deployment admin is never disabled — make someone else one first`,
        });
      };
      const admins = await enabledDeploymentAdminIds();
      if (admins.has(user.id) && admins.size <= 1) {
        keptLastAdmin();
        continue;
      }
      let account;
      try {
        account = await disableUser(user.id, { reason: verdict.reason, protectLastAdmin: true });
      } catch (err) {
        if (!(err instanceof LastDeploymentAdminError)) throw err;
        keptLastAdmin();
        continue;
      }
      if (!account) continue; // disabled meanwhile
      await stripDirectoryAccess(user);
      counts.disabled++;
      details.push({
        userId: user.id,
        email: user.email,
        outcome: "disabled",
        reason: verdict.reason,
      });
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
