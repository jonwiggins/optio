/**
 * Integration tests for encrypted secret storage (secret-service.ts) against
 * the real per-file database.
 *
 * Covers: store/retrieve roundtrips at global and workspace scope (asserting
 * ciphertext-at-rest), retrieveSecretWithFallback scope fallback, the AES-GCM
 * AAD binding contract (tampering with identifying columns breaks decryption),
 * the legacy 16-byte-IV no-AAD compatibility branch, and
 * healContradictoryGlobalSecrets (issue #509).
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  ALG_AES_256_GCM_V1,
  buildSecretAAD,
  deleteSecret,
  encrypt,
  healContradictoryGlobalSecrets,
  retrieveSecret,
  retrieveSecretWithFallback,
  storeSecret,
} from "./secret-service.js";

const uniq = () => randomBytes(4).toString("hex");

async function rowsByName(name: string) {
  return db.select().from(secrets).where(eq(secrets.name, name));
}

/** Mirror of the service's key derivation, for crafting legacy rows. */
function encryptionKeyFromEnv(): Buffer {
  const key = process.env.OPTIO_ENCRYPTION_KEY!;
  return key.length === 64 && /^[0-9a-f]+$/i.test(key)
    ? Buffer.from(key, "hex")
    : createHash("sha256").update(key).digest();
}

describe("secret-service roundtrips", () => {
  it("stores and retrieves a global-scope secret with only ciphertext at rest", async () => {
    const name = `IT_GLOBAL_${uniq()}`;
    const value = `global-plaintext-${uniq()}-long-enough-to-spot`;

    await storeSecret(name, value);
    await expect(retrieveSecret(name)).resolves.toBe(value);

    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.scope).toBe("global");
    expect(row.workspaceId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.alg).toBe(ALG_AES_256_GCM_V1);
    expect(row.iv.length).toBe(12); // v1 writes NIST-recommended 12-byte IVs
    expect(row.authTag.length).toBe(16);

    // The DB must hold no plaintext: stored bytes differ from and do not
    // contain the plaintext.
    const plainBuf = Buffer.from(value, "utf8");
    expect(row.encryptedValue.equals(plainBuf)).toBe(false);
    expect(row.encryptedValue.includes(plainBuf)).toBe(false);
    expect(row.encryptedValue.toString("utf8")).not.toContain(value);
  });

  it("stores and retrieves a workspace-scope secret, isolated from the workspace-less row", async () => {
    const ws = await insertWorkspace();
    const scope = `https://github.com/it-org/secret-repo-${uniq()}`;
    const name = `IT_WS_${uniq()}`;
    const value = `workspace-plaintext-${uniq()}`;

    await storeSecret(name, value, scope, ws.id);
    await expect(retrieveSecret(name, scope, ws.id)).resolves.toBe(value);

    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe(scope);
    expect(rows[0].workspaceId).toBe(ws.id);
    expect(rows[0].encryptedValue.includes(Buffer.from(value, "utf8"))).toBe(false);

    // Non-global retrieval without a workspaceId filters on workspace_id IS
    // NULL, so the workspace-bound row is not visible.
    await expect(retrieveSecret(name, scope)).rejects.toThrow(/Secret not found/);
  });

  it("upserts in place when storing the same (name, scope, workspace) twice", async () => {
    const name = `IT_UPSERT_${uniq()}`;
    await storeSecret(name, "first-value");
    await storeSecret(name, "second-value");

    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    await expect(retrieveSecret(name)).resolves.toBe("second-value");
  });

  it("rejects contradictory or malformed scope combinations up front", async () => {
    const ws = await insertWorkspace();
    // scope="global" must not carry a workspaceId (issue #509)
    await expect(storeSecret(`IT_BAD_${uniq()}`, "v", "global", ws.id)).rejects.toThrow(
      /workspaceId must be null when scope is 'global'/,
    );
    // scope="user" requires a userId, and userId requires scope="user"
    await expect(storeSecret(`IT_BAD_${uniq()}`, "v", "user")).rejects.toThrow(
      /userId is required/,
    );
    await expect(
      storeSecret(`IT_BAD_${uniq()}`, "v", "global", null, "00000000-0000-0000-0000-000000000001"),
    ).rejects.toThrow(/userId can only be set/);
  });
});

describe("retrieveSecretWithFallback", () => {
  it("prefers the workspace-bound row and falls back to the scope's workspace-less row", async () => {
    const ws = await insertWorkspace();
    const otherWs = await insertWorkspace();
    const scope = `https://github.com/it-org/fallback-repo-${uniq()}`;
    const name = `IT_FALLBACK_${uniq()}`;

    await storeSecret(name, "global-val", scope); // (scope, workspace_id NULL)
    await storeSecret(name, "ws-val", scope, ws.id); // (scope, ws.id)

    // Workspace value wins when present.
    await expect(retrieveSecretWithFallback(name, scope, ws.id)).resolves.toBe("ws-val");
    // A workspace without its own row falls back to the workspace-less row.
    await expect(retrieveSecretWithFallback(name, scope, otherWs.id)).resolves.toBe("global-val");
    // No workspaceId goes straight to the fallback row.
    await expect(retrieveSecretWithFallback(name, scope)).resolves.toBe("global-val");

    // Deleting the workspace row makes the same call fall through to global.
    await deleteSecret(name, scope, ws.id);
    await expect(retrieveSecretWithFallback(name, scope, ws.id)).resolves.toBe("global-val");
  });

  it('resolves scope="global" + workspaceId to the true global row (worker call pattern)', async () => {
    // Workers call retrieveSecretWithFallback(name, "global", workspaceId).
    // Since storeSecret refuses global-scope rows bound to a workspace, the
    // workspace-preference step misses and the true global row is returned.
    const ws = await insertWorkspace();
    const name = `IT_GLOBAL_FB_${uniq()}`;
    await storeSecret(name, "the-global-value");

    await expect(retrieveSecretWithFallback(name, "global", ws.id)).resolves.toBe(
      "the-global-value",
    );
    await expect(retrieveSecretWithFallback(`MISSING_${uniq()}`, "global", ws.id)).rejects.toThrow(
      /Secret not found/,
    );
  });
});

describe("AES-GCM AAD binding", () => {
  it("fails decryption when the stored name is changed out from under the ciphertext", async () => {
    const name = `IT_AAD_NAME_${uniq()}`;
    const renamed = `IT_AAD_RENAMED_${uniq()}`;
    await storeSecret(name, "aad-bound-value");

    const [row] = await rowsByName(name);
    await db.update(secrets).set({ name: renamed }).where(eq(secrets.id, row.id));

    // The row is found under its new name, but the AAD (name|scope|workspace)
    // no longer matches what the ciphertext was bound to → GCM auth failure,
    // surfaced with the actionable "key likely changed" wrapper.
    await expect(retrieveSecret(renamed)).rejects.toThrow(
      new RegExp(`Failed to decrypt stored secret "${renamed}"`),
    );
  });

  it("fails decryption when a workspace-bound row is re-pointed at another workspace", async () => {
    const ws = await insertWorkspace();
    const otherWs = await insertWorkspace();
    const scope = `https://github.com/it-org/aad-repo-${uniq()}`;
    const name = `IT_AAD_WS_${uniq()}`;
    await storeSecret(name, "workspace-bound-value", scope, ws.id);

    const [row] = await rowsByName(name);
    await db.update(secrets).set({ workspaceId: otherWs.id }).where(eq(secrets.id, row.id));

    await expect(retrieveSecret(name, scope, otherWs.id)).rejects.toThrow(/Failed to decrypt/);
    // And the original coordinates no longer find any row at all.
    await expect(retrieveSecret(name, scope, ws.id)).rejects.toThrow(/Secret not found/);
  });

  it("still decrypts legacy rows (16-byte IV, no AAD) for backward compatibility", async () => {
    const name = `IT_LEGACY_${uniq()}`;
    const value = `legacy-plaintext-${uniq()}`;

    // Craft a pre-AAD row exactly as the old code wrote it: 16-byte IV, no AAD.
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", encryptionKeyFromEnv(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await db.insert(secrets).values({
      name,
      scope: "global",
      encryptedValue: ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      alg: ALG_AES_256_GCM_V1,
    });

    // retrieveSecret passes an AAD, but decryptAesGcmV1 skips it for 16-byte
    // IVs, so legacy data stays readable.
    await expect(retrieveSecret(name)).resolves.toBe(value);
  });
});

describe("healContradictoryGlobalSecrets", () => {
  /** Insert a scope="global" row bound to a workspace, as pre-#509 code did. */
  async function insertContradictoryRow(name: string, value: string, workspaceId: string) {
    const blob = encrypt(value, buildSecretAAD(name, "global", workspaceId));
    await db.insert(secrets).values({
      name,
      scope: "global",
      encryptedValue: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      alg: blob.alg,
      workspaceId,
    });
  }

  it("promotes a contradictory row to true global scope, idempotently", async () => {
    const ws = await insertWorkspace();
    const name = `IT_HEAL_${uniq()}`;
    await insertContradictoryRow(name, "healed-value", ws.id);

    // Reproduce issue #509 before healing: the global lookup omits the
    // workspace filter, matches the workspace-bound row, and fails GCM auth
    // because the AAD was built with the workspaceId.
    await expect(retrieveSecret(name)).rejects.toThrow(/Failed to decrypt/);

    expect(await healContradictoryGlobalSecrets()).toBe(1);

    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBeNull();
    expect(rows[0].scope).toBe("global");
    await expect(retrieveSecret(name)).resolves.toBe("healed-value");

    // Idempotent: the invariant now holds, so a second pass is a no-op.
    expect(await healContradictoryGlobalSecrets()).toBe(0);
  });

  it("drops a contradictory row shadowed by a true global row instead of colliding", async () => {
    const ws = await insertWorkspace();
    const name = `IT_HEAL_SHADOW_${uniq()}`;
    await storeSecret(name, "true-global-value"); // canonical (name, global, NULL)
    await insertContradictoryRow(name, "workspace-copy", ws.id);

    expect(await healContradictoryGlobalSecrets()).toBe(1);

    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBeNull();
    await expect(retrieveSecret(name)).resolves.toBe("true-global-value");

    expect(await healContradictoryGlobalSecrets()).toBe(0);
  });

  it("leaves undecryptable contradictory rows in place for manual review", async () => {
    const ws = await insertWorkspace();
    const name = `IT_HEAL_BAD_${uniq()}`;
    // Bind the ciphertext to a DIFFERENT workspace than the row claims, so the
    // heal pass cannot decrypt it with the row's own coordinates.
    const otherWs = await insertWorkspace();
    const blob = encrypt("unreachable", buildSecretAAD(name, "global", otherWs.id));
    await db.insert(secrets).values({
      name,
      scope: "global",
      encryptedValue: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      alg: blob.alg,
      workspaceId: ws.id,
    });

    // Not healed (returns 0), row untouched.
    expect(await healContradictoryGlobalSecrets()).toBe(0);
    const rows = await rowsByName(name);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(ws.id);

    // Clean up so this poisoned row can't bleed into other heal assertions.
    await db.delete(secrets).where(and(eq(secrets.name, name), isNull(secrets.userId)));
  });
});
