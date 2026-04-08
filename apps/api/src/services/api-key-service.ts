import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "../db/client.js";
import { apiKeys, users } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import type { SessionUser } from "./session-service.js";

const PAT_PREFIX = "optio_pat_";

/** Generate a new personal access token string. */
function generateToken(): string {
  return PAT_PREFIX + randomBytes(32).toString("hex");
}

/** SHA-256 hash of a token for storage. */
function hashKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateApiKeyResult {
  token: string; // raw token — shown once
  tokenId: string;
  prefix: string;
  name: string;
}

/** Create a new API key for a user. Returns the raw token (shown once). */
export async function createApiKey(
  userId: string,
  name: string,
  expiresAt?: Date,
): Promise<CreateApiKeyResult> {
  const token = generateToken();
  const hashedKey = hashKey(token);
  const prefix = token.slice(0, 12);

  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      name,
      prefix,
      hashedKey,
      expiresAt: expiresAt ?? null,
    })
    .returning({ id: apiKeys.id });

  return { token, tokenId: row.id, prefix, name };
}

/** List all non-revoked API keys for a user (never returns the hashed key). */
export async function listApiKeys(userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
}

/** Revoke an API key. Returns true if it existed and was revoked. */
export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return result.length > 0;
}

/**
 * Validate a `optio_pat_*` token. Returns the user if valid, null otherwise.
 * Also updates `lastUsedAt` on successful validation.
 */
export async function validateApiKey(token: string): Promise<SessionUser | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;

  const hashedKey = hashKey(token);
  const now = new Date();

  const rows = await db
    .select({
      keyId: apiKeys.id,
      hashedKey: apiKeys.hashedKey,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      userId: users.id,
      provider: users.provider,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      defaultWorkspaceId: users.defaultWorkspaceId,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.hashedKey, hashedKey))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // Constant-time comparison (defense-in-depth)
  if (!timingSafeEqual(Buffer.from(row.hashedKey), Buffer.from(hashedKey))) return null;

  // Check revocation
  if (row.revokedAt) return null;

  // Check expiry
  if (row.expiresAt && row.expiresAt <= now) return null;

  // Update lastUsedAt (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, row.keyId))
    .catch(() => {});

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
