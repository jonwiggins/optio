import { describe, it, expect, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  renderHealthTemplate,
  httpHealthCheck,
  awsStsHealthCheck,
  runHealthCheck,
} from "./connection-health.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
import type { OutboundPolicy } from "@optio/shared/ssrf";

const PUBLIC_IP = { address: "93.184.216.34", family: 4 as const };
const DEFAULT_POLICY: OutboundPolicy = { allowPrivate: false, allowedHosts: [], allowAll: false };

// Every probe below goes through the outbound guard: a fixed public DNS
// answer keeps the tests hermetic, and the default policy keeps them
// independent of the developer's environment.
setOutboundDefaults({ resolveHost: async () => [PUBLIC_IP], policy: DEFAULT_POLICY });

const SECRET = "sk-super-secret-token-123";
const lookup = (key: string) =>
  ({ token: SECRET, host: "api.example.com", user: "jon", pass: "hunter2" })[key];

function fakeFetch(status: number, statusText = "", body = "") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, statusText });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("renderHealthTemplate", () => {
  it("substitutes placeholders and blanks unknown keys", () => {
    expect(renderHealthTemplate("https://{{host}}/me?x={{missing}}", lookup)).toBe(
      "https://api.example.com/me?x=",
    );
    expect(renderHealthTemplate("Bearer {{ token }}", lookup)).toBe(`Bearer ${SECRET}`);
  });
});

describe("httpHealthCheck", () => {
  const spec = {
    kind: "http" as const,
    url: "https://{{host}}/me",
    headers: { Authorization: "Bearer {{token}}" },
  };

  it("is healthy on 2xx and never echoes header values", async () => {
    const { impl, calls } = fakeFetch(200, "OK", `{"secret":"${SECRET}"}`);
    const result = await httpHealthCheck(spec, lookup, { fetchImpl: impl });
    expect(result).toEqual({
      status: "healthy",
      message: "GET https://api.example.com/me → 200 OK",
    });
    expect(result.message).not.toContain(SECRET);
    expect(calls[0]!.url).toBe("https://api.example.com/me");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("is an error on 401 and never echoes the body", async () => {
    const { impl } = fakeFetch(401, "Unauthorized", `{"error":"bad token ${SECRET}"}`);
    const result = await httpHealthCheck(spec, lookup, { fetchImpl: impl });
    expect(result).toEqual({
      status: "error",
      message: "GET https://api.example.com/me → 401 Unauthorized",
    });
    expect(result.message).not.toContain(SECRET);
  });

  it("honors expectStatus", async () => {
    const { impl } = fakeFetch(401, "Unauthorized");
    const ok = await httpHealthCheck({ ...spec, expectStatus: 401 }, lookup, { fetchImpl: impl });
    expect(ok.status).toBe("healthy");

    const { impl: impl200 } = fakeFetch(200, "OK");
    const bad = await httpHealthCheck({ ...spec, expectStatus: 204 }, lookup, {
      fetchImpl: impl200,
    });
    expect(bad).toEqual({ status: "error", message: "GET https://api.example.com/me → 200 OK" });
  });

  it("uses the method from the spec", async () => {
    const { impl, calls } = fakeFetch(200, "OK");
    const result = await httpHealthCheck({ ...spec, method: "POST" }, lookup, { fetchImpl: impl });
    expect(result.message).toBe("POST https://api.example.com/me → 200 OK");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("reports a timeout from a TimeoutError", async () => {
    const impl = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const result = await httpHealthCheck(spec, lookup, { fetchImpl: impl, timeoutMs: 10_000 });
    expect(result).toEqual({
      status: "error",
      message: "GET https://api.example.com/me timed out after 10s",
    });
  });

  it("reports a timeout when the signal fires", async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const result = await httpHealthCheck(spec, lookup, { fetchImpl: impl, timeoutMs: 20 });
    expect(result.status).toBe("error");
    expect(result.message).toBe("GET https://api.example.com/me timed out after 0.0s");
  });

  it("reports network errors by message", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await httpHealthCheck(spec, lookup, { fetchImpl: impl });
    expect(result).toEqual({
      status: "error",
      message: "GET https://api.example.com/me failed: fetch failed",
    });
  });

  it("rejects non-http(s) URLs without fetching", async () => {
    const { impl } = fakeFetch(200);
    const result = await httpHealthCheck({ kind: "http", url: "ftp://files.example.com" }, lookup, {
      fetchImpl: impl,
    });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/not an http\(s\) URL/);
    expect(impl).not.toHaveBeenCalled();

    const invalid = await httpHealthCheck({ kind: "http", url: "not a url" }, lookup, {
      fetchImpl: impl,
    });
    expect(invalid.status).toBe("error");
    expect(impl).not.toHaveBeenCalled();
  });

  it("strips userinfo from the URL in messages", async () => {
    const { impl } = fakeFetch(200, "OK");
    const result = await httpHealthCheck(
      { kind: "http", url: "https://{{user}}:{{pass}}@{{host}}/me" },
      lookup,
      { fetchImpl: impl },
    );
    expect(result.message).toBe("GET https://api.example.com/me → 200 OK");
    expect(result.message).not.toContain("hunter2");
  });
});

describe("awsStsHealthCheck", () => {
  const stsMock = mockClient(STSClient);

  it("signs in with explicit keys", async () => {
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Arn: "arn:aws:iam::123456789012:user/optio",
      Account: "123456789012",
      UserId: "AIDAEXAMPLE",
    });
    const result = await awsStsHealthCheck({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      region: "eu-west-1",
    });
    expect(result).toEqual({
      status: "healthy",
      message: "Signed in as arn:aws:iam::123456789012:user/optio",
    });
    expect(result.message).not.toContain("secret");
  });

  it("notes when the API's own role was used", async () => {
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({ Arn: "arn:aws:iam::1:role/optio-api" });
    const result = await awsStsHealthCheck({});
    expect(result.message).toBe(
      "Signed in as arn:aws:iam::1:role/optio-api (checked with the API's own role, not the pod's)",
    );
  });

  it("reports InvalidClientTokenId with a truncated message", async () => {
    stsMock.reset();
    const err = new Error(
      "The security token included in the request is invalid. " + "x".repeat(300),
    );
    err.name = "InvalidClientTokenId";
    stsMock.on(GetCallerIdentityCommand).rejects(err);
    const result = await awsStsHealthCheck({ accessKeyId: "AKIA", secretAccessKey: "bad" });
    expect(result.status).toBe("error");
    expect(result.message.startsWith("AWS STS: InvalidClientTokenId: The security token")).toBe(
      true,
    );
    expect(result.message.length).toBeLessThanOrEqual(
      "AWS STS: InvalidClientTokenId: ".length + 201,
    );
  });

  it("accepts an injected client", async () => {
    const client = { send: vi.fn().mockResolvedValue({ Arn: "arn:x" }) } as unknown as STSClient;
    const result = await awsStsHealthCheck({ accessKeyId: "a", secretAccessKey: "b" }, { client });
    expect(result).toEqual({ status: "healthy", message: "Signed in as arn:x" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe("runHealthCheck", () => {
  it("returns null when the provider declares no check", async () => {
    expect(await runHealthCheck(null, lookup)).toBeNull();
    expect(await runHealthCheck(undefined, lookup)).toBeNull();
  });

  it("dispatches http checks", async () => {
    const { impl } = fakeFetch(200, "OK");
    const result = await runHealthCheck({ kind: "http", url: "https://{{host}}/me" }, lookup, {
      fetchImpl: impl,
    });
    expect(result?.status).toBe("healthy");
  });

  it("dispatches aws-sts checks with credentials from the lookup", async () => {
    const client = { send: vi.fn().mockResolvedValue({ Arn: "arn:sts" }) } as unknown as STSClient;
    const result = await runHealthCheck(
      { kind: "aws-sts" },
      (k) => ({ accessKeyId: "a", secretAccessKey: "b" })[k],
      { client },
    );
    expect(result).toEqual({ status: "healthy", message: "Signed in as arn:sts" });
  });
});

describe("httpHealthCheck — outbound guard", () => {
  const spec = { kind: "http" as const, url: "https://{{host}}/me" };

  it("blocks a host that resolves to a private address, names host and class, never fetches", async () => {
    const { impl, calls } = fakeFetch(200);
    const result = await httpHealthCheck(spec, lookup, {
      fetchImpl: impl,
      resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
    });
    expect(result).toEqual({
      status: "error",
      message:
        "GET https://api.example.com/me blocked: api.example.com resolves to a private address (10.0.0.5); set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS",
    });
    expect(calls).toHaveLength(0);
  });

  it("blocks loopback and metadata literals even when private ranges are allowed", async () => {
    const { impl, calls } = fakeFetch(200);
    const policy: OutboundPolicy = { ...DEFAULT_POLICY, allowPrivate: true };
    const loopback = await httpHealthCheck(
      { kind: "http", url: "http://127.0.0.1:8200/v1/sys/health" },
      lookup,
      { fetchImpl: impl, policy },
    );
    expect(loopback).toEqual({
      status: "error",
      message:
        "GET http://127.0.0.1:8200/v1/sys/health blocked: 127.0.0.1 is a loopback address; list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    });
    const metadata = await httpHealthCheck(
      { kind: "http", url: "http://169.254.169.254/latest/meta-data/" },
      lookup,
      { fetchImpl: impl, policy },
    );
    expect(metadata.message).toBe(
      "GET http://169.254.169.254/latest/meta-data/ blocked: 169.254.169.254 is a cloud metadata address; list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    );
    expect(calls).toHaveLength(0);
  });

  it("proceeds when private ranges are allowed or the host is listed", async () => {
    const privateAnswer = async () => [{ address: "10.0.0.5", family: 4 as const }];
    const a = fakeFetch(200, "OK");
    const allowed = await httpHealthCheck(spec, lookup, {
      fetchImpl: a.impl,
      resolveHost: privateAnswer,
      policy: { ...DEFAULT_POLICY, allowPrivate: true },
    });
    expect(allowed).toEqual({
      status: "healthy",
      message: "GET https://api.example.com/me → 200 OK",
    });
    expect(a.calls.map((c) => c.url)).toEqual(["https://api.example.com/me"]);

    const b = fakeFetch(200, "OK");
    const listed = await httpHealthCheck(spec, lookup, {
      fetchImpl: b.impl,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      policy: { ...DEFAULT_POLICY, allowedHosts: ["api.example.com"] },
    });
    expect(listed.status).toBe("healthy");
    expect(b.calls).toHaveLength(1);
  });

  it("never echoes a secret from the URL in a blocked message", async () => {
    const { impl } = fakeFetch(200);
    const result = await httpHealthCheck(
      { kind: "http", url: "https://{{user}}:{{pass}}@{{host}}/me?token={{token}}#{{token}}" },
      lookup,
      { fetchImpl: impl, resolveHost: async () => [{ address: "::1", family: 6 }] },
    );
    expect(result.status).toBe("error");
    expect(result.message).toBe(
      "GET https://api.example.com/me blocked: api.example.com resolves to a loopback address (::1); list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    );
    expect(result.message).not.toContain(SECRET);
    expect(result.message).not.toContain("hunter2");
  });

  it("reports an unresolvable host readably", async () => {
    const { impl, calls } = fakeFetch(200);
    const result = await httpHealthCheck(spec, lookup, {
      fetchImpl: impl,
      resolveHost: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    expect(result).toEqual({
      status: "error",
      message: "GET https://api.example.com/me api.example.com could not be resolved (ENOTFOUND)",
    });
    expect(calls).toHaveLength(0);
  });
});
