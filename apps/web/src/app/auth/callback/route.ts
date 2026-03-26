import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const WEB_URL = process.env.WEB_PUBLIC_URL ?? "";
const SESSION_COOKIE_NAME = "optio_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/** Build an absolute redirect URL using WEB_PUBLIC_URL or the request's origin. */
function redirectUrl(path: string, request: NextRequest): URL {
  if (WEB_URL) return new URL(path, WEB_URL);
  return new URL(path, request.url);
}

function isSecure(request: NextRequest): boolean {
  if (WEB_URL) return WEB_URL.startsWith("https://");
  return request.nextUrl.protocol === "https:";
}

/**
 * OAuth callback relay: the API redirects here with a short-lived auth code.
 * We exchange it for the real session token and set the cookie on our own origin.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(redirectUrl("/login?error=missing_code", request));
  }

  try {
    const res = await fetch(`${API_URL}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      return NextResponse.redirect(redirectUrl("/login?error=exchange_failed", request));
    }

    const { token } = (await res.json()) as { token: string };

    const response = NextResponse.redirect(redirectUrl("/", request));
    // HttpOnly cookie for Next.js middleware auth check
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure(request),
      maxAge: COOKIE_MAX_AGE,
    });
    // JS-readable cookie for the API client to send as Bearer token
    response.cookies.set("optio_token", token, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      secure: isSecure(request),
      maxAge: COOKIE_MAX_AGE,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=exchange_failed", request.url));
  }
}
