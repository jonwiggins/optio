// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { GET, POST } from "./[provider]/route.js";
import { signInPath } from "../../../lib/sign-in-path.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * The chart's ingress (and most hand-written ones) sends `/api` straight to
 * the API, so a sign-in that starts at `/api/auth/:provider/login` never
 * passes the web server that creates the browser verifier, and the API
 * refuses it ("Start sign-in from the web app"). Sign-in therefore starts on
 * a path the web server always owns.
 */
describe("sign-in starts on the web server's own path", () => {
  it("is outside /api, which an ingress may route to the API", () => {
    expect(signInPath("oidc")).toBe("/auth/login/oidc");
    expect(signInPath("oidc").startsWith("/api")).toBe(false);
  });

  it("starts a redirect sign-in with a private verifier and sends only its hash to the API", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example");
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://idp.example/authorize?state=abc" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await GET(
      new NextRequest("https://optio.example/auth/login/oidc?browserChallenge=attacker"),
      params("oidc"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example/authorize?state=abc");
    const verifier = response.cookies.get("__Host-optio_oauth_verifier")!;
    expect(verifier.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const target = new URL(fetch.mock.calls[0][0]);
    expect(target.pathname).toBe("/api/auth/oidc/login");
    expect([...target.searchParams.keys()]).toEqual(["browserChallenge"]);
    expect(target.searchParams.get("browserChallenge")).toBe(challengeOf(verifier.value));
  });

  it("binds a password sign-in the same way and keeps the Origin check", async () => {
    vi.stubEnv("PUBLIC_URL", "https://optio.example");
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: "ldap-code" }));
    vi.stubGlobal("fetch", fetch);
    const request = (origin: string) =>
      new NextRequest("https://optio.example/auth/login/ldap", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username: "ada", password: "test-password" }),
      });
    const response = await POST(request("https://optio.example"), params("ldap"));
    expect(await response.json()).toEqual({ code: "ldap-code" });
    const verifier = response.cookies.get("__Host-optio_oauth_verifier")!;
    const [target, init] = fetch.mock.calls[0];
    expect(new URL(target).pathname).toBe("/api/auth/ldap/login");
    expect(new URL(target).searchParams.get("browserChallenge")).toBe(challengeOf(verifier.value));
    expect(init.method).toBe("POST");
    expect(await new Response(init.body).json()).toEqual({
      username: "ada",
      password: "test-password",
    });

    const hostile = await POST(request("https://evil.example"), params("ldap"));
    expect(hostile.status).toBe(403);
    expect(hostile.cookies.get("__Host-optio_oauth_verifier")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a provider name that is not a plain name without calling the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["../internal", "a/b", "oidc?x=1", "", "a".repeat(65)]) {
      const response = await GET(
        new NextRequest("https://optio.example/auth/login/x"),
        params(provider),
      );
      expect(response.status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
