/**
 * E2E: Optio Local against the real API server with auth ENABLED — the setup
 * `optio local up` meets on an auth-enabled install (local-terminal.e2e runs
 * with auth disabled, where authenticateWs resolves without touching the DB).
 *
 * The CLI daemon sends `hello` the instant its socket opens, while the server
 * is still looking its PAT up. Every WS handler used to attach its `message`
 * listener only after that lookup, so on loopback about 19 hellos in 20 were
 * dropped and the daemon sat in a 10 s "Expected hello" close/reconnect loop
 * forever. The same applied to a viewer's first keystrokes. The server now
 * holds early frames until the handler is ready (ws/ws-connection.ts).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
let wsBase = "";
const PAT = `optio_pat_${randomBytes(32).toString("hex")}`;

/** A member with a personal access token, seeded straight into the DB. */
async function seedMemberWithPat(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const wsId = randomUUID();
    const userId = randomUUID();
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${wsId}, 'Local auth e2e', ${`local-auth-${wsId.slice(0, 8)}`})`;
    await sql`
      INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${userId}, 'github', 'local-auth-e2e', 'dev@local-auth.e2e', 'Local auth dev', ${wsId})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${wsId}, ${userId}, 'member')`;
    await sql`
      INSERT INTO api_keys (user_id, name, prefix, hashed_key)
      VALUES (${userId}, 'optio local up', ${PAT.slice(0, 12)},
              ${createHash("sha256").update(PAT).digest("hex")})`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await seedMemberWithPat();
  server = await startApiServer({ env: { OPTIO_AUTH_DISABLED: "false" } });
  wsBase = server.baseUrl.replace(/^http/, "ws");
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function api<T = any>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${PAT}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

type Json = Record<string, any>;

/** A socket authenticated like the CLI: PAT in Sec-WebSocket-Protocol. */
class Peer {
  readonly ws: WebSocket;
  readonly inbox: Json[] = [];
  readonly closed: Promise<number>;
  private waiters: Array<{ match: (m: Json) => boolean; resolve: (m: Json) => void }> = [];

  /** `onOpen` runs inside the `open` event — the CLI's timing. */
  constructor(path: string, onOpen: (peer: Peer) => void) {
    this.ws = new WebSocket(`${wsBase}${path}`, ["optio-ws-v1", `optio-auth-${PAT}`]);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => onOpen(this);
    this.closed = new Promise((resolve) => {
      this.ws.onclose = (ev) => resolve(ev.code);
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data) as Json;
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    };
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(match: (m: Json) => boolean, timeoutMs = 5_000): Promise<Json> {
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState < WebSocket.CLOSING) this.ws.close();
    await this.closed;
  }
}

/** A daemon that says hello the instant it connects, like `optio local up`. */
function daemon(hostId: string, terminals: Json[] = []): Peer {
  return new Peer("/ws/local/daemon", (p) => {
    p.send({
      type: "hello",
      hostId,
      daemonVersion: "0.0.0-e2e",
      dirs: [{ path: "/tmp/e2e-auth" }],
      terminals,
      claudeCredentials: false,
    });
    p.send({ type: "ping" });
  });
}

describe("Optio Local with auth enabled", () => {
  let hostId = "";

  beforeAll(async () => {
    const { status, body } = await api<{ host: { id: string } }>(
      "POST",
      "/api/local/hosts/register",
      {
        name: "auth e2e laptop",
        hostname: "auth-e2e",
        platform: "darwin",
        dirs: [{ path: "/tmp/e2e-auth" }],
      },
    );
    expect(status, JSON.stringify(body)).toBe(200);
    hostId = body.host.id;
  });

  it("accepts the hello a daemon sends on open, every time", async () => {
    for (let i = 0; i < 20; i++) {
      const d = daemon(hostId);
      // pong only comes back once the hello was accepted
      await d.next((m) => m.type === "pong");
      await d.close();
    }
    const { body } = await api<{ hosts: Array<{ id: string; lastSeenAt: string | null }> }>(
      "GET",
      "/api/local/hosts",
    );
    expect(body.hosts.find((h) => h.id === hostId)?.lastSeenAt).toBeTruthy();
  });

  it("delivers the keystrokes a viewer sends on open to the daemon", async () => {
    const d = daemon(hostId);
    await d.next((m) => m.type === "pong");

    const created = await api<{ terminal: { id: string } }>("POST", "/api/local/terminals", {
      hostId,
      dir: "/tmp/e2e-auth",
      spec: { kind: "shell" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const terminalId = created.body.terminal.id;
    await d.next((m) => m.type === "spawn" && m.terminalId === terminalId);
    d.send({ type: "started", terminalId });
    await waitFor(async () => {
      const { body } = await api<{ terminal: { state: string } }>(
        "GET",
        `/api/local/terminals/${terminalId}`,
      );
      return body.terminal.state === "running" ? true : null;
    });

    const viewer = new Peer(`/ws/local/terminals/${terminalId}/stream`, (p) => {
      p.send({ type: "input", data: "whoami\r" });
    });
    const attach = await d.next((m) => m.type === "attach" && m.terminalId === terminalId);
    const input = await d.next((m) => m.type === "input" && m.terminalId === terminalId);
    expect(attach.attachId).toBeTruthy();
    expect(Buffer.from(input.dataB64, "base64").toString()).toBe("whoami\r");

    await viewer.close();
    await d.close();
  });
});
