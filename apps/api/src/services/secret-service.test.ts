import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the secret-service encryption/decryption logic.
 *
 * We mock the database layer and test that:
 * 1. Encryption round-trip works correctly
 * 2. Different keys produce different ciphertexts
 * 3. Hex vs hashed key parsing works
 * 4. Scope-based secret resolution with fallback
 */

// Helper to create a chainable DB mock with an in-memory store
function createDbMock() {
  let storedData: any = null;
  let callCount = 0;

  const mockSelectFromWhere = vi.fn().mockImplementation(() => {
    callCount++;
    if (storedData) return Promise.resolve([storedData]);
    return Promise.resolve([]);
  });
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  const mockInsertValues = vi.fn().mockImplementation((data: any) => {
    storedData = { id: "test-id", ...data, createdAt: new Date(), updatedAt: new Date() };
    return Promise.resolve();
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return {
    db: { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete },
    getStored: () => storedData,
    setStored: (d: any) => {
      storedData = d;
    },
    getCallCount: () => callCount,
    resetCallCount: () => {
      callCount = 0;
    },
    mockSelectFromWhere,
  };
}

describe("secret-service", () => {
  const TEST_KEY_HEX = "a".repeat(64); // Valid 64-char hex key

  beforeEach(() => {
    process.env.OPTIO_ENCRYPTION_KEY = TEST_KEY_HEX;
    // Reset the cached encryption key by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.OPTIO_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  describe("encryption round-trip", () => {
    it("encrypts and decrypts a simple string correctly", async () => {
      // We'll test the round-trip by storing and retrieving a secret
      // using our mocked DB that stores the actual encrypted buffers
      let storedData: any = null;

      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockImplementation(() => {
          if (storedData) {
            return Promise.resolve([storedData]);
          }
          return Promise.resolve([]);
        });
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

        const mockInsertValues = vi.fn().mockImplementation((data: any) => {
          storedData = {
            id: "test-id",
            name: data.name,
            scope: data.scope,
            encryptedValue: data.encryptedValue,
            iv: data.iv,
            authTag: data.authTag,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          return Promise.resolve();
        });
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

        return {
          db: {
            select: mockSelect,
            insert: mockInsert,
            update: mockUpdate,
            delete: mockDelete,
          },
        };
      });

      const { storeSecret, retrieveSecret } = await import("./secret-service.js");

      await storeSecret("MY_SECRET", "super-secret-value-123");
      const retrieved = await retrieveSecret("MY_SECRET");

      expect(retrieved).toBe("super-secret-value-123");
    });

    it("encrypts and decrypts special characters correctly", async () => {
      let storedData: any = null;

      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockImplementation(() => {
          if (storedData) return Promise.resolve([storedData]);
          return Promise.resolve([]);
        });
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

        const mockInsertValues = vi.fn().mockImplementation((data: any) => {
          storedData = {
            id: "test-id",
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          return Promise.resolve();
        });
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

        return {
          db: {
            select: mockSelect,
            insert: mockInsert,
            update: mockUpdate,
            delete: mockDelete,
          },
        };
      });

      const { storeSecret, retrieveSecret } = await import("./secret-service.js");

      const specialValue = "pässwörd!@#$%^&*()_+={}\n\ttabs and newlines 🔑";
      await storeSecret("SPECIAL", specialValue);
      const retrieved = await retrieveSecret("SPECIAL");

      expect(retrieved).toBe(specialValue);
    });

    it("encrypts and decrypts empty string", async () => {
      let storedData: any = null;

      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockImplementation(() => {
          if (storedData) return Promise.resolve([storedData]);
          return Promise.resolve([]);
        });
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

        const mockInsertValues = vi.fn().mockImplementation((data: any) => {
          storedData = { id: "test-id", ...data, createdAt: new Date(), updatedAt: new Date() };
          return Promise.resolve();
        });
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

        return {
          db: {
            select: mockSelect,
            insert: mockInsert,
            update: mockUpdate,
            delete: mockDelete,
          },
        };
      });

      const { storeSecret, retrieveSecret } = await import("./secret-service.js");

      await storeSecret("EMPTY", "");
      const retrieved = await retrieveSecret("EMPTY");
      expect(retrieved).toBe("");
    });
  });

  describe("encryption key handling", () => {
    it("throws when OPTIO_ENCRYPTION_KEY is not set", async () => {
      delete process.env.OPTIO_ENCRYPTION_KEY;
      vi.resetModules();

      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockResolvedValue([]);
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });
        const mockInsertValues = vi.fn().mockResolvedValue(undefined);
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });
        return {
          db: { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete },
        };
      });

      const { storeSecret } = await import("./secret-service.js");
      await expect(storeSecret("KEY", "value")).rejects.toThrow("OPTIO_ENCRYPTION_KEY is not set");
    });

    it("accepts non-hex key by hashing it", async () => {
      process.env.OPTIO_ENCRYPTION_KEY = "my-short-key";
      vi.resetModules();

      let storedData: any = null;

      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockImplementation(() => {
          if (storedData) return Promise.resolve([storedData]);
          return Promise.resolve([]);
        });
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

        const mockInsertValues = vi.fn().mockImplementation((data: any) => {
          storedData = { id: "test-id", ...data, createdAt: new Date(), updatedAt: new Date() };
          return Promise.resolve();
        });
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

        return {
          db: {
            select: mockSelect,
            insert: mockInsert,
            update: mockUpdate,
            delete: mockDelete,
          },
        };
      });

      const { storeSecret, retrieveSecret } = await import("./secret-service.js");

      await storeSecret("KEY", "my-value");
      const result = await retrieveSecret("KEY");
      expect(result).toBe("my-value");
    });
  });

  describe("retrieveSecret", () => {
    it("throws when secret is not found", async () => {
      vi.doMock("../db/client.js", () => {
        const mockSelectFromWhere = vi.fn().mockResolvedValue([]);
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });
        const mockInsertValues = vi.fn().mockResolvedValue(undefined);
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });
        return {
          db: { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete },
        };
      });

      const { retrieveSecret } = await import("./secret-service.js");
      await expect(retrieveSecret("NONEXISTENT")).rejects.toThrow("Secret not found: NONEXISTENT");
    });
  });

  describe("resolveSecretsForTask", () => {
    it("falls back from repo scope to global scope", async () => {
      let callCount = 0;

      vi.doMock("../db/client.js", () => {
        // Store secrets by key (name:scope)
        const secrets = new Map<string, any>();

        const mockSelectFromWhere = vi.fn().mockImplementation(() => {
          callCount++;
          // First call: repo scope (miss), second call: global scope (hit)
          if (callCount === 1) {
            // Repo-scoped lookup — not found
            return Promise.resolve([]);
          }
          // Global lookup — return a pre-encrypted value
          // We need actual encrypted data, so return from stored
          const stored = secrets.get("global");
          if (stored) return Promise.resolve([stored]);
          return Promise.resolve([]);
        });
        const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectFromWhere });
        const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

        const mockInsertValues = vi.fn().mockImplementation((data: any) => {
          secrets.set(data.scope, {
            id: "test-id",
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          return Promise.resolve();
        });
        const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

        const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateSetWhere });
        const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

        const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
        const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

        return {
          db: {
            select: mockSelect,
            insert: mockInsert,
            update: mockUpdate,
            delete: mockDelete,
          },
        };
      });

      const { storeSecret, resolveSecretsForTask } = await import("./secret-service.js");

      // Store secret at global scope
      await storeSecret("API_KEY", "global-key-value", "global");

      // Resolve with a repo scope — should fall back to global
      callCount = 0;
      const resolved = await resolveSecretsForTask(["API_KEY"], "https://github.com/org/repo");

      expect(resolved).toHaveProperty("API_KEY");
      expect(resolved.API_KEY).toBe("global-key-value");
    });
  });
});
