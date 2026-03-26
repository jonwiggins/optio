import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const WEB_URL = process.env.WEB_PUBLIC_URL ?? "";
const SESSION_COOKIE_NAME = "optio_session";

/**
 * Logout: revoke the session on the API, clear the cookie, redirect to login.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  // Revoke session on the API (best-effort)
  if (token) {
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });
    } catch {
      // best-effort
    }
  }

  const loginUrl = WEB_URL ? new URL("/login", WEB_URL) : new URL("/login", request.url);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });
  response.cookies.set("optio_token", "", {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: 0,
  });
  return response;
}
