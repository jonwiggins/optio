import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../db/client.js";
import { users, sessions } from "../db/schema.js";
import { eq, and, gt, lt } from "drizzle-orm";
import type { OAuthUser } from "./oauth/provider.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  workspaceId: string | null;
  workspaceRole: string | null;
}

/** Find or create a user from an OAuth profile, then create a session. */
export async function createSession(
  provider: string,
  profile: OAuthUser,
): Promise<{ token: string; user: SessionUser }> {
  // Upsert user
  const existing = await db
    .select()
    .from(users)
    .where(and(eq(users.provider, provider), eq(users.externalId, profile.externalId)))
    .limit(1);

  let user: (typeof existing)[0];

  if (existing.length > 0) {
    // Update user info on login
    const updated = await db
      .update(users)
      .set({
        email: profile.email,
        displayName: profile.displayName,
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
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl ?? null,
      })
      .returning();
    user = inserted[0];
  }

  // Create session token
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  return {
    token,
    user: {
      id: user.id,
      provider: user.provider,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      workspaceId: user.defaultWorkspaceId,
      workspaceRole: null,
    },
  };
}

/** Validate a session token and return the user if valid. */
export async function validateSession(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);

  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
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

// ── In-memory store for single-use WebSocket upgrade tokens ──────────────

const WS_TOKEN_TTL_MS = 30_000; // 30 seconds — just enough for the WS upgrade
const WS_TOKEN_CLEANUP_INTERVAL_MS = 60_000;

interface WsUpgradeEntry {
  userId: string;
  expiresAt: number; // epoch ms
}

/** Map from token-hash → { userId, expiresAt }. Tokens are deleted on first use. */
const wsUpgradeTokens = new Map<string, WsUpgradeEntry>();

/** Periodic cleanup of expired entries (prevents slow leak if tokens are never used). */
const _wsCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [hash, entry] of wsUpgradeTokens) {
    if (entry.expiresAt <= now) wsUpgradeTokens.delete(hash);
  }
}, WS_TOKEN_CLEANUP_INTERVAL_MS);
// Allow the process to exit even if the timer is still running.
if (_wsCleanupTimer.unref) _wsCleanupTimer.unref();

/** Create a short-lived, single-use token for WebSocket authentication. */
export async function createWsToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  wsUpgradeTokens.set(tokenHash, {
    userId,
    expiresAt: Date.now() + WS_TOKEN_TTL_MS,
  });

  return token;
}

/**
 * Find a WS upgrade token entry using timing-safe comparison.
 *
 * Iterates all entries and compares hashes with crypto.timingSafeEqual
 * to prevent timing side-channel attacks. Returns the matching key and
 * entry, or null if not found.
 */
function findWsTokenEntry(tokenHash: string): { key: string; entry: WsUpgradeEntry } | null {
  const targetBuf = Buffer.from(tokenHash, "hex");
  for (const [key, entry] of wsUpgradeTokens) {
    const candidateBuf = Buffer.from(key, "hex");
    if (candidateBuf.length === targetBuf.length && timingSafeEqual(candidateBuf, targetBuf)) {
      return { key, entry };
    }
  }
  return null;
}

/**
 * Validate and consume a single-use WebSocket upgrade token.
 * Returns the SessionUser on success (token is deleted), or null if
 * the token is invalid, expired, or already consumed.
 *
 * Uses timing-safe comparison and atomic delete-then-validate semantics.
 */
export async function validateWsToken(token: string): Promise<SessionUser | null> {
  const tokenHash = hashToken(token);
  const match = findWsTokenEntry(tokenHash);

  if (!match) return null;

  // Always delete — single use regardless of expiry check (atomic consume)
  wsUpgradeTokens.delete(match.key);

  if (match.entry.expiresAt <= Date.now()) return null;

  // Look up the user by ID
  const rows = await db
    .select({
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(users)
    .where(eq(users.id, match.entry.userId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.userId,
    provider: row.provider,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    workspaceId: row.defaultWorkspaceId,
    workspaceRole: null,
  };
}

/** Expose internals for testing only. */
export const _wsTokenStoreForTesting = wsUpgradeTokens;

/** Delete all expired sessions. Returns count of deleted rows. */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning();
  return result.length;
}
