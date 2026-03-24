import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import type { SecretRef } from "@optio/shared";

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const key = process.env.OPTIO_ENCRYPTION_KEY;
  if (!key) throw new Error("OPTIO_ENCRYPTION_KEY is not set");
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

function encrypt(plaintext: string): { encrypted: Buffer; iv: Buffer; authTag: Buffer } {
  const key = encryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

function decrypt(encrypted: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}

export async function storeSecret(name: string, value: string, scope = "global"): Promise<void> {
  const { encrypted, iv, authTag } = encrypt(value);

  // Try update first, then insert
  const existing = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(eq(secrets.name, name), eq(secrets.scope, scope)));

  if (existing.length > 0) {
    await db
      .update(secrets)
      .set({ encryptedValue: encrypted, iv, authTag, updatedAt: new Date() })
      .where(and(eq(secrets.name, name), eq(secrets.scope, scope)));
  } else {
    await db.insert(secrets).values({ name, scope, encryptedValue: encrypted, iv, authTag });
  }
}

export async function retrieveSecret(name: string, scope = "global"): Promise<string> {
  const [secret] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.name, name), eq(secrets.scope, scope)));
  if (!secret) throw new Error(`Secret not found: ${name} (scope: ${scope})`);
  return decrypt(secret.encryptedValue, secret.iv, secret.authTag);
}

export async function listSecrets(scope?: string): Promise<SecretRef[]> {
  const query = scope
    ? db.select().from(secrets).where(eq(secrets.scope, scope))
    : db.select().from(secrets);
  const rows = await query;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function deleteSecret(name: string, scope = "global"): Promise<void> {
  await db.delete(secrets).where(and(eq(secrets.name, name), eq(secrets.scope, scope)));
}

export async function resolveSecretsForTask(
  requiredSecrets: string[],
  scope = "global",
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of requiredSecrets) {
    if (scope !== "global") {
      // Try repo-scoped secret first, fall back to global
      try {
        resolved[name] = await retrieveSecret(name, scope);
        continue;
      } catch {
        // Not found at repo scope — fall through to global
      }
    }
    resolved[name] = await retrieveSecret(name, "global");
  }
  return resolved;
}
