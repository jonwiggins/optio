import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { trustProxyFromEnv } from "./trust-proxy.js";

describe("trustProxyFromEnv", () => {
  it("reads hops, true, addresses, or nothing", () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv("")).toBe(false);
    expect(trustProxyFromEnv("0")).toBe(false);
    expect(trustProxyFromEnv("1")).toBe(1);
    expect(trustProxyFromEnv("true")).toBe(true);
    expect(trustProxyFromEnv("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
  });

  it("with one hop, req.ip is the address the ingress saw, not one the client wrote", async () => {
    const app = Fastify({ trustProxy: trustProxyFromEnv("1") });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    // The controller appends the peer it saw; anything before it is the client's own claim.
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.42.0.7",
      headers: { "x-forwarded-for": "6.6.6.6, 192.168.1.20" },
    });
    expect(res.json().ip).toBe("192.168.1.20");
    const direct = Fastify({ trustProxy: trustProxyFromEnv("") });
    direct.get("/ip", async (req) => ({ ip: req.ip }));
    const plain = await direct.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.42.0.7",
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(plain.json().ip).toBe("10.42.0.7");
  });
});
