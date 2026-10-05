import { describe, expect, it } from "vitest";
import {
  buildRequest,
  describeConfig,
  parseConfig,
  redact,
  REQUEST_BODY_LIMIT,
  resolvePath,
  shapeResponse,
  type BridgeConfig,
} from "./bridge.js";

const base = { OPTIO_HTTP_BASE_URL: "https://api.example.com/v2" };

function cfgWith(env: Record<string, string | undefined>): BridgeConfig {
  return parseConfig({ ...base, ...env });
}

function headersOf(result: ReturnType<typeof buildRequest>): Headers {
  if (!result.ok) throw new Error(result.error);
  return result.init.headers as Headers;
}

describe("parseConfig", () => {
  it("requires a base URL", () => {
    expect(() => parseConfig({})).toThrow(/OPTIO_HTTP_BASE_URL is required/);
    expect(() => parseConfig({ OPTIO_HTTP_BASE_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => parseConfig({ OPTIO_HTTP_BASE_URL: "ftp://x" })).toThrow(/http\(s\)/);
  });

  it("defaults name, auth header and extra headers", () => {
    const cfg = parseConfig(base);
    expect(cfg.name).toBe("http-api");
    expect(cfg.description).toBe("");
    expect(cfg.authHeader).toBe("Authorization");
    expect(cfg.authValue).toBeNull();
    expect(cfg.extraHeaders).toEqual({});
    expect(cfg.baseUrl.href).toBe("https://api.example.com/v2/");
  });

  it("drops query and fragment from the base URL", () => {
    expect(cfgWith({ OPTIO_HTTP_BASE_URL: "https://a.example/?x=1#f" }).baseUrl.href).toBe(
      "https://a.example/",
    );
  });

  it("takes the full auth value as given", () => {
    expect(cfgWith({ OPTIO_HTTP_AUTH_VALUE: "Token token=abc" }).authValue).toBe("Token token=abc");
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_VALUE: "abc", OPTIO_HTTP_AUTH_HEADER: "X-Api-Key" }),
    ).toMatchObject({
      authHeader: "X-Api-Key",
      authValue: "abc",
    });
  });

  it("builds the legacy scheme + token pair", () => {
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_SCHEME: "bearer", OPTIO_HTTP_AUTH_TOKEN: "t0k" }).authValue,
    ).toBe("Bearer t0k");
    expect(cfgWith({ OPTIO_HTTP_AUTH_TOKEN: "t0k" }).authValue).toBe("Bearer t0k");
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_SCHEME: "api-key", OPTIO_HTTP_AUTH_TOKEN: "t0k" }).authValue,
    ).toBe("t0k");
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_SCHEME: "none", OPTIO_HTTP_AUTH_TOKEN: "t0k" }).authValue,
    ).toBeNull();
    expect(() =>
      cfgWith({ OPTIO_HTTP_AUTH_SCHEME: "digest", OPTIO_HTTP_AUTH_TOKEN: "t0k" }),
    ).toThrow(/AUTH_SCHEME/);
  });

  it("prefers OPTIO_HTTP_AUTH_VALUE over the legacy pair, and an empty value means no auth", () => {
    expect(
      cfgWith({
        OPTIO_HTTP_AUTH_VALUE: "Direct",
        OPTIO_HTTP_AUTH_SCHEME: "bearer",
        OPTIO_HTTP_AUTH_TOKEN: "t0k",
      }).authValue,
    ).toBe("Direct");
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_VALUE: "", OPTIO_HTTP_AUTH_TOKEN: "t0k" }).authValue,
    ).toBeNull();
    expect(
      cfgWith({ OPTIO_HTTP_AUTH_SCHEME: "bearer", OPTIO_HTTP_AUTH_TOKEN: "  " }).authValue,
    ).toBeNull();
  });

  it("parses extra headers as a JSON object", () => {
    expect(
      cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/vnd.pagerduty+json;version=2"}' })
        .extraHeaders,
    ).toEqual({
      Accept: "application/vnd.pagerduty+json;version=2",
    });
    expect(cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: "" }).extraHeaders).toEqual({});
    expect(() => cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: "[1]" })).toThrow(/JSON object/);
    expect(() => cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: "{nope" })).toThrow(/JSON object/);
    expect(() => cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: '{"A":1}' })).toThrow(/must be a string/);
    expect(() => cfgWith({ OPTIO_HTTP_EXTRA_HEADERS: '{"authorization":"x"}' })).toThrow(
      /auth header/,
    );
  });
});

describe("resolvePath", () => {
  const b = parseConfig(base).baseUrl;

  it("resolves under the base path with or without a leading slash", () => {
    expect(resolvePath(b, "/users")).toMatchObject({
      ok: true,
      url: new URL("https://api.example.com/v2/users"),
    });
    expect(resolvePath(b, "users/1")).toMatchObject({
      ok: true,
      url: new URL("https://api.example.com/v2/users/1"),
    });
    expect(resolvePath(b, "")).toMatchObject({ ok: false });
  });

  it("rejects absolute URLs and protocol-relative paths", () => {
    expect(resolvePath(b, "https://evil.example/x")).toMatchObject({
      ok: false,
      error: /no scheme or host/,
    });
    expect(resolvePath(b, "HTTP://evil.example/x")).toMatchObject({ ok: false });
    expect(resolvePath(b, "//evil.example/x")).toMatchObject({ ok: false });
    expect(resolvePath(b, "javascript:alert(1)")).toMatchObject({ ok: false });
  });

  it("rejects .. escapes, encoded or not", () => {
    expect(resolvePath(b, "../admin")).toMatchObject({ ok: false, error: /\.\./ });
    expect(resolvePath(b, "/users/../../admin")).toMatchObject({ ok: false });
    expect(resolvePath(b, "/users/%2e%2e/admin")).toMatchObject({ ok: false });
    expect(resolvePath(b, "/users/..\\admin")).toMatchObject({ ok: false });
  });

  it("keeps a query string carried in the path", () => {
    const r = resolvePath(b, "/users?limit=5");
    expect(r.ok && r.url.href).toBe("https://api.example.com/v2/users?limit=5");
  });

  it("allows anything on a root base URL", () => {
    const root = parseConfig({ OPTIO_HTTP_BASE_URL: "https://api.example.com" }).baseUrl;
    expect(resolvePath(root, "/anything/at/all")).toMatchObject({ ok: true });
  });
});

describe("buildRequest", () => {
  it("adds the auth header and extra headers", () => {
    const cfg = cfgWith({
      OPTIO_HTTP_AUTH_VALUE: "Bearer secret",
      OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/json"}',
    });
    const h = headersOf(buildRequest(cfg, { method: "GET", path: "/users" }));
    expect(h.get("authorization")).toBe("Bearer secret");
    expect(h.get("accept")).toBe("application/json");
  });

  it("sends no auth header when there is no auth value", () => {
    const h = headersOf(buildRequest(cfgWith({}), { method: "GET", path: "/users" }));
    expect(h.has("authorization")).toBe(false);
  });

  it("ignores the caller's attempts to override auth and static headers", () => {
    const cfg = cfgWith({
      OPTIO_HTTP_AUTH_HEADER: "X-Api-Key",
      OPTIO_HTTP_AUTH_VALUE: "real",
      OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/json"}',
    });
    const h = headersOf(
      buildRequest(cfg, {
        method: "GET",
        path: "/users",
        headers: { "x-api-key": "fake", ACCEPT: "text/html", "X-Trace": "1" },
      }),
    );
    expect(h.get("x-api-key")).toBe("real");
    expect(h.get("accept")).toBe("application/json");
    expect(h.get("x-trace")).toBe("1");
  });

  it("encodes query parameters", () => {
    const r = buildRequest(cfgWith({}), {
      method: "GET",
      path: "/search?q=a b",
      query: { page: 2, active: true, name: "x&y=z" },
    });
    expect(r.ok && r.url.href).toBe(
      "https://api.example.com/v2/search?q=a+b&page=2&active=true&name=x%26y%3Dz",
    );
  });

  it("JSON-encodes the body with application/json", () => {
    const r = buildRequest(cfgWith({}), { method: "POST", path: "/users", body: { name: "a" } });
    expect(r.ok && r.init.body).toBe('{"name":"a"}');
    expect(headersOf(r).get("content-type")).toBe("application/json");
  });

  it("sends a string body as-is when the caller set content-type", () => {
    const r = buildRequest(cfgWith({}), {
      method: "POST",
      path: "/upload",
      headers: { "content-type": "text/csv" },
      body: "a,b\n1,2",
    });
    expect(r.ok && r.init.body).toBe("a,b\n1,2");
    expect(headersOf(r).get("content-type")).toBe("text/csv");
  });

  it("rejects a body on GET, an oversized body, and a bad method", () => {
    expect(buildRequest(cfgWith({}), { method: "GET", path: "/x", body: {} })).toMatchObject({
      ok: false,
      error: /GET/,
    });
    expect(
      buildRequest(cfgWith({}), {
        method: "POST",
        path: "/x",
        body: "x".repeat(REQUEST_BODY_LIMIT + 1),
      }),
    ).toMatchObject({ ok: false, error: /exceeds/ });
    expect(buildRequest(cfgWith({}), { method: "HEAD" as never, path: "/x" })).toMatchObject({
      ok: false,
      error: /method/,
    });
  });

  it("returns an error (no request) for an escaping path", () => {
    expect(
      buildRequest(cfgWith({}), { method: "GET", path: "https://evil.example/" }),
    ).toMatchObject({ ok: false });
    expect(buildRequest(cfgWith({}), { method: "GET", path: "../x" })).toMatchObject({ ok: false });
  });

  it("sets a timeout signal and does not follow redirects", () => {
    const r = buildRequest(cfgWith({}), { method: "DELETE", path: "/x" });
    expect(r.ok && r.init.signal).toBeInstanceOf(AbortSignal);
    expect(r.ok && r.init.redirect).toBe("manual");
  });
});

describe("shapeResponse", () => {
  it("pretty-prints JSON and formats the status line", async () => {
    const res = new Response('{"a":1}', {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
    });
    const shaped = await shapeResponse(res);
    expect(shaped.text).toBe('HTTP 201 Created\napplication/json\n\n{\n  "a": 1\n}');
    expect(shaped.truncated).toBe(false);
  });

  it("returns non-JSON as received", async () => {
    const shaped = await shapeResponse(
      new Response("hi", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    expect(shaped.body).toBe("hi");
    expect(shaped.text.startsWith("HTTP 500")).toBe(true);
  });
});

describe("describeConfig / redact", () => {
  it("names the auth header but never its value", () => {
    const cfg = cfgWith({
      OPTIO_HTTP_NAME: "pylon",
      OPTIO_HTTP_DESCRIPTION: "Pylon support tickets",
      OPTIO_HTTP_AUTH_VALUE: "Bearer supersecrettoken",
      OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/json"}',
    });
    const text = describeConfig(cfg);
    expect(text).toContain("name: pylon");
    expect(text).toContain("Pylon support tickets");
    expect(text).toContain("auth header: Authorization");
    expect(text).toContain("extra headers: Accept");
    expect(text).not.toContain("supersecrettoken");
    expect(redact(cfg, "leak Bearer supersecrettoken and supersecrettoken")).toBe(
      "leak [redacted] and [redacted]",
    );
  });
});
