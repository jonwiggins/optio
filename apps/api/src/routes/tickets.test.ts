import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// Shared Redis stand-in for the durable delivery-id dedupe (SET NX EX).
const redisKeys = new Set<string>();
const redisSet = vi.fn(async (key: string) => {
  if (redisKeys.has(key)) return null;
  redisKeys.add(key);
  return "OK";
});
vi.mock("../services/event-bus.js", () => ({
  getRedisClient: () => ({ set: redisSet }),
  publishEvent: vi.fn(),
}));

import { verifyGitHubSignature } from "./tickets.js";
import { resetSlackEventDedupe } from "./event-ingress.js";

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
    redisKeys.clear();
    redisSet.mockClear();
    resetSlackEventDedupe();
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

  it("drops a replayed delivery id without re-processing it", async () => {
    const headers = { "x-hub-signature-256": sign(raw), "x-github-delivery": "guid-1" };
    expect((await deliver(headers)).statusCode).toBe(200);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisSet.mock.calls[0]).toEqual([
      "optio:webhook-delivery:github:guid-1",
      "1",
      "EX",
      86400,
      "NX",
    ]);
    // Replay: answered 200 but short-circuited by the in-process set.
    expect((await deliver(headers)).json()).toEqual({ ok: true });
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it("drops a delivery another replica (or a previous process) already claimed", async () => {
    redisKeys.add("optio:webhook-delivery:github:guid-2");
    const res = await deliver({ "x-hub-signature-256": sign(raw), "x-github-delivery": "guid-2" });
    expect(res.statusCode).toBe(200);
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it("accepts the delivery when Redis is unavailable (fails open)", async () => {
    redisSet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await deliver({ "x-hub-signature-256": sign(raw), "x-github-delivery": "guid-3" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects every delivery when GITHUB_WEBHOOK_SECRET is unset", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const res = await deliver({ "x-hub-signature-256": sign(raw) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Webhook secret not configured");
  });
});
