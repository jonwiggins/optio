import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostResolver, OutboundPolicy } from "@optio/shared/ssrf";
import { guardedFetch, setOutboundDefaults, SsrfError } from "./outbound-url.js";

/**
 * A real server on 127.0.0.1 behind made-up host names (`api.test`,
 * `other.test`) that only the injected resolver knows: a request that
 * arrives proves the connection was pinned to the vetted address, since the
 * names do not exist in DNS. Loopback is blocked by default, so the tests
 * that expect a request to arrive list 127.0.0.1.
 */
interface Seen {
  method: string;
  url: string;
  host: string | undefined;
  authorization: string | undefined;
}

let server: http.Server;
let port: number;
const seen: Seen[] = [];

const resolveHost: HostResolver = async (hostname) => {
  if (hostname === "api.test" || hostname === "other.test") {
    return [{ address: "127.0.0.1", family: 4 }];
  }
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
};
const DEFAULT: OutboundPolicy = { allowPrivate: false, allowedHosts: [], allowAll: false };
const LOOPBACK_OK: OutboundPolicy = { ...DEFAULT, allowedHosts: ["127.0.0.1"] };
const api = (path: string) => `http://api.test:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      host: req.headers.host,
      authorization: req.headers.authorization,
    });
    const path = req.url ?? "/";
    const redirectTo = (status: number, location: string) => {
      res.writeHead(status, { location });
      res.end();
    };
    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    } else if (path === "/redirect") redirectTo(302, "/ok");
    else if (path === "/loop") redirectTo(302, "/loop");
    else if (path === "/to-private") redirectTo(302, "http://10.0.0.1/");
    else if (path === "/to-ftp") redirectTo(302, "ftp://files.example.com/");
    else if (path === "/303") redirectTo(303, "/ok");
    else if (path === "/cross") redirectTo(302, `http://other.test:${port}/ok`);
    else if (path === "/no-location") {
      res.writeHead(302);
      res.end();
    } else if (path === "/slow") {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

describe("guardedFetch", () => {
  it("connects only to the vetted address: a name DNS does not know still arrives, Host header intact", async () => {
    const res = await guardedFetch(api("/ok"), { resolveHost, policy: LOOPBACK_OK });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual([
      { method: "GET", url: "/ok", host: `api.test:${port}`, authorization: undefined },
    ]);
  });

  it("blocks a host that resolves to loopback under the default policy, before any connection", async () => {
    await expect(guardedFetch(api("/ok"), { resolveHost, policy: DEFAULT })).rejects.toThrow(
      `blocked: api.test resolves to a loopback address (127.0.0.1); list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it`,
    );
    expect(seen).toEqual([]);
  });

  it("blocks a loopback literal and a private literal; allowPrivate frees only the latter", async () => {
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/ok`, { resolveHost, policy: DEFAULT }),
    ).rejects.toThrow("blocked: 127.0.0.1 is a loopback address");
    await expect(
      guardedFetch("http://10.0.0.1/", {
        resolveHost,
        policy: { ...DEFAULT, allowPrivate: true },
        timeoutMs: 50,
      }),
    ).rejects.not.toThrow(SsrfError);
    await expect(
      guardedFetch(`http://127.0.0.1:${port}/ok`, {
        resolveHost,
        policy: { ...DEFAULT, allowPrivate: true },
      }),
    ).rejects.toThrow(SsrfError);
    expect(seen).toEqual([]);
  });

  it("follows a same-origin redirect, vetting each hop", async () => {
    const res = await guardedFetch(api("/redirect"), { resolveHost, policy: LOOPBACK_OK });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.map((s) => s.url)).toEqual(["/redirect", "/ok"]);
  });

  it("stops at a redirect to a blocked address", async () => {
    await expect(
      guardedFetch(api("/to-private"), { resolveHost, policy: LOOPBACK_OK }),
    ).rejects.toThrow("blocked: 10.0.0.1 is a private address");
    expect(seen.map((s) => s.url)).toEqual(["/to-private"]);
  });

  it("stops at a redirect to a non-http(s) URL", async () => {
    await expect(
      guardedFetch(api("/to-ftp"), { resolveHost, policy: LOOPBACK_OK }),
    ).rejects.toThrow("blocked: only http and https URLs can be fetched");
  });

  it("gives up after maxRedirects hops", async () => {
    await expect(
      guardedFetch(api("/loop"), { resolveHost, policy: LOOPBACK_OK, maxRedirects: 3 }),
    ).rejects.toThrow("api.test redirected more than 3 times");
    expect(seen).toHaveLength(4);
  });

  it("returns a 3xx without a Location as the response", async () => {
    const res = await guardedFetch(api("/no-location"), { resolveHost, policy: LOOPBACK_OK });
    expect(res.status).toBe(302);
    await res.text();
  });

  it("redirect: manual returns the 3xx; redirect: error rejects", async () => {
    const manual = await guardedFetch(api("/redirect"), {
      resolveHost,
      policy: LOOPBACK_OK,
      redirect: "manual",
    });
    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe("/ok");
    await manual.text();
    await expect(
      guardedFetch(api("/redirect"), { resolveHost, policy: LOOPBACK_OK, redirect: "error" }),
    ).rejects.toThrow();
    expect(seen.map((s) => s.url)).toEqual(["/redirect", "/redirect"]);
  });

  it("turns a POST into a GET without a body on 303", async () => {
    const res = await guardedFetch(api("/303"), {
      resolveHost,
      policy: LOOPBACK_OK,
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["POST", "/303"],
      ["GET", "/ok"],
    ]);
  });

  it("drops credentials on a cross-origin hop and keeps them on a same-origin one", async () => {
    const cross = await guardedFetch(api("/cross"), {
      resolveHost,
      policy: LOOPBACK_OK,
      headers: { Authorization: "Bearer s3cret", "X-Keep": "1" },
    });
    expect(cross.status).toBe(200);
    await cross.text();
    expect(seen.map((s) => [s.host, s.authorization])).toEqual([
      [`api.test:${port}`, "Bearer s3cret"],
      [`other.test:${port}`, undefined],
    ]);

    seen.length = 0;
    const same = await guardedFetch(api("/redirect"), {
      resolveHost,
      policy: LOOPBACK_OK,
      headers: new Headers({ Authorization: "Bearer s3cret" }),
    });
    await same.text();
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer s3cret", "Bearer s3cret"]);
  });

  it("times out", async () => {
    await expect(
      guardedFetch(api("/slow"), { resolveHost, policy: LOOPBACK_OK, timeoutMs: 100 }),
    ).rejects.toThrow();
  });

  it("rejects an unresolvable host readably", async () => {
    await expect(guardedFetch("https://nope.test/", { resolveHost })).rejects.toThrow(
      "nope.test could not be resolved (ENOTFOUND)",
    );
  });

  describe("with an injected fetchImpl", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("never calls it for a blocked URL", async () => {
      const impl = vi.fn();
      await expect(
        guardedFetch("http://169.254.169.254/latest/meta-data/", { fetchImpl: impl }),
      ).rejects.toThrow("blocked: 169.254.169.254 is a cloud metadata address");
      expect(impl).not.toHaveBeenCalled();
    });

    it("calls it with the vetted URL, the caller's redirect mode and a signal", async () => {
      const impl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      const res = await guardedFetch("https://api.example.com/x?y=1", {
        fetchImpl: impl,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        method: "POST",
        redirect: "error",
        headers: { "X-Optio-Event": "task.completed" },
      });
      expect(res.status).toBe(200);
      expect(impl).toHaveBeenCalledTimes(1);
      const [url, init] = impl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/x?y=1");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { "X-Optio-Event": "task.completed" },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("uses the process-wide defaults until they are restored", async () => {
      const impl = vi.fn().mockResolvedValue(new Response("ok"));
      const restore = setOutboundDefaults({
        fetchImpl: impl,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      try {
        await guardedFetch("https://api.example.com/");
        expect(impl).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
      await expect(guardedFetch("https://api.example.com/", { resolveHost })).rejects.toThrow(
        "api.example.com could not be resolved",
      );
      expect(impl).toHaveBeenCalledTimes(1);
    });
  });
});
