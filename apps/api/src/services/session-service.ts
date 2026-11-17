import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../db/client.js";
import { users, sessions, userIdentities, wsUpgradeTokens } from "../db/schema.js";
import { eq, and, lt, or, sql } from "drizzle-orm";
import type { OAuthUser } from "./oauth/provider.js";
import { DEFAULT_SESSION_SLIDING_MS, sessionLifetimes } from "./credential-lifetimes.js";

// A session lasts 30 days at most and ends after 7 days unused, unless the
// deployment sets a shorter max lifetime or an idle timeout
// (services/credential-lifetimes.ts).

/** When a session used at `now` expires next: idle (or 7-day) window, capped by its max lifetime. */
function nextExpiry(
  createdAt: Date,
  now: Date,
  lifetimes: { maxMs: number; idleMs: number | null },
): Date {
  const sliding = now.getTime() + (lifetimes.idleMs ?? DEFAULT_SESSION_SLIDING_MS);
  return new Date(Math.min(sliding, createdAt.getTime() + lifetimes.maxMs));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  /** Provider handle (GitHub login / GitLab username); null when unknown. */
  username: string | null;
  avatarUrl: string | null;
  workspaceId: string | null;
  workspaceRole: string | null;
  /** May change how everyone signs in (Settings → Sign-in). Filled by /api/auth/me. */
  deploymentAdmin?: boolean;
}

/** Whether a new sign-in identity may join an existing account by email (opt-in). */
export function linkAccountsByEmailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPTIO_LINK_ACCOUNTS_BY_EMAIL?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * The account a provider identity already belongs to: its own row, else the
 * account a linked identity (`user_identities`) points at — one query.
 */
async function findAccountByIdentity(
  provider: string,
  externalId: string,
): Promise<typeof users.$inferSelect | null> {
  const [account] = await db
    .select()
    .from(users)
    .where(
      or(
        and(eq(users.provider, provider), eq(users.externalId, externalId)),
        sql`${users.id} IN (SELECT "user_id" FROM "user_identities" WHERE "provider" = ${provider} AND "external_id" = ${externalId})`,
      ),
    )
    .limit(1);
  return account ?? null;
}

/** Record that `provider`/`externalId` signs in to `userId` (idempotent). */
async function linkIdentity(
  userId: string,
  provider: string,
  profile: Pick<OAuthUser, "externalId" | "email">,
): Promise<void> {
  await db
    .insert(userIdentities)
    .values({ userId, provider, externalId: profile.externalId, email: profile.email || null })
    .onConflictDoNothing();
}

/**
 * Find or create a user from a sign-in profile, then create a session.
 *
 * The account is the `(provider, externalId)` pair, or an identity linked to
 * it (`user_identities`). Otherwise:
 *
 * - `linkByEmail` (opt-in: an OIDC or LDAP provider's own `linkByEmail`
 *   setting, or `OPTIO_LINK_ACCOUNTS_BY_EMAIL=true`): when the provider itself
 *   asserted the email (`emailVerifiedByProvider`, never an administrator's
 *   `trustEmail`) and exactly one account has it, the new identity is linked
 *   to that account — someone who signed in through LDAP keeps their account
 *   when the deployment moves to SSO, say.
 *
 * Linking adds a `user_identities` row; the account keeps the provider and
 * id it was created with. Otherwise a new identity is a new account.
 */
export async function createSession(
  provider: string,
  profile: OAuthUser,
  opts: { linkByEmail?: boolean } = {},
): Promise<{ token: string; user: SessionUser }> {
  const found = await findAccountByIdentity(provider, profile.externalId);
  let existing = found ? [found] : [];

  const asserted = profile.emailVerifiedByProvider ?? profile.emailVerified;
  if (existing.length === 0 && opts.linkByEmail && asserted && profile.email) {
    const sameEmail = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${profile.email.toLowerCase()}`)
      .limit(2);
    if (sameEmail.length === 1 && sameEmail[0].emailVerified === true) {
      await linkIdentity(sameEmail[0].id, provider, profile);
      existing = sameEmail;
    }
  }

  let user: (typeof existing)[0];

  if (existing.length > 0) {
    // Update user info on login
    const updated = await db
      .update(users)
      .set({
        email: profile.email,
        emailVerified: (profile.emailVerifiedByProvider ?? profile.emailVerified) === true,
        displayName: profile.displayName,
        username: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();
    user = updated[0];
  } else {
    const inserted = await db
      .insert(users)
      .values({
        provider,
        externalId: profile.externalId,
        email: profile.email,
        emailVerified: (profile.emailVerifiedByProvider ?? profile.emailVerified) === true,
        displayName: profile.displayName,
        username: profile.username ?? null,
        avatarUrl: profile.avatarUrl ?? null,
      })
      .returning();
    user = inserted[0];
  }

  // Create session token
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = nextExpiry(now, now, await sessionLifetimes());

  await db.insert(sessions).values({
    userId: user.id,
    tokenHash,
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
  });

  return {
    token,
    user: {
      id: user.id,
      provider: user.provider,
      email: user.email,
      displayName: user.displayName,
      username: user.username,
      avatarUrl: user.avatarUrl,
      workspaceId: user.defaultWorkspaceId,
      workspaceRole: null,
    },
  };
}

/** Validate a session token and return the user if valid. */
export async function validateSession(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const rows = await db
    .select({
      sessionId: sessions.id,
      tokenHash: sessions.tokenHash,
      sessionCreatedAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // Constant-time comparison of token hash (defense-in-depth)
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(tokenHash))) return null;

  // Check expiry in application code
  if (row.expiresAt <= now) return null;

  // The deployment's limits as they are now, so lowering one applies to
  // sessions that already exist: past its max lifetime or idle too long, the
  // session is over (and removed).
  const lifetimes = await sessionLifetimes();
  const lastSeen = row.lastSeenAt ?? row.sessionCreatedAt;
  if (
    row.sessionCreatedAt.getTime() + lifetimes.maxMs <= now.getTime() ||
    (lifetimes.idleMs !== null && lastSeen.getTime() + lifetimes.idleMs <= now.getTime())
  ) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  // Sliding-window: extend session expiry on successful validation
  const newExpiry = nextExpiry(row.sessionCreatedAt, now, lifetimes);
  if (newExpiry > now) {
    await db
      .update(sessions)
      .set({ expiresAt: newExpiry, lastSeenAt: now })
      .where(eq(sessions.id, row.sessionId));
  }

  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    workspaceId: row.defaultWorkspaceId,
    workspaceRole: null, // resolved by auth middleware from header/cookie
  };
}

/** Revoke a session by token. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/** Revoke all sessions for a user. */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ── Single-use WebSocket upgrade tokens (ws_upgrade_tokens) ───────────────

const WS_TOKEN_TTL_SECONDS = 30; // just enough for the WS upgrade

/**
 * Create a short-lived, single-use token for WebSocket authentication.
 *
 * The browser fetches it from whichever API instance answers
 * `/api/auth/ws-token` and upgrades `/ws/*` through the ingress to any
 * instance, so the token lives in `ws_upgrade_tokens` (hashed; the raw
 * token is never stored), not in process memory. Expired rows are swept by
 * the housekeeping worker.
 */
export async function createWsToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  // Expiry on the database's clock, as validation compares it: API pods'
  // clocks may disagree by more than the token lives.
  await db.insert(wsUpgradeTokens).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: sql`now() + make_interval(secs => ${WS_TOKEN_TTL_SECONDS})`,
  });
  return token;
}

/**
 * Validate and consume a single-use WebSocket upgrade token.
 * Returns the SessionUser on success (token is deleted), or null if
 * the token is invalid, expired, or already consumed.
 *
 * Consuming is one `DELETE … RETURNING` on the hash: exactly one of two
 * concurrent upgrades with the same token (on any instances) gets the row.
 * The lookup is an equality on a SHA-256 of 32 random bytes, so a timing
 * side channel on the comparison reveals nothing an attacker could use.
 */
export async function validateWsToken(token: string): Promise<SessionUser | null> {
  const [entry] = await db
    .delete(wsUpgradeTokens)
    .where(eq(wsUpgradeTokens.tokenHash, hashToken(token)))
    .returning({
      userId: wsUpgradeTokens.userId,
      live: sql<boolean>`${wsUpgradeTokens.expiresAt} > now()`,
    });

  // Consumed either way: an expired token is spent, not left to retry.
  if (!entry || !entry.live) return null;

  // Look up the user by ID
  const rows = await db
    .select({
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      username: users.username,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(users)
    .where(eq(users.id, entry.userId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    avatarUrl: row.avatarUrl,
    workspaceId: row.defaultWorkspaceId,
    workspaceRole: null,
  };
}

/** Delete all expired sessions. Returns count of deleted rows. */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning();
  return result.length;
}
