import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/setup", "/auth/callback"];
const SESSION_COOKIE_NAME = "optio_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth check for public paths, static assets, and API routes
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // If auth is disabled server-side, the API returns a synthetic user.
  // We check for the session cookie client-side; middleware only redirects
  // if no cookie is present AND auth is not disabled.
  // Since middleware can't call the API, we use an env var check.
  const authDisabled = process.env.NEXT_PUBLIC_AUTH_DISABLED === "true";
  if (authDisabled) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (!sessionCookie?.value) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
