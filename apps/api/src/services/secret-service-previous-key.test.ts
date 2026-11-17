import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Made at run time: no key-shaped literal in the source.
const OLD = randomBytes(32).toString("hex");
const NEW = randomBytes(32).toString("hex");

/** The service loaded fresh under these variables (it caches its keys). */
async function underKeys(current: string, previous?: string) {
  vi.resetModules();
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", current);
  vi.stubEnv("OPTIO_ENCRYPTION_KEY_PREVIOUS", previous ?? "");
  return import("./secret-service.js");
}

afterEach(() => vi.unstubAllEnvs());

describe("OPTIO_ENCRYPTION_KEY_PREVIOUS", () => {
  it("opens values sealed under the previous key, and seals only with the current one", async () => {
    const aad = Buffer.from("name|global|global");
    const sealedOld = (await underKeys(OLD)).encrypt("old-value", aad);

    const svc = await underKeys(NEW, OLD);
    expect(svc.decrypt(sealedOld, aad)).toBe("old-value");
    const sealedNew = svc.encrypt("new-value", aad);
    expect(svc.decryptWithKey(Buffer.from(NEW, "hex"), sealedNew, aad)).toBe("new-value");
    expect(() => svc.decryptWithKey(Buffer.from(OLD, "hex"), sealedNew, aad)).toThrow();
  });

  it("still binds the AAD: the previous key doesn't open a value moved to another binding", async () => {
    const sealedOld = (await underKeys(OLD)).encrypt("v", Buffer.from("a|global|global"));
    const svc = await underKeys(NEW, OLD);
    expect(() => svc.decrypt(sealedOld, Buffer.from("b|global|global"), "b")).toThrow(
      /Failed to decrypt stored secret "b"/,
    );
  });

  it("without it, a value under the old key fails as before", async () => {
    const aad = Buffer.from("x");
    const sealedOld = (await underKeys(OLD)).encrypt("v", aad);
    const svc = await underKeys(NEW);
    expect(svc.previousEncryptionKey()).toBeNull();
    expect(() => svc.decrypt(sealedOld, aad)).toThrow(/OPTIO_ENCRYPTION_KEY/);
  });

  it("is ignored when it is the current key, and refused when weak", async () => {
    const same = await underKeys(NEW, NEW);
    expect(same.previousEncryptionKey()).toBeNull();
    const weak = await underKeys(NEW, "changeme");
    expect(() => weak.validateEncryptionKey()).toThrow(
      /OPTIO_ENCRYPTION_KEY_PREVIOUS is set to a known-weak value/,
    );
  });

  it("parses keys as OPTIO_ENCRYPTION_KEY is parsed (hex, else hashed)", async () => {
    const svc = await underKeys(NEW);
    expect(svc.parseEncryptionKey(NEW).equals(Buffer.from(NEW, "hex"))).toBe(true);
    expect(svc.parseEncryptionKey("a passphrase of some length")).toHaveLength(32);
    expect(svc.currentEncryptionKey().equals(Buffer.from(NEW, "hex"))).toBe(true);
  });
});
