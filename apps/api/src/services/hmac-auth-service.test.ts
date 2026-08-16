import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseSignatureHeader,
  computeSignature,
  verifyInternalRequest,
  SIGNATURE_HEADER,
  MAX_AGE_SECONDS,
} from "./hmac-auth-service.js";
import { getCredentialSecret, resetCredentialSecret } from "./credential-secret-service.js";

// Set up a known encryption key for deterministic secret derivation
process.env.OPTIO_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests";
resetCredentialSecret();
const SECRET = getCredentialSecret();

describe("parseSignatureHeader", () => {
  it("parses valid header", () => {
    const result = parseSignatureHeader("t=1712505600,sig=abc123");
    expect(result).toEqual({ timestamp: 1712505600, signature: "abc123" });
  });

  it("returns null for missing timestamp", () => {
    expect(parseSignatureHeader("sig=abc123")).toBeNull();
  });

  it("returns null for missing signature", () => {
    expect(parseSignatureHeader("t=1712505600")).toBeNull();
  });

  it("returns null for non-numeric timestamp", () => {
    expect(parseSignatureHeader("t=abc,sig=abc123")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSignatureHeader("")).toBeNull();
  });

  it("handles signature values containing = characters", () => {
    // base64-encoded values might contain =
    const result = parseSignatureHeader("t=1712505600,sig=abc123def==");
    expect(result).toEqual({ timestamp: 1712505600, signature: "abc123def==" });
  });
});

describe("computeSignature", () => {
  it("produces deterministic output", () => {
    const sig1 = computeSignature("secret", 1000, "/api/test");
    const sig2 = computeSignature("secret", 1000, "/api/test");
    expect(sig1).toBe(sig2);
  });

  it("changes when timestamp changes", () => {
    const sig1 = computeSignature("secret", 1000, "/api/test");
    const sig2 = computeSignature("secret", 1001, "/api/test");
    expect(sig1).not.toBe(sig2);
  });

  it("changes when path changes", () => {
    const sig1 = computeSignature("secret", 1000, "/api/a");
    const sig2 = computeSignature("secret", 1000, "/api/b");
    expect(sig1).not.toBe(sig2);
  });

  it("changes when secret changes", () => {
    const sig1 = computeSignature("secret1", 1000, "/api/test");
    const sig2 = computeSignature("secret2", 1000, "/api/test");
    expect(sig1).not.toBe(sig2);
  });

  it("includes query string in the signed payload", () => {
    const sig1 = computeSignature("secret", 1000, "/api/test");
    const sig2 = computeSignature("secret", 1000, "/api/test?taskId=abc");
    expect(sig1).not.toBe(sig2);
  });
});

describe("verifyInternalRequest", () => {
  const PATH = "/api/internal/git-credentials";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-04-07T12:00:00Z"));
  });

  afterEach(() => {
    delete process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER;
    vi.useRealTimers();
  });

  it("accepts valid HMAC signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, now, PATH);
    const headers = { [SIGNATURE_HEADER]: `t=${now},sig=${sig}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toBeNull();
  });

  it("accepts HMAC signature with query string", () => {
    const now = Math.floor(Date.now() / 1000);
    const pathWithQuery = `${PATH}?taskId=task-123`;
    const sig = computeSignature(SECRET, now, pathWithQuery);
    const headers = { [SIGNATURE_HEADER]: `t=${now},sig=${sig}` };

    const result = verifyInternalRequest(headers, pathWithQuery);
    expect(result).toBeNull();
  });

  it("rejects expired HMAC signature", () => {
    const expiredTime = Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS - 1;
    const sig = computeSignature(SECRET, expiredTime, PATH);
    const headers = { [SIGNATURE_HEADER]: `t=${expiredTime},sig=${sig}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Signature expired", status: 401 });
  });

  it("rejects future HMAC signature outside window", () => {
    const futureTime = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS + 1;
    const sig = computeSignature(SECRET, futureTime, PATH);
    const headers = { [SIGNATURE_HEADER]: `t=${futureTime},sig=${sig}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Signature expired", status: 401 });
  });

  it("rejects invalid HMAC signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = { [SIGNATURE_HEADER]: `t=${now},sig=invalid_signature` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Invalid signature", status: 401 });
  });

  it("rejects malformed signature header", () => {
    const headers = { [SIGNATURE_HEADER]: "garbage" };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Malformed signature header", status: 401 });
  });

  it("rejects signature computed for a different path", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, now, "/api/other");
    const headers = { [SIGNATURE_HEADER]: `t=${now},sig=${sig}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Invalid signature", status: 401 });
  });

  it("rejects legacy Bearer token by default", () => {
    const headers = { authorization: `Bearer ${SECRET}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Legacy bearer authentication disabled", status: 401 });
  });

  it("accepts valid legacy Bearer token only when explicitly enabled", () => {
    process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER = "1";
    const headers = { authorization: `Bearer ${SECRET}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toBeNull();
  });

  it("rejects invalid legacy Bearer token", () => {
    process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER = "1";
    const headers = { authorization: "Bearer wrong-token" };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Unauthorized", status: 401 });
  });

  it("returns 401 when no auth headers present", () => {
    const result = verifyInternalRequest({}, PATH);
    expect(result).toEqual({ error: "Missing authentication", status: 401 });
  });

  it("returns 503 when credential secret is not configured", () => {
    const origKey = process.env.OPTIO_ENCRYPTION_KEY;
    const origSecret = process.env.OPTIO_CREDENTIAL_SECRET;
    delete process.env.OPTIO_ENCRYPTION_KEY;
    delete process.env.OPTIO_CREDENTIAL_SECRET;
    resetCredentialSecret();

    const now = Math.floor(Date.now() / 1000);
    const sig = computeSignature("any", now, PATH);
    const headers = { [SIGNATURE_HEADER]: `t=${now},sig=${sig}` };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toEqual({ error: "Credential secret not configured", status: 503 });

    // Restore
    process.env.OPTIO_ENCRYPTION_KEY = origKey;
    if (origSecret) process.env.OPTIO_CREDENTIAL_SECRET = origSecret;
    resetCredentialSecret();
  });

  it("prefers HMAC signature over Bearer token when both are present", () => {
    const now = Math.floor(Date.now() / 1000);
    const sig = computeSignature(SECRET, now, PATH);
    const headers = {
      [SIGNATURE_HEADER]: `t=${now},sig=${sig}`,
      authorization: "Bearer wrong-token", // Would fail if used
    };

    const result = verifyInternalRequest(headers, PATH);
    expect(result).toBeNull(); // HMAC is preferred
  });
});
