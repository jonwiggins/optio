import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  SIGN_IN_PROVIDER_LABEL,
  type AnySignInSettings,
  type GiteaSettings,
  type LdapSignInSettings,
  type OidcSettings,
  type SamlSettings,
  type SignInAccessSettings,
  type SignInProviderName,
  type SignInProviderTestResult,
  type SignInProviderView,
} from "@optio/shared";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaceMembers, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";
import { decrypt, encrypt } from "./secret-service.js";
import { getRedisClient } from "./event-bus.js";
import { getCallbackUrl, publicApiOrigin } from "./oauth/provider.js";
import { ensureUserHasWorkspace, normalizeAutoJoinDomains } from "./workspace-service.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { envConfig } from "./sign-in-env.js";

export type { SignInProviderName };

// Kept here rather than read from @optio/shared at load (the same lists as
// packages/shared/src/types/sign-in.ts): this module loads with every route
// that checks auth, including in tests that mock the shared package.
export const SIGN_IN_PROVIDERS = [
  "google",
  "github",
  "gitlab",
  "oidc",
  "ldap",
  "bitbucket",
  "gitea",
  "saml",
] as const satisfies readonly SignInProviderName[];

/**
 * How everyone signs in, configured in the app — see docs/sign-in.md.
 *
 * - The account providers (**bitbucket**, **gitea**, **github**, **gitlab**,
 *   **google**) and the organization's own identity: **ldap** (a username +
 *   password form against LDAP / Active Directory), **oidc** (its OpenID
 *   Connect SSO) and **saml** (its SAML 2.0 SSO). All but GitHub and GitLab
 *   can be stored in `auth_provider_configs` from Settings → Sign-in or the
 *   setup wizard; a stored, enabled row takes precedence over the provider's
 *   env vars. GitHub and GitLab come from the environment. The secret
 *   (client secret, bind password) is encrypted on the row. Each is off
 *   until it is configured.
 * - `allowedDomains` says whose email may sign in (empty = anyone the
 *   provider vouches for); `requiredGroups` does the same by group, for
 *   every provider that reports groups.
 * - `adminGroups` make their members **deployment admins** and admins of the
 *   organization workspace; with `autoJoinOrganization` (off unless set),
 *   everyone else who signs in joins it as `defaultRole`. Groups come from
 *   the sign-in (an OIDC claim, a SAML attribute, LDAP) or from SCIM
 *   provisioning (services/scim.ts).
 * - **Deployment admins** (`users.deployment_admin`, or an email in
 *   `OPTIO_DEPLOYMENT_ADMINS`) are the people who may change this.
 * - **Bootstrap mode**: auth is on but no provider is configured anywhere, so
 *   nobody can sign in. A one-time **setup token** (`OPTIO_SETUP_TOKEN`, else
 *   generated at boot, shared through Redis and printed in the API log) lets
 *   the deployer save the first provider from the setup wizard. The first
 *   person to then sign in completes the bootstrap: they become the deployment
 *   admin and their workspace becomes the organization's. The token also lets
 *   a signed-in person claim the role on a deployment that has none yet (an
 *   upgrade), never afterwards.
 */

const isAuthDisabled = () => process.env.OPTIO_AUTH_DISABLED === "true";

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

/** The providers whose config can be stored in the app. */
export const CONFIGURABLE_PROVIDERS = [
  "google",
  "oidc",
  "ldap",
  "bitbucket",
  "gitea",
  "saml",
] as const satisfies readonly SignInProviderName[];
export type ConfigurableProvider = (typeof CONFIGURABLE_PROVIDERS)[number];

/** A provider's live settings, wherever they come from. */
export interface ResolvedProviderConfig {
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  source: "database" | "environment";
  /** Everything that isn't a client id or secret (Google, GitHub and GitLab have none). */
  settings?: AnySignInSettings;
  /** The name on the login page (providers with settings). */
  displayName?: string;
}

export function isSignInProvider(name: string): name is SignInProviderName {
  return (SIGN_IN_PROVIDERS as readonly string[]).includes(name);
}

type ProviderWithSettings = "oidc" | "ldap" | "saml" | "gitea" | "bitbucket";

/** The providers with settings beyond a client id and secret. */
function hasSettings(provider: string): provider is ProviderWithSettings {
  return (
    provider === "oidc" ||
    provider === "ldap" ||
    provider === "saml" ||
    provider === "gitea" ||
    provider === "bitbucket"
  );
}

/** No OAuth client: LDAP binds, SAML trusts the identity provider's certificate. */
function hasNoClient(provider: string): boolean {
  return provider === "ldap" || provider === "saml";
}

function isConfigurable(provider: string): provider is ConfigurableProvider {
  return (CONFIGURABLE_PROVIDERS as readonly string[]).includes(provider);
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
    `sign-in ${row.provider} secret`,
  );
}

export { envConfig };

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
    const resolved: ResolvedProviderConfig = {
      clientId: stored.clientId,
      clientSecret: openSecret(stored) ?? "",
      allowedDomains: stored.allowedDomains ?? [],
      source: "database",
    };
    if (hasSettings(provider)) {
      resolved.settings = stored.settings as unknown as AnySignInSettings;
      resolved.displayName = stored.displayName || SIGN_IN_PROVIDER_LABEL[provider];
    }
    return resolved;
  }
  const env = envConfig(provider);
  return env ? { ...env, allowedDomains: [], source: "environment" } : null;
}

/** The public view of stored settings (never a secret; the CA is public). */
function viewSettings(
  settings: Record<string, unknown> | AnySignInSettings | null | undefined,
): AnySignInSettings | null {
  if (!settings || Object.keys(settings).length === 0) return null;
  return settings as AnySignInSettings;
}

/** Every provider as the Sign-in page lists it, stored or from the environment. */
export async function listSignInProviders(): Promise<SignInProviderView[]> {
  const out: SignInProviderView[] = [];
  for (const provider of SIGN_IN_PROVIDERS) {
    const stored = await getStoredConfig(provider);
    const env = envConfig(provider);
    const fromDb = !!stored?.enabled;
    const showStored = fromDb || (stored && !env);
    out.push({
      provider,
      displayName:
        (showStored ? stored!.displayName : env?.displayName) ||
        stored?.displayName ||
        SIGN_IN_PROVIDER_LABEL[provider],
      configurable: isConfigurable(provider),
      enabled: fromDb || !!env,
      source: fromDb ? "database" : env ? "environment" : stored ? "database" : "none",
      clientId: hasNoClient(provider)
        ? null
        : showStored
          ? stored!.clientId
          : (env?.clientId ?? null),
      hasClientSecret: showStored ? !!stored!.encryptedClientSecret : !!env?.clientSecret,
      allowedDomains: stored?.allowedDomains ?? [],
      settings: !hasSettings(provider)
        ? null
        : showStored
          ? viewSettings(stored!.settings)
          : (env?.settings ?? null),
      callbackUrl: provider === "ldap" ? null : getCallbackUrl(provider),
      ...(provider === "saml"
        ? { metadataUrl: `${publicApiOrigin()}/api/auth/saml/metadata` }
        : {}),
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    });
  }
  return out;
}

export interface SaveSignInConfigInput {
  clientId?: string;
  /** Replaces the stored secret; absent keeps it. */
  clientSecret?: string | null;
  allowedDomains?: string[];
  enabled?: boolean;
  displayName?: string | null;
  settings?: AnySignInSettings;
}

async function validateSettings(
  provider: ProviderWithSettings,
  settings: unknown,
): Promise<AnySignInSettings> {
  const { settingsSchemaFor } = await import("../schemas/sign-in.js");
  const parsed = settingsSchemaFor(provider).safeParse(settings);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SignInConfigError(
      `${issue?.path.join(".") || "settings"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Store (or update) a provider's config. Validates the domains like workspace auto-join. */
export async function saveSignInConfig(
  provider: string,
  input: SaveSignInConfigInput,
  actorUserId: string | null,
): Promise<SignInProviderView> {
  if (!isSignInProvider(provider)) {
    throw new SignInConfigError(`Unknown sign-in provider: ${provider}`, 404);
  }
  if (!isConfigurable(provider)) {
    throw new SignInConfigError(`${provider} can only be configured by environment variables`, 400);
  }
  const existing = await getStoredConfig(provider);
  let settings: AnySignInSettings | null = null;
  if (hasSettings(provider)) {
    settings =
      input.settings !== undefined
        ? await validateSettings(provider, input.settings)
        : existing
          ? (existing.settings as unknown as AnySignInSettings)
          : provider === "bitbucket"
            ? {}
            : null;
    if (!settings) throw new SignInConfigError("Settings are required on the first save");
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

  const clientId = hasNoClient(provider) ? "" : (input.clientId ?? existing?.clientId ?? "").trim();
  if (!hasNoClient(provider) && !clientId) throw new SignInConfigError("A client ID is required");

  let domains: string[] = [];
  if (input.allowedDomains !== undefined) {
    const normalized = normalizeAutoJoinDomains(input.allowedDomains);
    if ("error" in normalized) throw new SignInConfigError(normalized.error);
    domains = normalized.domains;
  }
  const secret = provider === "saml" ? undefined : input.clientSecret?.trim();
  const needsSecret =
    provider === "ldap"
      ? !!(settings as LdapSignInSettings | null)?.bindDn?.trim()
      : provider !== "saml";
  if (!existing?.encryptedClientSecret && !secret && needsSecret) {
    throw new SignInConfigError(
      provider === "ldap" ? "The bind password is required" : "A client secret is required",
    );
  }

  const sealed = secret
    ? (() => {
        const blob = encrypt(secret, secretAAD(provider));
        return {
          encryptedClientSecret: blob.ciphertext,
          clientSecretIv: blob.iv,
          clientSecretAuthTag: blob.authTag,
        };
      })()
    : input.clientSecret === null
      ? { encryptedClientSecret: null, clientSecretIv: null, clientSecretAuthTag: null }
      : {};
  const values = {
    clientId,
    allowedDomains: input.allowedDomains !== undefined ? domains : (existing?.allowedDomains ?? []),
    settings: (settings ?? {}) as unknown as Record<string, unknown>,
    enabled: input.enabled ?? existing?.enabled ?? true,
    displayName:
      input.displayName === undefined ? (existing?.displayName ?? null) : input.displayName,
    updatedBy: actorUserId,
    updatedAt: new Date(),
    ...sealed,
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

// ── Test connection ─────────────────────────────────────────────────────────

export interface TestSignInInput {
  clientId?: string;
  clientSecret?: string | null;
  settings?: AnySignInSettings;
  sampleUsername?: string;
}

/**
 * Settings → Sign-in "Test": try the settings as typed (unsaved), falling
 * back to the stored secret when none was typed. Never stores anything.
 */
export async function testSignInProvider(
  provider: string,
  input: TestSignInInput,
): Promise<SignInProviderTestResult> {
  if (!isSignInProvider(provider)) {
    throw new SignInConfigError(`Unknown sign-in provider: ${provider}`, 404);
  }
  if (!hasSettings(provider) || provider === "bitbucket") {
    throw new SignInConfigError(`${provider} sign-in has no connection test`, 400);
  }
  const stored = await getStoredConfig(provider);
  let settings: AnySignInSettings;
  try {
    settings = await validateSettings(
      provider,
      input.settings ?? stored?.settings ?? envConfig(provider)?.settings ?? {},
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const secret =
    input.clientSecret?.trim() ||
    (stored ? openSecret(stored) : null) ||
    envConfig(provider)?.clientSecret ||
    "";

  if (provider === "saml") {
    const { describeSamlIdp } = await import("./oauth/saml.js");
    try {
      return { ok: true, saml: await describeSamlIdp(settings as SamlSettings) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (provider === "oidc" || provider === "gitea") {
    const oidc =
      provider === "gitea"
        ? (await import("./oauth/gitea.js")).giteaOidcSettings(settings as GiteaSettings)
        : (settings as OidcSettings);
    const { discoverOidc, effectiveOidcSettings } = await import("./oauth/oidc.js");
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const ldap = settings as LdapSignInSettings;
  const { ldapTest } = await import("./auth/ldap.js");
  const result = await ldapTest(
    {
      url: ldap.url,
      startTls: ldap.startTls,
      caPem: ldap.caPem,
      insecureSkipVerify: ldap.insecureSkipVerify,
      bindDn: ldap.bindDn,
      bindPassword: secret,
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

// ── Who may sign in ─────────────────────────────────────────────────────────

export type AccessDecision =
  | "allowed"
  | "unverified_email"
  | "domain_not_allowed"
  | "group_not_allowed";

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

/**
 * Whether a sign-in may proceed: `requiredGroups` (OIDC, LDAP; empty: any)
 * needs one of the person's groups listed, then the allowed domains decide
 * (`domainDecision`).
 */
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
  if (user.email && envDeploymentAdmins().has(user.email.toLowerCase())) return true;
  const [row] = await db
    .select({ deploymentAdmin: users.deploymentAdmin })
    .from(users)
    .where(eq(users.id, user.id));
  return row?.deploymentAdmin ?? false;
}

export interface DeploymentAdmin {
  id: string;
  email: string;
  displayName: string;
  /** Granted by `OPTIO_DEPLOYMENT_ADMINS` rather than in the app (can't be removed here). */
  fromEnvironment: boolean;
}

export async function listDeploymentAdmins(
  // `enabledOnly` leaves out disabled accounts (users.disabled_at,
  // services/offboarding.ts) — for the "never the last deployment admin"
  // checks, where a disabled admin can't run anything.
  opts: { enabledOnly?: boolean } = {},
): Promise<DeploymentAdmin[]> {
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
      and(
        env.size > 0
          ? sql`(${users.deploymentAdmin} = true OR lower(${users.email}) IN (${sql.join(
              [...env].map((e) => sql`${e}`),
              sql`, `,
            )}))`
          : eq(users.deploymentAdmin, true),
        opts.enabledOnly ? isNull(users.disabledAt) : undefined,
      ),
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
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
  if (!user) {
    throw new SignInConfigError(
      `No one with the email ${email} has signed in yet — they need to sign in once first`,
      404,
    );
  }
  await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, user.id));
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
  // only an enabled admin counts as one left (offboarding.ts).
  const enabledOthers = (await listDeploymentAdmins({ enabledOnly: true })).filter(
    (a) => a.id !== userId,
  );
  if (enabledOthers.length === 0) {
    throw new SignInConfigError(
      userId === actorUserId
        ? "You can't remove yourself as the last deployment admin"
        : "The last deployment admin can't be removed",
      400,
    );
  }
  await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, userId));
}

// ── The organization workspace ──────────────────────────────────────────────

/** The one workspace everyone joins (marked by the bootstrap sign-in), if any. */
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
 * setup wizard's bootstrap). Never an existing workspace: only the bootstrap
 * claim or a deployment admin (`PUT /api/workspaces/:id/organization`) makes
 * one of those the organization's. Named OPTIO_ORGANIZATION_NAME
 * ("Organization"); its first member runs it when they may (`mayAdminister`:
 * a deployment admin, in an admin group, or no admin groups are set),
 * otherwise they are a member and the admin groups' members run it as they
 * sign in.
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
    const base = slugBase(name) || "organization";
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
    return ws.id;
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

export interface SignInCompletion {
  deploymentAdmin: boolean;
  bootstrapped: boolean;
  /** The organization workspace joined (or already a member of), when the provider adds people to it. */
  organizationWorkspaceId?: string;
}

const lower = (list: string[] | undefined) => new Set((list ?? []).map((g) => g.toLowerCase()));
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));

/**
 * The step after every sign-in: grant the deployment-admin role where the
 * environment or the provider's admin groups say so (and take it back from
 * someone the groups granted it to and no longer do — never from the last
 * admin, never from an env admin); remember the person's groups; join the
 * organization workspace; and — when a bootstrap claim is pending and the
 * deployment has no deployment admin yet — make this first person the
 * deployment admin and their workspace the organization's. Returns what it did.
 */
export async function completeSignIn(
  user: { id: string; email: string },
  identity: { provider?: string; groups?: string[] } = {},
  // the directory sync re-applies a person's groups through this same
  // step (services/directory-sync.ts) — but nobody signed in, so it never
  // completes the bootstrap or makes a workspace the organization's; and for
  // a leaver (`join: false`) it only takes back, never joins them anywhere.
  opts: { directorySync?: boolean; join?: boolean } = {},
): Promise<SignInCompletion> {
  const [row] = await db
    .select({ deploymentAdmin: users.deploymentAdmin, previousGroups: users.ssoGroups })
    .from(users)
    .where(eq(users.id, user.id));
  const provider = identity.provider ?? "";
  const config = isSignInProvider(provider)
    ? await resolveProviderConfig(provider).catch(() => null)
    : null;
  const access: SignInAccessSettings = config?.settings ?? {};
  // Joining the organization workspace is opt-in for every provider
  // (Settings → Sign-in, or `<PROVIDER>_AUTO_JOIN_ORGANIZATION`).
  const autoJoinOrganization = access.autoJoinOrganization === true;
  const groups = identity.groups ?? [];
  const adminGroups = lower(access.adminGroups);
  const isGroupAdmin = adminGroups.size > 0 && intersects(lower(groups), adminGroups);
  const wasGroupAdmin = adminGroups.size > 0 && intersects(lower(row?.previousGroups), adminGroups);
  const envAdmin = envDeploymentAdmins().has(user.email.toLowerCase());

  let deploymentAdmin = row?.deploymentAdmin ?? false;
  if (envAdmin || isGroupAdmin) deploymentAdmin = true;
  else if (wasGroupAdmin && deploymentAdmin) {
    // The group granted it and no longer does.
    // a disabled admin isn't one left (offboarding.ts).
    const others = (await listDeploymentAdmins({ enabledOnly: true })).filter(
      (a) => a.id !== user.id,
    );
    if (others.length > 0) deploymentAdmin = false;
  }
  await db
    .update(users)
    .set({ deploymentAdmin, ssoGroups: groups, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  let bootstrapped = false;
  const claim = opts.directorySync ? null : await pendingBootstrapClaim();
  if (claim) {
    if (await hasDeploymentAdmin()) {
      // Someone already is; the claim is spent.
      await getRedisClient().del(BOOTSTRAP_CLAIM_KEY);
    } else {
      await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, user.id));
      deploymentAdmin = true;
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
      await markOrganizationWorkspace(wsId);
      await db
        .update(workspaceMembers)
        .set({ role: "admin" })
        .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, user.id)));
      await getRedisClient().del(BOOTSTRAP_CLAIM_KEY);
      bootstrapped = true;
      logger.info(
        {
          userId: user.id,
          workspaceId: wsId,
          organization: claim.organizationName,
          domains: claim.domains,
        },
        "Sign-in bootstrap complete: first deployment admin and organization workspace",
      );
    }
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
      orgWsId = await createOrganizationWorkspace(
        user.id,
        isGroupAdmin || deploymentAdmin || adminGroups.size === 0,
      );
    if (orgWsId) {
      const role = isGroupAdmin ? "admin" : (access.defaultRole ?? "member");
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
      } else if (isGroupAdmin && existing.role !== "admin") {
        await db
          .update(workspaceMembers)
          .set({ role: "admin" })
          .where(
            and(eq(workspaceMembers.workspaceId, orgWsId), eq(workspaceMembers.userId, user.id)),
          );
      } else if (wasGroupAdmin && !isGroupAdmin && existing.role === "admin") {
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
      // The provider's groups fill the teams mapped to them.
      if (identity.groups) {
        const { syncTeamsFromGroups } = await import("./team-service.js");
        await syncTeamsFromGroups(user.id, orgWsId, identity.groups).catch((err) =>
          logger.warn({ err, userId: user.id }, "team sync from groups failed"),
        );
      }
    }
  }

  // The workspaces the person's groups open (workspaces.access_groups), and
  // the group-mapped teams in each (services/workspace-groups.ts).
  if (groups.length > 0) {
    const { joinWorkspacesByGroups } = await import("./workspace-groups.js");
    await joinWorkspacesByGroups(user.id, groups).catch((err) =>
      logger.warn({ err, userId: user.id }, "joining workspaces by group failed"),
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

function slugBase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugOf(name: string, fallbackId: string): string {
  return slugBase(name) || `org-${fallbackId.slice(0, 8)}`;
}
