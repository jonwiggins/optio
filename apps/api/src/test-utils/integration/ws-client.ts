/**
 * WebSocket helpers for integration tests that drive the real WS route
 * handlers in-process: an app wired like server.ts (Sec-WebSocket-Protocol
 * negotiation) listening on an ephemeral port, and a small client that
 * records every JSON frame.
 */
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";

export type WsFrame = Record<string, any>;

type Routes = (app: FastifyInstance) => Promise<void> | void;

/** Register WS routes on a fresh app that negotiates protocols like server.ts. */
export async function listenWsApp(
  routes: Routes[],
): Promise<{ app: FastifyInstance; baseUrl: string; wsBase: string }> {
  const app = Fastify({ logger: false });
  await app.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has("optio-ws-v1") ? "optio-ws-v1" : (protocols.values().next().value ?? false),
    },
  });
  for (const route of routes) await app.register(route);
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, baseUrl, wsBase: baseUrl.replace(/^http/, "ws") };
}

export interface WsTestClientOptions {
  /** Authenticate like the CLI / apps: `optio-auth-<token>` in Sec-WebSocket-Protocol. */
  token?: string;
  /** Runs synchronously inside the `open` event — "send the moment it opens". */
  onOpen?: (client: WsTestClient) => void;
}

export class WsTestClient {
  readonly ws: WebSocket;
  readonly frames: WsFrame[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<{ match: (f: WsFrame) => boolean; resolve: (f: WsFrame) => void }> = [];
  private seen = 0;

  constructor(url: string, opts: WsTestClientOptions = {}) {
    this.ws = new WebSocket(
      url,
      opts.token ? ["optio-ws-v1", `optio-auth-${opts.token}`] : undefined,
    );
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => {
        opts.onOpen?.(this);
        resolve();
      };
      this.ws.onerror = () => reject(new Error(`socket error on ${url}`));
    });
    this.closed = new Promise((resolve) => {
      this.ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const frame = JSON.parse(ev.data) as WsFrame;
      this.frames.push(frame);
      const i = this.waiters.findIndex((w) => w.match(frame));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame);
    };
  }

  send(frame: WsFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** The next frame (after the previous next()) matching `match`. */
  next(match: (f: WsFrame) => boolean, timeoutMs = 5_000): Promise<WsFrame> {
    const i = this.frames.slice(this.seen).findIndex(match);
    if (i >= 0) {
      const frame = this.frames[this.seen + i];
      this.seen += i + 1;
      return Promise.resolve(frame);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; frames so far: ${JSON.stringify(this.frames)}`)),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          this.seen = this.frames.length;
          resolve(f);
        },
      });
    });
  }

  async close(): Promise<void> {
    if (this.ws.readyState < WebSocket.CLOSING) this.ws.close();
    await this.closed;
  }
}
