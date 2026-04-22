import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the database module before importing the service
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock the schema to return simple column references
vi.mock("../db/schema.js", () => ({
  secrets: {
    id: "secrets.id",
    name: "secrets.name",
    scope: "secrets.scope",
    workspaceId: "secrets.workspace_id",
    userId: "secrets.user_id",
    encryptedValue: "secrets.encrypted_value",
    iv: "secrets.iv",
    authTag: "secrets.auth_tag",
    createdAt: "secrets.created_at",
    updatedAt: "secrets.updated_at",
  },
}));

import { db } from "../db/client.js";

// Set encryption key before importing the service (it caches on first access)
const TEST_KEY = "a".repeat(64); // 64-char hex string
process.env.OPTIO_ENCRYPTION_KEY = TEST_KEY;

/** Simulate legacy encryption: 16-byte IV, no AAD (pre-fix format). */
function legacyEncrypt(plaintext: string) {
  const key = Buffer.from(TEST_KEY, "hex");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { encrypted, iv, authTag: cipher.getAuthTag() };
}

// ── Mock Data Types ─────────────────────────────────────────────────────────

interface MockSecretData {
  name: string;
  scope: string;
  value: string; // plaintext - will be encrypted when retrieved
  userId?: string | null;
}

// ── Drizzle Expression Parser ───────────────────────────────────────────────

/** Extract {column: value} filters from a Drizzle SQL condition (eq/and expressions) */
function parseWhereCondition(condition: any): Record<string, string> {
  const filters: Record<string, string> = {};
  if (!condition?.queryChunks) return filters;

  // Walk through queryChunks to find nested SQL objects (from and())
  for (const chunk of condition.queryChunks) {
    if (chunk?.queryChunks) {
      Object.assign(filters, parseWhereCondition(chunk));
    }
  }

  // Handle eq() - queryChunks structure: [StringChunk, column, StringChunk, value, StringChunk]
  const chunks = condition.queryChunks;
  if (chunks.length >= 4) {
    const col = typeof chunks[1] === "string" ? chunks[1] : null;
    const val = typeof chunks[3] === "string" ? chunks[3] : null;
    if (col && val) {
      const colName = col.replace("secrets.", ""); // "secrets.scope" -> "scope"
      filters[colName] = val;
    }
  }

  return filters;
}

describe("secret-service", () => {
  let encrypt: typeof import("./secret-service.js").encrypt;
  let decrypt: typeof import("./secret-service.js").decrypt;
  let buildSecretAAD: typeof import("./secret-service.js").buildSecretAAD;
  let storeSecret: typeof import("./secret-service.js").storeSecret;
  let retrieveSecret: typeof import("./secret-service.js").retrieveSecret;
  let listSecrets: typeof import("./secret-service.js").listSecrets;
  let deleteSecret: typeof import("./secret-service.js").deleteSecret;
  let resolveSecretsForTask: typeof import("./secret-service.js").resolveSecretsForTask;
  let resolveSecretsForSetup: typeof import("./secret-service.js").resolveSecretsForSetup;
  let retrieveSecretWithFallback: typeof import("./secret-service.js").retrieveSecretWithFallback;
  let IDENTITY_SECRET_DENYLIST: typeof import("./secret-service.js").IDENTITY_SECRET_DENYLIST;
  let ALG_AES_256_GCM_V1: number;

  // ── Data-Driven Mock Helper ─────────────────────────────────────────────────

  /**
   * Set up db.select mock with a data-driven approach.
   * Queries are filtered based on the actual where clause conditions.
   */
  function setupSecretStoreMock(mockSecrets: MockSecretData[]) {
    (db.select as any) = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((condition) => {
          const filters = parseWhereCondition(condition);

          // Filter mock data based on extracted conditions
          const matches = mockSecrets.filter((s) => {
            if (filters.scope && s.scope !== filters.scope) return false;
            if (filters.name && s.name !== filters.name) return false;
            if (filters.user_id && s.userId !== filters.user_id) return false;
            return true;
          });

          // Return encrypted rows (simulating DB storage)
          return Promise.resolve(
            matches.map((s) => {
              const aad = buildSecretAAD(s.name, s.scope, null);
              const blob = encrypt(s.value, aad);
              return {
                id: `mock-${s.name}-${s.scope}`,
                name: s.name,
                scope: s.scope,
                encryptedValue: blob.ciphertext,
                iv: blob.iv,
                authTag: blob.authTag,
                alg: blob.alg,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            }),
          );
        }),
      }),
    }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./secret-service.js");
    encrypt = mod.encrypt;
    decrypt = mod.decrypt;
    buildSecretAAD = mod.buildSecretAAD;
    storeSecret = mod.storeSecret;
    retrieveSecret = mod.retrieveSecret;
    listSecrets = mod.listSecrets;
    deleteSecret = mod.deleteSecret;
    resolveSecretsForTask = mod.resolveSecretsForTask;
    resolveSecretsForSetup = mod.resolveSecretsForSetup;
    retrieveSecretWithFallback = mod.retrieveSecretWithFallback;
    IDENTITY_SECRET_DENYLIST = mod.IDENTITY_SECRET_DENYLIST;
    ALG_AES_256_GCM_V1 = mod.ALG_AES_256_GCM_V1;
  });

  describe("encryption round-trip", () => {
    it("stores and retrieves a secret with correct decryption", async () => {
      const secretValue = "my-super-secret-api-key-12345";
      let capturedEncrypted: Buffer;
      let capturedIv: Buffer;
      let capturedAuthTag: Buffer;
      let capturedAlg: number;

      const selectMock = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (db.select as any) = selectMock;

      const insertMock = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedEncrypted = vals.encryptedValue;
          capturedIv = vals.iv;
          capturedAuthTag = vals.authTag;
          capturedAlg = vals.alg;
          return Promise.resolve();
        }),
      });
      (db.insert as any) = insertMock;

      await storeSecret("API_KEY", secretValue);

      expect(capturedAlg!).toBe(ALG_AES_256_GCM_V1);
      expect(capturedEncrypted!).toBeInstanceOf(Buffer);
      expect(capturedIv!).toBeInstanceOf(Buffer);
      expect(capturedIv!.length).toBe(12); // NIST-recommended 12-byte IV
      expect(capturedAuthTag!).toBeInstanceOf(Buffer);
      expect(capturedEncrypted!.toString("utf8")).not.toBe(secretValue);

      const selectForRetrieve = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "test-id",
              name: "API_KEY",
              scope: "global",
              encryptedValue: capturedEncrypted!,
              iv: capturedIv!,
              authTag: capturedAuthTag!,
              alg: capturedAlg!,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        }),
      });
      (db.select as any) = selectForRetrieve;

      const result = await retrieveSecret("API_KEY");
      expect(result).toBe(secretValue);
    });

    it("handles multi-line secret values", async () => {
      const multiLine = "line1\nline2\nline3\nspecial chars: !@#$%^&*()";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("MULTI", multiLine);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("MULTI");
      expect(result).toBe(multiLine);
    });

    it("handles unicode secret values", async () => {
      const unicode = "秘密のキー 🔑 пароль";
      let captured: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("UNICODE", unicode);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: captured!.encrypted, iv: captured!.iv, authTag: captured!.authTag },
            ]),
        }),
      });

      const result = await retrieveSecret("UNICODE");
      expect(result).toBe(unicode);
    });

    it("decrypts legacy secrets encrypted with 16-byte IV and no AAD", async () => {
      // Simulate a legacy row stored before the AAD migration
      const { encrypted, iv, authTag } = legacyEncrypt("old-api-key");

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ encryptedValue: encrypted, iv, authTag, alg: 1 }]),
        }),
      });

      // retrieveSecret should handle legacy 16-byte IV rows gracefully
      const result = await retrieveSecret("OLD_KEY");
      expect(result).toBe("old-api-key");
    });

    it("defaults to ALG_AES_256_GCM_V1 when alg is null in DB row", async () => {
      // Encrypt with the same AAD that retrieveSecret("KEY", "global") will compute
      const aad = buildSecretAAD("KEY", "global");
      const blob = encrypt("new-secret", aad);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { encryptedValue: blob.ciphertext, iv: blob.iv, authTag: blob.authTag, alg: null },
            ]),
        }),
      });

      const result = await retrieveSecret("KEY");
      expect(result).toBe("new-secret");
    });
  });

  describe("encrypt/decrypt IV and AAD", () => {
    it("uses 12-byte IV (NIST SP 800-38D recommended)", () => {
      const blob = encrypt("test-value");
      expect(blob.iv.length).toBe(12);
    });

    it("encrypts and decrypts with AAD", () => {
      const aad = Buffer.from("API_KEY|global|global");
      const blob = encrypt("secret-value", aad);
      const result = decrypt(blob, aad);
      expect(result).toBe("secret-value");
    });

    it("fails to decrypt with wrong AAD", () => {
      const aad = Buffer.from("API_KEY|global|ws-1");
      const wrongAad = Buffer.from("API_KEY|global|ws-2");
      const blob = encrypt("secret-value", aad);
      expect(() => decrypt(blob, wrongAad)).toThrow();
    });

    it("fails to decrypt when AAD is expected but missing", () => {
      const aad = Buffer.from("API_KEY|global|global");
      const blob = encrypt("secret-value", aad);
      // Decrypting without AAD on 12-byte IV data should fail
      expect(() => decrypt(blob)).toThrow();
    });

    it("handles legacy 16-byte IV data without AAD (backward compat)", () => {
      const { encrypted, iv, authTag } = legacyEncrypt("legacy-secret");
      expect(iv.length).toBe(16);
      // decrypt with AAD provided should still work for 16-byte IV (legacy mode)
      const aad = Buffer.from("name|scope|global");
      const blob = { alg: ALG_AES_256_GCM_V1, iv, ciphertext: encrypted, authTag };
      const result = decrypt(blob, aad);
      expect(result).toBe("legacy-secret");
    });

    it("handles legacy 16-byte IV data without any AAD argument", () => {
      const { encrypted, iv, authTag } = legacyEncrypt("legacy-secret");
      const blob = { alg: ALG_AES_256_GCM_V1, iv, ciphertext: encrypted, authTag };
      const result = decrypt(blob);
      expect(result).toBe("legacy-secret");
    });

    it("encrypts without AAD when none provided", () => {
      const blob = encrypt("no-aad-value");
      expect(blob.iv.length).toBe(12);
      const result = decrypt(blob);
      expect(result).toBe("no-aad-value");
    });
  });

  describe("buildSecretAAD", () => {
    it("builds AAD from name, scope, and workspaceId", () => {
      const aad = buildSecretAAD("API_KEY", "global", "ws-123");
      expect(aad.toString()).toBe("API_KEY|global|ws-123");
    });

    it("uses 'global' when workspaceId is null", () => {
      const aad = buildSecretAAD("TOKEN", "repo-scope", null);
      expect(aad.toString()).toBe("TOKEN|repo-scope|global");
    });

    it("uses 'global' when workspaceId is undefined", () => {
      const aad = buildSecretAAD("TOKEN", "repo-scope");
      expect(aad.toString()).toBe("TOKEN|repo-scope|global");
    });
  });

  describe("EncryptedBlob and algorithm versioning", () => {
    it("encrypt returns an EncryptedBlob with alg set to ALG_AES_256_GCM_V1", () => {
      const blob = encrypt("test-value");
      expect(blob.alg).toBe(ALG_AES_256_GCM_V1);
      expect(blob.alg).toBe(0x01);
    });

    it("encrypt returns ciphertext (not encrypted) in the blob", () => {
      const blob = encrypt("test-value");
      expect(blob).toHaveProperty("ciphertext");
      expect(blob.ciphertext).toBeInstanceOf(Buffer);
      expect(blob).not.toHaveProperty("encrypted");
    });

    it("decrypt accepts an EncryptedBlob and returns plaintext", () => {
      const blob = encrypt("round-trip-test");
      const result = decrypt(blob);
      expect(result).toBe("round-trip-test");
    });

    it("decrypt accepts an EncryptedBlob with AAD", () => {
      const aad = Buffer.from("context");
      const blob = encrypt("aad-test", aad);
      const result = decrypt(blob, aad);
      expect(result).toBe("aad-test");
    });

    it("decrypt rejects invalid alg < 1", () => {
      const blob = encrypt("test");
      blob.alg = 0;
      expect(() => decrypt(blob)).toThrow("Invalid algorithm id");
    });

    it("decrypt rejects invalid alg > 255", () => {
      const blob = encrypt("test");
      blob.alg = 256;
      expect(() => decrypt(blob)).toThrow("Invalid algorithm id");
    });

    it("decrypt rejects non-integer alg", () => {
      const blob = encrypt("test");
      blob.alg = 1.5;
      expect(() => decrypt(blob)).toThrow("Invalid algorithm id");
    });

    it("decrypt rejects unsupported alg", () => {
      const blob = encrypt("test");
      blob.alg = 0x10;
      expect(() => decrypt(blob)).toThrow("Unsupported encryption algorithm: 0x10");
    });

    it("handles legacy blobs with 16-byte IV via ALG_AES_256_GCM_V1", () => {
      const { encrypted, iv, authTag } = legacyEncrypt("legacy-value");
      const blob = { alg: ALG_AES_256_GCM_V1, iv, ciphertext: encrypted, authTag };
      const result = decrypt(blob);
      expect(result).toBe("legacy-value");
    });
  });

  describe("storeSecret", () => {
    it("updates existing secret when one already exists", async () => {
      const updateSetMock = vi
        .fn()
        .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "existing-id" }]),
        }),
      });
      (db.update as any) = vi.fn().mockReturnValue({ set: updateSetMock });

      await storeSecret("EXISTING_KEY", "new-value");
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new secret when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await storeSecret("NEW_KEY", "value");
      expect(db.insert).toHaveBeenCalled();
    });

    it("uses custom scope when provided", async () => {
      let capturedScope: string;

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedScope = vals.scope;
          return Promise.resolve();
        }),
      });

      await storeSecret("KEY", "val", "https://github.com/owner/repo");
      expect(capturedScope!).toBe("https://github.com/owner/repo");
    });
  });

  describe("retrieveSecret", () => {
    it("throws when secret is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("MISSING")).rejects.toThrow("Secret not found: MISSING");
    });

    it("includes scope in error message", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await expect(retrieveSecret("KEY", "my-repo")).rejects.toThrow(
        "Secret not found: KEY (scope: my-repo)",
      );
    });

    it("applies isNull workspace filter for non-global scope without workspaceId", async () => {
      // Encrypt with appropriate AAD for this context
      const aad = buildSecretAAD("TOKEN", "repo-scope", null);
      const blob = encrypt("val", aad);

      const whereMock = vi
        .fn()
        .mockResolvedValue([
          { encryptedValue: blob.ciphertext, iv: blob.iv, authTag: blob.authTag, alg: blob.alg },
        ]);
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereMock }),
      });

      const result = await retrieveSecret("TOKEN", "repo-scope");
      expect(result).toBe("val");
      // The where clause should have been called (with 3 conditions: name, scope, isNull)
      expect(whereMock).toHaveBeenCalled();
    });
  });

  describe("listSecrets", () => {
    it("returns secrets without values", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY_A",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-02"),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(mockRows) }),
      });

      const result = await listSecrets("global");
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("encryptedValue");
      expect(result[0].name).toBe("KEY_A");
    });

    it("returns all secrets when no scope filter", async () => {
      const mockRows = [
        {
          id: "1",
          name: "KEY",
          scope: "global",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listSecrets();
      expect(result).toHaveLength(1);
    });
  });

  describe("deleteSecret", () => {
    it("calls delete with correct name and scope", async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      (db.delete as any) = vi.fn().mockReturnValue({ where: whereMock });

      await deleteSecret("MY_KEY", "my-scope");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("resolveSecretsForTask", () => {
    it("falls back to global when repo-scoped secret is not found", async () => {
      let capturedGlobal: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedGlobal = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("API_KEY", "global-key-value");

      let resolveCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            resolveCallCount++;
            if (resolveCallCount === 1) return Promise.resolve([]);
            return Promise.resolve([
              {
                encryptedValue: capturedGlobal!.encrypted,
                iv: capturedGlobal!.iv,
                authTag: capturedGlobal!.authTag,
              },
            ]);
          }),
        }),
      }));

      const result = await resolveSecretsForTask(["API_KEY"], "https://github.com/owner/repo");
      expect(result.API_KEY).toBe("global-key-value");
    });

    it("uses repo-scoped secret when available", async () => {
      let capturedRepo: { encrypted: Buffer; iv: Buffer; authTag: Buffer };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedRepo = { encrypted: vals.encryptedValue, iv: vals.iv, authTag: vals.authTag };
          return Promise.resolve();
        }),
      });

      await storeSecret("TOKEN", "repo-specific-token", "https://github.com/owner/repo");

      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              encryptedValue: capturedRepo!.encrypted,
              iv: capturedRepo!.iv,
              authTag: capturedRepo!.authTag,
            },
          ]),
        }),
      }));

      const result = await resolveSecretsForTask(["TOKEN"], "https://github.com/owner/repo");
      expect(result.TOKEN).toBe("repo-specific-token");
    });
  });

  describe("resolveSecretsForSetup", () => {
    it("returns both global and repo-scoped secrets", async () => {
      const repoUrl = "https://github.com/owner/repo";
      setupSecretStoreMock([
        { name: "GLOBAL_TOKEN", scope: "global", value: "global-value" },
        { name: "REPO_TOKEN", scope: repoUrl, value: "repo-value" },
      ]);

      const result = await resolveSecretsForSetup(repoUrl);
      expect(result.GLOBAL_TOKEN).toBe("global-value");
      expect(result.REPO_TOKEN).toBe("repo-value");
      expect(Object.keys(result)).toHaveLength(2);
    });

    it("repo-scoped secret overrides global secret with same name", async () => {
      const repoUrl = "https://github.com/owner/repo";
      setupSecretStoreMock([
        { name: "SHARED_TOKEN", scope: "global", value: "global-value" },
        { name: "SHARED_TOKEN", scope: repoUrl, value: "repo-override-value" },
      ]);

      const result = await resolveSecretsForSetup(repoUrl);
      expect(result.SHARED_TOKEN).toBe("repo-override-value");
      expect(Object.keys(result)).toHaveLength(1);
    });

    it("returns empty object when no secrets exist", async () => {
      setupSecretStoreMock([]);

      const result = await resolveSecretsForSetup("https://github.com/owner/empty-repo");
      expect(result).toEqual({});
    });

    it("excludes user-scoped secrets even when names match global/repo", async () => {
      const repoUrl = "https://github.com/owner/repo";
      setupSecretStoreMock([
        { name: "NPM_TOKEN", scope: "global", value: "npm-global" },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", scope: "user", value: "user-oauth", userId: "u-1" },
      ]);

      const result = await resolveSecretsForSetup(repoUrl);
      // user-scoped rows must not appear in setup secrets
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(result.NPM_TOKEN).toBe("npm-global");
    });

    it("filters out identity-denylist names from setup secrets", async () => {
      const repoUrl = "https://github.com/owner/repo";
      setupSecretStoreMock([
        { name: "NPM_TOKEN", scope: "global", value: "npm-value" },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", scope: "global", value: "should-be-blocked" },
        { name: "ANTHROPIC_API_KEY", scope: "global", value: "should-be-blocked" },
        { name: "OPENAI_API_KEY", scope: "global", value: "should-be-blocked" },
        { name: "GEMINI_API_KEY", scope: "global", value: "should-be-blocked" },
      ]);

      const result = await resolveSecretsForSetup(repoUrl);
      expect(result.NPM_TOKEN).toBe("npm-value");
      expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.OPENAI_API_KEY).toBeUndefined();
      expect(result.GEMINI_API_KEY).toBeUndefined();
    });
  });

  describe("IDENTITY_SECRET_DENYLIST", () => {
    it("contains the known identity secret names", () => {
      expect(IDENTITY_SECRET_DENYLIST).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(IDENTITY_SECRET_DENYLIST).toContain("ANTHROPIC_API_KEY");
      expect(IDENTITY_SECRET_DENYLIST).toContain("OPENAI_API_KEY");
      expect(IDENTITY_SECRET_DENYLIST).toContain("GEMINI_API_KEY");
    });
  });

  describe("user-scoped secrets", () => {
    it("storeSecret with user scope requires userId", async () => {
      await expect(storeSecret("TOKEN", "val", "user")).rejects.toThrow("userId is required");
    });

    it("storeSecret rejects userId for non-user scopes", async () => {
      await expect(storeSecret("TOKEN", "val", "global", null, "u-1")).rejects.toThrow(
        "userId can only be set",
      );
    });

    it("retrieveSecretWithFallback resolves user → workspace-global → global", async () => {
      // Set up mock to return user-scoped secret on first call
      const aad = buildSecretAAD("ANTHROPIC_API_KEY", "user", null);
      const blob = encrypt("user-api-key", aad);

      let callCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            // First call: user-scoped lookup succeeds
            if (callCount === 1) {
              return Promise.resolve([
                {
                  id: "user-secret",
                  name: "ANTHROPIC_API_KEY",
                  scope: "user",
                  encryptedValue: blob.ciphertext,
                  iv: blob.iv,
                  authTag: blob.authTag,
                  alg: blob.alg,
                },
              ]);
            }
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await retrieveSecretWithFallback("ANTHROPIC_API_KEY", "global", "ws-1", "u-1");
      expect(result).toBe("user-api-key");
    });

    it("retrieveSecretWithFallback falls back to global when user scope is empty", async () => {
      const aad = buildSecretAAD("ANTHROPIC_API_KEY", "global", null);
      const blob = encrypt("global-api-key", aad);

      let callCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            // First call: user-scoped lookup fails (empty)
            if (callCount === 1) return Promise.resolve([]);
            // Second call: workspace-scoped lookup fails
            if (callCount === 2) return Promise.resolve([]);
            // Third call: global lookup succeeds
            return Promise.resolve([
              {
                id: "global-secret",
                name: "ANTHROPIC_API_KEY",
                scope: "global",
                encryptedValue: blob.ciphertext,
                iv: blob.iv,
                authTag: blob.authTag,
                alg: blob.alg,
              },
            ]);
          }),
        }),
      }));

      const result = await retrieveSecretWithFallback("ANTHROPIC_API_KEY", "global", "ws-1", "u-1");
      expect(result).toBe("global-api-key");
    });

    it("retrieveSecretWithFallback without userId gets existing behavior", async () => {
      const aad = buildSecretAAD("GITHUB_TOKEN", "global", "ws-1");
      const blob = encrypt("ws-github-token", aad);

      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "ws-secret",
              name: "GITHUB_TOKEN",
              scope: "global",
              encryptedValue: blob.ciphertext,
              iv: blob.iv,
              authTag: blob.authTag,
              alg: blob.alg,
            },
          ]),
        }),
      }));

      const result = await retrieveSecretWithFallback("GITHUB_TOKEN", "global", "ws-1");
      expect(result).toBe("ws-github-token");
    });

    it("listSecrets filters by userId when provided", async () => {
      const mockRows = [
        {
          id: "1",
          name: "ANTHROPIC_API_KEY",
          scope: "user",
          userId: "u-1",
          encryptedValue: Buffer.from("x"),
          iv: Buffer.from("x"),
          authTag: Buffer.from("x"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(mockRows) }),
      });

      const result = await listSecrets("user", null, "u-1");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("ANTHROPIC_API_KEY");
    });

    it("deleteSecret with user scope uses userId in conditions", async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      (db.delete as any) = vi.fn().mockReturnValue({ where: whereMock });

      await deleteSecret("MY_TOKEN", "user", null, "u-1");
      expect(db.delete).toHaveBeenCalled();
      expect(whereMock).toHaveBeenCalled();
    });
  });
});
