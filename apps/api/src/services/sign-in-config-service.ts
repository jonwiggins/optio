import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs, users, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";
import { decrypt, encrypt } from "./secret-service.js";
import { getRedisClient } from "./event-bus.js";
import { getCallbackUrl } from "./oauth/provider.js";
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
export const CONFIGURABLE_PROVIDERS = ["google"] as const;
export type ConfigurableProvider = (typeof CONFIGURABLE_PROVIDERS)[number];

export const SIGN_IN_PROVIDERS = ["google", "github", "gitlab", "oidc"] as const;
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
  callbackUrl: string;
  updatedAt: string | null;
}

const DISPLAY: Record<SignInProviderName, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  oidc: process.env.OIDC_DISPLAY_NAME || "SSO",
};

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

function envConfig(
  provider: SignInProviderName,
): { clientId: string; clientSecret: string } | null {
  const env = process.env;
  switch (provider) {
    case "google":
      return env.GOOGLE_OAUTH_CLIENT_ID
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "github":
      return env.GITHUB_OAUTH_CLIENT_ID || env.GITHUB_APP_CLIENT_ID
        ? {
            clientId: (env.GITHUB_OAUTH_CLIENT_ID ?? env.GITHUB_APP_CLIENT_ID)!,
            clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? env.GITHUB_APP_CLIENT_SECRET ?? "",
          }
        : null;
    case "gitlab":
      return env.GITLAB_OAUTH_CLIENT_ID
        ? {
            clientId: env.GITLAB_OAUTH_CLIENT_ID,
            clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? "",
          }
        : null;
    case "oidc":
      return env.OIDC_ISSUER_URL
        ? { clientId: env.OIDC_CLIENT_ID ?? "", clientSecret: env.OIDC_CLIENT_SECRET ?? "" }
        : null;
  }
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
      displayName: stored?.displayName || DISPLAY[provider],
      configurable: (CONFIGURABLE_PROVIDERS as readonly string[]).includes(provider),
      enabled: fromDb || !!env,
      source: fromDb ? "database" : env ? "environment" : stored ? "database" : "none",
      clientId: fromDb || (stored && !env) ? stored!.clientId : (env?.clientId ?? null),
      hasClientSecret:
        fromDb || (stored && !env) ? !!stored!.encryptedClientSecret : !!env?.clientSecret,
      allowedDomains: stored?.allowedDomains ?? [],
      callbackUrl: getCallbackUrl(provider),
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    });
  }
  return out;
}

export interface SaveSignInConfigInput {
  clientId: string;
  /** Replaces the stored secret; absent keeps it; required on first save. */
  clientSecret?: string | null;
  allowedDomains?: string[];
  enabled?: boolean;
  displayName?: string | null;
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
  const clientId = input.clientId.trim();
  if (!clientId) throw new SignInConfigError("A client ID is required");
  let domains: string[] = [];
  if (input.allowedDomains !== undefined) {
    const normalized = normalizeAutoJoinDomains(input.allowedDomains);
    if ("error" in normalized) throw new SignInConfigError(normalized.error);
    domains = normalized.domains;
  }
  const existing = await getStoredConfig(provider);
  const secret = input.clientSecret?.trim();
  if (!existing && !secret) throw new SignInConfigError("A client secret is required");

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
  const values = {
    clientId,
    allowedDomains: input.allowedDomains !== undefined ? domains : (existing?.allowedDomains ?? []),
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
  logger.info({ provider, actorUserId, domains: values.allowedDomains }, "Sign-in provider saved");
  return (await listSignInProviders()).find((p) => p.provider === provider)!;
}

export async function deleteSignInConfig(provider: string): Promise<void> {
  await db.delete(authProviderConfigs).where(eq(authProviderConfigs.provider, provider));
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
        ? sql`${users.deploymentAdmin} = true OR lower(${users.email}) IN (${sql.join(
            [...env].map((e) => sql`${e}`),
            sql`, `,
          )})`
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
  if (admins.length === 1) {
    throw new SignInConfigError(
      userId === actorUserId
        ? "You can't remove yourself as the last deployment admin"
        : "The last deployment admin can't be removed",
      400,
    );
  }
  await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, userId));
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
export async function completeSignIn(user: {
  id: string;
  email: string;
}): Promise<{ deploymentAdmin: boolean; bootstrapped: boolean }> {
  let deploymentAdmin = false;
  if (envDeploymentAdmins().has(user.email.toLowerCase())) {
    await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, user.id));
    deploymentAdmin = true;
  }
  const claim = await pendingBootstrapClaim();
  if (!claim) return { deploymentAdmin, bootstrapped: false };
  if (await hasDeploymentAdmin()) {
    // Someone already is; the claim is spent.
    await getRedisClient().del(BOOTSTRAP_CLAIM_KEY);
    return { deploymentAdmin, bootstrapped: false };
  }
  await db.update(users).set({ deploymentAdmin: true }).where(eq(users.id, user.id));
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
