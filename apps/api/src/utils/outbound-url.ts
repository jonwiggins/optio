/**
 * `guardedFetch`: the one HTTP client for URLs people typed that the API
 * itself fetches — outbound webhooks, Slack notifications, connection health
 * checks, the setup wizard's GitLab check.
 *
 * It vets the URL with `@optio/shared/ssrf` (scheme, host name, every DNS
 * answer, the deployment's policy) and then connects to the vetted addresses
 * ONLY: the request goes through a per-request undici Agent whose `lookup`
 * returns those addresses, so a DNS answer that changes between the check
 * and the connect (rebinding) cannot reach anything else. Redirects are never
 * followed by the client: `redirect: "follow"` is a loop here, each hop
 * vetted again, at most `maxRedirects` (5) hops, credentials dropped when the
 * origin changes. Every request has a timeout (10 s unless a signal is given).
 *
 * Failures surface as `SsrfError` with a readable, secret-free message
 * (`blocked: host resolves to a private address (10.0.0.5); set
 * OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS`).
 */

import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  SsrfError,
  normalizeHostname,
  vetOutboundUrl,
  type HostResolver,
  type OutboundPolicy,
  type VettedUrl,
} from "@optio/shared/ssrf";

export { SsrfError };

/** What `fetch` looks like to this module (a stand-in for tests). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OutboundOptions {
  /** Overrides the environment's policy. */
  policy?: OutboundPolicy;
  /** Overrides DNS (tests). */
  resolveHost?: HostResolver;
  /** Replaces the HTTP client (tests). Vetting still runs; pinning cannot. */
  fetchImpl?: FetchLike;
  /** Hops `redirect: "follow"` may take. Default 5. */
  maxRedirects?: number;
  /** Used when `signal` is absent. Default 10 s. */
  timeoutMs?: number;
}

export type GuardedFetchInit = Omit<RequestInit, "redirect"> & {
  redirect?: "follow" | "manual" | "error";
} & OutboundOptions;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 10_000;
/** How long an Agent may linger after its response for the body to be read. */
const AGENT_GRACE_MS = 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

type Defaults = Pick<OutboundOptions, "fetchImpl" | "resolveHost" | "policy">;
let defaults: Defaults = {};

/**
 * Process-wide defaults for the three injectable pieces. For tests: point
 * `fetchImpl` at a mock and `resolveHost` at a fixed answer so no test ever
 * resolves a real name. Returns a function that restores the previous values.
 */
export function setOutboundDefaults(next: Defaults): () => void {
  const previous = defaults;
  defaults = { ...previous, ...next };
  return () => {
    defaults = previous;
  };
}

/** `fetch` with the outbound guard; see the module comment. */
export async function guardedFetch(
  input: string | URL,
  init: GuardedFetchInit = {},
): Promise<Response> {
  const {
    policy = defaults.policy,
    resolveHost = defaults.resolveHost,
    fetchImpl = defaults.fetchImpl,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    redirect = "follow",
    ...rest
  } = init;
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
  const vet = { policy, resolveHost, signal };
  let url = input instanceof URL ? input.toString() : input;

  if (redirect !== "follow") {
    const vetted = await vetOutboundUrl(url, vet);
    return send(vetted, { ...rest, signal, redirect }, fetchImpl);
  }

  let method = rest.method ?? "GET";
  let body = rest.body;
  let headers = rest.headers;
  let origin: string | null = null;
  for (let hop = 0; ; hop++) {
    const vetted = await vetOutboundUrl(url, vet);
    if (origin !== null && vetted.url.origin !== origin) headers = withoutCredentials(headers);
    origin = vetted.url.origin;
    const response = await send(
      vetted,
      { ...rest, method, body, headers, signal, redirect: "manual" },
      fetchImpl,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers?.get?.("location");
    if (!location) return response;
    await drain(response);
    if (hop >= maxRedirects) {
      throw new Error(`${vetted.hostname} redirected more than ${maxRedirects} times`);
    }
    let next: URL;
    try {
      next = new URL(location, vetted.url);
    } catch {
      throw new SsrfError(`blocked: ${vetted.hostname} redirected to an invalid URL`, {
        hostname: vetted.hostname,
      });
    }
    const { status } = response;
    if (status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === "POST")) {
      method = "GET";
      body = undefined;
    }
    url = next.toString();
  }
}

async function send(
  vetted: VettedUrl,
  init: RequestInit,
  fetchImpl: FetchLike | undefined,
): Promise<Response> {
  const url = vetted.url.toString();
  if (fetchImpl) return fetchImpl(url, init);
  const agent = pinnedAgent(vetted);
  try {
    const response = await undiciFetch(url, {
      ...(init as unknown as Record<string, unknown>),
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  } finally {
    // Graceful: lets the caller read or cancel the body, then frees the sockets.
    void agent.close().catch(() => {});
    setTimeout(() => void agent.destroy().catch(() => {}), AGENT_GRACE_MS).unref();
  }
}

/** An Agent that connects `vetted.hostname` to `vetted.addresses` and nothing else. */
function pinnedAgent(vetted: VettedUrl): Agent {
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== vetted.hostname) {
      callback(new Error(`connection to ${hostname} was not vetted`), "", undefined);
      return;
    }
    const all = vetted.addresses.map((a) => ({ address: a.address, family: a.family }));
    if (options.all) callback(null, all);
    else callback(null, all[0]!.address, all[0]!.family);
  };
  const connect = { lookup, timeout: CONNECT_TIMEOUT_MS };
  return new Agent({ connect: connect as unknown as Agent.Options["connect"] });
}

async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to drain
  }
}

/** The same headers without the ones that carry credentials (cross-origin hop). */
function withoutCredentials(headers: RequestInit["headers"]): RequestInit["headers"] {
  if (!headers) return headers;
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    for (const name of CREDENTIAL_HEADERS) copy.delete(name);
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()));
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );
}
