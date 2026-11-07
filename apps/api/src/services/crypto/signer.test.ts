import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import {
  Rs256Signer,
  HmacSha256Signer,
  HmacSha256Verifier,
  MlDsa65Signer,
  NotImplementedError,
} from "./signer.js";

// ---------------------------------------------------------------------------
// Test RSA key pair (generated once, used across RS256 tests)
// ---------------------------------------------------------------------------
const { privateKey: rsaPrivateKey, publicKey: rsaPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const rsaPem = rsaPrivateKey.export({ type: "pkcs8", format: "pem" }) as string;

// ---------------------------------------------------------------------------
// Rs256Signer
// ---------------------------------------------------------------------------
describe("Rs256Signer", () => {
  it("has kty 'rsa-sha256' and jwtAlg 'RS256'", () => {
    const signer = new Rs256Signer(rsaPem);
    expect(signer.kty).toBe("rsa-sha256");
    expect(signer.jwtAlg).toBe("RS256");
  });

  it("produces a valid RSA-SHA256 signature", async () => {
    const signer = new Rs256Signer(rsaPem);
    const message = Buffer.from("header.payload");
    const signature = await signer.sign(message);

    // Verify with Node's built-in verifier
    const verifier = createVerify("RSA-SHA256");
    verifier.update(message);
    expect(verifier.verify(rsaPublicKey, signature)).toBe(true);
  });

  it("produces different signatures for different messages", async () => {
    const signer = new Rs256Signer(rsaPem);
    const sig1 = await signer.sign(Buffer.from("message-1"));
    const sig2 = await signer.sign(Buffer.from("message-2"));
    expect(sig1.equals(sig2)).toBe(false);
  });

  it("accepts a PEM string", async () => {
    const signer = new Rs256Signer(rsaPem);
    const sig = await signer.sign(Buffer.from("test"));
    expect(sig.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HmacSha256Signer
// ---------------------------------------------------------------------------
describe("HmacSha256Signer", () => {
  const secret = "test-secret";

  it("has kty 'hmac-sha256' and no jwtAlg", () => {
    const signer = new HmacSha256Signer(secret);
    expect(signer.kty).toBe("hmac-sha256");
    expect(signer.jwtAlg).toBeUndefined();
  });

  it("produces the same output as createHmac", async () => {
    const signer = new HmacSha256Signer(secret);
    const message = Buffer.from("hello world");
    const result = await signer.sign(message);

    const expected = createHmac("sha256", secret).update(message).digest();
    expect(result.equals(expected)).toBe(true);
  });

  it("produces a 32-byte digest", async () => {
    const signer = new HmacSha256Signer(secret);
    const result = await signer.sign(Buffer.from("data"));
    expect(result.length).toBe(32);
  });

  it("produces different signatures for different secrets", async () => {
    const signer1 = new HmacSha256Signer("secret-1");
    const signer2 = new HmacSha256Signer("secret-2");
    const message = Buffer.from("same message");
    const sig1 = await signer1.sign(message);
    const sig2 = await signer2.sign(message);
    expect(sig1.equals(sig2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HmacSha256Verifier
// ---------------------------------------------------------------------------
describe("HmacSha256Verifier", () => {
  const secret = "verify-secret";

  it("has kty 'hmac-sha256'", () => {
    const verifier = new HmacSha256Verifier(secret);
    expect(verifier.kty).toBe("hmac-sha256");
  });

  it("accepts a valid HMAC signature", async () => {
    const message = Buffer.from("payload");
    const signature = createHmac("sha256", secret).update(message).digest();
    const verifier = new HmacSha256Verifier(secret);
    expect(await verifier.verify(message, signature)).toBe(true);
  });

  it("rejects a signature from the wrong secret", async () => {
    const message = Buffer.from("payload");
    const signature = createHmac("sha256", "wrong-secret").update(message).digest();
    const verifier = new HmacSha256Verifier(secret);
    expect(await verifier.verify(message, signature)).toBe(false);
  });

  it("rejects a signature with wrong length", async () => {
    const verifier = new HmacSha256Verifier(secret);
    expect(await verifier.verify(Buffer.from("data"), Buffer.from("short"))).toBe(false);
  });

  it("rejects a tampered message", async () => {
    const message = Buffer.from("original");
    const signature = createHmac("sha256", secret).update(message).digest();
    const verifier = new HmacSha256Verifier(secret);
    expect(await verifier.verify(Buffer.from("tampered"), signature)).toBe(false);
  });

  it("round-trips with HmacSha256Signer", async () => {
    const signer = new HmacSha256Signer(secret);
    const verifier = new HmacSha256Verifier(secret);
    const message = Buffer.from("round-trip test");
    const signature = await signer.sign(message);
    expect(await verifier.verify(message, signature)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MlDsa65Signer (stub)
// ---------------------------------------------------------------------------
describe("MlDsa65Signer", () => {
  it("has kty 'ml-dsa-65' and jwtAlg 'ML-DSA-65'", () => {
    const signer = new MlDsa65Signer();
    expect(signer.kty).toBe("ml-dsa-65");
    expect(signer.jwtAlg).toBe("ML-DSA-65");
  });

  it("throws NotImplementedError on sign", async () => {
    const signer = new MlDsa65Signer();
    await expect(signer.sign(Buffer.from("test"))).rejects.toThrow(NotImplementedError);
    await expect(signer.sign(Buffer.from("test"))).rejects.toThrow(
      "ML-DSA-65 is not yet supported",
    );
  });
});
