/**
 * Fastify's `trustProxy` from OPTIO_TRUST_PROXY: whose X-Forwarded-For the
 * API believes, so `req.ip` — what the rate limits count, and the sign-in
 * limits most of all — is the person's address, not the ingress
 * controller's. Behind an ingress every request arrives from the
 * controller, and counting by its address put the whole organization in one
 * bucket (600 requests and 10 sign-ins a minute, for everyone).
 *
 *   ""  / unset   → false: believe nobody (the API is reached directly)
 *   "1", "2", …   → that many proxy hops (the chart sets 1 with an ingress)
 *   "true"        → any proxy — only when nothing else can reach the API
 *   anything else → addresses / CIDRs, comma-separated
 */
export function trustProxyFromEnv(
  raw: string | undefined = process.env.OPTIO_TRUST_PROXY,
): boolean | number | string[] {
  const value = (raw ?? "").trim();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
