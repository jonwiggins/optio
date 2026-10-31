import { isIP, isIPv4 } from "node:net";

/**
 * OPTIO_TRUST_PROXY holds something that is neither an address, a CIDR nor
 * "loopback". The API refuses to start rather than fail later inside
 * Fastify's proxy-addr with a bare TypeError.
 */
export class TrustProxyConfigError extends Error {
  constructor(readonly entry: string) {
    super(
      `OPTIO_TRUST_PROXY: "${entry}" is not an IP address, a CIDR (10.0.5.17/32) or "loopback"; ` +
        "set the ingress controller's addresses, comma-separated, or leave it empty",
    );
    this.name = "TrustProxyConfigError";
  }
}

/**
 * proxy-addr's named ranges other than "loopback": "uniquelocal" is every
 * private range (10/8, 172.16/12, 192.168/16, fc00::/7) and so every agent
 * pod, "linklocal" every link-local address. Either one trusts the agents.
 */
const BROAD_KEYWORDS = new Set(["uniquelocal", "linklocal"]);

/**
 * A prefix this short holds far more than an ingress controller: it is
 * "true" with extra steps.
 */
const MIN_PREFIX = { 4: 8, 6: 16 } as const;

/** The prefix length of a dotted IPv4 netmask, or null when it isn't one. */
function netmaskBits(mask: string): number | null {
  if (!isIPv4(mask)) return null;
  const n = mask.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  const bits = n.toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(bits)) return null;
  const firstZero = bits.indexOf("0");
  return firstZero === -1 ? 32 : firstZero;
}

/** "broad" for an entry that trusts too much, else whether it parses. */
function classify(entry: string): "ok" | "broad" | "invalid" {
  const lower = entry.toLowerCase();
  if (lower === "loopback") return "ok";
  if (BROAD_KEYWORDS.has(lower)) return "broad";
  const slash = entry.indexOf("/");
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (family !== 4 && family !== 6) return "invalid";
  if (slash === -1) return "ok";
  const range = entry.slice(slash + 1);
  let bits: number | null = null;
  if (/^\d{1,3}$/.test(range)) bits = Number(range);
  else if (family === 4) bits = netmaskBits(range);
  if (bits === null || bits > (family === 4 ? 32 : 128)) return "invalid";
  return bits < MIN_PREFIX[family] ? "broad" : "ok";
}

type Parsed = { trust: false | string[]; ignored: string | null };

const INSTEAD = "set the ingress controller's own IPs (or a CIDR holding only them) instead";

function parse(raw: string | undefined): Parsed {
  const value = (raw ?? "").trim();
  if (!value || value === "false" || value === "0") return { trust: false, ignored: null };
  if (value === "true") {
    return {
      trust: false,
      ignored: `OPTIO_TRUST_PROXY="true" is ignored (it would let any client spoof its address); ${INSTEAD}`,
    };
  }
  if (/^\d+$/.test(value)) {
    return {
      trust: false,
      ignored: `OPTIO_TRUST_PROXY="${value}" is ignored (hop counts are not supported); ${INSTEAD}`,
    };
  }
  const entries = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const broad: string[] = [];
  for (const entry of entries) {
    const kind = classify(entry);
    if (kind === "invalid") throw new TrustProxyConfigError(entry);
    if (kind === "broad") broad.push(entry);
  }
  if (broad.length > 0) {
    return {
      trust: false,
      ignored:
        `OPTIO_TRUST_PROXY is ignored: ${broad.map((b) => `"${b}"`).join(", ")} covers far more ` +
        `than an ingress controller (agent pods included), which is as unsafe as "true"; ${INSTEAD}`,
    };
  }
  return { trust: entries, ignored: null };
}

/**
 * Fastify's `trustProxy` from OPTIO_TRUST_PROXY: whose X-Forwarded-For the
 * API believes, so `req.ip` — what the rate limits count, and the sign-in
 * limits most of all — is the person's address, not the ingress
 * controller's. Behind an ingress every request arrives from the
 * controller, and counting by its address put the whole organization in one
 * bucket (600 requests and 10 sign-ins a minute, for everyone).
 *
 *   ""  / unset   → false: believe nobody (the API is reached directly)
 *   "1", "2", …   → false: Fastify rejects hop-only trust
 *                    (configure explicit proxy addresses / CIDRs instead)
 *   "true"        → false: unrestricted proxy trust allows spoofed loopback IPs
 *   "uniquelocal", "linklocal", a CIDR shorter than /8 (IPv6 /16)
 *                 → false: as broad as "true"; agent pods could spoof too
 *   addresses / CIDRs / "loopback", comma-separated → those
 *   anything else → TrustProxyConfigError (the API doesn't start)
 *
 * A CIDR that still covers the agent pods (a cluster's whole pod CIDR) can't
 * be told apart here; docs/audit.md says to list the controller only.
 */
export function trustProxyFromEnv(
  raw: string | undefined = process.env.OPTIO_TRUST_PROXY,
): boolean | string[] {
  return parse(raw).trust;
}

/**
 * Why OPTIO_TRUST_PROXY was ignored, for a startup warning: "true", hop
 * counts and ranges as broad as "true" read as "trust nobody", so without it
 * every client is recorded (and rate limited) as the ingress controller's
 * address with no sign of why. Null when the value is honoured or unset.
 */
export function ignoredTrustProxyReason(
  raw: string | undefined = process.env.OPTIO_TRUST_PROXY,
): string | null {
  return parse(raw).ignored;
}
