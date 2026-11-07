import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for OpenRouter (tests of the `openrouter` gateway
 * type): its key management as the API reference documents it, the key's
 * own info and the model list. It records every call and keeps keys in
 * memory, named by a hash OpenRouter gives them (not the SHA-256 of the
 * value, so tests prove Optio keeps OpenRouter's id).
 *
 *   const or = await startFakeOpenRouter({ managementKey: "sk-or-mgmt" });
 *   // baseUrl → or.baseUrl (".../api"); or.calls; or.keys; or.setUsage(hash, 4.2)
 *   await or.close();
 *
 * Routes, under /api/v1: POST /keys, GET /keys, GET|PATCH|DELETE
 * /keys/{hash} (the management key); GET /key (a key it made); GET /models
 * (anyone, as OpenRouter's list is public).
 */

export interface FakeOpenRouterKey {
  key: string;
  hash: string;
  name: string;
  limit: number | null;
  limitReset: "daily" | "weekly" | "monthly" | null;
  expiresAt: string | null;
  disabled: boolean;
  /** USD this period (the fake keeps one number for every period). */
  usage: number;
}

export interface FakeOpenRouterCall {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

export interface FakeOpenRouter {
  url: string;
  /** What a gateway's base URL is: `<url>/api`. */
  baseUrl: string;
  managementKey: string;
  calls: FakeOpenRouterCall[];
  keys: Map<string, FakeOpenRouterKey>;
  callsTo(route: string): FakeOpenRouterCall[];
  setUsage(hash: string, usd: number): void;
  /** The next answer to `route` ("POST /api/v1/keys") is this status and message. */
  failNext(route: string, status: number, message: string): void;
  close(): Promise<void>;
}

/** What `/models` lists: two models with OpenRouter's fields, prices as USD-per-token strings. */
export const FAKE_OPENROUTER_MODELS = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    context_length: 1_000_000,
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
  },
  {
    id: "qwen/qwen3-coder",
    name: "Qwen: Qwen3 Coder",
    context_length: 262_144,
    pricing: { prompt: "0.0000002", completion: "0.0000008" },
    top_provider: { context_length: 262_144, max_completion_tokens: null },
  },
  {
    id: "openrouter/auto",
    name: "Auto Router",
    context_length: 2_000_000,
    pricing: { prompt: "-1", completion: "-1" },
    top_provider: { context_length: null, max_completion_tokens: null },
  },
];

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

const RESETS = new Set(["daily", "weekly", "monthly"]);
/** OpenRouter takes an expiry with seconds; a minute-precision one is refused. */
const EXPIRY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export async function startFakeOpenRouter(
  opts: { managementKey?: string } = {},
): Promise<FakeOpenRouter> {
  const managementKey = opts.managementKey ?? `sk-or-mgmt-${randomBytes(4).toString("hex")}`;
  const calls: FakeOpenRouterCall[] = [];
  const keys = new Map<string, FakeOpenRouterKey>();
  const failures = new Map<string, { status: number; message: string }>();

  const view = (k: FakeOpenRouterKey) => ({
    hash: k.hash,
    name: k.name,
    label: `${k.key.slice(0, 11)}...${k.key.slice(-3)}`,
    disabled: k.disabled,
    limit: k.limit,
    limit_remaining: k.limit === null ? null : Math.max(0, k.limit - k.usage),
    limit_reset: k.limitReset,
    include_byok_in_limit: false,
    usage: k.usage,
    usage_daily: k.usage,
    usage_weekly: k.usage,
    usage_monthly: k.usage,
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: null,
    expires_at: k.expiresAt,
    creator_user_id: null,
    workspace_id: "00000000-0000-4000-8000-000000000000",
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
    calls.push({ method: req.method ?? "", path: url.pathname + url.search, auth: bearer, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, message: string) =>
      send(status, { error: { code: status, message } });
    const keyRoute = url.pathname.match(/^\/api\/v1\/keys\/([^/]+)$/);
    const route = keyRoute ? `${req.method} /api/v1/keys/{hash}` : `${req.method} ${url.pathname}`;
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return error(failure.status, failure.message);
    }

    if (route === "GET /api/v1/models") {
      return send(200, { data: FAKE_OPENROUTER_MODELS });
    }
    if (route === "GET /api/v1/key") {
      const k = [...keys.values()].find((x) => x.key === bearer);
      if (!k) return error(401, "User not found.");
      if (k.disabled) return error(403, "Key is disabled");
      return send(200, {
        data: { ...view(k), is_management_key: false, is_provisioning_key: false },
      });
    }
    if (bearer !== managementKey) {
      return error(bearer ? 403 : 401, "Only management keys can perform this operation");
    }
    if (route === "GET /api/v1/keys") {
      return send(200, { data: [...keys.values()].map(view) });
    }
    if (route === "POST /api/v1/keys") {
      if (typeof body?.name !== "string" || !body.name) return error(400, "name is required");
      const reset = body.limit_reset ?? null;
      if (reset !== null && !RESETS.has(String(reset))) return error(400, "Invalid limit_reset");
      const expires = body.expires_at ?? null;
      if (expires !== null && !EXPIRY.test(String(expires)))
        return error(400, "Invalid expires_at");
      const key = `sk-or-v1-${randomBytes(16).toString("hex")}`;
      const k: FakeOpenRouterKey = {
        key,
        // OpenRouter's own id, unrelated to the SHA-256 of the value.
        hash: createHash("sha256").update(`or:${key}:${Date.now()}`).digest("hex"),
        name: body.name,
        limit: typeof body.limit === "number" ? body.limit : null,
        limitReset: reset as FakeOpenRouterKey["limitReset"],
        expiresAt: (expires as string | null) ?? null,
        disabled: false,
        usage: 0,
      };
      keys.set(k.hash, k);
      return send(201, { data: view(k), key });
    }
    if (keyRoute) {
      const k = keys.get(decodeURIComponent(keyRoute[1]));
      if (!k) return error(404, "Key not found");
      if (req.method === "GET") return send(200, { data: view(k) });
      if (req.method === "DELETE") {
        keys.delete(k.hash);
        return send(200, { deleted: true });
      }
      if (req.method === "PATCH") {
        const fields = ["name", "disabled", "limit", "limit_reset", "include_byok_in_limit"];
        if (!body || !fields.some((f) => f in body)) return error(400, "No update fields provided");
        if (
          "limit_reset" in body &&
          body.limit_reset !== null &&
          !RESETS.has(String(body.limit_reset))
        ) {
          return error(400, "Invalid limit_reset");
        }
        if (typeof body.name === "string") k.name = body.name;
        if (typeof body.disabled === "boolean") k.disabled = body.disabled;
        if ("limit" in body) k.limit = typeof body.limit === "number" ? body.limit : null;
        if ("limit_reset" in body)
          k.limitReset = body.limit_reset as FakeOpenRouterKey["limitReset"];
        return send(200, { data: view(k) });
      }
    }
    return error(404, "Not Found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: `${url}/api`,
    managementKey,
    calls,
    keys,
    callsTo: (route) => {
      const [method, path] = route.split(" ");
      return calls.filter((c) => c.method === method && c.path.split("?")[0] === path);
    },
    setUsage(hash, usd) {
      const k = keys.get(hash);
      if (k) k.usage = usd;
    },
    failNext(route, status, message) {
      failures.set(route, { status, message });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
