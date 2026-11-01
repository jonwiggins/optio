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
 * Requests the rate limits don't count: those whose client, as `req.ip`
 * resolves it through the trusted proxies, is on the API's own host — the
 * pod calling itself (the web's server-side calls) and a browser on the same
 * machine (local development, the e2e stack), as before per-client keying.
 * A request the web proxy forwards for any other browser carries that
 * browser's address and counts like any other client; a client talking to
 * the API directly can't claim loopback, because only trusted peers'
 * `X-Forwarded-For` is believed.
 */
export function rateLimitExempt(req: Pick<FastifyRequest, "ip">): boolean {
  return LOOPBACK.has(req.ip ?? "");
}
