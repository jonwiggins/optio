import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process E2B for tests of the E2B provider
 * (services/remote-workspaces/e2b.ts): the REST calls Optio makes, shaped as
 * E2B's spec/openapi.yml describes them, and envd's `process.Process/Start`
 * (spec/envd/process/process.proto) as a Connect server-streaming call with
 * JSON envelopes, under `<url>/envd/<sandboxID>` — point the provider there
 * with `setEnvdUrlForTests((id) => `${e2b.url}/envd/${id}`)`.
 *
 *   const e2b = await startFakeE2b({ apiKey: "e2b_1" });
 *   e2b.sandboxes.get(id).state; e2b.started; e2b.callsTo("POST /v2/sandboxes")
 *   await e2b.close();
 */

export interface FakeE2bSandbox {
  sandboxID: string;
  templateID: string;
  state: "running" | "paused";
  envdAccessToken: string;
  metadata: Record<string, string>;
  timeout: number;
  autoPause: boolean;
}

export interface FakeE2bCall {
  method: string;
  path: string;
  query: string;
  body: unknown;
  headers: IncomingMessage["headers"];
}

export interface FakeE2b {
  url: string;
  domain: string;
  sandboxes: Map<string, FakeE2bSandbox>;
  /** Every process envd started: its command, arguments and environment. */
  started: Array<{
    sandboxId: string;
    cmd: string;
    args: string[];
    envs: Record<string, string>;
    user: string | null;
  }>;
  calls: FakeE2bCall[];
  callsTo(route: string): FakeE2bCall[];
  failNext(route: string, status: number): void;
  close(): Promise<void>;
}

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** A Connect envelope: flags, a big-endian length, the JSON message. */
function envelope(message: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export async function startFakeE2b(
  opts: { apiKey?: string; envdVersion?: string } = {},
): Promise<FakeE2b> {
  const apiKey = opts.apiKey ?? "e2b_fake_key";
  const envdVersion = opts.envdVersion ?? "0.5.1";
  const domain = "e2b.test";
  const sandboxes = new Map<string, FakeE2bSandbox>();
  const started: FakeE2b["started"] = [];
  const calls: FakeE2bCall[] = [];
  const failures = new Map<string, number>();
  let pid = 400;

  const detail = (s: FakeE2bSandbox) => ({
    templateID: s.templateID,
    alias: "optio-node",
    sandboxID: s.sandboxID,
    clientID: "fake",
    startedAt: "2026-10-25T10:00:00Z",
    endAt: "2026-10-25T11:00:00Z",
    envdVersion,
    envdAccessToken: s.envdAccessToken,
    domain,
    cpuCount: 2,
    memoryMB: 2048,
    diskSizeMB: 4096,
    metadata: s.metadata,
    state: s.state,
  });

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake-e2b");
    const path = u.pathname.replace(/\/+$/, "");
    const buf = req.method === "GET" ? Buffer.alloc(0) : await rawBody(req);
    const route = `${req.method} ${path}`;
    let body: unknown = null;
    const isConnect = String(req.headers["content-type"] ?? "").startsWith("application/connect");
    if (buf.length && !isConnect) {
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch {
        body = buf.toString("utf8");
      }
    }
    calls.push({ method: req.method ?? "", path, query: u.search, body, headers: req.headers });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    // envd, in the sandbox: its own access token, not the API key.
    const envd = path.match(/^\/envd\/([^/]+)\/process\.Process\/Start$/);
    if (envd && req.method === "POST") {
      const s = sandboxes.get(envd[1]);
      if (!s || s.state !== "running") return send(502, { message: "sandbox not running" });
      if (req.headers["x-access-token"] !== s.envdAccessToken) {
        return send(401, { code: "unauthenticated", message: "invalid access token" });
      }
      if (req.headers["connect-protocol-version"] !== "1" || !isConnect) {
        return send(415, { code: "invalid_argument", message: "not a Connect streaming call" });
      }
      const len = buf.readUInt32BE(1);
      const msg = JSON.parse(buf.subarray(5, 5 + len).toString("utf8")) as {
        process: { cmd: string; args?: string[]; envs?: Record<string, string> };
      };
      const auth = req.headers.authorization;
      started.push({
        sandboxId: s.sandboxID,
        cmd: msg.process.cmd,
        args: msg.process.args ?? [],
        envs: msg.process.envs ?? {},
        user: auth ? Buffer.from(auth.replace(/^Basic /, ""), "base64").toString() : null,
      });
      res.writeHead(200, { "content-type": "application/connect+json" });
      res.end(
        Buffer.concat([
          envelope({ event: { start: { pid: ++pid } } }),
          envelope({ event: { end: { exitCode: 0, exited: true, status: "exit status 0" } } }),
          envelope({}, 0x02),
        ]),
      );
      return;
    }

    if (req.headers["x-api-key"] !== apiKey) {
      return send(401, { code: 401, message: "Invalid API key" });
    }
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return send(failure, { code: failure, message: "injected failure" });
    }
    const b = (body ?? {}) as Record<string, any>;

    if (route === "GET /v2/templates") {
      return send(200, [
        {
          templateID: "tpl-node",
          buildID: "b-1",
          cpuCount: 2,
          memoryMB: 2048,
          diskSizeMB: 4096,
          public: false,
          aliases: ["optio-node"],
          names: ["acme/optio-node"],
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          createdBy: null,
          lastSpawnedAt: null,
          spawnCount: 0,
          buildCount: 1,
          envdVersion,
          buildStatus: "ready",
        },
      ]);
    }
    if (route === "GET /v2/sandboxes") {
      const wanted = (u.searchParams.get("state") ?? "running,paused").split(",");
      return send(200, [...sandboxes.values()].filter((s) => wanted.includes(s.state)).map(detail));
    }
    if (route === "POST /v2/sandboxes") {
      if (b.templateID !== "tpl-node" && b.templateID !== "optio-node") {
        return send(404, { code: 404, message: `template '${b.templateID}' not found` });
      }
      const s: FakeE2bSandbox = {
        sandboxID: `i${randomBytes(8).toString("hex")}`,
        templateID: "tpl-node",
        state: "running",
        envdAccessToken: randomBytes(16).toString("hex"),
        metadata: (b.metadata as Record<string, string>) ?? {},
        timeout: Number(b.timeout ?? 300),
        autoPause: !!b.autoPause,
      };
      sandboxes.set(s.sandboxID, s);
      return send(201, {
        templateID: s.templateID,
        sandboxID: s.sandboxID,
        alias: "optio-node",
        clientID: "fake",
        envdVersion,
        envdAccessToken: s.envdAccessToken,
        domain,
      });
    }
    let m = path.match(/^\/sandboxes\/([^/]+)(?:\/(pause))?$/);
    if (m) {
      const s = sandboxes.get(m[1]);
      if (!s) return send(404, { code: 404, message: `sandbox "${m[1]}" doesn't exist` });
      if (!m[2] && req.method === "GET") return send(200, detail(s));
      if (!m[2] && req.method === "DELETE") {
        sandboxes.delete(s.sandboxID);
        res.writeHead(204);
        return res.end();
      }
      if (m[2] === "pause" && req.method === "POST") {
        if (s.state === "paused") return send(409, { code: 409, message: "already paused" });
        s.state = "paused";
        res.writeHead(204);
        return res.end();
      }
    }
    m = path.match(/^\/v2\/sandboxes\/([^/]+)\/connect$/);
    if (m && req.method === "POST") {
      const s = sandboxes.get(m[1]);
      if (!s) return send(404, { code: 404, message: `sandbox "${m[1]}" doesn't exist` });
      const wasPaused = s.state === "paused";
      s.state = "running";
      s.timeout = Number(b.timeout ?? 300);
      return send(wasPaused ? 201 : 200, {
        templateID: s.templateID,
        sandboxID: s.sandboxID,
        clientID: "fake",
        envdVersion,
        envdAccessToken: s.envdAccessToken,
        domain,
      });
    }
    return send(404, { code: 404, message: `No fake for ${route}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    domain,
    sandboxes,
    started,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    failNext: (route, status) => void failures.set(route, status),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
