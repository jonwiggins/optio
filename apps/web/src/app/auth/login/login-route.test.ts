// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./[provider]/route.js";
import { signInPath } from "../../../lib/sign-in-path.js";

/**
 * The proxy draws the verifier from `randomBytes(32)`. Here those bytes are
 * known (32 times `random.fill`), so the verifier cookie and the challenge the
 * API must receive are constants and the test hashes nothing itself:
 *
 *   v = Buffer.alloc(32, fill).toString("base64url")
 *   challenge = createHash("sha256").update(v).digest("base64url")
 */
const random = vi.hoisted(() => ({ fill: 0, sizes: [] as number[] }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomBytes: (size: number) => {
    random.sizes.push(size);
    return Buffer.alloc(size, random.fill);
  },
}));
const KNOWN = {
  1: {
    verifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    challenge: "VtX6czP210fbQsI5QH5dpMMvTHnzXQkrE0_TWkAtnFw",
  },
  2: {
    verifier: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
    challenge: "bB1ju9q0N8VDaMu9iIaohqea2XcpfiZe6_H19fAVM7k",
  },
} as const;

afterEach(() => {
  random.sizes.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

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
    random.fill = 1;
    const response = await GET(
      new NextRequest("https://optio.example/auth/login/oidc?browserChallenge=attacker"),
      params("oidc"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example/authorize?state=abc");
    const verifier = response.cookies.get("__Host-optio_oauth_verifier")!;
    expect(random.sizes).toEqual([32]);
    expect(verifier.value).toBe(KNOWN[1].verifier);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const target = new URL(fetch.mock.calls[0][0]);
    expect(target.pathname).toBe("/api/auth/oidc/login");
    expect([...target.searchParams.keys()]).toEqual(["browserChallenge"]);
    expect(target.searchParams.get("browserChallenge")).toBe(KNOWN[1].challenge);
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
    random.fill = 2;
    const response = await POST(request("https://optio.example"), params("ldap"));
    expect(await response.json()).toEqual({ code: "ldap-code" });
    expect(response.cookies.get("__Host-optio_oauth_verifier")!.value).toBe(KNOWN[2].verifier);
    const [target, init] = fetch.mock.calls[0];
    expect(new URL(target).pathname).toBe("/api/auth/ldap/login");
    expect(new URL(target).searchParams.get("browserChallenge")).toBe(KNOWN[2].challenge);
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
