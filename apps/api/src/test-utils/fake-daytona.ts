import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process Daytona API for tests of the Daytona provider
 * (services/remote-workspaces/daytona.ts): the calls Optio makes, shaped as
 * Daytona's published OpenAPI documents describe them (/docs/openapi.json,
 * /docs/toolbox-openapi.json), with sandboxes kept in memory. A new or
 * started sandbox reads `creating` / `starting` once, then `started`, so the
 * start script waits for it as it would for a real one. The sandbox's
 * toolbox answers under `<url>/toolbox` (its `toolboxProxyUrl`).
 *
 *   const daytona = await startFakeDaytona({ apiKey: "dtn_1" });
 *   // connection → { provider: "daytona", url: daytona.url, token: "dtn_1" }
 *   daytona.sandboxes.get(id).state; daytona.executed; daytona.callsTo("POST /sandbox")
 *   daytona.failNext("POST /sandbox", 400);
 *   await daytona.close();
 */

export interface FakeDaytonaSandbox {
  id: string;
  name: string;
  snapshot: string;
  state: string;
  labels: Record<string, string>;
  autoStopInterval: number;
  target: string;
  /** The states it reads before `started` (one per GET). */
  pending: string[];
}

export interface FakeDaytonaCall {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingMessage["headers"];
}

export interface FakeDaytona {
  url: string;
  sandboxes: Map<string, FakeDaytonaSandbox>;
  /** Every command the toolbox ran: its command line and environment. */
  executed: Array<{ sandboxId: string; command: string; envs: Record<string, string> }>;
  calls: FakeDaytonaCall[];
  callsTo(route: string): FakeDaytonaCall[];
  failNext(route: string, status: number): void;
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startFakeDaytona(
  opts: { apiKey?: string; snapshots?: string[] } = {},
): Promise<FakeDaytona> {
  const apiKey = opts.apiKey ?? "fake-daytona-key";
  const snapshots = opts.snapshots ?? ["optio-node", "optio-python"];
  const sandboxes = new Map<string, FakeDaytonaSandbox>();
  const executed: FakeDaytona["executed"] = [];
  const calls: FakeDaytonaCall[] = [];
  const failures = new Map<string, number>();
  let url = "";

  const view = (s: FakeDaytonaSandbox) => ({
    id: s.id,
    organizationId: "org-1",
    name: s.name,
    snapshot: s.snapshot,
    user: "daytona",
    env: {},
    labels: s.labels,
    public: false,
    target: s.target,
    cpu: 1,
    gpu: 0,
    memory: 1,
    disk: 3,
    state: s.state,
    desiredState: s.state === "stopped" ? "stopped" : "started",
    autoStopInterval: s.autoStopInterval,
    toolboxProxyUrl: `${url}/toolbox`,
  });
  /** A GET moves a sandbox on: the next pending state, else `started`. */
  const advance = (s: FakeDaytonaSandbox) => {
    if (s.pending.length > 0) s.state = s.pending.shift()!;
    else if (s.state === "creating" || s.state === "starting") s.state = "started";
  };

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake-daytona");
    const path = u.pathname.replace(/\/+$/, "");
    const body = req.method === "GET" ? null : await bodyOf(req);
    const route = `${req.method} ${path}`;
    calls.push({ method: req.method ?? "", path, body, headers: req.headers });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return send(401, { statusCode: 401, message: "Unauthorized", error: "Unauthorized" });
    }
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return send(failure, { statusCode: failure, message: "injected failure" });
    }
    const b = (body ?? {}) as Record<string, any>;

    if (route === "GET /api-keys/current") {
      return send(200, {
        name: "optio",
        value: "dtn_****",
        createdAt: "2026-10-01T00:00:00.000Z",
        permissions: ["write:sandboxes", "delete:sandboxes"],
        lastUsedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
        userId: "du-1",
        organizationId: "org-1",
      });
    }
    if (route === "GET /snapshots") {
      const items = snapshots.map((name, i) => ({
        id: `snap-${i}`,
        name,
        state: "active",
        imageName: `registry.example.com/${name}:1`,
        general: false,
      }));
      return send(200, { items, total: items.length, page: 1, totalPages: 1 });
    }
    if (route === "GET /sandbox") {
      // Deleted sandboxes are left out unless asked for (includeErroredDeleted).
      const live = [...sandboxes.values()].filter((s) => s.state !== "destroyed");
      return send(200, { items: live.map(view), nextCursor: null });
    }
    if (route === "POST /sandbox") {
      const s: FakeDaytonaSandbox = {
        id: randomUUID(),
        name: String(b.name ?? ""),
        snapshot: String(b.snapshot ?? ""),
        state: "creating",
        labels: (b.labels as Record<string, string>) ?? {},
        autoStopInterval: Number(b.autoStopInterval ?? 15),
        target: String(b.target ?? "us"),
        pending: [],
      };
      if (!s.name) s.name = s.id;
      if (!snapshots.includes(s.snapshot)) {
        return send(400, { statusCode: 400, message: `Snapshot ${s.snapshot} not found` });
      }
      sandboxes.set(s.id, s);
      return send(200, view(s));
    }
    let m = path.match(/^\/sandbox\/([^/]+)(?:\/(start|stop))?$/);
    if (m) {
      const s = sandboxes.get(m[1]) ?? [...sandboxes.values()].find((x) => x.name === m![1]);
      if (!s || s.state === "destroyed") {
        return send(404, { statusCode: 404, message: `Sandbox ${m[1]} not found` });
      }
      const action = m[2];
      if (!action && req.method === "GET") {
        advance(s);
        return send(200, view(s));
      }
      if (!action && req.method === "DELETE") {
        s.state = "destroyed";
        return send(200, { ...view(s), state: "destroying" });
      }
      if (action === "start" && req.method === "POST") {
        if (s.state === "stopped") s.state = "starting";
        return send(200, view(s));
      }
      if (action === "stop" && req.method === "POST") {
        s.state = "stopped";
        return send(200, view(s));
      }
    }
    m = path.match(/^\/toolbox\/([^/]+)\/process\/execute$/);
    if (m && req.method === "POST") {
      const s = sandboxes.get(m[1]);
      if (!s) return send(404, { message: "sandbox not found" });
      if (s.state !== "started") {
        return send(400, { message: `sandbox is ${s.state}, not started` });
      }
      executed.push({
        sandboxId: s.id,
        command: String(b.command ?? ""),
        envs: (b.envs as Record<string, string>) ?? {},
      });
      return send(200, { exitCode: 0, result: "" });
    }
    return send(404, { statusCode: 404, message: `No fake for ${route}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;

  return {
    url,
    sandboxes,
    executed,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    failNext: (route, status) => void failures.set(route, status),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
