/**
 * Connection health checks.
 *
 * A connection provider may declare how to verify that a configured
 * connection works: an HTTP probe (an authenticated "who am I" request) or
 * an AWS STS `GetCallerIdentity` call. The result is a status plus a short,
 * safe message — never a response body, header value, or resolved lookup
 * value, since those can hold secrets.
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SsrfError } from "@optio/shared/ssrf";
import { guardedFetch, type OutboundOptions } from "../utils/outbound-url.js";

import type { ConnectionHealthCheck } from "@optio/shared";
export type { ConnectionHealthCheck };

export interface HealthResult {
  status: "healthy" | "error";
  message: string;
}

/** Resolves a `{{key}}` placeholder; values may be secrets (tokens, keys). */
export type Lookup = (key: string) => string | undefined;

export interface HttpHealthCheckOptions extends Pick<
  OutboundOptions,
  "fetchImpl" | "resolveHost" | "policy"
> {
  /** Default 10_000. */
  timeoutMs?: number;
}

export interface AwsStsHealthCheckOptions {
  client?: STSClient;
}

export interface AwsStsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
}

export type RunHealthCheckOptions = HttpHealthCheckOptions & AwsStsHealthCheckOptions;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_AWS_REGION = "us-east-1";
const MAX_AWS_MESSAGE_LENGTH = 200;

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** `{{key}}` → `lookup(key) ?? ""`. */
export function renderHealthTemplate(template: string, lookup: Lookup): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => lookup(key) ?? "");
}

/**
 * The URL as it may appear in a message: userinfo, query string and fragment
 * stripped (a provider template may put a token in any of them).
 */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not parseable — strip anything that looks like `scheme://user:pass@` by hand.
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1").replace(/[?#].*$/, "");
  }
}

function formatTimeout(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

export async function httpHealthCheck(
  spec: Extract<ConnectionHealthCheck, { kind: "http" }>,
  lookup: Lookup,
  opts: HttpHealthCheckOptions = {},
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = spec.method ?? "GET";

  const renderedUrl = renderHealthTemplate(spec.url, lookup);
  const shown = `${method} ${displayUrl(renderedUrl)}`;

  let parsed: URL;
  try {
    parsed = new URL(renderedUrl);
  } catch {
    return { status: "error", message: `${shown} is not a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "error", message: `${shown} is not an http(s) URL` };
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    headers[name] = renderHealthTemplate(value, lookup);
  }

  let response: Response;
  try {
    response = await guardedFetch(parsed.toString(), {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      fetchImpl: opts.fetchImpl,
      resolveHost: opts.resolveHost,
      policy: opts.policy,
    });
  } catch (err) {
    if (err instanceof SsrfError) {
      return { status: "error", message: `${shown} ${err.message}` };
    }
    if (isTimeoutError(err)) {
      return { status: "error", message: `${shown} timed out after ${formatTimeout(timeoutMs)}` };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `${shown} failed: ${reason}` };
  }

  // Drain the body without ever reading it into the message.
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }

  const ok =
    spec.expectStatus !== undefined
      ? response.status === spec.expectStatus
      : response.status >= 200 && response.status < 300;
  const statusLine = response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
  return { status: ok ? "healthy" : "error", message: `${shown} → ${statusLine}` };
}

export async function awsStsHealthCheck(
  creds: AwsStsCredentials,
  opts: AwsStsHealthCheckOptions = {},
): Promise<HealthResult> {
  const hasKeys = Boolean(creds.accessKeyId && creds.secretAccessKey);
  const client =
    opts.client ??
    new STSClient({
      region: creds.region || DEFAULT_AWS_REGION,
      ...(hasKeys
        ? {
            credentials: {
              accessKeyId: creds.accessKeyId!,
              secretAccessKey: creds.secretAccessKey!,
              ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
            },
          }
        : {}),
    });

  try {
    const identity = await client.send(new GetCallerIdentityCommand({}));
    const arn = identity.Arn ?? "unknown identity";
    const suffix = hasKeys ? "" : " (checked with the API's own role, not the pod's)";
    return { status: "healthy", message: `Signed in as ${arn}${suffix}` };
  } catch (err) {
    const name = err instanceof Error && err.name ? err.name : "Error";
    const raw = err instanceof Error ? err.message : String(err);
    const message =
      raw.length > MAX_AWS_MESSAGE_LENGTH ? `${raw.slice(0, MAX_AWS_MESSAGE_LENGTH)}…` : raw;
    return { status: "error", message: `AWS STS: ${name}: ${message}` };
  }
}

/** Runs the provider's declared check. `null` when the provider has none. */
export async function runHealthCheck(
  spec: ConnectionHealthCheck | null | undefined,
  lookup: Lookup,
  opts: RunHealthCheckOptions = {},
): Promise<HealthResult | null> {
  if (!spec) return null;
  switch (spec.kind) {
    case "http":
      return httpHealthCheck(spec, lookup, opts);
    case "aws-sts":
      return awsStsHealthCheck(
        {
          accessKeyId: lookup("accessKeyId") ?? lookup("AWS_ACCESS_KEY_ID"),
          secretAccessKey: lookup("secretAccessKey") ?? lookup("AWS_SECRET_ACCESS_KEY"),
          sessionToken: lookup("sessionToken") ?? lookup("AWS_SESSION_TOKEN"),
          region: lookup("region") ?? lookup("AWS_REGION"),
        },
        opts,
      );
    default:
      return null;
  }
}
