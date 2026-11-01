import type { FastifyRequest } from "fastify";

/**
 * The peers whose `X-Forwarded-For` the API believes (`OPTIO_TRUST_PROXY`,
 * Fastify's `trustProxy`), for `req.ip`: what the rate limits and the
 * WebSocket connection cap key on.
 *
 * Default: loopback only — the web container's proxy in the same pod
 * (`apps/web/src/app/api/[...path]/route.ts`), which forwards the address
 * of the browser it serves. Behind an ingress or load balancer that talks to
 * the API directly, list its addresses: comma-separated IPs or CIDRs, or
 * proxy-addr's names `loopback`, `linklocal`, `uniquelocal`. `req.ip` is
 * then the nearest address in the chain that isn't one of them. A client
 * talking to the API directly is never a trusted peer, so whatever it puts
 * in `X-Forwarded-For` is ignored.
 *
 * `true` (trust every peer) is refused: it would let any client choose its
 * own address. A hop count isn't offered either (Fastify 5 refuses to
 * validate the immediate peer with one).
 */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OPTIO_TRUST_PROXY?.trim();
  if (!raw) return ["loopback"];
  if (/^(true|\*|\d+)$/i.test(raw)) {
    throw new Error(
      `OPTIO_TRUST_PROXY=${raw} would let a client choose its own address: list the proxies' addresses (IPs, CIDRs, "loopback") instead`,
    );
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Requests the global rate limit doesn't count: the API's own pod calling
 * itself over loopback with no client behind it (the web's server-side
 * calls). A request the web proxy forwards for a browser carries that
 * browser's address in `X-Forwarded-For` and counts like any other client.
 */
export function rateLimitExempt(req: Pick<FastifyRequest, "headers" | "socket">): boolean {
  return LOOPBACK.has(req.socket?.remoteAddress ?? "") && !req.headers["x-forwarded-for"];
}
