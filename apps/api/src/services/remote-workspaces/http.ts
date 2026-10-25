/**
 * The HTTP calls the providers' REST clients make: through the outbound
 * guard (`OPTIO_OUTBOUND_ALLOWED_HOSTS` must let a private host through)
 * with the connection's CA, never following a redirect (the credential
 * travels in a header), JSON in and out, and the provider's error turned
 * into a RemoteWorkspaceError that never repeats the credential.
 */
import { guardedFetch } from "../../utils/outbound-url.js";
import { hostOf } from "./coder.js";
import { RemoteWorkspaceError, type ProviderTarget } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ProviderHttp {
  /** A JSON call; `null` for an empty answer (204). */
  json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  /** The raw response for a call whose answer isn't one JSON document. */
  raw(
    url: string,
    init: { method: HttpMethod; headers?: Record<string, string>; body?: string | Uint8Array },
    opts?: { timeoutMs?: number },
  ): Promise<Response>;
}

/** Why a provider said no, from the usual JSON error shapes. */
async function detailOf(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const parts = [json.message, json.error, json.detail, json.error_code]
        .map((v) => (typeof v === "string" ? v : null))
        .filter((v): v is string => !!v);
      return [...new Set(parts)].join(" — ");
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}

export function providerHttp(
  provider: string,
  target: ProviderTarget,
  headers: Record<string, string>,
): ProviderHttp {
  const base = target.url.replace(/\/+$/, "");
  const tls = {
    ca: target.caPem,
    ...(target.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
  };
  const send = async (
    url: string,
    init: { method: HttpMethod; headers?: Record<string, string>; body?: string | Uint8Array },
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> => {
    try {
      return await guardedFetch(url, {
        method: init.method,
        headers: { ...headers, ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
        redirect: "error",
        timeoutMs,
        tls,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new RemoteWorkspaceError(`Couldn't reach ${provider} at ${hostOf(url)}: ${why}`, 502);
    }
  };
  return {
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      const res = await send(`${base}${path}`, {
        method,
        headers: {
          // The provider's own media type when it has one (GitHub's), else JSON.
          ...(Object.keys(headers).some((h) => h.toLowerCase() === "accept")
            ? {}
            : { Accept: "application/json" }),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const detail = await detailOf(res);
        const status =
          res.status === 401 || res.status === 403
            ? 403
            : res.status === 404
              ? 404
              : res.status === 409
                ? 409
                : 502;
        throw new RemoteWorkspaceError(
          `${provider} answered ${res.status} to ${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
          status,
        );
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    raw: (url, init, opts) => send(url, init, opts?.timeoutMs),
  };
}
