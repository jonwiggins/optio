import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for Portkey (tests of the `portkey` gateway type):
 * its Admin API's API keys as the reference documents them, and the model
 * list a key can read. Keys are named by a UUID; a rotated key keeps its id
 * and limits, and its previous value is still taken until the transition
 * ends. Every call is recorded.
 *
 *   const pk = await startFakePortkey({ adminKey: "pk-admin" });
 *   // baseUrl → pk.url; pk.calls; pk.keys
 *   await pk.close();
 *
 * Routes, under /v1: POST /api-keys/{type}/{sub-type}, GET /api-keys,
 * GET|PUT|DELETE /api-keys/{id}, POST /api-keys/{id}/rotate (the admin
 * key, `x-portkey-api-key`); GET /models (a key it made, or the admin key).
 */

export interface FakePortkeyKey {
  id: string;
  key: string;
  /** A rotated key's previous value, taken until `previousUntil`. */
  previous: string | null;
  previousUntil: number | null;
  name: string;
  type: string;
  scopes: string[];
  workspaceId: string | null;
  usageLimits: Record<string, unknown> | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface FakePortkeyCall {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

export interface FakePortkey {
  url: string;
  adminKey: string;
  calls: FakePortkeyCall[];
  keys: Map<string, FakePortkeyKey>;
  callsTo(route: string): FakePortkeyCall[];
  failNext(route: string, status: number, message: string): void;
  close(): Promise<void>;
}

/** What `/v1/models` lists: models of the organization's Model Catalog. */
export const FAKE_PORTKEY_MODELS = ["@anthropic-prod/claude-sonnet-4-5", "@openai-prod/gpt-5"];

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

/** Portkey's `usage_limits`: cost or tokens, a whole limit of 1 or more, one way to reset. */
function usageLimitsProblem(limits: unknown): string | null {
  if (limits === undefined) return null;
  if (!limits || typeof limits !== "object") return "usage_limits must be an object";
  const l = limits as Record<string, unknown>;
  if (l.type !== undefined && l.type !== "cost" && l.type !== "tokens") return "Invalid type";
  if (
    typeof l.credit_limit !== "number" ||
    !Number.isInteger(l.credit_limit) ||
    l.credit_limit < 1
  ) {
    return "credit_limit must be an integer of 1 or more";
  }
  if (
    l.periodic_reset !== undefined &&
    l.periodic_reset !== "monthly" &&
    l.periodic_reset !== "weekly"
  ) {
    return "Invalid periodic_reset";
  }
  if (l.periodic_reset !== undefined && l.periodic_reset_days !== undefined) {
    return "periodic_reset and periodic_reset_days are mutually exclusive";
  }
  const days = l.periodic_reset_days;
  if (days !== undefined && (typeof days !== "number" || days < 1 || days > 365)) {
    return "periodic_reset_days must be 1 to 365";
  }
  return null;
}

export async function startFakePortkey(opts: { adminKey?: string } = {}): Promise<FakePortkey> {
  const adminKey = opts.adminKey ?? `pk-admin-${randomBytes(4).toString("hex")}`;
  const calls: FakePortkeyCall[] = [];
  const keys = new Map<string, FakePortkeyKey>();
  const failures = new Map<string, { status: number; message: string }>();

  const view = (k: FakePortkeyKey) => ({
    id: k.id,
    key: `${k.key.slice(0, 2)}*******${k.key.slice(-2)}`,
    name: k.name,
    type: k.type,
    workspace_id: k.workspaceId,
    status: "active",
    scopes: k.scopes,
    usage_limits: k.usageLimits,
    defaults: { metadata: k.metadata },
    expires_at: k.expiresAt,
    object: "api-key",
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req);
    const auth = (req.headers["x-portkey-api-key"] as string | undefined) ?? null;
    calls.push({ method: req.method ?? "", path: url.pathname + url.search, auth, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, message: string) => send(status, { success: false, message });
    const idRoute = url.pathname.match(/^\/v1\/api-keys\/([0-9a-f-]{36})(\/rotate)?$/i);
    const createRoute = url.pathname.match(
      /^\/v1\/api-keys\/(organisation|workspace)\/(user|service)$/,
    );
    const route = idRoute
      ? `${req.method} /v1/api-keys/{id}${idRoute[2] ?? ""}`
      : createRoute
        ? `${req.method} /v1/api-keys/{type}/{sub-type}`
        : `${req.method} ${url.pathname}`;
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return error(failure.status, failure.message);
    }
    const now = Date.now();
    const caller = [...keys.values()].find(
      (k) => k.key === auth || (k.previous === auth && (k.previousUntil ?? 0) > now),
    );

    if (route === "GET /v1/models") {
      if (auth !== adminKey && !caller) return error(401, "Invalid API Key");
      return send(200, {
        object: "list",
        data: FAKE_PORTKEY_MODELS.map((id) => ({
          id,
          object: "model",
          created: 1,
          owned_by: "portkey",
        })),
      });
    }
    if (auth !== adminKey) return error(auth ? 403 : 401, "You do not have enough permissions");

    if (route === "GET /v1/api-keys") {
      const ws = url.searchParams.get("workspace_id");
      const data = [...keys.values()].filter((k) => !ws || k.workspaceId === ws).map(view);
      return send(200, { object: "list", total: data.length, data });
    }
    if (createRoute && req.method === "POST") {
      if (typeof body?.name !== "string" || !body.name) return error(400, "name is required");
      if (!Array.isArray(body.scopes) || !body.scopes.length)
        return error(400, "scopes is required");
      const problem = usageLimitsProblem(body.usage_limits);
      if (problem) return error(400, problem);
      const k: FakePortkeyKey = {
        id: randomUUID(),
        key: `pk-${randomBytes(16).toString("hex")}`,
        previous: null,
        previousUntil: null,
        name: body.name,
        type: `${createRoute[1]}-${createRoute[2]}`,
        scopes: body.scopes as string[],
        workspaceId: typeof body.workspace_id === "string" ? body.workspace_id : null,
        usageLimits: (body.usage_limits as Record<string, unknown> | undefined) ?? null,
        expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
        metadata:
          ((body.defaults as Record<string, unknown> | undefined)?.metadata as Record<
            string,
            unknown
          >) ?? {},
      };
      keys.set(k.id, k);
      return send(200, { id: k.id, key: k.key, object: "api-key" });
    }
    if (idRoute) {
      const k = keys.get(idRoute[1].toLowerCase());
      if (!k) return error(404, "API key not found");
      if (idRoute[2] && req.method === "POST") {
        const grace = Number(body?.key_transition_period_ms ?? 1_800_000);
        if (!Number.isFinite(grace) || grace < 1_800_000) {
          return error(400, "key_transition_period_ms must be at least 1800000");
        }
        if (k.previous && (k.previousUntil ?? 0) > now) {
          return error(409, "A previous secret is still in its transition window");
        }
        k.previous = k.key;
        k.previousUntil = now + grace;
        k.key = `pk-${randomBytes(16).toString("hex")}`;
        return send(200, {
          id: k.id,
          key: k.key,
          key_transition_expires_at: new Date(k.previousUntil).toISOString(),
        });
      }
      if (req.method === "GET") return send(200, view(k));
      if (req.method === "DELETE") {
        keys.delete(k.id);
        return send(200, {});
      }
      if (req.method === "PUT") {
        if (body && "usage_limits" in body) {
          const problem = usageLimitsProblem(body.usage_limits);
          if (problem) return error(400, problem);
          k.usageLimits = body.usage_limits as Record<string, unknown>;
        }
        if (typeof body?.name === "string") k.name = body.name;
        return send(200, {});
      }
    }
    return error(404, "Not Found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    adminKey,
    calls,
    keys,
    callsTo: (route) => {
      const [method, path] = route.split(" ");
      return calls.filter((c) => c.method === method && c.path.split("?")[0] === path);
    },
    failNext(route, status, message) {
      failures.set(route, { status, message });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
