import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { authCookieName, secureAuthCookies } from "../../../lib/auth-cookies.js";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";

/**
 * BFF (Backend for Frontend) proxy route.
 *
 * All client-side `/api/*` requests are routed here. The handler:
 * 1. Reads the HttpOnly session cookie (invisible to client-side JS)
 * 2. Forwards the request to the real API with an Authorization header
 * 3. Returns the API response transparently
 *
 * This keeps the session token out of client-side JavaScript entirely,
 * eliminating XSS-based session hijacking.
 */
async function proxyRequest(request: NextRequest) {
  const url = new URL(request.url);
  const targetUrl = new URL(`${INTERNAL_API_URL}${url.pathname}${url.search}`);
  const isMcp = url.pathname === "/api/mcp";
  const isLdapLogin = request.method === "POST" && url.pathname === "/api/auth/ldap/login";
  const browserVerifier =
    (request.method === "GET" && /^\/api\/auth\/[^/]+\/login$/.test(url.pathname)) || isLdapLogin
      ? randomBytes(32).toString("base64url")
      : undefined;
  if (browserVerifier) {
    targetUrl.searchParams.set(
      "browserChallenge",
      createHash("sha256").update(browserVerifier).digest("base64url"),
    );
  }

  // SameSite cookies still accompany requests from hostile sibling origins.
  // Check before converting ambient cookies into an explicit Bearer token.
  if (!isMcp && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    const expected = new URL(process.env.PUBLIC_URL ?? request.url).origin;
    if (origin && origin !== expected) {
      return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
    }
  }

  const headers = new Headers();

  // Forward safe request headers
  const forwardHeaders = ["content-type", "accept", "x-workspace-id", "x-optio-setup-token"];
  for (const name of forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The browser's address, so the API's per-client limits count this browser
  // rather than this proxy (the API believes it from loopback only:
  // OPTIO_TRUST_PROXY). Next fills it from the socket when nothing in front
  // of the web set it; a proxy in front appends the address it saw.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  if (isMcp) {
    // MCP is a bearer-authenticated integration, not a cookie-authenticated
    // UI request. Preserve its Origin and Host for the controller's checks.
    for (const name of ["authorization", "origin", "host", "mcp-protocol-version"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }

  // Inject session token as Bearer header (from HttpOnly cookie)
  const sessionToken = request.cookies.get(authCookieName("session"))?.value;
  if (sessionToken && !isMcp) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }

  try {
    // OAuth login routes return 302 redirects that the browser must follow
    // directly (to GitHub, Google, etc.). Don't let fetch() silently follow
    // them — pass the redirect through to the browser instead.
    const isAuthRedirect = url.pathname.match(/^\/api\/auth\/[^/]+\/(login|callback)$/);

    const fetchInit: RequestInit = {
      method: request.method,
      headers,
      redirect: isAuthRedirect || isMcp ? "manual" : "follow",
    };

    // Forward request body for non-GET/HEAD methods
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (isMcp) {
        // Undici may replay a body on an authentication challenge. A raw
        // stream has no replayable source and turns a legitimate 401 into a
        // fetch failure. MCP RPCs are small: buffer within the API's limit.
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) {
            await reader.cancel();
            return NextResponse.json({ error: "MCP request too large" }, { status: 413 });
          }
          chunks.push(value);
        }
        const body = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          body.set(chunk, at);
          at += chunk.byteLength;
        }
        fetchInit.body = body.buffer;
      } else {
        fetchInit.body = request.body;
        // @ts-expect-error duplex is required for streaming request bodies in Node
        fetchInit.duplex = "half";
      }
    }

    const apiRes = await fetch(targetUrl, fetchInit);

    // For auth redirects, pass the Location header through to the browser
    if (isAuthRedirect && apiRes.status >= 300 && apiRes.status < 400) {
      const location = apiRes.headers.get("location");
      if (location) {
        const response = NextResponse.redirect(location, apiRes.status);
        if (browserVerifier) {
          response.cookies.set(authCookieName("oauth_verifier"), browserVerifier, {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            secure: secureAuthCookies(),
            maxAge: 600,
          });
        }
        return response;
      }
    }

    // Build a clean response — don't forward Set-Cookie or other sensitive
    // headers from the API that could conflict with the web origin.
    const responseHeaders = new Headers();
    const safeResponseHeaders = ["content-type", "content-length", "cache-control", "etag"];
    if (isMcp) safeResponseHeaders.push("www-authenticate", "allow", "mcp-protocol-version");
    for (const name of safeResponseHeaders) {
      const value = apiRes.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    const response = new NextResponse(apiRes.body, {
      status: apiRes.status,
      statusText: apiRes.statusText,
      headers: responseHeaders,
    });
    if (isLdapLogin && apiRes.ok && browserVerifier) {
      response.cookies.set(authCookieName("oauth_verifier"), browserVerifier, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: secureAuthCookies(),
        maxAge: 600,
      });
    }
    return response;
  } catch {
    return NextResponse.json({ error: "API proxy error" }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
