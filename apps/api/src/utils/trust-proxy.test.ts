import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  ignoredTrustProxyReason,
  trustProxyFromEnv,
  TrustProxyConfigError,
} from "./trust-proxy.js";

describe("trustProxyFromEnv", () => {
  it("reads hops, true, addresses, or nothing", () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv("")).toBe(false);
    expect(trustProxyFromEnv("0")).toBe(false);
    expect(trustProxyFromEnv("1")).toBe(false);
    expect(trustProxyFromEnv("true")).toBe(false);
    expect(trustProxyFromEnv("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(trustProxyFromEnv("10.43.0.17/32,loopback,fd00::1/128,10.0.5.0/255.255.255.0")).toEqual([
      "10.43.0.17/32",
      "loopback",
      "fd00::1/128",
      "10.0.5.0/255.255.255.0",
    ]);
  });

  it("trusts nobody for keywords and ranges as broad as true", () => {
    for (const v of [
      "uniquelocal",
      "10.43.0.17, linklocal",
      "UniqueLocal",
      "0.0.0.0/0",
      "10.0.0.0/7",
      "::/0",
      "fc00::/7",
      "10.0.0.0/254.0.0.0",
    ]) {
      expect(trustProxyFromEnv(v), v).toBe(false);
    }
  });

  it("refuses an unparseable value with a named error instead of proxy-addr's TypeError", () => {
    for (const v of [
      "ingress",
      "10.0.0.1, nginx",
      "10.0.0.0/33",
      "10.0.0.0/255.0.255.0",
      "::1/129",
    ]) {
      expect(() => trustProxyFromEnv(v), v).toThrow(TrustProxyConfigError);
    }
    expect(() => trustProxyFromEnv("ingress")).toThrow(/OPTIO_TRUST_PROXY: "ingress" is not/);
  });

  it("refuses unrestricted proxy trust so agent pods cannot spoof a loopback client", async () => {
    for (const v of ["true", "uniquelocal", "0.0.0.0/0"]) {
      const app = Fastify({ trustProxy: trustProxyFromEnv(v) });
      app.get("/ip", async (req) => ({ ip: req.ip }));
      const res = await app.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "10.42.0.7",
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(res.json().ip, v).toBe("10.42.0.7");
      await app.close();
    }
  });

  it("with the ingress controller's address, req.ip is the address it saw, not one the client wrote", async () => {
    const app = Fastify({ trustProxy: trustProxyFromEnv("10.42.0.7/32") });
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

describe("ignoredTrustProxyReason", () => {
  it("names the values that are read as trusting nobody", () => {
    expect(ignoredTrustProxyReason("true")).toMatch(/"true" is ignored/);
    expect(ignoredTrustProxyReason(" 2 ")).toMatch(/"2" is ignored/);
    expect(ignoredTrustProxyReason("uniquelocal")).toMatch(/"uniquelocal" covers far more/);
    expect(ignoredTrustProxyReason("10.0.0.1,0.0.0.0/0")).toMatch(/"0.0.0.0\/0" covers/);
  });

  it("stays quiet for unset, off and explicit addresses", () => {
    for (const v of [
      undefined,
      "",
      "false",
      "0",
      "10.42.0.7/32",
      "127.0.0.1, 10.0.0.1",
      "loopback",
    ]) {
      expect(ignoredTrustProxyReason(v)).toBeNull();
    }
  });
});
