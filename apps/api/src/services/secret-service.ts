import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, and, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets, workspaceMembers, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";
import type { SecretRef } from "@optio/shared";
import { canSee, ownerNameFor, ownerNames, type Actor } from "./ownership.js";

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
  "CURSOR_API_KEY",
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

/**
 * Decrypt an EncryptedBlob. `secretName` (optional) is included in error
 * messages for diagnosability — never the value.
 *
 * A failed GCM auth check surfaces from Node as the cryptic "Unsupported state
 * or unable to authenticate data"; in practice this almost always means the
 * encryption key changed after the secret was stored (see issue #553), so we
 * wrap it with an actionable message. The original error text is preserved.
 */
export function decrypt(blob: EncryptedBlob, aad?: Buffer, secretName?: string): string {
  if (!Number.isInteger(blob.alg) || blob.alg < 1 || blob.alg > 255) {
    throw new Error(`Invalid algorithm id: ${blob.alg}`);
  }
  switch (blob.alg) {
    case ALG_AES_256_GCM_V1:
      try {
        return decryptAesGcmV1(blob, aad);
      } catch (err) {
        const label = secretName ? ` "${secretName}"` : "";
        throw new Error(
          `Failed to decrypt stored secret${label} — the encryption key (OPTIO_ENCRYPTION_KEY) ` +
            `has likely changed since it was saved. Re-enter the credential, or restore the ` +
            `original encryption key. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
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
  // Enforce: scope = "global" implies workspaceId IS NULL. A "global"-scoped
  // row bound to a workspace is a contradictory state — the SQL lookup in
  // retrieveSecret omits the workspace filter for global scope, so it can match
  // a workspace-bound row that was encrypted with a workspace-bound AAD,
  // producing GCM auth-tag failures (see issue #509). Reject up front.
  if (scope === "global" && workspaceId) {
    throw new Error(
      "workspaceId must be null when scope is 'global' — use a workspace-specific scope instead",
    );
  }
  // A private secret (scope "user") belongs to a person, not a workspace: it
  // follows them across workspaces, and every reader looks it up by user alone
  // (`retrieveSecret(name, "user", undefined, userId)`), rebuilding the AAD as
  // `name|user|global`. Storing it bound to a workspace would make it
  // undecryptable at run time, so the workspace is dropped here.
  if (scope === "user") workspaceId = null;

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
      .set({
        encryptedValue: ciphertext,
        iv,
        authTag,
        alg,
        updatedAt: new Date(),
        // A private row written before the fix above may still carry a
        // workspace; re-saving it fixes the binding.
        ...(scope === "user" ? { workspaceId: null } : {}),
      })
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
    name,
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

/**
 * A secret as a list shows it: who owns it (a private secret's user, a
 * legacy `user:<id>` token's user, else the organization) and, for private
 * rows, the owner's name.
 */
export interface VisibleSecret extends SecretRef {
  ownerUserId: string | null;
  ownerName: string | null;
}

/** The owner a `secrets` row implies: `user_id`, a legacy `user:<id>` scope, or nobody. */
export function secretOwner(row: { scope: string; userId: string | null }): string | null {
  if (row.userId) return row.userId;
  if (row.scope.startsWith("user:")) return row.scope.slice("user:".length) || null;
  return null;
}

/**
 * The secrets `actor` may see, names only: the organization's (instance-wide
 * `global` rows and this workspace's repo-scoped rows), their own private
 * ones, and — for a workspace admin — the private secrets of the workspace's
 * members, read-only. `scope` narrows to one scope (`global`, a repo URL,
 * `user`). See `services/ownership.ts`.
 */
export async function listVisibleSecrets(actor: Actor, scope?: string): Promise<VisibleSecret[]> {
  const org = and(
    ne(secrets.scope, "user"),
    actor.workspaceId
      ? or(eq(secrets.workspaceId, actor.workspaceId), isNull(secrets.workspaceId))
      : undefined,
  );
  const mine = actor.userId
    ? and(eq(secrets.scope, "user"), eq(secrets.userId, actor.userId))
    : null;
  // An admin also sees the workspace's members' private secrets (by name).
  const members =
    actor.isAdmin && actor.workspaceId
      ? and(
          eq(secrets.scope, "user"),
          inArray(
            secrets.userId,
            db
              .select({ userId: workspaceMembers.userId })
              .from(workspaceMembers)
              .where(eq(workspaceMembers.workspaceId, actor.workspaceId)),
          ),
        )
      : actor.isAdmin && !actor.workspaceId
        ? eq(secrets.scope, "user")
        : null;
  const visible = or(org, ...[mine, members].filter((x): x is SQL => !!x));
  const rows = await db
    .select()
    .from(secrets)
    .where(scope ? and(visible, eq(secrets.scope, scope)) : visible)
    .orderBy(secrets.name);
  // Legacy `user:<id>` rows (a person's GitHub token) are theirs alone.
  const seen = rows.filter((r) => canSee(secretOwner(r), actor));
  const names = await ownerNames(seen.map(secretOwner));
  return seen.map((r) => {
    const ownerUserId = secretOwner(r);
    return {
      id: r.id,
      name: r.name,
      scope: r.scope,
      userId: r.userId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ownerUserId,
      ownerName: ownerNameFor(ownerUserId, names),
    };
  });
}

export async function deleteSecret(
  name: string,
  scope = "global",
  workspaceId?: string | null,
  userId?: string | null,
): Promise<void> {
  const conditions = [eq(secrets.name, name), eq(secrets.scope, scope)];
  // Global and private rows never carry a workspace (see `storeSecret`).
  if (workspaceId && scope !== "global" && scope !== "user") {
    conditions.push(eq(secrets.workspaceId, workspaceId));
  }
  if (userId) {
    conditions.push(eq(secrets.userId, userId));
  }
  await db.delete(secrets).where(and(...conditions));
}

/**
 * Postgres advisory lock id for healWorkspaceBoundUserSecrets — its own, so
 * it can't deadlock with the global-secrets heal or the migration runner.
 */
const HEAL_USER_ADVISORY_LOCK_ID = 8_675_311;

/**
 * Heal private secrets (scope "user") stored bound to a workspace. Before
 * `storeSecret` dropped the workspace for private rows, `POST /api/secrets`
 * saved them with the caller's workspace in the AAD, while every reader
 * looked them up by user alone and rebuilt the AAD without it — so they could
 * be listed but never decrypted. Re-encrypts each such row with the canonical
 * AAD and nulls its workspace; a row shadowed by an already-correct one (same
 * name and user, no workspace) is dropped. Idempotent.
 *
 * Runs in one transaction under a transaction-scoped advisory lock, so
 * replicas booting together serialize and the lock can't outlive the work
 * (a session lock taken on one pooled connection isn't released from another).
 */
export async function healWorkspaceBoundUserSecrets(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${sql.raw(String(HEAL_USER_ADVISORY_LOCK_ID))})`,
    );
    const bad = await tx
      .select()
      .from(secrets)
      .where(and(eq(secrets.scope, "user"), isNotNull(secrets.workspaceId)));
    if (bad.length === 0) return 0;

    let healed = 0;
    for (const row of bad) {
      try {
        const plaintext = decrypt(
          {
            alg: row.alg ?? ALG_AES_256_GCM_V1,
            iv: row.iv,
            ciphertext: row.encryptedValue,
            authTag: row.authTag,
          },
          buildSecretAAD(row.name, "user", row.workspaceId),
          row.name,
        );
        const [shadow] = await tx
          .select({ id: secrets.id })
          .from(secrets)
          .where(
            and(
              eq(secrets.name, row.name),
              eq(secrets.scope, "user"),
              isNull(secrets.workspaceId),
              row.userId ? eq(secrets.userId, row.userId) : isNull(secrets.userId),
            ),
          );
        if (shadow) {
          await tx.delete(secrets).where(eq(secrets.id, row.id));
          logger.warn(
            { name: row.name, userId: row.userId },
            "healWorkspaceBoundUserSecrets: dropped a private secret shadowed by a correct row",
          );
        } else {
          const re = encrypt(plaintext, buildSecretAAD(row.name, "user", null));
          await tx
            .update(secrets)
            .set({
              encryptedValue: re.ciphertext,
              iv: re.iv,
              authTag: re.authTag,
              alg: re.alg,
              workspaceId: null,
              updatedAt: new Date(),
            })
            .where(eq(secrets.id, row.id));
        }
        healed++;
      } catch (err) {
        logger.error(
          { err, name: row.name, userId: row.userId },
          "healWorkspaceBoundUserSecrets: failed to heal row — leaving in place for manual review",
        );
      }
    }
    logger.info({ healed, total: bad.length }, "healWorkspaceBoundUserSecrets complete");
    return healed;
  });
}

/**
 * Postgres advisory lock id for healContradictoryGlobalSecrets — distinct from
 * the migration runner's lock so the two can't deadlock against each other.
 * Replicas booting concurrently serialize through this lock.
 */
const HEAL_ADVISORY_LOCK_ID = 8_675_310;

/**
 * Heal contradictory rows where scope='global' but workspace_id IS NOT NULL
 * (see issue #509). Re-encrypts each row with the canonical global AAD and
 * nulls out workspace_id. Idempotent — a no-op once the invariant holds.
 *
 * Returns the number of rows healed. If a row is already shadowed by a true
 * global row (same name, no workspace), it is dropped to avoid violating the
 * (name, scope, workspace_id, user_id) unique constraint on update.
 *
 * IMPORTANT: a Postgres advisory lock serializes concurrent replicas. Without
 * it, two pods booting at the same time would both select the same bad rows
 * and both update them — and because Postgres treats NULLs as distinct in
 * UNIQUE indexes, the second update would silently produce a duplicate
 * (name, 'global', NULL, NULL) row instead of conflicting.
 *
 * NOTE: each healed row turns a workspace-bound secret into a globally-readable
 * one. We log per-row at INFO so an operator can audit which secrets crossed
 * a workspace boundary as a side effect of the fix.
 */
export async function healContradictoryGlobalSecrets(): Promise<number> {
  await db.execute(sql`SELECT pg_advisory_lock(${sql.raw(String(HEAL_ADVISORY_LOCK_ID))})`);
  try {
    const bad = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.scope, "global"), isNotNull(secrets.workspaceId)));

    if (bad.length === 0) return 0;

    let healed = 0;
    for (const row of bad) {
      try {
        const oldAad = buildSecretAAD(row.name, "global", row.workspaceId);
        const plaintext = decrypt(
          {
            alg: row.alg ?? ALG_AES_256_GCM_V1,
            iv: row.iv,
            ciphertext: row.encryptedValue,
            authTag: row.authTag,
          },
          oldAad,
          row.name,
        );

        const [shadow] = await db
          .select({ id: secrets.id })
          .from(secrets)
          .where(
            and(
              eq(secrets.name, row.name),
              eq(secrets.scope, "global"),
              isNull(secrets.workspaceId),
            ),
          );

        if (shadow) {
          // A true global row already exists with the same name — drop the
          // contradictory row rather than collide on the unique constraint.
          await db.delete(secrets).where(eq(secrets.id, row.id));
          logger.warn(
            { name: row.name, fromWorkspaceId: row.workspaceId },
            "healContradictoryGlobalSecrets: dropped redundant workspace-bound global row",
          );
        } else {
          const newAad = buildSecretAAD(row.name, "global", null);
          const reEncrypted = encrypt(plaintext, newAad);
          await db
            .update(secrets)
            .set({
              encryptedValue: reEncrypted.ciphertext,
              iv: reEncrypted.iv,
              authTag: reEncrypted.authTag,
              alg: reEncrypted.alg,
              workspaceId: null,
              updatedAt: new Date(),
            })
            .where(eq(secrets.id, row.id));
          logger.info(
            { name: row.name, fromWorkspaceId: row.workspaceId },
            "healContradictoryGlobalSecrets: secret promoted from workspace to global scope",
          );
        }
        healed++;
      } catch (err) {
        logger.error(
          { err, name: row.name, workspaceId: row.workspaceId },
          "healContradictoryGlobalSecrets: failed to heal row — leaving in place for manual review",
        );
      }
    }

    logger.info({ healed, total: bad.length }, "healContradictoryGlobalSecrets complete");
    return healed;
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${sql.raw(String(HEAL_ADVISORY_LOCK_ID))})`);
  }
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
  opts?: {
    /**
     * Include the organization's global secrets (the legacy default). Off
     * when the workspace restricts pods to the secrets work picks: then the
     * repo pod gets only the repo's own secrets.
     */
    orgSecrets?: boolean;
  },
): Promise<Record<string, string>> {
  // Get all global and repo-scoped secret names (never "user" scope)
  const globalSecrets = opts?.orgSecrets === false ? [] : await listSecrets("global", workspaceId);
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

/**
 * Secrets that configure the deployment rather than connect work to a
 * service: the identity tokens Optio manages, its own settings, git and
 * cloud sign-in, and the notifier. They are kept out of the Connections
 * catalog (Settings shows them) but stay in every legacy list.
 */
export const DEPLOYMENT_SECRET_NAMES = new Set([
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_HOST",
  "SLACK_WEBHOOK_URL",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "COPILOT_GITHUB_TOKEN",
  "OPENCLAW_API_KEY",
  "GROQ_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
]);

export function isDeploymentSecret(name: string): boolean {
  return (
    IDENTITY_SECRET_DENYLIST.has(name) ||
    isOptioConfigSecret(name) ||
    DEPLOYMENT_SECRET_NAMES.has(name) ||
    name.startsWith("GITHUB_USER_") ||
    name.startsWith("GITLAB_USER_") ||
    name.startsWith("CODEX_AUTH_") ||
    name.startsWith("ticket-provider:")
  );
}

/**
 * Optio's own configuration stored as secrets (agent sign-in modes, Vertex
 * settings): never offered to work as a pod secret.
 */
export function isOptioConfigSecret(name: string): boolean {
  return (
    /_AUTH_MODE$/.test(name) ||
    name.startsWith("CLAUDE_VERTEX_") ||
    name === "CODEX_APP_SERVER_URL" ||
    name.startsWith("OPENCODE_DEFAULT_")
  );
}

/**
 * The secrets a piece of work can give its pod, by name: the organization's
 * (global scope, instance-wide or this workspace's) and the viewer's own.
 * Identity tokens and Optio's own settings are never offered.
 */
export async function listPickableSecrets(
  workspaceId: string | null,
  userId: string | null,
): Promise<Array<{ name: string; owner: "workspace" | "me" }>> {
  const org = await db
    .select({ name: secrets.name })
    .from(secrets)
    .where(
      and(
        eq(secrets.scope, "global"),
        workspaceId
          ? sql`(${secrets.workspaceId} IS NULL OR ${secrets.workspaceId} = ${workspaceId})`
          : isNull(secrets.workspaceId),
      ),
    );
  const mine = userId
    ? await db
        .select({ name: secrets.name })
        .from(secrets)
        .where(and(eq(secrets.scope, "user"), eq(secrets.userId, userId)))
    : [];
  const offer = (n: string) => !IDENTITY_SECRET_DENYLIST.has(n) && !isOptioConfigSecret(n);
  const orgNames = [...new Set(org.map((r) => r.name).filter(offer))].sort();
  const myNames = [...new Set(mine.map((r) => r.name).filter(offer))].sort();
  return [
    ...orgNames.map((name) => ({ name, owner: "workspace" as const })),
    ...myNames.map((name) => ({ name, owner: "me" as const })),
  ];
}

/**
 * The secrets a piece of work picked for its pod, by name → value. Personal
 * work (an owner) gets its owner's secret first, then the repo's, then the
 * organization's; organization work never sees a personal secret. A picked
 * name that no longer exists is reported in `missing` rather than failing
 * the run.
 */
export async function resolvePodSecrets(
  names: string[] | null | undefined,
  opts: { repoUrl?: string | null; workspaceId?: string | null; ownerUserId?: string | null },
): Promise<{ env: Record<string, string>; missing: string[] }> {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of new Set(names ?? [])) {
    if (IDENTITY_SECRET_DENYLIST.has(name) || isOptioConfigSecret(name)) continue;
    let value: string | null = null;
    if (opts.ownerUserId) {
      value = await retrieveSecret(name, "user", undefined, opts.ownerUserId).catch(() => null);
    }
    if (value === null && opts.repoUrl) {
      value = await retrieveSecretWithFallback(name, opts.repoUrl, opts.workspaceId).catch(
        () => null,
      );
    }
    if (value === null) {
      value = await retrieveSecretWithFallback(name, "global", opts.workspaceId).catch(() => null);
    }
    if (value === null) missing.push(name);
    else env[name] = value;
  }
  return { env, missing };
}

/** Whether every picked name is a secret this work's owner may give its pod. */
export async function podSecretsSelectionError(
  names: string[] | null | undefined,
  opts: { workspaceId: string | null; ownerUserId: string | null },
): Promise<string | null> {
  if (!names || names.length === 0) return null;
  const pickable = await listPickableSecrets(opts.workspaceId, opts.ownerUserId);
  const org = new Set(pickable.filter((s) => s.owner === "workspace").map((s) => s.name));
  const mine = new Set(pickable.filter((s) => s.owner === "me").map((s) => s.name));
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return `"${name}" isn't a secret name`;
    if (org.has(name)) continue;
    if (mine.has(name)) continue;
    return opts.ownerUserId
      ? `There's no secret named ${name} for this work`
      : `${name} isn't one of the organization's secrets — personal secrets need work set to "Just me"`;
  }
  return null;
}

/** Whether the workspace gives pods only the secrets work picks. */
export async function workspaceRestrictsPodSecrets(workspaceId: string | null): Promise<boolean> {
  if (!workspaceId) return false;
  const [row] = await db
    .select({ restrict: workspaces.restrictPodSecrets })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row?.restrict ?? false;
}

/** A secret row by id with its decrypted value, or null when there is none. */
export async function retrieveSecretById(
  id: string,
): Promise<{ row: typeof secrets.$inferSelect; value: string } | null> {
  const [row] = await db.select().from(secrets).where(eq(secrets.id, id));
  if (!row) return null;
  const value = decrypt(
    {
      alg: row.alg ?? ALG_AES_256_GCM_V1,
      iv: row.iv,
      ciphertext: row.encryptedValue,
      authTag: row.authTag,
    },
    buildSecretAAD(row.name, row.scope, row.workspaceId ?? undefined),
    row.name,
  );
  return { row, value };
}
