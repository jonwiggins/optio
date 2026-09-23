import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature, isReplayedEvent } from "./tickets.js";

describe("verifyGitHubSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ action: "labeled" }));

  function sign(payload: Buffer, key: string): string {
    return "sha256=" + createHmac("sha256", key).update(payload).digest("hex");
  }

  it("accepts a valid signature", async () => {
    const signature = sign(body, secret);
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const signature = sign(body, "wrong-secret");
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a completely invalid signature string", async () => {
    expect(await verifyGitHubSignature(body, "sha256=invalid", secret)).toBe(false);
  });

  it("rejects when body differs from what was signed", async () => {
    const signature = sign(Buffer.from("different body"), secret);
    expect(await verifyGitHubSignature(body, signature, secret)).toBe(false);
  });

  it("rejects a signature with wrong length", async () => {
    expect(await verifyGitHubSignature(body, "sha256=abc", secret)).toBe(false);
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
});

// The receiver is public (plugins/auth.ts PUBLIC_WEBHOOK_RECEIVERS), so its
// own signature check is the only thing between the internet and it.
describe("POST /api/webhooks/github (signature enforcement)", () => {
  const secret = "route-webhook-secret";
  const url = "/api/webhooks/github";
  const raw = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const sign = (body: string, key = secret) =>
    "sha256=" + createHmac("sha256", key).update(body).digest("hex");

  let app: import("fastify").FastifyInstance;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    const { buildRouteTestApp } = await import("../test-utils/build-route-test-app.js");
    const { ticketRoutes } = await import("./tickets.js");
    app = await buildRouteTestApp(ticketRoutes, { user: null });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  const deliver = (headers: Record<string, string>, body = raw) =>
    app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", "x-github-event": "ping", ...headers },
      payload: body,
    });

  it("accepts a correctly signed delivery", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects an unsigned delivery", async () => {
    const res = await deliver({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Missing signature");
  });

  it("rejects a delivery signed with another secret", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw, "attacker-secret") });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  it("rejects a body that differs from the one signed", async () => {
    const res = await deliver({ "x-hub-signature-256": sign(raw) }, raw.replace("awesome", "evil"));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  it("rejects a stale delivery", async () => {
    const stale = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
    const res = await deliver({
      "x-hub-signature-256": sign(raw),
      "x-github-delivery-timestamp": stale,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Replayed event");
  });

  it("rejects every delivery when GITHUB_WEBHOOK_SECRET is unset", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const res = await deliver({ "x-hub-signature-256": sign(raw) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Webhook secret not configured");
  });
});
