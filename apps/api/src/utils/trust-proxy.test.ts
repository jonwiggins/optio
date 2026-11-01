import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it } from "vitest";
import { rateLimitExempt, trustProxySetting } from "./trust-proxy.js";

/** The API's limiter as server.ts sets it up (in-memory store), with an auth-style route. */
async function limitedApp(env: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: trustProxySetting(env) });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute", allowList: rateLimitExempt });
  app.post(
    "/api/auth/ldap/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => ({ ip: req.ip }),
  );
  await app.ready();
  return app;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function statuses(
  app: FastifyInstance,
  n: number,
  request: (i: number) => { remoteAddress: string; headers?: Record<string, string> },
) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const { remoteAddress, headers } = request(i);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      remoteAddress,
      headers,
    });
    out.push(res.statusCode);
  }
  return out;
}

describe("the address the rate limits key on", () => {
  it("counts each browser behind the web's proxy on its own, not as one exempt loopback", async () => {
    const app = await limitedApp();
    apps.push(app);
    const viaWeb = (client: string) => () => ({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": client },
    });
    const first = await statuses(app, 12, viaWeb("198.51.100.1"));
    expect(first.filter((s) => s === 429)).toHaveLength(2);
    // Another browser has its own allowance.
    expect(await statuses(app, 1, viaWeb("198.51.100.2"))).toEqual([200]);
  });

  it("ignores X-Forwarded-For from a client talking to the API directly", async () => {
    const app = await limitedApp();
    apps.push(app);
    const spoofing = await statuses(app, 12, (i) => ({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": `192.0.2.${i}` },
    }));
    expect(spoofing.filter((s) => s === 429)).toHaveLength(2);
    // Claiming to be the pod itself doesn't exempt it either.
    const claimLoopback = await statuses(app, 1, () => ({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "127.0.0.1" },
    }));
    expect(claimLoopback).toEqual([429]);
  });

  it("leaves the pod's own loopback calls with no client behind them alone", async () => {
    const app = await limitedApp();
    apps.push(app);
    const own = await statuses(app, 15, () => ({ remoteAddress: "127.0.0.1" }));
    expect(own.every((s) => s === 200)).toBe(true);
  });

  it("leaves a browser on the API's own host alone (local development, e2e)", async () => {
    const app = await limitedApp();
    apps.push(app);
    for (const local of ["::1", "127.0.0.1"]) {
      const viaWeb = await statuses(app, 15, () => ({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": local },
      }));
      expect(
        viaWeb.every((s) => s === 200),
        local,
      ).toBe(true);
    }
    // …but a remote browser behind it, even one listing loopback first, counts.
    const remote = await statuses(app, 12, () => ({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "127.0.0.1, 198.51.100.3" },
    }));
    expect(remote.filter((s) => s === 429)).toHaveLength(2);
  });

  it("believes a listed ingress: each client behind it counts on its own", async () => {
    const app = await limitedApp({ OPTIO_TRUST_PROXY: "10.0.0.0/8" });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/ldap/login",
      remoteAddress: "10.1.2.3",
      headers: { "x-forwarded-for": "192.0.2.50, 198.51.100.7" },
    });
    // The nearest address that isn't a trusted proxy: what the ingress saw.
    expect(res.json().ip).toBe("198.51.100.7");
  });
});

describe("trustProxySetting", () => {
  it("defaults to loopback and reads a comma-separated list", () => {
    expect(trustProxySetting({})).toEqual(["loopback"]);
    expect(trustProxySetting({ OPTIO_TRUST_PROXY: " 10.0.0.0/8, loopback ," })).toEqual([
      "10.0.0.0/8",
      "loopback",
    ]);
  });

  it("refuses settings that would let a client choose its own address", () => {
    for (const value of ["true", "TRUE", "*", "2"]) {
      expect(() => trustProxySetting({ OPTIO_TRUST_PROXY: value }), value).toThrow(
        /choose its own address/,
      );
    }
  });
});
