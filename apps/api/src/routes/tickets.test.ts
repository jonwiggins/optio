import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature, isReplayedEvent } from "./tickets.js";

describe("verifyGitHubSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ action: "labeled" }));

  function sign(payload: Buffer, key: string): string {
    return "sha256=" + createHmac("sha256", key).update(payload).digest("hex");
  }

  it("accepts a valid signature", () => {
    const signature = sign(body, secret);
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = sign(body, "wrong-secret");
    expect(verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a completely invalid signature string", () => {
    expect(verifyGitHubSignature(body, "sha256=invalid", secret)).toBe(false);
  });

  it("rejects when body differs from what was signed", () => {
    const signature = sign(Buffer.from("different body"), secret);
    expect(verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a signature with wrong length", () => {
    expect(verifyGitHubSignature(body, "sha256=abc", secret)).toBe(false);
  });
});

describe("isReplayedEvent", () => {
  it("returns false when no timestamp header is provided", () => {
    expect(isReplayedEvent(undefined)).toBe(false);
  });

  it("returns false for a recent timestamp", () => {
    const nowSec = Math.floor(Date.now() / 1000).toString();
    expect(isReplayedEvent(nowSec)).toBe(false);
  });

  it("returns true for a timestamp older than the max age", () => {
    const tenMinutesAgoSec = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    expect(isReplayedEvent(tenMinutesAgoSec, 5)).toBe(true);
  });

  it("returns false for a non-numeric timestamp", () => {
    expect(isReplayedEvent("not-a-number")).toBe(false);
  });

  it("uses the custom max age when provided", () => {
    const threeMinutesAgoSec = Math.floor((Date.now() - 3 * 60 * 1000) / 1000).toString();
    expect(isReplayedEvent(threeMinutesAgoSec, 2)).toBe(true);
    expect(isReplayedEvent(threeMinutesAgoSec, 5)).toBe(false);
  });

  it("returns true for a timestamp far in the future (clock-skew attack)", () => {
    const tenMinutesFromNowSec = Math.floor((Date.now() + 10 * 60 * 1000) / 1000).toString();
    expect(isReplayedEvent(tenMinutesFromNowSec, 5)).toBe(true);
  });

  it("returns false for a timestamp slightly in the future within tolerance", () => {
    const oneMinuteFromNowSec = Math.floor((Date.now() + 1 * 60 * 1000) / 1000).toString();
    expect(isReplayedEvent(oneMinuteFromNowSec, 5)).toBe(false);
  });
});
