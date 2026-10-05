/**
 * Pure logic of the HTTP bridge: reading the env contract, turning a tool
 * call into a fetch, and shaping the response into text. Nothing here touches
 * stdio or the network, so every rule is unit-testable.
 */

export const REQUEST_BODY_LIMIT = 1024 * 1024; // 1 MiB
export const RESPONSE_BODY_LIMIT = 2 * 1024 * 1024; // 2 MiB
export const REQUEST_TIMEOUT_MS = 30_000;

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface BridgeConfig {
  /** Server name advertised to the MCP client (`OPTIO_HTTP_NAME`). */
  name: string;
  /** What the API is, for the tool descriptions (`OPTIO_HTTP_DESCRIPTION`). */
  description: string;
  /** Base URL every request path is resolved against (`OPTIO_HTTP_BASE_URL`). */
  baseUrl: URL;
  /** Name of the auth header (`OPTIO_HTTP_AUTH_HEADER`, default `Authorization`). */
  authHeader: string;
  /** Full value of the auth header, or null when the API takes none. Never printed. */
  authValue: string | null;
  /** Static headers sent on every request (`OPTIO_HTTP_EXTRA_HEADERS`, a JSON object). */
  extraHeaders: Record<string, string>;
}

export interface RequestInput {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

export type BuildResult = { ok: true; url: URL; init: RequestInit } | { ok: false; error: string };

export interface ShapedResponse {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  truncated: boolean;
  /** The tool result text: `HTTP <status> <statusText>\n<content-type>\n\n<body>`. */
  text: string;
}

type Env = Record<string, string | undefined>;

/** Resolves the auth header value from `OPTIO_HTTP_AUTH_VALUE` or the legacy scheme + token pair. */
function resolveAuthValue(env: Env): string | null {
  const direct = env.OPTIO_HTTP_AUTH_VALUE;
  if (direct !== undefined) {
    return direct.trim() === "" ? null : direct;
  }
  const token = env.OPTIO_HTTP_AUTH_TOKEN ?? "";
  if (token.trim() === "") return null;
  const scheme = (env.OPTIO_HTTP_AUTH_SCHEME ?? "bearer").trim().toLowerCase();
  switch (scheme) {
    case "none":
      return null;
    case "api-key":
    case "apikey":
    case "raw":
      return token;
    case "bearer":
      return `Bearer ${token}`;
    default:
      throw new Error(
        `OPTIO_HTTP_AUTH_SCHEME must be one of bearer, api-key, none (got "${scheme}")`,
      );
  }
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OPTIO_HTTP_EXTRA_HEADERS must be a JSON object of header names to values");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPTIO_HTTP_EXTRA_HEADERS must be a JSON object of header names to values");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`OPTIO_HTTP_EXTRA_HEADERS: header "${name}" must be a string`);
    }
    headers[name] = value;
  }
  return headers;
}

/** Reads the whole env contract. Throws with a message safe to print (never a token). */
export function parseConfig(env: Env): BridgeConfig {
  const rawBase = env.OPTIO_HTTP_BASE_URL?.trim();
  if (!rawBase) throw new Error("OPTIO_HTTP_BASE_URL is required");
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBase);
  } catch {
    throw new Error("OPTIO_HTTP_BASE_URL is not a valid URL");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("OPTIO_HTTP_BASE_URL must be an http(s) URL");
  }
  baseUrl.search = "";
  baseUrl.hash = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";

  const authHeader = (env.OPTIO_HTTP_AUTH_HEADER ?? "").trim() || "Authorization";
  const extraHeaders = parseExtraHeaders(env.OPTIO_HTTP_EXTRA_HEADERS);
  for (const name of Object.keys(extraHeaders)) {
    if (name.toLowerCase() === authHeader.toLowerCase()) {
      throw new Error(`OPTIO_HTTP_EXTRA_HEADERS may not set the auth header (${authHeader})`);
    }
  }

  return {
    name: (env.OPTIO_HTTP_NAME ?? "").trim() || "http-api",
    description: (env.OPTIO_HTTP_DESCRIPTION ?? "").trim(),
    baseUrl,
    authHeader,
    authValue: resolveAuthValue(env),
    extraHeaders,
  };
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves `path` under the base URL. Returns an error for anything that is
 * not a relative path (a scheme, a `//host`, a `..` segment) or that lands
 * off the base URL's origin or outside its path prefix.
 */
export function resolvePath(
  baseUrl: URL,
  path: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  if (typeof path !== "string" || path.trim() === "") {
    return { ok: false, error: 'path is required (relative to the base URL, e.g. "/v1/users")' };
  }
  const trimmed = path.trim();
  if (SCHEME_RE.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("\\\\")) {
    return { ok: false, error: "path must be relative to the base URL: no scheme or host" };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: "path contains control characters" };
  }
  const beforeQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
  for (const segment of beforeQuery.split(/[/\\]/)) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep the raw segment; the URL parser will reject what it must
    }
    if (decoded === ".." || decoded === ".") {
      return { ok: false, error: 'path may not contain ".." or "." segments' };
    }
  }
  const relative = trimmed.replace(/^[/\\]+/, "");
  let url: URL;
  try {
    url = new URL(relative, baseUrl);
  } catch {
    return { ok: false, error: "path could not be resolved against the base URL" };
  }
  url.hash = "";
  if (url.origin !== baseUrl.origin) {
    return { ok: false, error: "path resolved off the base URL's origin" };
  }
  const prefix = baseUrl.pathname;
  if (url.pathname !== prefix.slice(0, -1) && !url.pathname.startsWith(prefix)) {
    return { ok: false, error: `path resolved outside the base URL's path prefix (${prefix})` };
  }
  return { ok: true, url };
}

/** Builds the fetch call for a `request` tool input, or an error that is returned without any request being made. */
export function buildRequest(cfg: BridgeConfig, input: RequestInput): BuildResult {
  const method = String(input.method ?? "").toUpperCase() as HttpMethod;
  if (!HTTP_METHODS.includes(method)) {
    return { ok: false, error: `method must be one of ${HTTP_METHODS.join(", ")}` };
  }

  const resolved = resolvePath(cfg.baseUrl, input.path);
  if (!resolved.ok) return resolved;
  const url = resolved.url;

  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.append(key, String(value));
    }
  }

  const headers = new Headers();
  const reserved = new Set<string>([cfg.authHeader.toLowerCase()]);
  for (const [name, value] of Object.entries(cfg.extraHeaders)) {
    headers.set(name, value);
    reserved.add(name.toLowerCase());
  }
  if (input.headers) {
    for (const [name, value] of Object.entries(input.headers)) {
      if (reserved.has(name.toLowerCase())) continue; // the caller never overrides auth or static headers
      if (typeof value !== "string") continue;
      try {
        headers.set(name, value);
      } catch {
        return { ok: false, error: `invalid header: ${name}` };
      }
    }
  }
  if (cfg.authValue !== null) headers.set(cfg.authHeader, cfg.authValue);

  let body: string | undefined;
  if (input.body !== undefined && input.body !== null) {
    if (method === "GET") {
      return { ok: false, error: "a GET request cannot carry a body" };
    }
    if (typeof input.body === "string" && headers.has("content-type")) {
      body = input.body;
    } else {
      try {
        body = JSON.stringify(input.body);
      } catch {
        return { ok: false, error: "body could not be JSON-encoded" };
      }
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    if (Buffer.byteLength(body, "utf8") > REQUEST_BODY_LIMIT) {
      return { ok: false, error: `request body exceeds ${REQUEST_BODY_LIMIT} bytes` };
    }
  }

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual",
  };
  if (body !== undefined) init.body = body;
  return { ok: true, url, init };
}

/** Reads at most `limit` bytes of a response body; says whether more was left unread. */
async function readBodyCapped(
  res: Response,
  limit: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (total + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

/** Turns a fetch Response into the tool's text, pretty-printing JSON and capping the body at 2 MiB. */
export async function shapeResponse(res: Response): Promise<ShapedResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  const { bytes, truncated } = await readBodyCapped(res, RESPONSE_BODY_LIMIT);
  let body = bytes.toString("utf8");
  if (!truncated && body.trim() !== "") {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // not JSON: returned as received
    }
  }
  const lines = [
    `HTTP ${res.status} ${res.statusText}`.trimEnd(),
    contentType || "(no content-type)",
    "",
    body,
  ];
  if (truncated) {
    lines.push(
      "",
      `[truncated: true — the response body exceeded ${RESPONSE_BODY_LIMIT} bytes; only the first ${RESPONSE_BODY_LIMIT} are shown]`,
    );
  }
  return {
    status: res.status,
    statusText: res.statusText,
    contentType,
    body,
    truncated,
    text: lines.join("\n"),
  };
}

/** Removes the auth value from any text that might reach the agent. */
export function redact(cfg: BridgeConfig, text: string): string {
  if (!cfg.authValue) return text;
  const needles = new Set([cfg.authValue]);
  // A bearer value's bare token, in case a library echoes it without the scheme.
  const bare = cfg.authValue.replace(/^\S+\s+/, "");
  if (bare.length >= 8) needles.add(bare);
  let out = text;
  for (const needle of needles) out = out.split(needle).join("[redacted]");
  return out;
}

/** The `describe` tool's text: everything about the bridge except the auth value. */
export function describeConfig(cfg: BridgeConfig): string {
  const lines = [
    `name: ${cfg.name}`,
    `description: ${cfg.description || "(none)"}`,
    `base URL: ${cfg.baseUrl.href}`,
    `auth header: ${cfg.authValue === null ? "(none)" : cfg.authHeader}`,
    `extra headers: ${Object.keys(cfg.extraHeaders).join(", ") || "(none)"}`,
    `limits: request body ${REQUEST_BODY_LIMIT} bytes, response body ${RESPONSE_BODY_LIMIT} bytes, timeout ${REQUEST_TIMEOUT_MS} ms`,
  ];
  return lines.join("\n");
}
