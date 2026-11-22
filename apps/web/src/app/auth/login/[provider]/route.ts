import { NextRequest, NextResponse } from "next/server";
import { GET as proxyGet, POST as proxyPost } from "../../../api/[...path]/route.js";

type Context = { params: Promise<{ provider: string }> };

/**
 * Start a sign-in from a path the web server always owns.
 *
 * The API only starts a browser sign-in that carries the challenge of a
 * verifier cookie, and the `/api` proxy is what creates both. Behind an
 * ingress that sends `/api` straight to the API (the Helm chart's does), a
 * browser that went to `/api/auth/:provider/login` never reached that proxy
 * and the API answered 400. `/auth/login/:provider` is routed to the web like
 * `/auth/callback`, and hands the request to the same proxy code, so the
 * verifier, the Origin check and the redirect are the ones it already has.
 * Nothing of the caller's query string is forwarded.
 */
async function start(request: NextRequest, context: Context) {
  const { provider } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const target = new URL(`/api/auth/${provider}/login`, request.url);
  if (request.method === "POST") {
    return proxyPost(
      new NextRequest(target, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        duplex: "half",
      }),
    );
  }
  return proxyGet(new NextRequest(target, { headers: request.headers }));
}

export const GET = start;
export const POST = start;
