import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import type { SecretRef } from "@optio/shared";

const ALGORITHM = "aes-256-gcm";

// ── Algorithm version constants ─────────────────────────────────────────────
export const ALG_AES_256_GCM_V1 = 0x01;
export const ALG_AES_256_GCM_V2_AAD = 0x02; // future: adds AAD binding (see #302)
// export const ALG_HYBRID_MLKEM_AESGCM = 0x10; // future: ML-KEM wraps the DEK
// export const ALG_KMS_WRAPPED_AESGCM  = 0x20; // future: KMS-wrapped

export interface EncryptedBlob {
  alg: number; // 1 byte, identifies the encryption algorithm
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

/** Values that must never be accepted as encryption keys. */
const WEAK_KEY_VALUES = new Set([
  "change-me-in-production",
  "changeme",
  "test",
  "secret",
  "password",
  "default",
]);

/**
 * Identity secret names that must never be injected into shared pod env
 * via resolveSecretsForSetup. Belt-and-suspenders defense: even if someone
 * stores an identity token at global scope, it won't leak into pod env.
 */
export const IDENTITY_SECRET_DENYLIST = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
]);

function getEncryptionKey(): Buffer {
  const key = process.env.OPTIO_ENCRYPTION_KEY;
  if (!key) throw new Error("OPTIO_ENCRYPTION_KEY is not set");
  if (WEAK_KEY_VALUES.has(key.toLowerCase())) {
    throw new Error(
      `OPTIO_ENCRYPTION_KEY is set to a known-weak value ("${key}"). ` +
        "Generate a strong key with: openssl rand -hex 32",
    );
  }
  if (key.length === 64 && /^[0-9a-f]+$/i.test(key)) {
    return Buffer.from(key, "hex");
  }
  return createHash("sha256").update(key).digest();
}

let _encryptionKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (!_encryptionKey) {
    _encryptionKey = getEncryptionKey();
  }
  return _encryptionKey;
}

/**
 * Eagerly validate the encryption key on startup.
 * Call this during server boot to fail fast rather than on first secret access.
 */
export function validateEncryptionKey(): void {
  encryptionKey();
}

/**
 * Build AAD (Additional Authenticated Data) that binds ciphertext to its
 * identifying context in the `secrets` table.  Format: `name|scope|workspaceId`.
 */
export function buildSecretAAD(name: string, scope: string, workspaceId?: string | null): Buffer {
  return Buffer.from(`${name}|${scope}|${workspaceId ?? "global"}`);
}

export function encrypt(plaintext: string, aad?: Buffer): EncryptedBlob {
  const key = encryptionKey();
  const iv = randomBytes(12); // NIST SP 800-38D recommended 12-byte IV
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) {
    cipher.setAAD(aad);
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { alg: ALG_AES_256_GCM_V1, iv, ciphertext, authTag: cipher.getAuthTag() };
}

export function decrypt(blob: EncryptedBlob, aad?: Buffer): string {
  if (!Number.isInteger(blob.alg) || blob.alg < 1 || blob.alg > 255) {
    throw new Error(`Invalid algorithm id: ${blob.alg}`);
  }
  switch (blob.alg) {
    case ALG_AES_256_GCM_V1:
      return decryptAesGcmV1(blob, aad);
    default:
      throw new Error(`Unsupported encryption algorithm: 0x${blob.alg.toString(16)}`);
  }
}

function decryptAesGcmV1(blob: EncryptedBlob, aad?: Buffer): string {
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, blob.iv);
  // Legacy rows use 16-byte IV without AAD; new rows use 12-byte IV with AAD.
  // Skip AAD for legacy data to maintain backward compatibility.
  if (aad && blob.iv.length !== 16) {
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(blob.authTag);
  return decipher.update(blob.ciphertext).toString("utf8") + decipher.final("utf8");
}

export async function storeSecret(
  name: string,
  value: string,
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<void> {
  // Enforce CHECK semantics: scope = "user" iff userId is set
  if (scope === "user" && !userId) {
    throw new Error("userId is required when scope is 'user'");
  }
  if (scope !== "user" && userId) {
    throw new Error("userId can only be set when scope is 'user'");
  }

  const aad = buildSecretAAD(name, scope, workspaceId);
  const { alg, ciphertext, iv, authTag } = encrypt(value, aad);

  // Build conditions for lookup
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) {
    conditions.push(eq(secrets.workspaceId, workspaceId));
  } else if (scope !== "global" && scope !== "user") {
    conditions.push(isNull(secrets.workspaceId));
  }
  if (userId) {
    conditions.push(eq(secrets.userId, userId));
  } else if (scope !== "user") {
    // For non-user scopes, match rows with null userId
    conditions.push(isNull(secrets.userId));
  }

  // Try update first, then insert
  const existing = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(...conditions));

  if (existing.length > 0) {
    await db
      .update(secrets)
      .set({ encryptedValue: ciphertext, iv, authTag, alg, updatedAt: new Date() })
      .where(and(...conditions));
  } else {
    await db.insert(secrets).values({
      name,
      scope,
      encryptedValue: ciphertext,
      iv,
      authTag,
      alg,
      workspaceId: workspaceId ?? undefined,
      userId: userId ?? undefined,
    });
  }
}

export async function retrieveSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<string> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (scope === "user") {
    if (userId) {
      conditions.push(eq(secrets.userId, userId));
    } else {
      throw new Error("userId is required to retrieve a user-scoped secret");
    }
  } else {
    if (workspaceId) {
      conditions.push(eq(secrets.workspaceId, workspaceId));
    } else if (scope !== "global") {
      // For non-global scopes, always apply a workspace filter to prevent
      // cross-workspace secret leakage when workspaceId is omitted.
      conditions.push(isNull(secrets.workspaceId));
    }
    conditions.push(isNull(secrets.userId));
  }

  const [secret] = await db
    .select()
    .from(secrets)
    .where(and(...conditions));
  if (!secret) throw new Error(`Secret not found: ${name} (scope: ${scope})`);

  const aad = buildSecretAAD(name, scope, workspaceId);
  return decrypt(
    {
      alg: secret.alg ?? ALG_AES_256_GCM_V1,
      iv: secret.iv,
      ciphertext: secret.encryptedValue,
      authTag: secret.authTag,
    },
    aad,
  );
}

export async function listSecrets(
  scope?: string,
  workspaceId?: string | null,
  userId?: string | null,
): Promise<SecretRef[]> {
  const conditions = [];
  if (scope) conditions.push(eq(secrets.scope, scope));
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));
  if (userId) conditions.push(eq(secrets.userId, userId));

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(secrets)
          .where(and(...conditions))
      : db.select().from(secrets);
  const rows = await query;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    userId: r.userId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<void> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  if (workspaceId) conditions.push(eq(secrets.workspaceId, workspaceId));
  if (userId) {
    conditions.push(eq(secrets.userId, userId));
  }
  await db.delete(secrets).where(and(...conditions));
}

/**
 * Retrieve a secret with user → workspace → global fallback.
 *
 * Lookup order when userId is provided:
 *   1. (name, scope="user", userId=userId)
 *   2. (name, scope=scope, workspaceId=workspaceId)
 *   3. (name, scope=scope, workspaceId=null)   [global fallback]
 *
 * When userId is not provided, falls back to the original behavior:
 *   1. (name, scope=scope, workspaceId=workspaceId)
 *   2. (name, scope=scope, workspaceId=null)
 */
export async function retrieveSecretWithFallback(
  name: string,
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<string> {
  // Step 1: try user-scoped lookup if userId is provided
  if (userId) {
    try {
      return await retrieveSecret(name, "user", undefined, userId);
    } catch {
      // Not found at user scope — fall through
    }
  }
  // Step 2: try workspace-scoped lookup
  if (workspaceId) {
    try {
      return await retrieveSecret(name, scope, workspaceId);
    } catch {
      // Not found in workspace — fall through to global
    }
  }
  // Step 3: global fallback
  return retrieveSecret(name, scope);
}

export async function resolveSecretsForTask(
  requiredSecrets: string[],
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of requiredSecrets) {
    if (scope !== "global") {
      // Try repo-scoped secret first, fall back to global
      try {
        resolved[name] = await retrieveSecretWithFallback(name, scope, workspaceId, userId);
        continue;
      } catch {
        // Not found at repo scope — fall through to global
      }
    }
    resolved[name] = await retrieveSecretWithFallback(name, "global", workspaceId, userId);
  }
  return resolved;
}

/**
 * Resolve all secrets available for setup commands (global + repo-scoped).
 * Repo-scoped secrets take precedence over global secrets with the same name.
 *
 * SECURITY: User-scoped secrets (scope="user") are excluded by construction —
 * listSecrets only queries "global" and repoUrl scopes. Additionally, known
 * identity secret names are filtered via IDENTITY_SECRET_DENYLIST as a
 * belt-and-suspenders defense against identity tokens leaking into pod env.
 */
export async function resolveSecretsForSetup(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<Record<string, string>> {
  // Get all global and repo-scoped secret names (never "user" scope)
  const globalSecrets = await listSecrets("global", workspaceId);
  const repoSecrets = await listSecrets(repoUrl, workspaceId);

  // Merge names (unique) - repo-scoped will override global in resolveSecretsForTask
  const allNames = [
    ...new Set([...globalSecrets.map((s) => s.name), ...repoSecrets.map((s) => s.name)]),
  ];

  if (allNames.length === 0) return {};

  // Filter out identity secret names that must never be in pod env
  const safeNames = allNames.filter((n) => !IDENTITY_SECRET_DENYLIST.has(n));

  if (safeNames.length === 0) return {};

  // Resolve with repo→global fallback (no userId — setup is pod-level, not user-level)
  return resolveSecretsForTask(safeNames, repoUrl, workspaceId);
}
