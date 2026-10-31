import { groupAuthority, replaceProviderGroups } from "./identity-groups.js";
import type { SignInAccessSettings } from "@optio/shared";
import { envConfig } from "./sign-in-env.js";
import type { SignInProviderTestResult } from "@optio/shared";
import type {
  AnySignInSettings,
  GiteaSettings,
  LdapSignInSettings,
  OidcSettings,
  SamlSettings,
} from "@optio/shared";
import { ldapSettingsSchema, samlSettingsSchema, settingsSchemaFor } from "../schemas/sign-in.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaceMembers, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";
import { decrypt, encrypt } from "./secret-service.js";
import { getRedisClient } from "./event-bus.js";
import { getCallbackUrl, publicApiOrigin } from "./oauth/provider.js";
import { ensureUserHasWorkspace, normalizeAutoJoinDomains } from "./workspace-service.js";

/**
 * How everyone signs in, configured in the app — see
 * docs/plans/org-scoping-and-sso.md ("Sign-in").
 *
 * - A provider's config (today: Google) can be stored in `auth_provider_configs`
 *   from Settings → Sign-in; a stored, enabled row takes precedence over the
 *   provider's env vars. Its client secret is encrypted on the row.
 * - `allowedDomains` says who may sign in with it: a Google Workspace domain
 *   (`hd`) and the verified email's domain must be listed; empty = anyone.
 * - **Deployment admins** (`users.deployment_admin`, or an email in
 *   `OPTIO_DEPLOYMENT_ADMINS`) are the people who may change this.
 * - **Bootstrap mode**: auth is on but no provider is configured anywhere, so
 *   nobody can sign in. A one-time **setup token** (`OPTIO_SETUP_TOKEN`, else
 *   generated at boot, shared through Redis and printed in the API log) lets
 *   the deployer save the first provider from the setup wizard. The first
 *   person to then sign in completes the bootstrap: they become the deployment
 *   admin and their workspace becomes the organization's (named, with the
 *   allowed domains auto-joining). The token also lets a signed-in person claim
 *   the role on a deployment that has none yet (an upgrade), never afterwards.
 */

const isAuthDisabled = () => process.env.OPTIO_AUTH_DISABLED === "true";

/** The providers whose config can be stored in the app. */
export const CONFIGURABLE_PROVIDERS = [
  "google",
  "oidc",
  "saml",
  "gitea",
  "bitbucket",
  "ldap",
] as const;
export type ConfigurableProvider = (typeof CONFIGURABLE_PROVIDERS)[number];

export const SIGN_IN_PROVIDERS = [
  "google",
  "github",
  "gitlab",
  "oidc",
  "saml",
  "gitea",
  "bitbucket",
  "ldap",
] as const;
export type SignInProviderName = (typeof SIGN_IN_PROVIDERS)[number];

export class SignInConfigError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "SignInConfigError";
  }
}

type ConfigRow = typeof authProviderConfigs.$inferSelect;

/** A provider's live settings, wherever they come from. */
export interface ResolvedProviderConfig {
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  source: "database" | "environment";
  displayName?: string;
  settings?: AnySignInSettings;
}

/** What the Sign-in page shows for one provider (never the secret). */
export interface SignInProviderView {
  provider: SignInProviderName;
  displayName: string;
  /** Can be edited in the app (today: google). */
  configurable: boolean;
  enabled: boolean;
  source: "database" | "environment" | "none";
  clientId: string | null;
  hasClientSecret: boolean;
  allowedDomains: string[];
  /** The redirect URI to register with the provider. */
  callbackUrl: string | null;
  metadataUrl?: string | null;
  settings?: AnySignInSettings;
  updatedAt: string | null;
}

const DISPLAY: Record<SignInProviderName, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  oidc: process.env.OIDC_DISPLAY_NAME || "SSO",
  ldap: process.env.LDAP_DISPLAY_NAME || "LDAP / Active Directory",
  saml: process.env.SAML_DISPLAY_NAME || "SSO (SAML 2.0)",
  gitea: process.env.GITEA_DISPLAY_NAME || "Gitea / Forgejo",
  bitbucket: "Bitbucket",
};

function hasSettings(
  provider: string,
): provider is "oidc" | "saml" | "gitea" | "bitbucket" | "ldap" {
  return (
    provider === "oidc" ||
    provider === "saml" ||
    provider === "gitea" ||
    provider === "bitbucket" ||
    provider === "ldap"
  );
}

function secretAAD(provider: string): Buffer {
  return Buffer.from(`auth_provider|${provider}`);
}

function openSecret(row: ConfigRow): string | null {
  if (!row.encryptedClientSecret || !row.clientSecretIv || !row.clientSecretAuthTag) return null;
  return decrypt(
    {
      alg: 1,
      iv: row.clientSecretIv,
      ciphertext: row.encryptedClientSecret,
      authTag: row.clientSecretAuthTag,
    },
    secretAAD(row.provider),
    `sign-in ${row.provider} client secret`,
  );
}

export async function getStoredConfig(provider: string): Promise<ConfigRow | null> {
  const [row] = await db
    .select()
    .from(authProviderConfigs)
    .where(eq(authProviderConfigs.provider, provider));
  return row ?? null;
}

/**
 * A provider's live config: the stored, enabled row first, else its env
 * vars, else null (not configured). Read on each sign-in — logins are rare
 * and this keeps every replica current without a cache to invalidate.
 */
export async function resolveProviderConfig(
  provider: SignInProviderName,
): Promise<ResolvedProviderConfig | null> {
  const stored = await getStoredConfig(provider).catch(() => null);
  if (stored?.enabled) {
    return {
      clientId: stored.clientId,
      clientSecret: openSecret(stored) ?? "",
      allowedDomains: stored.allowedDomains ?? [],
      source: "database",
      settings: stored.settings ?? undefined,
    };
  }
  const env = envConfig(provider);
  return env ? { ...env, allowedDomains: [], source: "environment" } : null;
}

/** Every provider as the Sign-in page lists it, stored or from the environment. */
export async function listSignInProviders(): Promise<SignInProviderView[]> {
  const out: SignInProviderView[] = [];
  for (const provider of SIGN_IN_PROVIDERS) {
    const stored = await getStoredConfig(provider);
    const env = envConfig(provider);
    const fromDb = !!stored?.enabled;
    out.push({
      provider,
      displayName: stored?.displayName || env?.displayName || DISPLAY[provider],
      configurable: (CONFIGURABLE_PROVIDERS as readonly string[]).includes(provider),
      enabled: fromDb || !!env,
      source: fromDb ? "database" : env ? "environment" : stored ? "database" : "none",
      clientId:
        provider === "saml" || provider === "ldap"
          ? null
          : fromDb || (stored && !env)
            ? stored!.clientId
            : (env?.clientId ?? null),
      hasClientSecret:
        fromDb || (stored && !env) ? !!stored!.encryptedClientSecret : !!env?.clientSecret,
      allowedDomains: stored?.allowedDomains ?? [],
      callbackUrl: provider === "ldap" ? null : getCallbackUrl(provider),
      metadataUrl: provider === "saml" ? publicApiOrigin() + "/api/auth/saml/metadata" : null,
      settings: hasSettings(provider)
        ? ((fromDb || (stored && !env) ? stored?.settings : env?.settings) ?? undefined)
        : undefined,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    });
  }
  return out;
}

export interface SaveSignInConfigInput {
  settings?: AnySignInSettings;
  clientId?: string;
  /** Replaces the stored secret; absent keeps it; required on first save. */
  clientSecret?: string | null;
  allowedDomains?: string[];
  enabled?: boolean;
  displayName?: string | null;
}

/**
 * Whether two LDAP settings reach the same server the same way: the URL and
 * every transport option (STARTTLS, certificate verification, the trusted
 * CA). A stored bind password is only ever sent over the transport it was
 * saved with.
 */
function sameLdapTransport(
  a: AnySignInSettings | null | undefined,
  b: AnySignInSettings | null | undefined,
): boolean {
  const x = ldapSettingsSchema.safeParse(a).data;
  const y = ldapSettingsSchema.safeParse(b).data;
  if (!x || !y) return false;
  return (
    x.url === y.url &&
    !!x.startTls === !!y.startTls &&
    !!x.insecureSkipVerify === !!y.insecureSkipVerify &&
    (x.caPem?.trim() ?? "") === (y.caPem?.trim() ?? "")
  );
}

/** Store (or update) a provider's config. Validates the domains like workspace auto-join. */
export async function saveSignInConfig(
  provider: string,
  input: SaveSignInConfigInput,
  actorUserId: string | null,
): Promise<SignInProviderView> {
  if (!(CONFIGURABLE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new SignInConfigError(`${provider} can only be configured by environment variables`, 400);
  }
  const clientId = provider === "saml" ? "" : (input.clientId ?? "").trim();
  if (!clientId && provider !== "saml" && provider !== "ldap")
    throw new SignInConfigError("A client ID is required");
  let domains: string[] = [];
  if (input.allowedDomains !== undefined) {
    const normalized = normalizeAutoJoinDomains(input.allowedDomains);
    if ("error" in normalized) throw new SignInConfigError(normalized.error);
    domains = normalized.domains;
  }
  const existing = await getStoredConfig(provider);
  const secret = provider === "saml" ? undefined : input.clientSecret?.trim();
  if (!existing && !secret && provider !== "saml" && provider !== "ldap")
    throw new SignInConfigError("A client secret is required");

  const sealed = secret
    ? (() => {
        const blob = encrypt(secret, secretAAD(provider));
        return {
          encryptedClientSecret: blob.ciphertext,
          clientSecretIv: blob.iv,
          clientSecretAuthTag: blob.authTag,
        };
      })()
    : {};
  let settings: AnySignInSettings | null = null;
  if (hasSettings(provider)) {
    const candidate =
      input.settings ?? existing?.settings ?? (provider === "bitbucket" ? {} : undefined);
    if (!candidate) throw new SignInConfigError("Settings are required");
    const parsed = settingsSchemaFor(provider).safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SignInConfigError(
        (issue?.path.join(".") || "settings") + ": " + (issue?.message ?? "invalid"),
      );
    }
    settings = parsed.data;
  }
  let clearSecret = false;
  if (provider === "ldap" && !secret) {
    const bindDn = (settings as LdapSignInSettings)?.bindDn?.trim();
    // The stored bind password belongs to the server it was saved with: a
    // save that points the directory elsewhere (another URL, or the same one
    // with weaker transport) must bring the password again, or the next
    // sign-in would send the stored one to the new server.
    const keepsServer =
      !!existing?.encryptedClientSecret &&
      sameLdapTransport(existing.settings, settings as LdapSignInSettings);
    if (bindDn && !keepsServer) {
      throw new SignInConfigError(
        existing?.encryptedClientSecret
          ? "Enter the bind password again: the saved one is only sent to the server it was saved for"
          : "The bind password is required",
      );
    }
    // An anonymous bind needs no password; drop one left for another server.
    clearSecret = !keepsServer && !!existing?.encryptedClientSecret;
  }
  if (provider === "saml") {
    // The identity provider must be reachable now: its metadata, or the
    // single sign-on URL and certificate typed in.
    const { resolveSamlIdp } = await import("./oauth/saml.js");
    try {
      await resolveSamlIdp(settings as SamlSettings, { fresh: true });
    } catch (err) {
      throw new SignInConfigError(err instanceof Error ? err.message : String(err));
    }
  }

  const values = {
    clientId,
    settings,
    allowedDomains: input.allowedDomains !== undefined ? domains : (existing?.allowedDomains ?? []),
    enabled: input.enabled ?? existing?.enabled ?? true,
    displayName:
      input.displayName === undefined ? (existing?.displayName ?? null) : input.displayName,
    updatedBy: actorUserId,
    updatedAt: new Date(),
    ...(clearSecret
      ? { encryptedClientSecret: null, clientSecretIv: null, clientSecretAuthTag: null }
      : sealed),
  };
  if (existing) {
    await db
      .update(authProviderConfigs)
      .set(values)
      .where(eq(authProviderConfigs.provider, provider));
  } else {
    await db.insert(authProviderConfigs).values({ provider, ...values });
  }
  const { resetOAuthProviders } = await import("./oauth/index.js");
  resetOAuthProviders();
  logger.info({ provider, actorUserId, domains: values.allowedDomains }, "Sign-in provider saved");
  return (await listSignInProviders()).find((p) => p.provider === provider)!;
}

export async function deleteSignInConfig(provider: string): Promise<void> {
  await db.delete(authProviderConfigs).where(eq(authProviderConfigs.provider, provider));
  const { resetOAuthProviders } = await import("./oauth/index.js");
  resetOAuthProviders();
}

// ── Who may sign in ─────────────────────────────────────────────────────────

/**
 * Whether a sign-in may proceed under `allowedDomains`. An empty list allows
 * anyone the provider vouches for. Otherwise the account's Google Workspace
 * domain (`hd`), when the provider sends one, must be listed, and so must the
 * email's domain — and the email must be verified (a consumer Google account
 * never has `hd`, so it is refused by its email alone).
 */
export function domainDecision(
  profile: { email: string; emailVerified?: boolean; hostedDomain?: string | null },
  allowedDomains: string[],
): "allowed" | "unverified_email" | "domain_not_allowed" {
  if (allowedDomains.length === 0) return "allowed";
  const allowed = new Set(allowedDomains.map((d) => d.toLowerCase()));
  if (profile.hostedDomain && !allowed.has(profile.hostedDomain.toLowerCase())) {
    return "domain_not_allowed";
  }
  if (!profile.emailVerified) return "unverified_email";
  const domain = profile.email.split("@")[1]?.trim().toLowerCase();
  return domain && allowed.has(domain) ? "allowed" : "domain_not_allowed";
}

export type AccessDecision =
  "allowed" | "unverified_email" | "domain_not_allowed" | "group_not_allowed";

export function accessDecision(
  profile: {
    email: string;
    emailVerified?: boolean;
    hostedDomain?: string | null;
    groups?: string[];
  },
  config: { allowedDomains: string[]; settings?: SignInAccessSettings | null },
): AccessDecision {
  const required = config.settings?.requiredGroups ?? [];
  if (required.length > 0) {
    const mine = new Set((profile.groups ?? []).map((g) => g.toLowerCase()));
    if (!required.some((g) => mine.has(g.toLowerCase()))) return "group_not_allowed";
  }
  return domainDecision(profile, config.allowedDomains);
}

// ── Deployment admins ───────────────────────────────────────────────────────

/** Emails granted the role by the environment (`OPTIO_DEPLOYMENT_ADMINS`, comma-separated). */
export function envDeploymentAdmins(): Set<string> {
  return new Set(
    (process.env.OPTIO_DEPLOYMENT_ADMINS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function hasDeploymentAdmin(): Promise<boolean> {
  if (envDeploymentAdmins().size > 0) return true;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.deploymentAdmin, true));
  return (row?.n ?? 0) > 0;
}

export async function isDeploymentAdmin(user: {
  id: string;
  email?: string | null;
}): Promise<boolean> {
  if (isAuthDisabled()) return true;
  const [row] = await db
    .select({
      deploymentAdmin: users.deploymentAdmin,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, user.id));
  return (
    !!row &&
    (row.deploymentAdmin ||
      (row.emailVerified && envDeploymentAdmins().has(row.email.toLowerCase())))
  );
}

/**
 * Whether `userId` is an admin of the deployment's first workspace — the
 * stand-in for a deployment admin until someone holds that role. Only the
 * founding workspace counts: anyone signed in can create a workspace and be
 * its admin, so "an admin somewhere" proves nothing about the deployment.
 */
export async function isFoundingWorkspaceAdmin(userId: string): Promise<boolean> {
  const [first] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (!first) return false;
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, first.id), eq(workspaceMembers.userId, userId)));
  return member?.role === "admin";
}

export interface DeploymentAdmin {
  id: string;
  email: string;
  displayName: string;
  /** Granted by `OPTIO_DEPLOYMENT_ADMINS` rather than in the app (can't be removed here). */
  fromEnvironment: boolean;
}

export async function listDeploymentAdmins(): Promise<DeploymentAdmin[]> {
  const env = envDeploymentAdmins();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      flag: users.deploymentAdmin,
    })
    .from(users)
    .where(
      env.size > 0
        ? sql`${users.deploymentAdmin} = true OR (${users.emailVerified} = true AND lower(${users.email}) IN (${sql.join(
            [...env].map((e) => sql`${e}`),
            sql`, `,
          )}))`
        : eq(users.deploymentAdmin, true),
    )
    .orderBy(users.displayName);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    fromEnvironment: env.has(r.email.toLowerCase()),
  }));
}

/** Grant the role to an existing user by email (they must have signed in once). */
export async function addDeploymentAdminByEmail(email: string): Promise<DeploymentAdmin> {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.emailVerified, true),
        sql`lower(${users.email}) = ${email.trim().toLowerCase()}`,
      ),
    );
  if (!user) {
    throw new SignInConfigError(
      `No one with the verified email ${email} has signed in yet — they need to sign in once first`,
      404,
    );
  }
  await db
    .update(users)
    .set({ deploymentAdmin: true, deploymentAdminSources: { manual: true, groups: {} } })
    .where(eq(users.id, user.id));
  await grantOrganizationAdmin(user.id);
  return { id: user.id, email: user.email, displayName: user.displayName, fromEnvironment: false };
}

export async function removeDeploymentAdmin(
  userId: string,
  actorUserId: string | null,
): Promise<void> {
  const admins = await listDeploymentAdmins();
  const target = admins.find((a) => a.id === userId);
  if (!target) throw new SignInConfigError("Not a deployment admin", 404);
  if (target.fromEnvironment) {
    throw new SignInConfigError("Granted by OPTIO_DEPLOYMENT_ADMINS — remove it there", 400);
  }
  if (admins.length === 1) {
    throw new SignInConfigError(
      userId === actorUserId
        ? "You can't remove yourself as the last deployment admin"
        : "The last deployment admin can't be removed",
      400,
    );
  }
  await db
    .update(users)
    .set({ deploymentAdmin: false, deploymentAdminSources: { manual: false, groups: {} } })
    .where(eq(users.id, userId));
}

// ── Bootstrap: the setup token and the first sign-in ────────────────────────

const SETUP_TOKEN_KEY = "optio:setup_token";
const BOOTSTRAP_CLAIM_KEY = "optio:sign_in_bootstrap_claim";
const BOOTSTRAP_CLAIM_TTL_SECS = 24 * 60 * 60;

let announced = false;

/**
 * The one-time setup token: `OPTIO_SETUP_TOKEN` when set; otherwise one is
 * generated at first use and shared through Redis so every replica agrees,
 * and printed to the API log so the deployer can read it with `kubectl logs`.
 */
export async function setupToken(): Promise<string> {
  const fromEnv = process.env.OPTIO_SETUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const redis = getRedisClient();
  const fresh = randomBytes(24).toString("hex");
  await redis.set(SETUP_TOKEN_KEY, fresh, "NX");
  const token = (await redis.get(SETUP_TOKEN_KEY)) ?? fresh;
  if (!announced) {
    announced = true;
    logger.info(
      { setupToken: token },
      "Sign-in setup token — paste it in the setup wizard's Sign-in step (or set OPTIO_SETUP_TOKEN)",
    );
  }
  return token;
}

/** Whether `candidate` is the setup token (constant-time). */
export async function verifySetupToken(candidate: string | undefined | null): Promise<boolean> {
  if (!candidate) return false;
  const expected = await setupToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Auth is on and no provider is configured anywhere: nobody can sign in, so
 * the setup wizard's Sign-in step is reachable without a session (with the
 * setup token).
 */
export async function isBootstrapMode(): Promise<boolean> {
  if (isAuthDisabled()) return false;
  for (const provider of SIGN_IN_PROVIDERS) {
    if (await resolveProviderConfig(provider)) return false;
  }
  return true;
}

/**
 * Whether the setup token still opens anything: while nobody can sign in
 * (bootstrap), or while the deployment has no deployment admin yet (so an
 * upgraded deployment can claim the role once). Never afterwards.
 */
export async function setupTokenUsable(): Promise<boolean> {
  if (await isBootstrapMode()) return true;
  return !(await hasDeploymentAdmin());
}

export interface BootstrapClaim {
  /** The organization's name: the first signer-in's workspace is renamed to it. */
  organizationName: string | null;
  /** Its domains: they auto-join that workspace as members. */
  domains: string[];
  provider: string;
}

/** Remember what the wizard asked for, for the first sign-in to complete. */
export async function recordBootstrapClaim(claim: BootstrapClaim): Promise<void> {
  await getRedisClient().set(
    BOOTSTRAP_CLAIM_KEY,
    JSON.stringify(claim),
    "EX",
    BOOTSTRAP_CLAIM_TTL_SECS,
  );
}

export async function pendingBootstrapClaim(): Promise<BootstrapClaim | null> {
  const raw = await getRedisClient().get(BOOTSTRAP_CLAIM_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BootstrapClaim;
  } catch {
    return null;
  }
}

/**
 * The step after every OAuth sign-in: grant the deployment-admin role where
 * the environment says so, and — when a bootstrap claim is pending and the
 * deployment has no deployment admin yet — make this first person the
 * deployment admin and their workspace the organization's. Returns what it did.
 */
async function completeSignInBootstrap(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  provider: string;
}): Promise<{ deploymentAdmin: boolean; bootstrapped: boolean }> {
  let deploymentAdmin = false;
  if (user.emailVerified && envDeploymentAdmins().has(user.email.toLowerCase())) {
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, user.id));
    deploymentAdmin = true;
  }
  const claim = await pendingBootstrapClaim();
  if (!claim) return { deploymentAdmin, bootstrapped: false };
  if (
    user.provider !== claim.provider ||
    !user.emailVerified ||
    domainDecision(user, claim.domains) !== "allowed"
  )
    return { deploymentAdmin, bootstrapped: false };
  if (await hasDeploymentAdmin()) {
    // Someone already is; the claim is spent.
    await getRedisClient().del(BOOTSTRAP_CLAIM_KEY);
    return { deploymentAdmin, bootstrapped: false };
  }
  // Exactly one concurrent first login may claim deployment administration.
  const claimed = await getRedisClient().eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    1,
    BOOTSTRAP_CLAIM_KEY,
    JSON.stringify(claim),
  );
  if (claimed !== 1) return { deploymentAdmin, bootstrapped: false };
  await db
    .update(users)
    .set({ deploymentAdmin: true, deploymentAdminSources: { manual: true, groups: {} } })
    .where(eq(users.id, user.id));
  const wsId = await ensureUserHasWorkspace(user.id);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (claim.organizationName) {
    updates.name = claim.organizationName;
    updates.slug = await freeSlug(slugOf(claim.organizationName, wsId), wsId);
    updates.description = null;
  }
  if (claim.domains.length > 0) {
    updates.autoJoinDomains = claim.domains;
    updates.autoJoinRole = "member";
  }
  await db.update(workspaces).set(updates).where(eq(workspaces.id, wsId));
  await getRedisClient().del(BOOTSTRAP_CLAIM_KEY);
  logger.info(
    {
      userId: user.id,
      workspaceId: wsId,
      organization: claim.organizationName,
      domains: claim.domains,
    },
    "Sign-in bootstrap complete: first deployment admin and organization workspace",
  );
  return { deploymentAdmin: true, bootstrapped: true };
}

export async function organizationWorkspaceId(): Promise<string | null> {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organization, true))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A new organization workspace, for `autoJoinOrganization` when none is
 * marked (a deployment whose sign-in came from the environment never ran the
 * setup wizard's bootstrap). Never an existing workspace: only the setup
 * wizard's bootstrap claim makes one of those the organization's. Named
 * OPTIO_ORGANIZATION_NAME ("Organization"). Its first member runs it when
 * they may (`mayAdminister`: a deployment admin or in an admin group);
 * otherwise they join as a member, and the deployment admins run it (as
 * every deployment admin does, see grantOrganizationAdmin) along with the
 * admin groups' members as they sign in.
 *
 * Creation is serialized across replicas; existing workspaces are never adopted.
 */
export async function createOrganizationWorkspace(
  userId: string,
  mayAdminister: boolean,
): Promise<string> {
  // Serialize opt-in creation across API replicas. A pre-existing slug must
  // never turn another person's workspace into the shared workspace.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(129731, 2)`);
    const existing = await organizationWorkspaceId();
    if (existing) return existing;
    const name = process.env.OPTIO_ORGANIZATION_NAME?.trim() || "Organization";
    const base = slugOf(name, "organization") || "organization";
    const { createWorkspace } = await import("./workspace-service.js");
    const slug = await freeSlug(base, randomBytes(16).toString("hex"));
    const ws = await createWorkspace({ name, slug }, userId);
    if (!mayAdminister) {
      await db
        .update(workspaceMembers)
        .set({ role: "member" })
        .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)));
    }
    await markOrganizationWorkspace(ws.id);
    // Never a shared workspace nobody can administer: the deployment admins run it.
    for (const admin of await listDeploymentAdmins()) {
      if (admin.id !== userId) await grantOrganizationAdmin(admin.id, ws.id);
    }
    return ws.id;
  });
}

/**
 * Deployment admins administer the organization workspace: make `userId` an
 * admin of it (joining it when they aren't a member). Nothing without one.
 */
export async function grantOrganizationAdmin(
  userId: string,
  workspaceId?: string | null,
): Promise<void> {
  const wsId = workspaceId ?? (await organizationWorkspaceId());
  if (!wsId) return;
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: wsId, userId, role: "admin" })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: "admin" },
    });
}

/** Make `workspaceId` the organization's (and no other). */
export async function markOrganizationWorkspace(workspaceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ organization: false })
      .where(eq(workspaces.organization, true));
    await tx
      .update(workspaces)
      .set({ organization: true, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
  });
}

const lower = (list: string[] | undefined) => new Set((list ?? []).map((g) => g.toLowerCase()));
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));

export async function completeSignIn(
  user: { id: string; email: string; emailVerified: boolean; provider: string },
  identity: { provider?: string; groups?: string[] } = {},
  opts: { directorySync?: boolean; join?: boolean; groupProvider?: string } = {},
): Promise<{ deploymentAdmin: boolean; bootstrapped: boolean; organizationWorkspaceId?: string }> {
  const [row] = await db
    .select({
      deploymentAdmin: users.deploymentAdmin,
      sources: users.deploymentAdminSources,
      ssoGroups: users.ssoGroups,
    })
    .from(users)
    .where(eq(users.id, user.id));
  const provider = identity.provider ?? user.provider;
  const config = (SIGN_IN_PROVIDERS as readonly string[]).includes(provider)
    ? await resolveProviderConfig(provider as SignInProviderName).catch(() => null)
    : null;
  const access: SignInAccessSettings = config?.settings ?? {};
  // Joining the organization workspace is opt-in for every provider
  // (Settings → Sign-in, or `<PROVIDER>_AUTO_JOIN_ORGANIZATION`).
  const autoJoinOrganization = access.autoJoinOrganization === true;
  // An absent claim (moved to userinfo, an oversized token, a provider that
  // couldn't read them) says nothing about the person's groups: only a
  // claim that is present, even an empty one, changes what groups grant.
  const groupsAsserted = identity.groups !== undefined;
  const assertedGroups = identity.groups ?? [];
  const groups = assertedGroups.filter((group) => group.length <= 1024).slice(0, 300);
  if (groups.length !== assertedGroups.length)
    logger.warn(
      { userId: user.id, assertedCount: assertedGroups.length, retainedCount: groups.length },
      "Identity-provider groups exceeded the storage bound",
    );
  const adminGroups = lower(access.adminGroups);
  const groupProvider = opts.groupProvider ?? provider;
  const source = groupAuthority(groupProvider, config?.settings);
  const rememberedGroups = groupsAsserted
    ? replaceProviderGroups(row?.ssoGroups ?? [], groupProvider, config?.settings, groups)
    : (row?.ssoGroups ?? []);
  const membershipGroups = rememberedGroups.filter((group) => group.length <= 1200).slice(0, 300);
  if (membershipGroups.length !== rememberedGroups.length)
    logger.warn(
      {
        userId: user.id,
        assertedCount: rememberedGroups.length,
        retainedCount: membershipGroups.length,
      },
      "Remembered SSO groups exceeded the storage bound",
    );
  const previousSources = row?.sources ?? {
    manual: row?.deploymentAdmin ?? false,
    groups: {} as Record<string, boolean>,
  };
  const wasGroupAdmin = Object.entries(previousSources.groups).some(
    ([key, active]) => key.startsWith(`${groupProvider}:`) && active,
  );
  // Without a claim, the group-granted admin role stands as it was.
  const isGroupAdmin = groupsAsserted
    ? adminGroups.size > 0 && intersects(lower(groups), adminGroups)
    : previousSources.groups[source] === true;
  const sources = { manual: previousSources.manual, groups: { ...previousSources.groups } };
  // Updating one linked identity must not erase another provider's grant. A
  // changed issuer also cannot keep the old issuer's authority alive.
  if (groupsAsserted) {
    for (const key of Object.keys(sources.groups)) {
      if (key.startsWith(`${groupProvider}:`)) sources.groups[key] = false;
    }
    if (adminGroups.size > 0 || wasGroupAdmin) sources.groups[source] = isGroupAdmin;
  }
  const anyGroupAdmin = Object.values(sources.groups).some(Boolean);
  const envAdmin = user.emailVerified && envDeploymentAdmins().has(user.email.toLowerCase());

  let deploymentAdmin = row?.deploymentAdmin ?? false;
  if (envAdmin || sources.manual || anyGroupAdmin) deploymentAdmin = true;
  else if (deploymentAdmin) {
    // The group granted it and no longer does.
    // a disabled admin isn't one left (offboarding.ts).
    const others = (await listDeploymentAdmins()).filter((a) => a.id !== user.id);
    if (others.length > 0) deploymentAdmin = false;
    else
      logger.warn(
        { userId: user.id, provider: groupProvider },
        "Group-admin grant revoked but the last deployment admin is retained; appoint another admin to complete revocation",
      );
  }
  await db
    .update(users)
    .set({
      deploymentAdmin,
      deploymentAdminSources: sources,
      ssoGroups: membershipGroups,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  const bootstrap = opts.directorySync
    ? { deploymentAdmin, bootstrapped: false }
    : await completeSignInBootstrap(user);
  const bootstrapped = bootstrap.bootstrapped;
  deploymentAdmin = deploymentAdmin || bootstrap.deploymentAdmin;
  if (bootstrapped) {
    await db
      .update(users)
      .set({ deploymentAdminSources: { manual: true, groups: {} } })
      .where(eq(users.id, user.id));
    const wsId = await ensureUserHasWorkspace(user.id);
    await markOrganizationWorkspace(wsId);
  }
  // With autoJoinOrganization, everyone who signs in joins the organization
  // workspace; admin-group members run it. A role someone was given by hand
  // is never lowered.
  let orgWsId: string | null = null;
  if (autoJoinOrganization) {
    orgWsId = await organizationWorkspaceId();
    // Sign-in set up from the deployment's environment never ran the setup
    // wizard's bootstrap, so nothing is the organization's yet: a new
    // workspace becomes it (never someone's existing one).
    if (!orgWsId && !opts.directorySync)
      orgWsId = await createOrganizationWorkspace(user.id, isGroupAdmin || deploymentAdmin);
    if (orgWsId) {
      // Admin-group members and deployment admins run it.
      const runsIt = isGroupAdmin || deploymentAdmin;
      const role = runsIt ? "admin" : (access.defaultRole ?? "member");
      const [existing] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, orgWsId), eq(workspaceMembers.userId, user.id)),
        );
      if (!existing) {
        if (opts.join !== false)
          await db
            .insert(workspaceMembers)
            .values({ workspaceId: orgWsId, userId: user.id, role })
            .onConflictDoNothing();
      } else if (runsIt && existing.role !== "admin") {
        await db
          .update(workspaceMembers)
          .set({ role: "admin" })
          .where(
            and(eq(workspaceMembers.workspaceId, orgWsId), eq(workspaceMembers.userId, user.id)),
          );
      } else if (
        !runsIt &&
        wasGroupAdmin &&
        !anyGroupAdmin &&
        !sources.manual &&
        existing.role === "admin"
      ) {
        await db
          .update(workspaceMembers)
          .set({ role: access.defaultRole ?? "member" })
          .where(
            and(eq(workspaceMembers.workspaceId, orgWsId), eq(workspaceMembers.userId, user.id)),
          );
      }
      // A first-time user lands in the organization, not in a workspace of their own.
      await db
        .update(users)
        .set({ defaultWorkspaceId: orgWsId })
        .where(and(eq(users.id, user.id), sql`${users.defaultWorkspaceId} IS NULL`));
    }
  }

  // The workspaces the person's groups open (workspaces.access_groups), and
  // the group-mapped teams in each (services/workspace-groups.ts).
  if (groupsAsserted) {
    const { leaveWorkspacesByGroups } = await import("./workspace-groups.js");
    await leaveWorkspacesByGroups(user.id, membershipGroups);
  }
  if (membershipGroups.length > 0) {
    const { joinWorkspacesByGroups } = await import("./workspace-groups.js");
    await joinWorkspacesByGroups(user.id, membershipGroups).catch((err) =>
      logger.warn({ err, userId: user.id }, "joining workspaces by group failed"),
    );
  }
  // The group-mapped teams of every workspace the person is in, while teams
  // are on (team-service.ts). Only a claim that is present changes them.
  if (groupsAsserted) {
    const { syncTeamsAfterSignIn } = await import("./team-service.js");
    await syncTeamsAfterSignIn(user.id, membershipGroups).catch((err) =>
      logger.warn({ err, userId: user.id }, "team sync from groups failed"),
    );
  }

  return orgWsId
    ? { deploymentAdmin, bootstrapped, organizationWorkspaceId: orgWsId }
    : { deploymentAdmin, bootstrapped };
}

/** `base`, or `base-<id8>` when another workspace already has that slug. */
async function freeSlug(base: string, wsId: string): Promise<string> {
  const [taken] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, base));
  return !taken || taken.id === wsId ? base : `${base}-${wsId.slice(0, 8)}`;
}

function slugOf(name: string, fallbackId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `org-${fallbackId.slice(0, 8)}`;
}

export async function testSignInProvider(
  provider: string,
  input: { settings?: AnySignInSettings; clientSecret?: string; sampleUsername?: string },
): Promise<SignInProviderTestResult> {
  if (provider === "ldap") {
    const stored = await getStoredConfig(provider);
    const parsed = ldapSettingsSchema.safeParse(
      input.settings ?? stored?.settings ?? envConfig("ldap")?.settings,
    );
    if (!parsed.success) return { ok: false, error: "Valid LDAP settings are required" };
    const ldap = parsed.data as LdapSignInSettings;
    const environment = envConfig("ldap");
    // A test may inspect a new server, but must never send another server's
    // saved password to it. The request must supply credentials for a new URL.
    // The URL and every transport option must match: the request may not
    // turn off STARTTLS or verification, or swap the CA, for a saved password.
    const bindPassword =
      input.clientSecret?.trim() ||
      (stored && sameLdapTransport(stored.settings, ldap) ? openSecret(stored) : null) ||
      (sameLdapTransport(environment?.settings, ldap) ? environment?.clientSecret : null) ||
      "";
    if (ldap.bindDn && !bindPassword)
      return {
        ok: false,
        error: "Supply the bind password when testing a different LDAP server or transport",
      };

    const { ldapTest } = await import("./auth/ldap.js");
    const result = await ldapTest(
      {
        url: ldap.url,
        startTls: ldap.startTls,
        caPem: ldap.caPem,
        insecureSkipVerify: ldap.insecureSkipVerify,
        bindDn: ldap.bindDn,
        bindPassword,
        userBaseDn: ldap.userBaseDn,
        userFilter: ldap.userFilter,
        usernameAttribute: ldap.usernameAttribute,
        emailAttribute: ldap.emailAttribute,
        displayNameAttribute: ldap.displayNameAttribute,
        groupMode: ldap.groupMode,
        groupBaseDn: ldap.groupBaseDn,
        groupFilter: ldap.groupFilter,
      },
      input.sampleUsername,
    );
    return {
      ok: result.ok,
      error: result.error,
      ldap: result.ok
        ? { boundAs: result.boundAs, serverInfo: result.serverInfo, sample: result.sample ?? null }
        : undefined,
    };
  }
  if (provider === "saml") {
    const stored = await getStoredConfig(provider);
    const parsed = samlSettingsSchema.safeParse(
      input.settings ?? stored?.settings ?? envConfig("saml")?.settings,
    );
    if (!parsed.success)
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid SAML settings" };
    const { describeSamlIdp } = await import("./oauth/saml.js");
    try {
      return { ok: true, saml: await describeSamlIdp(parsed.data) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (provider !== "oidc" && provider !== "gitea")
    throw new SignInConfigError("This provider has no connection test", 400);
  const stored = await getStoredConfig(provider);
  const parsed = settingsSchemaFor(provider).safeParse(
    input.settings ?? stored?.settings ?? envConfig(provider)?.settings,
  );
  if (!parsed.success)
    return { ok: false, error: "Valid OIDC settings and issuer URL are required" };
  const oidc =
    provider === "gitea"
      ? (await import("./oauth/gitea.js")).giteaOidcSettings(parsed.data as GiteaSettings)
      : (parsed.data as OidcSettings);
  const { discoverOidc, effectiveOidcSettings, describeFetchError } =
    await import("./oauth/oidc.js");
  try {
    const doc = await discoverOidc(oidc);
    const effective = effectiveOidcSettings(oidc);
    const claims = doc.claims_supported ?? null;
    return {
      ok: true,
      oidc: {
        issuer: doc.issuer ?? effective.issuerUrl,
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        userinfoEndpoint: doc.userinfo_endpoint ?? null,
        jwksUri: doc.jwks_uri,
        scopesSupported: doc.scopes_supported ?? [],
        claimsSupported: claims ?? [],
        groupsClaimAdvertised: claims
          ? claims.includes(effective.groupsClaim.split(".")[0]!)
          : null,
        pkceSupported: doc.code_challenge_methods_supported
          ? doc.code_challenge_methods_supported.includes("S256")
          : null,
      },
    };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  }
}

export { envConfig };
