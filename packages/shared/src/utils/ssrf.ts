import * as dns from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound URL guard (SSRF protection).
 *
 * Every URL a person typed that the server itself will fetch — an outbound
 * webhook, a Slack notification, a ticket provider's API, a connection's
 * health check — goes through here. The routes that take such URLs are
 * already admin- or member-only; this is defence in depth against an account
 * that is allowed to configure them.
 *
 * Three layers:
 *  1. `isSsrfSafeUrl` / `isSsrfSafeHost` — synchronous, from the URL text
 *     alone: IP literals (the URL parser already normalises `2130706433`,
 *     `0x7f000001` and `127.1` to `127.0.0.1`) and tell-tale host names.
 *     For Zod schemas.
 *  2. `vetOutboundUrl` / `assertSsrfSafe` — asynchronous: resolves the host
 *     and classifies EVERY answer. Call right before the fetch. The API's
 *     `guardedFetch` (apps/api/src/utils/outbound-url.ts) then connects to the
 *     vetted addresses only, so the DNS answer cannot change between the check
 *     and the connect.
 *  3. The policy (`outboundPolicyFromEnv`):
 *     - loopback, unspecified, link-local (where cloud metadata lives),
 *       multicast and reserved addresses, and the metadata host names, are
 *       blocked unless the host or address is listed;
 *     - private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) and
 *       internal-looking names (`.internal`, `.local`, `*.svc.cluster.local`)
 *       are blocked by default; `OPTIO_OUTBOUND_ALLOW_PRIVATE=true` allows
 *       them — an in-cluster API is a legitimate target;
 *     - `OPTIO_OUTBOUND_ALLOWED_HOSTS` lists host names, `*.suffix` names,
 *       IP addresses or CIDRs that are always allowed, loopback included;
 *     - `OPTIO_ALLOW_PRIVATE_URLS=1` (older; local dev only) disables the
 *       guard entirely.
 *
 * Messages name the host and the address class, never a path, query string,
 * header or body.
 */

export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "unspecified"
  | "link-local"
  | "multicast"
  | "reserved"
  | "metadata";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it has (`dns.lookup({ all: true })`). */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface OutboundPolicy {
  /** Private ranges and internal-looking names may be fetched. */
  allowPrivate: boolean;
  /** Hosts, `*.suffix` names, IPs or CIDRs that are always allowed. */
  allowedHosts: readonly string[];
  /** The guard is off (`OPTIO_ALLOW_PRIVATE_URLS=1`, local dev only). */
  allowAll: boolean;
}

export interface OutboundDecision {
  allowed: boolean;
  /** Why not, for people: host and address class, nothing else. */
  reason?: string;
  addressClass?: AddressClass;
  address?: string;
}

export interface VetOptions {
  policy?: OutboundPolicy;
  resolveHost?: HostResolver;
  signal?: AbortSignal;
}

export interface VettedUrl {
  url: URL;
  /** Lower-cased, trailing dot and IPv6 brackets removed. */
  hostname: string;
  /** Every address the host resolved to (the literal itself for an IP URL). */
  addresses: ResolvedAddress[];
}

export class SsrfError extends Error {
  readonly hostname?: string;
  readonly addressClass?: AddressClass;
  readonly address?: string;

  constructor(
    message: string,
    details: { hostname?: string; addressClass?: AddressClass; address?: string } = {},
  ) {
    super(message);
    this.name = "SsrfError";
    this.hostname = details.hostname;
    this.addressClass = details.addressClass;
    this.address = details.address;
  }
}

// ── Address parsing ──────────────────────────────────────────────────────────

/** Dotted IPv4 → 32-bit unsigned, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** IPv6 text (compressed, with an optional embedded dotted IPv4) → 8 hextets, or null. */
function ipv6ToHextets(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  // An embedded dotted IPv4 tail becomes two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const h of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** The IPv4 inside an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) address. */
function embeddedIpv4(h: number[]): number | null {
  const tail = ((h[6]! << 16) | h[7]!) >>> 0;
  const zeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && h[5] === 0xffff) return tail;
  if (zeroTo(6) && tail !== 0 && tail !== 1) return tail;
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return tail;
  return null;
}

const METADATA_IPV4 = new Set([
  "169.254.169.254", // AWS, GCP, Azure, OpenStack, Oracle
  "100.100.100.200", // Alibaba Cloud
]);

function classifyIpv4(n: number): AddressClass {
  const dotted = intToIpv4(n);
  if (METADATA_IPV4.has(dotted)) return "metadata";
  const inRange = (base: string, bits: number) =>
    n >>> (32 - bits) === ipv4ToInt(base)! >>> (32 - bits);
  if (inRange("127.0.0.0", 8)) return "loopback";
  if (inRange("0.0.0.0", 8)) return "unspecified";
  if (inRange("169.254.0.0", 16)) return "link-local";
  if (inRange("224.0.0.0", 4)) return "multicast";
  if (
    inRange("240.0.0.0", 4) || // reserved, incl. 255.255.255.255
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("192.88.99.0", 24) || // deprecated 6to4 relay anycast
    inRange("198.18.0.0", 15) // benchmarking
  ) {
    return "reserved";
  }
  if (
    inRange("10.0.0.0", 8) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.168.0.0", 16) ||
    inRange("100.64.0.0", 10) // carrier-grade NAT
  ) {
    return "private";
  }
  return "public";
}

function classifyIpv6(h: number[]): AddressClass {
  const embedded = embeddedIpv4(h);
  if (embedded !== null) return classifyIpv4(embedded);
  if (h.every((x) => x === 0)) return "unspecified";
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return "loopback";
  if ((h[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((h[0]! & 0xff00) === 0xff00) return "multicast";
  // AWS IMDS over IPv6 sits inside fd00::/8; it must stay blocked under allowPrivate.
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && h.slice(2, 7).every((x) => x === 0) && h[7] === 0x254) {
    return "metadata";
  }
  if ((h[0]! & 0xfe00) === 0xfc00) return "private"; // unique-local
  if ((h[0]! & 0xffc0) === 0xfec0) return "private"; // site-local (deprecated)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return "reserved"; // documentation
  return "public";
}

/** The class of an IPv4 or IPv6 address; `null` when the text is not an address. */
export function classifyAddress(ip: string): AddressClass | null {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const version = isIP(bare);
  if (version === 4) {
    const n = ipv4ToInt(bare);
    return n === null ? null : classifyIpv4(n);
  }
  if (version === 6) {
    const h = ipv6ToHextets(bare);
    return h === null ? null : classifyIpv6(h);
  }
  return null;
}

// ── Host names ───────────────────────────────────────────────────────────────

/** Host names that are the cloud metadata service wherever the API runs. */
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Suffixes that name an internal network, not the Internet. */
const INTERNAL_NAME_SUFFIXES = [".internal", ".local", ".localdomain", ".home.arpa"];

/** Lower-cased, without trailing dots or IPv6 brackets. */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

/** What the name alone says about a host; `null` when it says nothing. */
function classifyHostname(host: string): Exclude<AddressClass, "public"> | null {
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (METADATA_HOSTNAMES.has(host)) return "metadata";
  if (INTERNAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "private";
  return null;
}

// ── Policy ───────────────────────────────────────────────────────────────────

function envFlag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => normalizeHostname(entry))
    .filter(Boolean);
}

const DEFAULT_POLICY: OutboundPolicy = { allowPrivate: false, allowedHosts: [], allowAll: false };

let cachedPolicy: { key: string; policy: OutboundPolicy } | null = null;

/** The policy the environment describes (re-read on every call; cheap). */
export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const key = [
    env.OPTIO_OUTBOUND_ALLOW_PRIVATE ?? "",
    env.OPTIO_OUTBOUND_ALLOWED_HOSTS ?? "",
    env.OPTIO_ALLOW_PRIVATE_URLS ?? "",
  ].join("\u0000");
  if (cachedPolicy?.key === key) return cachedPolicy.policy;
  const policy: OutboundPolicy = {
    allowPrivate: envFlag(env.OPTIO_OUTBOUND_ALLOW_PRIVATE),
    allowedHosts: parseAllowedHosts(env.OPTIO_OUTBOUND_ALLOWED_HOSTS),
    allowAll: (env.OPTIO_ALLOW_PRIVATE_URLS ?? "").trim() === "1",
  };
  cachedPolicy = { key, policy };
  return policy;
}

interface AllowEntry {
  kind: "host" | "suffix" | "ip" | "cidr";
  value: string;
  bits?: number;
}

const allowEntryCache = new WeakMap<readonly string[], AllowEntry[]>();

function allowEntries(policy: OutboundPolicy): AllowEntry[] {
  const cached = allowEntryCache.get(policy.allowedHosts);
  if (cached) return cached;
  const entries: AllowEntry[] = [];
  for (const raw of policy.allowedHosts) {
    const entry = normalizeHostname(raw);
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash !== -1) {
      const base = entry.slice(0, slash);
      const bits = Number(entry.slice(slash + 1));
      const version = isIP(base);
      const max = version === 4 ? 32 : version === 6 ? 128 : 0;
      if (max && Number.isInteger(bits) && bits >= 0 && bits <= max) {
        entries.push({ kind: "cidr", value: base, bits });
      }
      continue;
    }
    if (isIP(entry)) entries.push({ kind: "ip", value: entry });
    else if (entry.startsWith("*.")) entries.push({ kind: "suffix", value: entry.slice(1) });
    else entries.push({ kind: "host", value: entry });
  }
  allowEntryCache.set(policy.allowedHosts, entries);
  return entries;
}

function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  if (isIP(a) === 6 && isIP(b) === 6) {
    const ha = ipv6ToHextets(a);
    const hb = ipv6ToHextets(b);
    return !!ha && !!hb && ha.every((x, i) => x === hb[i]);
  }
  return false;
}

function inCidr(address: string, base: string, bits: number): boolean {
  const va = isIP(address);
  const vb = isIP(base);
  if (va !== vb) return false;
  if (va === 4) {
    const a = ipv4ToInt(address);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    return a >>> (32 - bits) === b >>> (32 - bits);
  }
  const ha = ipv6ToHextets(address);
  const hb = ipv6ToHextets(base);
  if (!ha || !hb) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((ha[i]! & mask) !== (hb[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

function hostListed(host: string, policy: OutboundPolicy): boolean {
  return allowEntries(policy).some(
    (e) =>
      (e.kind === "host" && e.value === host) ||
      (e.kind === "suffix" && host.endsWith(e.value) && host.length > e.value.length) ||
      (e.kind === "ip" && isIP(host) && sameAddress(e.value, host)),
  );
}

function addressListed(address: string, policy: OutboundPolicy): boolean {
  return allowEntries(policy).some(
    (e) =>
      (e.kind === "ip" && sameAddress(e.value, address)) ||
      (e.kind === "cidr" && inCidr(address, e.value, e.bits!)),
  );
}

// ── Decision ─────────────────────────────────────────────────────────────────

const CLASS_WORDS: Record<Exclude<AddressClass, "public">, string> = {
  private: "private",
  loopback: "loopback",
  unspecified: "unspecified",
  "link-local": "link-local",
  multicast: "multicast",
  reserved: "reserved",
  metadata: "cloud metadata",
};

const ALLOW_PRIVATE_HINT =
  "set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS";
const ALLOW_LIST_HINT = "list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it";

function blocked(
  host: string,
  addressClass: Exclude<AddressClass, "public">,
  how: "is" | "resolves to",
  address?: string,
): OutboundDecision {
  const what = `${host} ${how} a ${CLASS_WORDS[addressClass]} ${how === "is" && address === undefined ? "host name" : "address"}`;
  const where = address !== undefined && address !== host ? ` (${address})` : "";
  const hint = addressClass === "private" ? ALLOW_PRIVATE_HINT : ALLOW_LIST_HINT;
  return {
    allowed: false,
    reason: `blocked: ${what}${where}; ${hint}`,
    addressClass,
    address,
  };
}

/**
 * Is `hostname` (with the addresses it resolved to, when known) a host the
 * server may connect to under `policy`? Pure; the async layer resolves.
 */
export function decideOutboundHost(
  hostname: string,
  addresses: readonly ResolvedAddress[] | null,
  policy: OutboundPolicy = outboundPolicyFromEnv(),
): OutboundDecision {
  if (policy.allowAll) return { allowed: true };
  const host = normalizeHostname(hostname);
  if (!host) return { allowed: false, reason: "blocked: the URL has no host" };
  if (hostListed(host, policy)) return { allowed: true };

  if (isIP(host)) {
    if (addressListed(host, policy)) return { allowed: true };
    const cls = classifyAddress(host) ?? "reserved";
    if (cls === "public") return { allowed: true };
    if (cls === "private" && policy.allowPrivate) return { allowed: true };
    return blocked(host, cls, "is", host);
  }

  const byName = classifyHostname(host);
  if (byName && !(byName === "private" && policy.allowPrivate)) {
    return blocked(host, byName, "is");
  }

  for (const { address } of addresses ?? []) {
    if (addressListed(address, policy)) continue;
    const cls = classifyAddress(address) ?? "reserved";
    if (cls === "public") continue;
    if (cls === "private" && policy.allowPrivate) continue;
    return blocked(host, cls, "resolves to", address);
  }
  return { allowed: true };
}

// ── Public API ───────────────────────────────────────────────────────────────

function parseHttpUrl(url: string | URL): URL | null {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Synchronous URL-string check: `true` when nothing in the text itself says
 * the URL is internal (no DNS). Designed for Zod `.refine()`.
 */
export function isSsrfSafeUrl(
  url: string,
  policy: OutboundPolicy = outboundPolicyFromEnv(),
): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  return decideOutboundHost(parsed.hostname, null, policy).allowed;
}

/** `isSsrfSafeUrl` for a bare host name (a GitLab `host` field). */
export function isSsrfSafeHost(
  host: string,
  policy: OutboundPolicy = outboundPolicyFromEnv(),
): boolean {
  return isSsrfSafeUrl(`https://${host}/`, policy);
}

const defaultResolver: HostResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Resolves the URL's host and checks every address against the policy.
 * Returns the addresses so the caller can connect to exactly those. Throws
 * `SsrfError` when blocked or when the host does not resolve.
 */
export async function vetOutboundUrl(
  input: string | URL,
  opts: VetOptions = {},
): Promise<VettedUrl> {
  const policy = opts.policy ?? outboundPolicyFromEnv();
  const url = parseHttpUrl(input);
  if (!url) throw new SsrfError("blocked: only http and https URLs can be fetched");
  const hostname = normalizeHostname(url.hostname);

  const literal = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: hostname, family: literal as 4 | 6 }];
  } else {
    const byName = decideOutboundHost(hostname, null, policy);
    if (!byName.allowed) throw new SsrfError(byName.reason!, { ...byName, hostname });
    try {
      const resolved = await withSignal(
        (opts.resolveHost ?? defaultResolver)(hostname),
        opts.signal,
      );
      addresses = resolved.map((r) => ({ address: r.address, family: r.family }));
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err instanceof Error ? err.name : "");
      throw new SsrfError(`${hostname} could not be resolved${code ? ` (${code})` : ""}`);
    }
    if (addresses.length === 0)
      throw new SsrfError(`${hostname} could not be resolved (no addresses)`);
  }

  const decision = decideOutboundHost(hostname, addresses, policy);
  if (!decision.allowed) throw new SsrfError(decision.reason!, { ...decision, hostname });
  return { url, hostname, addresses };
}

/**
 * Check-only form for callers that fetch with their own client: resolves and
 * classifies, throws `SsrfError` when blocked. A host that does not resolve
 * passes (the fetch fails on its own); use `vetOutboundUrl` to pin addresses.
 */
export async function assertSsrfSafe(url: string, opts: VetOptions = {}): Promise<void> {
  try {
    await vetOutboundUrl(url, opts);
  } catch (err) {
    if (err instanceof SsrfError && err.message.startsWith("blocked:")) throw err;
    if (err instanceof SsrfError) return; // resolution failure
    throw err;
  }
}
