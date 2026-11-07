import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for LiteLLM's key management (tests of
 * services/gateway-keys.ts): it records every call and keeps keys in memory,
 * the way LiteLLM names them: a key by the SHA-256 of its value, aliases
 * unique.
 *
 *   const litellm = await startFakeLiteLLM({ masterKey: "sk-master" });
 *   // baseUrl → litellm.url; litellm.calls; litellm.keys; litellm.setSpend(hash, 4.2)
 *   await litellm.close();
 *
 * Routes: POST /key/generate, /key/delete, /key/block, /key/update; GET
 * /key/info, /key/list, /v1/models (any key it made, or the master key).
 */

export interface FakeKey {
  key: string;
  hash: string;
  alias: string | null;
  userId: string | null;
  models: string[];
  maxBudget: number | null;
  budgetDuration: string | null;
  duration: string | null;
  spend: number;
  blocked: boolean;
  metadata: Record<string, unknown>;
  /** When the budget resets, fixed when the key is made (null without a period). */
  budgetResetAt?: string | null;
}

export interface FakeCall {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

export interface FakeLiteLLM {
  url: string;
  masterKey: string;
  calls: FakeCall[];
  keys: Map<string, FakeKey>;
  /** Calls to one route (`POST /key/generate`). */
  callsTo(route: string): FakeCall[];
  setSpend(hash: string, spend: number): void;
  /** The next answer to `route` is this status and error message. */
  failNext(route: string, status: number, message: string): void;
  /** Answer 404 on this route from now on (an older LiteLLM). */
  disable(route: string): void;
  close(): Promise<void>;
}

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

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

export async function startFakeLiteLLM(
  opts: { masterKey?: string; models?: string[] } = {},
): Promise<FakeLiteLLM> {
  const masterKey = opts.masterKey ?? `sk-master-${randomBytes(4).toString("hex")}`;
  const models = opts.models ?? ["qwen-internal", "claude-sonnet-internal"];
  const calls: FakeCall[] = [];
  const keys = new Map<string, FakeKey>();
  const failures = new Map<string, { status: number; message: string }>();
  const disabled = new Set<string>();

  const lookup = (k: string | null | undefined): FakeKey | undefined => {
    if (!k) return undefined;
    return keys.get(k.startsWith("sk-") ? sha(k) : k);
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const route = `${req.method} ${url.pathname}`;
    const body = await readBody(req);
    const authHeader = req.headers.authorization ?? null;
    const bearer = authHeader?.replace(/^Bearer\s+/i, "") ?? null;
    calls.push({ method: req.method ?? "", path: url.pathname + url.search, auth: bearer, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, message: string) =>
      send(status, { error: { message, type: "auth_error", code: String(status) } });

    if (disabled.has(route)) return error(404, "Not Found");
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return error(failure.status, failure.message);
    }
    const isMaster = bearer === masterKey;
    const caller = lookup(bearer);

    if (route === "GET /v1/models") {
      if (!isMaster && (!caller || caller.blocked)) return error(401, "Authentication Error");
      const served = caller && caller.models.length ? caller.models : models;
      return send(200, { data: served.map((id) => ({ id, object: "model" })) });
    }
    if (route === "GET /key/info") {
      const target = url.searchParams.get("key");
      if (!isMaster && !(caller && (!target || lookup(target) === caller))) {
        return error(401, "Authentication Error");
      }
      const k = target ? lookup(target) : caller;
      if (!k) return error(404, "Key not found");
      return send(200, {
        key: k.hash,
        info: {
          key_alias: k.alias,
          user_id: k.userId,
          spend: k.spend,
          max_budget: k.maxBudget,
          budget_duration: k.budgetDuration,
          budget_reset_at: k.budgetDuration
            ? (k.budgetResetAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString())
            : null,
          models: k.models,
          blocked: k.blocked,
          metadata: k.metadata,
        },
      });
    }
    if (!isMaster) return error(401, "Authentication Error: not a proxy admin");

    switch (route) {
      case "GET /key/list":
        return send(200, { keys: [...keys.keys()], total_count: keys.size });
      case "POST /key/generate": {
        const alias = typeof body?.key_alias === "string" ? body.key_alias : null;
        if (alias && [...keys.values()].some((k) => k.alias === alias)) {
          return error(
            400,
            `Unique key aliases across all keys are required. Key alias=${alias} already exists.`,
          );
        }
        const key = `sk-${randomBytes(12).toString("hex")}`;
        const k: FakeKey = {
          key,
          hash: sha(key),
          alias,
          userId: typeof body?.user_id === "string" ? body.user_id : null,
          models: Array.isArray(body?.models) ? (body.models as string[]) : [],
          maxBudget: typeof body?.max_budget === "number" ? body.max_budget : null,
          budgetDuration: typeof body?.budget_duration === "string" ? body.budget_duration : null,
          duration: typeof body?.duration === "string" ? body.duration : null,
          spend: typeof body?.spend === "number" ? body.spend : 0,
          blocked: false,
          metadata: (body?.metadata as Record<string, unknown>) ?? {},
          budgetResetAt:
            typeof body?.budget_duration === "string"
              ? new Date(Date.now() + 30 * 86_400_000).toISOString()
              : null,
        };
        keys.set(k.hash, k);
        return send(200, {
          key,
          token_id: k.hash,
          key_alias: alias,
          user_id: k.userId,
          expires: k.duration ? "2027-01-22T00:00:00Z" : null,
        });
      }
      case "POST /key/delete": {
        const list = Array.isArray(body?.keys) ? (body.keys as string[]) : [];
        const found = list.map(lookup).filter((k): k is FakeKey => !!k);
        if (!found.length) return error(400, "Key not found");
        for (const k of found) keys.delete(k.hash);
        return send(200, { deleted_keys: found.map((k) => k.hash) });
      }
      case "POST /key/block": {
        const k = lookup(typeof body?.key === "string" ? body.key : null);
        if (!k) return error(404, "Key not found");
        k.blocked = true;
        return send(200, { token: k.hash, blocked: true });
      }
      case "POST /key/update": {
        const k = lookup(typeof body?.key === "string" ? body.key : null);
        if (!k) return error(404, "Key not found");
        if (typeof body?.key_alias === "string") k.alias = body.key_alias;
        if (typeof body?.spend === "number") k.spend = body.spend;
        return send(200, { key: k.hash, key_alias: k.alias, spend: k.spend });
      }
      default:
        return error(404, "Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    masterKey,
    calls,
    keys,
    callsTo: (route) => {
      const [method, path] = route.split(" ");
      return calls.filter((c) => c.method === method && c.path.split("?")[0] === path);
    },
    setSpend(id, spend) {
      const k = keys.get(id);
      if (k) k.spend = spend;
    },
    failNext(route, status, message) {
      failures.set(route, { status, message });
    },
    disable(route) {
      disabled.add(route);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
