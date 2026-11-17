import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeys, sessions, users } from "../db/schema.js";

/**
 * A person's sign-in sessions and API keys, as a deployment admin sees and
 * revokes them (routes/user-credentials.ts): one leaked key or one lost
 * laptop's session ends without disabling the account. Never returns a
 * token or its hash; a key shows its prefix.
 */

export interface CredentialAccount {
  id: string;
  email: string;
  displayName: string;
  provider: string;
  lastLoginAt: Date;
}

export interface CredentialSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
}

export interface CredentialApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

/** The accounts with this email (case-insensitive); several when identities weren't linked. */
export async function findAccountsByEmail(email: string): Promise<CredentialAccount[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      provider: users.provider,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .orderBy(desc(users.lastLoginAt))
    .limit(20);
}

/** The account's sessions that still work, and its API keys that aren't revoked. */
export async function listUserCredentials(
  userId: string,
): Promise<{ sessions: CredentialSession[]; apiKeys: CredentialApiKey[] }> {
  const [liveSessions, keys] = await Promise.all([
    db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt)),
    db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt)),
  ]);
  return { sessions: liveSessions, apiKeys: keys };
}

/** End one of the account's sessions. False when it has no such session. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<boolean> {
  const removed = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  return removed.length > 0;
}

/** End every session of the account (its API keys keep working). Returns how many ended. */
export async function revokeAllUserSessions(userId: string): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return removed.length;
}

/** Revoke one of the account's API keys; its prefix, or null when it has no such live key. */
export async function revokeUserApiKey(userId: string, keyId: string): Promise<string | null> {
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ prefix: apiKeys.prefix });
  return revoked?.prefix ?? null;
}
