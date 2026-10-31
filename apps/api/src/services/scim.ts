import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { SignInProviderName } from "@optio/shared";
import { db } from "../db/client.js";
import {
  scimGroupMembers,
  scimGroups,
  scimTokens,
  scimUsers,
  userIdentities,
  users,
} from "../db/schema.js";
import { logger } from "../logger.js";
import { getDeploymentSetting, setDeploymentSetting } from "./deployment-settings.js";
import {
  envDirectorySync,
  shouldHold,
  applyDirectoryGroups,
  stripDirectoryAccess,
} from "./directory-sync.js";
import { LastDeploymentAdminError, SCIM_REASONS, disableUser, enableUser } from "./offboarding.js";
import {
  accessDecision,
  domainDecision,
  isSignInProvider,
  envDeploymentAdmins,
  listDeploymentAdmins,
  resolveProviderConfig,
} from "./sign-in-config-service.js";

/**
 * SCIM 2.0 provisioning (RFC 7643 / 7644; docs/directory-sync.md): an
 * identity provider — Microsoft Entra ID, Okta, OneLogin, Authentik,
 * Keycloak with a SCIM plugin, anything standard — pushes people and groups
 * to `/api/scim/v2/Users` and `/Groups`, with a bearer token a deployment
 * admin generated (Settings → Access → Directory sync → SCIM). Off until a
 * token exists.
 *
 * - **A provisioned person** is an Optio account (their SCIM `id` is the
 *   user's id). An account that already signed in through the SCIM sign-in
 *   provider with the same email (or username, for OIDC and LDAP) is
 *   adopted, unless it is a deployment admin; otherwise one is made, and the
 *   person's first sign-in through that provider claims it
 *   (`scimAccountFor`): the same email the provider vouches for, or their
 *   username for OIDC and LDAP (a GitHub or GitLab login is a public handle).
 *   Only that provider — the identity provider that provisions — claims
 *   accounts.
 * - **Deprovisioning** (`active: false`, or DELETE) disables the account
 *   exactly as the LDAP sync's leaver path does (`disableUser`: sessions,
 *   API keys revoked, own automations paused; what the directory gave them
 *   taken back). `active: true` again
 *   enables only an account SCIM disabled (an admin's "disabled by hand"
 *   stays). SCIM never changes or disables a deployment admin whose role
 *   came from elsewhere (by hand, the environment, another provider's admin
 *   group), and never the last enabled deployment admin. A required-group change that
 *   would disable more than the directory sync's hold allows is refused, and
 *   so is any deactivation (inactive, out of the required groups, an email
 *   outside the allowed domains) that would, with SCIM's deactivations of
 *   the last 15 minutes (`guardUserDeactivation`, `guardGroupDeactivation`).
 * - **Groups**: a person's groups are the display names of the SCIM groups
 *   they are in, applied as a sign-in through the SCIM sign-in provider
 *   would apply them — its admin groups, the workspaces their groups open,
 *   (`applyDirectoryGroups`) — and also at each
 *   sign-in, merged with the groups the sign-in brings. An admin group grants
 *   deployment admin through SCIM only with OPTIO_SCIM_ALLOW_ADMIN_GROUPS=true.
 */

export const SCIM_SIGN_IN_PROVIDER_KEY = "scim.signInProvider";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_PAGE = 200;

/** A SCIM error, answered with the SCIM error body. */
export class ScimError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = "ScimError";
  }

  body() {
    return {
      schemas: [ERROR_SCHEMA],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.message,
    };
  }
}

// ── Settings and tokens ─────────────────────────────────────────────────────

export interface ScimTokenView {
  id: string;
  name: string;
  /** The token's first characters, to tell tokens apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ScimSettingsView {
  /** On while a token exists. */
  enabled: boolean;
  /** The sign-in provider whose identities claim provisioned accounts (and whose group rules apply). */
  signInProvider: SignInProviderName | null;
  tokens: ScimTokenView[];
  /** The SCIM base URL to give the identity provider. */
  baseUrl: string;
  /** The burst hold on single deactivations (`guardUserDeactivation`). */
  deactivationHold: {
    /** When a deactivation was last held, until an admin releases it. */
    heldAt: string | null;
    /** Deactivations go through until then (an admin released the hold). */
    releasedUntil: string | null;
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function scimSignInProvider(): Promise<SignInProviderName | null> {
  const stored = await getDeploymentSetting<string>(SCIM_SIGN_IN_PROVIDER_KEY);
  if (stored === "") return null;
  if (typeof stored === "string" && isSignInProvider(stored)) return stored;
  const env = process.env.OPTIO_SCIM_SIGN_IN_PROVIDER?.trim();
  return env && isSignInProvider(env) ? env : null;
}

export async function listScimTokens(): Promise<ScimTokenView[]> {
  const rows = await db
    .select()
    .from(scimTokens)
    .where(isNull(scimTokens.revokedAt))
    .orderBy(asc(scimTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function scimSettings(apiOrigin: string): Promise<ScimSettingsView> {
  const tokens = await listScimTokens();
  return {
    enabled: tokens.length > 0,
    signInProvider: await scimSignInProvider(),
    tokens,
    baseUrl: `${apiOrigin}/api/scim/v2`,
    deactivationHold: await deactivationHoldView(),
  };
}

// ── The burst hold on single deactivations ─────────────────────────────────

export const SCIM_HOLD_HELD_AT_KEY = "scim.deactivationHeldAt";
export const SCIM_HOLD_RELEASED_UNTIL_KEY = "scim.deactivationHoldReleasedUntil";
/** How far back single deactivations count together, and how long a release lasts. */
export const SCIM_DEACTIVATION_WINDOW_MS = 15 * 60_000;

async function deactivationHoldView(): Promise<ScimSettingsView["deactivationHold"]> {
  const heldAt = await getDeploymentSetting<string>(SCIM_HOLD_HELD_AT_KEY);
  const releasedUntil = await getDeploymentSetting<string>(SCIM_HOLD_RELEASED_UNTIL_KEY);
  const live = typeof releasedUntil === "string" && Date.parse(releasedUntil) > Date.now();
  return {
    heldAt: typeof heldAt === "string" && heldAt ? heldAt : null,
    releasedUntil: live ? releasedUntil : null,
  };
}

type Reader = Pick<typeof db, "select">;

/**
 * The hold's numbers: `recent`, the accounts SCIM disabled in the last 15
 * minutes for any of its reasons (deprovisioned, out of every required group,
 * an email domain no longer allowed), and `enabled`, the provisioned accounts
 * enabled now. An account SCIM created already disabled
 * (`markDisabledFromCreation`) never was anyone's to lose, so it isn't counted.
 */
async function deactivationWindow(reader: Reader): Promise<{ recent: number; enabled: number }> {
  const since = new Date(Date.now() - SCIM_DEACTIVATION_WINDOW_MS);
  const [{ recent }] = (await reader
    .select({ recent: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        gte(users.disabledAt, since),
        inArray(users.disabledReason, [...SCIM_REASONS]),
        sql`${users.disabledAt} > ${users.createdAt}`,
      ),
    )) as [{ recent: number }];
  const [{ enabled }] = (await reader
    .select({ enabled: sql<number>`count(*)::int` })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(isNull(users.disabledAt))) as [{ enabled: number }];
  return { recent, enabled };
}

/** Off (100 %) or released by a deployment admin: deactivations go through. */
async function deactivationHoldOff(): Promise<boolean> {
  if (envDirectorySync().maxDisablePercent >= 100) return true;
  return !!(await deactivationHoldView()).releasedUntil;
}

async function holdDeactivations(
  details: Record<string, unknown>,
  message: string,
): Promise<never> {
  await setDeploymentSetting(SCIM_HOLD_HELD_AT_KEY, new Date().toISOString(), null);
  logger.warn(details, "SCIM: held deactivations, too many at once or in the last 15 minutes");
  throw new ScimError(409, message, "mutability");
}

/**
 * Identity providers deprovision one person per request, and SCIM disables
 * people three ways (`active: false` or DELETE, a PATCH that takes someone out
 * of the last required group, an email moved outside the allowed domains), so
 * unassigning the app from N people can arrive as N single requests. Count
 * them together: a deactivation that, with SCIM's deactivations of the last 15
 * minutes, would cross the directory sync's hold (`shouldHold` over the
 * provisioned accounts enabled at the window's start) is refused with 409,
 * which identity providers retry, and nothing changes. A deployment admin who
 * has checked the identity provider releases the hold for 15 minutes
 * (Settings, or `POST /api/admin/scim/hold/release`).
 */
async function guardUserDeactivation(userId: string): Promise<void> {
  const [row] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!row || row.disabledAt) return;
  if (await deactivationHoldOff()) return;
  const maxPercent = envDirectorySync().maxDisablePercent;
  const { recent, enabled } = await deactivationWindow(db);
  if (!shouldHold(enabled + recent, recent + 1, maxPercent)) return;
  await holdDeactivations(
    { userId, recent, enabled, maxPercent },
    `SCIM deactivation held: ${recent} provisioned accounts were deactivated in the last 15 minutes. A deployment admin must review the identity provider and release the hold before retrying.`,
  );
}

/**
 * Would this email disable the account (the domain rule of
 * `reconcileScimUser`)? Only a reason to check the hold first.
 */
async function emailWouldDisable(email: string): Promise<boolean> {
  const provider = (await scimSignInProvider()) ?? "scim";
  const config = isSignInProvider(provider) ? await resolveProviderConfig(provider) : null;
  return domainDecision({ email, emailVerified: true }, config?.allowedDomains ?? []) !== "allowed";
}

/**
 * A new account SCIM made and disabled in the same request (inactive, outside
 * every required group or the allowed domains from the start) is dated
 * disabled from its creation: it isn't a deactivation for the hold to count.
 */
async function markDisabledFromCreation(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ disabledAt: sql`${users.createdAt}` })
    .where(
      and(
        eq(users.id, userId),
        inArray(users.disabledReason, [...SCIM_REASONS]),
        sql`${users.disabledAt} IS NOT NULL`,
      ),
    );
}

/** A deployment admin lets SCIM deactivations through for the next 15 minutes. */
export async function releaseScimDeactivationHold(byUserId: string | null): Promise<void> {
  const until = new Date(Date.now() + SCIM_DEACTIVATION_WINDOW_MS).toISOString();
  await setDeploymentSetting(SCIM_HOLD_RELEASED_UNTIL_KEY, until, byUserId);
  await setDeploymentSetting(SCIM_HOLD_HELD_AT_KEY, null, byUserId);
  logger.info({ byUserId, until }, "SCIM: deactivation hold released");
}

export async function saveScimSignInProvider(
  provider: string | null,
  byUserId: string | null,
): Promise<void> {
  if (provider !== null && !isSignInProvider(provider)) {
    throw new ScimError(400, `Unknown sign-in provider: ${provider}`);
  }
  await setDeploymentSetting(SCIM_SIGN_IN_PROVIDER_KEY, provider ?? "", byUserId);
}

/** A new token: returned once, stored hashed. */
export async function createScimToken(
  name: string,
  byUserId: string | null,
): Promise<{ token: string; view: ScimTokenView }> {
  const token = `optio_scim_${randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(scimTokens)
    .values({
      name: name.trim() || "SCIM",
      tokenHash: hashToken(token),
      prefix: token.slice(0, 16),
      createdBy: byUserId,
    })
    .returning();
  return {
    token,
    view: {
      id: row!.id,
      name: row!.name,
      prefix: row!.prefix,
      createdAt: row!.createdAt.toISOString(),
      lastUsedAt: null,
    },
  };
}

export async function revokeScimToken(id: string): Promise<boolean> {
  const rows = await db
    .update(scimTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(scimTokens.id, id), isNull(scimTokens.revokedAt)))
    .returning({ id: scimTokens.id });
  return rows.length > 0;
}

/** Whether `token` is a live SCIM token; notes when it was last used (at most once a minute). */
export async function verifyScimToken(token: string | undefined): Promise<boolean> {
  if (!token?.startsWith("optio_scim_")) return false;
  const [row] = await db
    .select({ id: scimTokens.id, lastUsedAt: scimTokens.lastUsedAt })
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, hashToken(token)), isNull(scimTokens.revokedAt)))
    .limit(1);
  if (!row) return false;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .update(scimTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(scimTokens.id, row.id))
      .catch(() => {});
  }
  return true;
}

// ── Filters and paging ──────────────────────────────────────────────────────

/** `attr eq "value"` — the filter identity providers send to find a resource. */
export function parseEqFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter?.trim()) return null;
  const m = /^\s*([A-Za-z][\w.:]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) {
    throw new ScimError(
      400,
      `Only "attribute eq \\"value\\"" filters are supported`,
      "invalidFilter",
    );
  }
  return { attr: m[1]!.toLowerCase(), value: m[2]!.replace(/\\(.)/g, "$1") };
}

export function paging(startIndex: unknown, count: unknown): { offset: number; limit: number } {
  const requested = Number.parseInt(String(startIndex ?? "1"), 10);
  if (!Number.isNaN(requested) && (!Number.isSafeInteger(requested) || requested > 2_147_483_647))
    throw new ScimError(400, "startIndex is outside the supported range", "invalidValue");
  const start = Math.max(1, requested || 1);
  const parsed = Number.parseInt(String(count ?? MAX_PAGE), 10);
  const limit = Math.min(MAX_PAGE, Math.max(0, Number.isNaN(parsed) ? MAX_PAGE : parsed));
  return { offset: start - 1, limit };
}

function listResponse<T>(resources: T[], total: number, offset: number) {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex: offset + 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// ── Users ───────────────────────────────────────────────────────────────────

/** What a SCIM User body says, normalized. */
export interface ScimUserInput {
  userName: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The primary (else work, else first) email of a SCIM `emails` value. */
function primaryEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  const list = emails.filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
  const pick =
    list.find((e) => asBool(e.primary) === true) ?? list.find((e) => e.type === "work") ?? list[0];
  return str(pick?.value);
}

export function parseScimUser(body: Record<string, unknown>): ScimUserInput {
  const userName = str(body.userName);
  if (!userName) throw new ScimError(400, "userName is required", "invalidValue");
  const name = (body.name ?? {}) as Record<string, unknown>;
  return {
    userName,
    externalId: str(body.externalId),
    active: asBool(body.active) ?? true,
    displayName: str(body.displayName) ?? str(name.formatted),
    givenName: str(name.givenName),
    familyName: str(name.familyName),
    email: primaryEmail(body.emails) ?? (/^[^@\s]+@[^@\s]+$/.test(userName) ? userName : null),
  };
}

function displayNameOf(input: ScimUserInput): string {
  return (
    input.displayName ??
    ([input.givenName, input.familyName].filter(Boolean).join(" ") || input.userName)
  );
}

type UserJoin = {
  user: typeof users.$inferSelect;
  scim: typeof scimUsers.$inferSelect;
};

async function groupsOfUsers(
  userIds: string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: scimGroupMembers.userId, id: scimGroups.id, name: scimGroups.displayName })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(inArray(scimGroupMembers.userId, userIds));
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.userId, list);
  }
  return out;
}

function userResource(
  row: UserJoin,
  groups: Array<{ id: string; name: string }>,
  baseUrl: string,
): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: row.user.id,
    ...(row.scim.externalId ? { externalId: row.scim.externalId } : {}),
    userName: row.scim.userName,
    displayName: row.user.displayName,
    name: { formatted: row.user.displayName },
    emails: row.user.email ? [{ value: row.user.email, type: "work", primary: true }] : [],
    active: row.scim.active,
    groups: groups.map((g) => ({
      value: g.id,
      display: g.name,
      $ref: `${baseUrl}/Groups/${g.id}`,
    })),
    meta: {
      resourceType: "User",
      created: row.scim.createdAt.toISOString(),
      lastModified: row.scim.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${row.user.id}`,
    },
  };
}

async function loadUser(id: string): Promise<UserJoin> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, `User ${id} not found`);
  const [row] = await db
    .select({ user: users, scim: scimUsers })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(eq(scimUsers.userId, id));
  if (!row) throw new ScimError(404, `User ${id} not found`);
  return row;
}

export async function getScimUser(id: string, baseUrl: string) {
  const row = await loadUser(id);
  return userResource(row, (await groupsOfUsers([id])).get(id) ?? [], baseUrl);
}

export async function listScimUsers(
  query: { filter?: string; startIndex?: unknown; count?: unknown },
  baseUrl: string,
) {
  const f = parseEqFilter(query.filter);
  const { offset, limit } = paging(query.startIndex, query.count);
  let where: SQL | undefined;
  if (f) {
    if (f.attr === "username") where = sql`lower(${scimUsers.userName}) = ${f.value.toLowerCase()}`;
    else if (f.attr === "externalid") where = eq(scimUsers.externalId, f.value);
    else if (f.attr === "id")
      where = /^[0-9a-f-]{36}$/i.test(f.value) ? eq(scimUsers.userId, f.value) : sql`false`;
    else if (f.attr === "emails.value" || f.attr === "emails")
      where = sql`lower(${users.email}) = ${f.value.toLowerCase()}`;
    else throw new ScimError(400, `Filtering on ${f.attr} isn't supported`, "invalidFilter");
  }
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(where)) as [{ n: number }];
  const rows =
    limit === 0
      ? []
      : await db
          .select({ user: users, scim: scimUsers })
          .from(scimUsers)
          .innerJoin(users, eq(users.id, scimUsers.userId))
          .where(where)
          .orderBy(asc(scimUsers.createdAt), asc(scimUsers.userId))
          .offset(offset)
          .limit(limit);
  const groups = await groupsOfUsers(rows.map((r) => r.user.id));
  return listResponse(
    rows.map((r) => userResource(r, groups.get(r.user.id) ?? [], baseUrl)),
    n,
    offset,
  );
}

/**
 * The existing account a newly provisioned person is, and isn't provisioned
 * yet: one that signed in through the SCIM sign-in provider (its own
 * identity, or a linked one) with this email, which the account verified —
 * or this username, for the providers that assert one (OIDC, LDAP; a GitHub
 * or GitLab login is a public handle anyone can register) — or the account
 * SCIM itself made for this userName before a DELETE, if no sign-in claimed
 * it since. Never a deployment admin: SCIM refuses rather than rewrite their
 * email and name or later deactivate them.
 */
async function adoptableAccount(
  provider: SignInProviderName | null,
  input: ScimUserInput,
): Promise<string | null> {
  const keys = [input.email, input.userName]
    .filter((v): v is string => !!v)
    .map((v) => v.toLowerCase());
  const userName = input.userName.toLowerCase();
  const sameUsername = sql`lower(coalesce(${users.username}, '')) = ${userName}`;
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        or(
          provider
            ? and(
                or(
                  eq(users.provider, provider),
                  sql`${users.id} IN (SELECT "user_id" FROM "user_identities" WHERE "provider" = ${provider})`,
                ),
                or(
                  // Only an address the account verified: anyone can sign up
                  // with someone else's address where a provider doesn't check.
                  and(inArray(sql`lower(${users.email})`, keys), eq(users.emailVerified, true)),
                  // The username the sign-in provider asserted; on an account
                  // SCIM made, it is only the userName SCIM gave it (below).
                  provider === "oidc" || provider === "ldap"
                    ? and(sameUsername, ne(users.provider, "scim"))
                    : undefined,
                ),
              )
            : undefined,
          // Provisioned, deleted (the account stays), provisioned again; not
          // when a sign-in claimed it: that would hand the next person with
          // this userName the previous person's identities.
          and(
            eq(users.provider, "scim"),
            sameUsername,
            sql`NOT EXISTS (SELECT 1 FROM ${userIdentities} WHERE ${userIdentities.userId} = ${users.id})`,
          ),
        ),
        sql`${users.id} NOT IN (SELECT "user_id" FROM "scim_users")`,
      ),
    )
    .limit(2);
  if (rows.some(isAdminAccount)) {
    logger.warn({ userName: input.userName }, "SCIM: refused to adopt a deployment admin");
    throw new ScimError(409, "SCIM cannot adopt a deployment admin's account", "uniqueness");
  }
  return rows.length === 1 ? rows[0]!.id : null;
}

export async function createScimUser(body: Record<string, unknown>, baseUrl: string) {
  const input = parseScimUser(body);
  const [taken] = await db
    .select({ id: scimUsers.userId })
    .from(scimUsers)
    .where(sql`lower(${scimUsers.userName}) = ${input.userName.toLowerCase()}`);
  if (taken) throw new ScimError(409, `userName ${input.userName} is taken`, "uniqueness");

  const provider = await scimSignInProvider();
  let userId = await adoptableAccount(provider, input);
  const adopted = !!userId;
  if (!userId) {
    const [created] = await db
      .insert(users)
      .values({
        provider: "scim",
        externalId: `scim:${randomUUID()}`,
        email: input.email ?? "",
        displayName: displayNameOf(input),
        username: input.userName,
      })
      .returning({ id: users.id });
    userId = created!.id;
  } else {
    await db
      .update(users)
      .set({
        email: input.email ?? undefined,
        emailVerified:
          input.email === null
            ? undefined
            : sql`CASE WHEN lower(${users.email}) = lower(${input.email}) THEN ${users.emailVerified} ELSE false END`,
        displayName: displayNameOf(input),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }
  try {
    await db.insert(scimUsers).values({
      userId,
      userName: input.userName,
      externalId: input.externalId,
      active: input.active,
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      throw new ScimError(409, `userName ${input.userName} is taken`, "uniqueness");
    }
    throw err;
  }
  logger.info({ userId, adopted }, "SCIM: user provisioned");
  await reconcileScimUser(userId);
  if (!adopted) await markDisabledFromCreation(userId);
  return getScimUser(userId, baseUrl);
}

async function writeUser(userId: string, input: ScimUserInput): Promise<void> {
  await assertScimMayManage(userId);
  if (!input.active) {
    const [current] = await db
      .select({ active: scimUsers.active })
      .from(scimUsers)
      .where(eq(scimUsers.userId, userId));
    if (current?.active) await guardUserDeactivation(userId);
  } else if (await emailWouldDisable(input.email ?? "")) {
    // An email moved outside the allowed domains disables the account too.
    await guardUserDeactivation(userId);
  }
  const [clash] = await db
    .select({ id: scimUsers.userId })
    .from(scimUsers)
    .where(
      and(
        sql`lower(${scimUsers.userName}) = ${input.userName.toLowerCase()}`,
        ne(scimUsers.userId, userId),
      ),
    );
  if (clash) throw new ScimError(409, `userName ${input.userName} is taken`, "uniqueness");
  await db
    .update(scimUsers)
    .set({
      userName: input.userName,
      externalId: input.externalId,
      active: input.active,
      updatedAt: new Date(),
    })
    .where(eq(scimUsers.userId, userId));
  await db
    .update(users)
    .set({
      email: input.email ?? "",
      emailVerified: sql`CASE WHEN lower(${users.email}) = lower(${input.email ?? ""}) THEN ${users.emailVerified} ELSE false END`,
      displayName: displayNameOf(input),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export async function replaceScimUser(id: string, body: Record<string, unknown>, baseUrl: string) {
  await loadUser(id);
  await writeUser(id, parseScimUser(body));
  await reconcileScimUser(id);
  return getScimUser(id, baseUrl);
}

/** The SCIM User as a plain document, for PATCH to work on. */
function userDocument(row: UserJoin): Record<string, unknown> {
  return {
    userName: row.scim.userName,
    externalId: row.scim.externalId,
    active: row.scim.active,
    displayName: row.user.displayName,
    name: {},
    emails: row.user.email ? [{ value: row.user.email, type: "work", primary: true }] : [],
  };
}

interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

export function patchOperations(body: Record<string, unknown>): PatchOp[] {
  const ops = body.Operations;
  if (!Array.isArray(ops)) throw new ScimError(400, "Operations is required", "invalidSyntax");
  return ops.map((o) => {
    const op = String((o as PatchOp)?.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, `Unsupported op ${String((o as PatchOp)?.op)}`, "invalidSyntax");
    }
    return { op, path: (o as PatchOp).path, value: (o as PatchOp).value };
  });
}

/** Set `path` (`a`, `a.b`, `emails[type eq "work"].value`) in a User document. */
function applyUserPath(doc: Record<string, unknown>, op: string, path: string, value: unknown) {
  const emailsFilter = /^emails\[.*\]\.value$/i.test(path);
  if (emailsFilter || path.toLowerCase() === "emails") {
    if (op === "remove") doc.emails = [];
    else if (emailsFilter) doc.emails = [{ value, type: "work", primary: true }];
    else doc.emails = Array.isArray(value) ? value : [value];
    return;
  }
  const parts = path.split(".");
  if (parts.some((p) => ["__proto__", "constructor", "prototype"].includes(p.toLowerCase()))) {
    throw new ScimError(400, "Unsupported attribute path", "invalidPath");
  }
  // An extension schema's attributes (enterprise User…) aren't kept.
  if (parts[0]!.includes(":")) return;
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    const key = Object.keys(node).find((k) => k.toLowerCase() === part.toLowerCase()) ?? part;
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  const key = Object.keys(node).find((k) => k.toLowerCase() === last.toLowerCase()) ?? last;
  if (op === "remove") delete node[key];
  else node[key] = value;
}

export async function patchScimUser(id: string, body: Record<string, unknown>, baseUrl: string) {
  const row = await loadUser(id);
  const doc = userDocument(row);
  for (const { op, path, value } of patchOperations(body)) {
    if (path) {
      applyUserPath(doc, op, path, value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        applyUserPath(doc, op, k, v);
      }
    }
  }
  await writeUser(id, parseScimUser(doc));
  await reconcileScimUser(id);
  return getScimUser(id, baseUrl);
}

/** DELETE: the person is gone from the identity provider — the account is disabled, kept. */
export async function deleteScimUser(id: string): Promise<void> {
  await loadUser(id);
  await assertScimMayManage(id);
  await guardUserDeactivation(id);
  await db
    .update(scimUsers)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(scimUsers.userId, id));
  await reconcileScimUser(id);
  await db.delete(scimGroupMembers).where(eq(scimGroupMembers.userId, id));
  await db.delete(scimUsers).where(eq(scimUsers.userId, id));
}

// ── Groups ──────────────────────────────────────────────────────────────────

async function membersOf(groupIds: string[]) {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({
      groupId: scimGroupMembers.groupId,
      id: users.id,
      name: users.displayName,
    })
    .from(scimGroupMembers)
    .innerJoin(users, eq(users.id, scimGroupMembers.userId))
    .where(inArray(scimGroupMembers.groupId, groupIds));
  for (const r of rows) {
    const list = out.get(r.groupId) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.groupId, list);
  }
  return out;
}

function groupResource(
  group: typeof scimGroups.$inferSelect,
  members: Array<{ id: string; name: string }> | null,
  baseUrl: string,
): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.displayName,
    ...(members
      ? {
          members: members.map((m) => ({
            value: m.id,
            display: m.name,
            $ref: `${baseUrl}/Users/${m.id}`,
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

async function loadGroup(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, `Group ${id} not found`);
  const [group] = await db.select().from(scimGroups).where(eq(scimGroups.id, id));
  if (!group) throw new ScimError(404, `Group ${id} not found`);
  return group;
}

function wantsMembers(excludedAttributes?: string): boolean {
  return !(excludedAttributes ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .includes("members");
}

export async function getScimGroup(id: string, baseUrl: string, excludedAttributes?: string) {
  const group = await loadGroup(id);
  const members = wantsMembers(excludedAttributes) ? ((await membersOf([id])).get(id) ?? []) : null;
  return groupResource(group, members, baseUrl);
}

export async function listScimGroups(
  query: { filter?: string; startIndex?: unknown; count?: unknown; excludedAttributes?: string },
  baseUrl: string,
) {
  const f = parseEqFilter(query.filter);
  const { offset, limit } = paging(query.startIndex, query.count);
  let where: SQL | undefined;
  if (f) {
    if (f.attr === "displayname")
      where = sql`lower(${scimGroups.displayName}) = ${f.value.toLowerCase()}`;
    else if (f.attr === "externalid") where = eq(scimGroups.externalId, f.value);
    else if (f.attr === "id")
      where = /^[0-9a-f-]{36}$/i.test(f.value) ? eq(scimGroups.id, f.value) : sql`false`;
    else throw new ScimError(400, `Filtering on ${f.attr} isn't supported`, "invalidFilter");
  }
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scimGroups)
    .where(where)) as [{ n: number }];
  const rows =
    limit === 0
      ? []
      : await db
          .select()
          .from(scimGroups)
          .where(where)
          .orderBy(asc(scimGroups.createdAt), asc(scimGroups.id))
          .offset(offset)
          .limit(limit);
  const members = wantsMembers(query.excludedAttributes)
    ? await membersOf(rows.map((r) => r.id))
    : null;
  return listResponse(
    rows.map((g) => groupResource(g, members ? (members.get(g.id) ?? []) : null, baseUrl)),
    n,
    offset,
  );
}

/** The member ids of a SCIM `members` value that are provisioned people. */
async function provisionedIds(members: unknown): Promise<string[]> {
  const ids = (Array.isArray(members) ? members : members ? [members] : [])
    .map((m) => str((m as Record<string, unknown>)?.value))
    .filter((v): v is string => !!v && /^[0-9a-f-]{36}$/i.test(v));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: scimUsers.userId })
    .from(scimUsers)
    .where(inArray(scimUsers.userId, [...new Set(ids)]));
  return rows.map((r) => r.id);
}

async function currentMembers(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ id: scimGroupMembers.userId })
    .from(scimGroupMembers)
    .where(eq(scimGroupMembers.groupId, groupId));
  return rows.map((r) => r.id);
}

/**
 * Refuse a change to a required group that would deactivate more provisioned
 * accounts than the directory sync's hold allows (`shouldHold`: more than
 * max(3, OPTIO_DIRECTORY_SYNC_MAX_DISABLE_PERCENT of them)), counting SCIM's
 * deactivations of the last 15 minutes with it, so removing one member per
 * request is held like removing them together. Refused before any row
 * changes; a token can't force it through. A deployment admin checks the
 * identity provider, then releases the hold for 15 minutes as for single
 * deactivations.
 */
async function guardGroupDeactivation(
  group: typeof scimGroups.$inferSelect,
  nextName: string | null,
  wanted: string[],
): Promise<void> {
  const provider = await scimSignInProvider();
  const config = provider ? await resolveProviderConfig(provider) : null;
  const required = new Set(
    (config?.settings?.requiredGroups ?? []).map((name) => name.toLowerCase()),
  );
  if (!required.has(group.displayName.toLowerCase())) return;
  if (await deactivationHoldOff()) return;
  const before = await currentMembers(group.id);
  if (before.length === 0) return;
  const active = await db
    .select({ id: users.id })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(and(inArray(users.id, before), isNull(users.disabledAt), eq(scimUsers.active, true)));
  let leavers = 0;
  for (const user of active) {
    const memberships = await db
      .select({ id: scimGroups.id, name: scimGroups.displayName })
      .from(scimGroupMembers)
      .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
      .where(eq(scimGroupMembers.userId, user.id));
    const remaining = memberships
      .filter((entry) => entry.id !== group.id)
      .map((entry) => entry.name.toLowerCase());
    if (nextName && wanted.includes(user.id)) remaining.push(nextName.toLowerCase());
    if (!remaining.some((name) => required.has(name))) leavers++;
  }
  if (leavers === 0) return;
  const { recent, enabled } = await deactivationWindow(db);
  const maxPercent = envDirectorySync().maxDisablePercent;
  if (shouldHold(enabled + recent, leavers + recent, maxPercent)) {
    await holdDeactivations(
      { groupId: group.id, leavers, recent, enabled, maxPercent },
      `SCIM group change held: it would deactivate ${leavers} of ${enabled} enabled provisioned accounts, after ${recent} deactivated in the last 15 minutes. A deployment admin must review the identity provider and release the hold before retrying.`,
    );
  }
}

async function setMembers(groupId: string, wanted: string[]): Promise<string[]> {
  const before = await currentMembers(groupId);
  const add = wanted.filter((id) => !before.includes(id));
  const remove = before.filter((id) => !wanted.includes(id));
  if (add.length > 0) {
    await db
      .insert(scimGroupMembers)
      .values(add.map((userId) => ({ groupId, userId })))
      .onConflictDoNothing();
  }
  if (remove.length > 0) {
    await db
      .delete(scimGroupMembers)
      .where(and(eq(scimGroupMembers.groupId, groupId), inArray(scimGroupMembers.userId, remove)));
  }
  return [...add, ...remove];
}

async function reconcileAll(userIds: Iterable<string>): Promise<void> {
  for (const id of new Set(userIds)) {
    await reconcileScimUser(id).catch((err) =>
      logger.warn({ err, userId: id }, "SCIM: applying a person's groups failed"),
    );
  }
}

export async function createScimGroup(body: Record<string, unknown>, baseUrl: string) {
  const displayName = str(body.displayName);
  if (!displayName) throw new ScimError(400, "displayName is required", "invalidValue");
  const [group] = await db
    .insert(scimGroups)
    .values({ displayName, externalId: str(body.externalId) })
    .returning();
  const changed = await setMembers(group!.id, await provisionedIds(body.members));
  await reconcileAll(changed);
  return getScimGroup(group!.id, baseUrl);
}

export async function replaceScimGroup(id: string, body: Record<string, unknown>, baseUrl: string) {
  const group = await loadGroup(id);
  const displayName = str(body.displayName);
  if (!displayName) throw new ScimError(400, "displayName is required", "invalidValue");
  const wanted = await provisionedIds(body.members);
  await guardGroupDeactivation(group, displayName, wanted);
  await db
    .update(scimGroups)
    .set({ displayName, externalId: str(body.externalId), updatedAt: new Date() })
    .where(eq(scimGroups.id, id));
  const before = await currentMembers(id);
  const changed = await setMembers(id, wanted);
  // A renamed group changes every member's groups.
  await reconcileAll(displayName !== group.displayName ? [...before, ...changed] : changed);
  return getScimGroup(id, baseUrl);
}

export async function patchScimGroup(id: string, body: Record<string, unknown>, baseUrl: string) {
  const group = await loadGroup(id);
  let displayName = group.displayName;
  let externalId = group.externalId;
  let members = await currentMembers(id);
  const before = [...members];
  for (const { op, path, value } of patchOperations(body)) {
    const p = path?.trim() ?? "";
    const memberFilter = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(p);
    if (memberFilter && op === "remove") {
      members = members.filter((m) => m !== memberFilter[1]);
    } else if (p.toLowerCase() === "members") {
      const ids = await provisionedIds(value);
      if (op === "add") members = [...new Set([...members, ...ids])];
      else if (op === "replace") members = ids;
      else {
        // remove: the listed members, or all of them when none is listed.
        const listed = (Array.isArray(value) ? value : value ? [value] : [])
          .map((m) => str((m as Record<string, unknown>)?.value))
          .filter(Boolean);
        members = listed.length > 0 ? members.filter((m) => !listed.includes(m)) : [];
      }
    } else if (p.toLowerCase() === "displayname") {
      if (op !== "remove" && str(value)) displayName = str(value)!;
    } else if (p.toLowerCase() === "externalid") {
      externalId = op === "remove" ? null : str(value);
    } else if (!p && value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      if (str(v.displayName)) displayName = str(v.displayName)!;
      if ("externalId" in v) externalId = str(v.externalId);
      if ("members" in v) {
        const ids = await provisionedIds(v.members);
        members = op === "add" ? [...new Set([...members, ...ids])] : ids;
      }
    }
  }
  await guardGroupDeactivation(group, displayName, members);
  if (displayName !== group.displayName || externalId !== group.externalId) {
    await db
      .update(scimGroups)
      .set({ displayName, externalId, updatedAt: new Date() })
      .where(eq(scimGroups.id, id));
  }
  const changed = await setMembers(id, members);
  if (changed.length > 0 && displayName === group.displayName) {
    await db.update(scimGroups).set({ updatedAt: new Date() }).where(eq(scimGroups.id, id));
  }
  await reconcileAll(displayName !== group.displayName ? [...before, ...changed] : changed);
  return getScimGroup(id, baseUrl);
}

export async function deleteScimGroup(id: string): Promise<void> {
  const group = await loadGroup(id);
  await guardGroupDeactivation(group, null, []);
  const before = await currentMembers(id);
  await db.delete(scimGroups).where(eq(scimGroups.id, id));
  await reconcileAll(before);
}

// ── Applying a person's state ───────────────────────────────────────────────

type UserRow = typeof users.$inferSelect;

/** A deployment admin: flagged or granted in the app, or named by OPTIO_DEPLOYMENT_ADMINS. */
function isAdminAccount(user: UserRow): boolean {
  const sources = user.deploymentAdminSources;
  return (
    user.deploymentAdmin ||
    !!sources?.manual ||
    Object.values(sources?.groups ?? {}).some(Boolean) ||
    (user.emailVerified === true && envDeploymentAdmins().has(user.email.toLowerCase()))
  );
}

/**
 * A deployment admin whose role SCIM didn't give: by hand, by the
 * environment, through another provider's admin group, or from before
 * grants were tracked. SCIM can't change or deactivate them; one whose only
 * grant is SCIM's own admin group stays SCIM's to manage.
 */
function adminBeyondScim(user: UserRow): boolean {
  if (!isAdminAccount(user)) return false;
  if (user.emailVerified === true && envDeploymentAdmins().has(user.email.toLowerCase()))
    return true;
  const sources = user.deploymentAdminSources;
  if (!sources || sources.manual) return true;
  const grants = Object.entries(sources.groups ?? {}).filter(([, active]) => active);
  return grants.length === 0 || grants.some(([key]) => !key.startsWith("scim:"));
}

async function assertScimMayManage(userId: string): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (user && adminBeyondScim(user)) {
    logger.warn({ userId }, "SCIM: refused to change a deployment admin");
    throw new ScimError(403, "SCIM cannot change or deactivate this deployment admin");
  }
}

/** The display names of the SCIM groups a person is in. */
export async function scimGroupsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: scimGroups.displayName })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(eq(scimGroupMembers.userId, userId));
  return [...new Set(rows.map((r) => r.name))];
}

/**
 * Bring a provisioned person's account in line with what SCIM says:
 * deprovisioned → disabled through the leaver path (never the last enabled
 * deployment admin); active → enabled again if SCIM had disabled them, and
 * their groups applied.
 */
export async function reconcileScimUser(userId: string): Promise<void> {
  const [row] = await db
    .select({ user: users, scim: scimUsers })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(eq(scimUsers.userId, userId));
  if (!row) return;
  const provider = (await scimSignInProvider()) ?? "scim";
  const account = {
    id: row.user.id,
    email: row.user.email,
    emailVerified: row.user.emailVerified === true,
  };

  const groups = await scimGroupsOf(userId);
  const config = isSignInProvider(provider) ? await resolveProviderConfig(provider) : null;
  // The domain rule here can only disable: a pushed address outside the
  // allowed domains is a leaver. It is checked as the directory's word and
  // proves nothing about who owns the address — `emailVerified` stays what a
  // sign-in provider made it (a changed address is unverified), and every
  // sign-in still passes the provider's own check with a verified email.
  const groupDecision = accessDecision(
    { email: "", groups },
    { allowedDomains: [], settings: config?.settings },
  );
  const decision =
    groupDecision !== "allowed"
      ? groupDecision
      : domainDecision(
          { email: row.user.email, emailVerified: true },
          config?.allowedDomains ?? [],
        );
  const reason = !row.scim.active
    ? "deprovisioned"
    : decision === "group_not_allowed"
      ? "scim_not_in_required_group"
      : decision !== "allowed"
        ? "scim_domain_not_allowed"
        : null;
  if (reason) {
    if (row.user.disabledAt) return;
    if (adminBeyondScim(row.user)) {
      logger.warn({ userId, reason }, "SCIM: refused to deactivate a deployment admin");
      throw new ScimError(403, "SCIM cannot change or deactivate this deployment admin");
    }
    const admins = await listDeploymentAdmins({ enabledOnly: true });
    if (admins.some((a) => a.id === userId) && admins.length <= 1) {
      logger.warn(
        { userId },
        "SCIM: kept the last deployment admin enabled — make someone else one first",
      );
      return;
    }
    let disabled;
    try {
      // Checked again under a lock: two concurrent requests can't both pass.
      disabled = await disableUser(userId, { reason, protectLastAdmin: true });
    } catch (err) {
      if (!(err instanceof LastDeploymentAdminError)) throw err;
      logger.warn(
        { userId },
        "SCIM: kept the last deployment admin enabled — make someone else one first",
      );
      return;
    }
    if (!disabled) return;
    await stripDirectoryAccess(account, provider, "scim");
    logger.info({ userId }, "SCIM: account disabled (deprovisioned)");
    return;
  }

  if (row.user.disabledAt) {
    const enabled = await enableUser(userId, { onlyReasons: SCIM_REASONS });
    if (!enabled) return; // disabled by an admin's hand or the LDAP sync: theirs to undo
  }
  await applyDirectoryGroups(account, provider, groups, "scim");
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/**
 * The provisioned account a sign-in through `provider` claims (for
 * `createSession`'s `claimAccount`): only through the SCIM sign-in
 * provider, only an account no identity of that provider holds yet, matched
 * by the email the provider vouches for or by the username.
 */
export async function scimAccountFor(
  provider: string,
  profile: {
    externalId: string;
    email: string;
    emailVerified?: boolean;
    emailVerifiedByProvider?: boolean;
    username?: string;
  },
): Promise<string | null> {
  if (provider !== (await scimSignInProvider())) return null;
  const asserted = profile.emailVerifiedByProvider ?? profile.emailVerified;
  const email = asserted && profile.email ? profile.email.toLowerCase() : null;
  const username =
    provider === "oidc" || provider === "ldap" ? (profile.username?.toLowerCase() ?? null) : null;
  if (!email && !username) return null;
  const rows = await db
    .select({ id: users.id })
    .from(scimUsers)
    .innerJoin(users, eq(users.id, scimUsers.userId))
    .where(
      and(
        or(
          email ? sql`lower(${users.email}) = ${email}` : undefined,
          email ? sql`lower(${scimUsers.userName}) = ${email}` : undefined,
          username ? sql`lower(${scimUsers.userName}) = ${username}` : undefined,
        ),
        // Not already someone's identity through this provider.
        ne(users.provider, provider),
        sql`${users.id} NOT IN (SELECT "user_id" FROM "user_identities" WHERE "provider" = ${provider})`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * The groups SCIM gave the account a sign-in lands in (its identity, else
 * the account it claims), to merge with the groups the sign-in brings.
 */
export async function scimGroupsForSignIn(
  provider: string,
  externalId: string,
  claimAccount: string | null,
): Promise<string[]> {
  const { findAccountByIdentity } = await import("./session-service.js");
  const account = (await findAccountByIdentity(provider, externalId))?.id ?? claimAccount;
  if (!account) return [];
  const [provisioned] = await db
    .select({ id: scimUsers.userId })
    .from(scimUsers)
    .where(eq(scimUsers.userId, account));
  return provisioned ? scimGroupsOf(account) : [];
}
