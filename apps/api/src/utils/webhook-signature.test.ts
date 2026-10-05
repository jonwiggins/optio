import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  hmacHex,
  safeEqualHex,
  verifyPagerDutySignature,
  verifySharedSecret,
} from "./webhook-signature.js";

const SECRET = "pd-signing-secret";
const raw = Buffer.from('{"event":{"id":"01","event_type":"incident.triggered"}}');
const good = createHmac("sha256", SECRET).update(raw).digest("hex");

describe("verifyPagerDutySignature", () => {
  it("accepts a single v1= signature over the raw body", () => {
    expect(verifyPagerDutySignature(raw, `v1=${good}`, SECRET)).toBe(true);
  });

  it("accepts a header with several signatures when any matches (key rotation)", () => {
    const other = createHmac("sha256", "old-secret").update(raw).digest("hex");
    expect(verifyPagerDutySignature(raw, `v1=${other},v1=${good}`, SECRET)).toBe(true);
    expect(verifyPagerDutySignature(raw, `v1=${good}, v1=${other}`, SECRET)).toBe(true);
  });

  it("rejects a wrong, differently-versioned, malformed, or missing signature", () => {
    const wrong = createHmac("sha256", "other").update(raw).digest("hex");
    expect(verifyPagerDutySignature(raw, `v1=${wrong}`, SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, `v2=${good}`, SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, good, SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, "v1=", SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, "v1=zz", SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyPagerDutySignature(raw, "", SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyPagerDutySignature(Buffer.from(raw.toString() + " "), `v1=${good}`, SECRET)).toBe(
      false,
    );
  });
});

describe("verifySharedSecret", () => {
  it("matches only the exact secret, whatever the lengths", () => {
    expect(verifySharedSecret("abc", "abc")).toBe(true);
    expect(verifySharedSecret("abd", "abc")).toBe(false);
    expect(verifySharedSecret("abcd", "abc")).toBe(false);
    expect(verifySharedSecret("ab", "abc")).toBe(false);
    expect(verifySharedSecret(undefined, "abc")).toBe(false);
    expect(verifySharedSecret("", "abc")).toBe(false);
    expect(verifySharedSecret("", "")).toBe(false);
    expect(verifySharedSecret("abc", "")).toBe(false);
  });
});

describe("hmacHex / safeEqualHex", () => {
  it("compare hex digests of equal length only", () => {
    const a = hmacHex("k", "m");
    expect(a).toBe(createHmac("sha256", "k").update("m").digest("hex"));
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, a.slice(1))).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
});
