/**
 * Early-frame buffering and close tracking for every WebSocket route.
 *
 * @fastify/websocket calls a route's handler the moment the upgrade
 * completes, and `ws` emits `message` for each frame as it arrives, to
 * whatever listeners exist at that instant; nothing is buffered. Every Optio
 * WS handler has async work to do before it can take a frame:
 * `authenticateWs` (a DB lookup when auth is enabled), role / ownership
 * checks, resource lookups, history replay. A `message` listener attached
 * after that work silently missed whatever the client sent in the meantime.
 * The Optio Local daemon sends `hello` the instant its socket opens, and on
 * loopback against an auth-enabled API it lost that race about 19 times in
 * 20. It then sat in a 10 s "Expected hello" close/reconnect loop forever.
 * The same window swallowed `close`: a client that went away during setup
 * leaked its per-IP connection slot, plus whatever setup created afterwards
 * (Redis subscribers, exec sessions, Optio chat's one-conversation lock).
 *
 * `acceptWs(socket, req)` must be called synchronously at the top of the
 * handler, before its first `await`. It enforces the per-IP connection
 * limit, attaches `message` and `close` listeners right away, and holds
 * incoming frames, bounded, until the handler calls `ready(onMessage)`. That
 * call replays the held frames in arrival order and then delivers live ones.
 * Clients may therefore send as soon as the socket opens.
 */
import type { FastifyRequest } from "fastify";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  WS_CLOSE_CONNECTION_LIMIT,
} from "./ws-limits.js";

/** A frame as `ws` hands it over (a Buffer with the default binaryType). */
export type WsFrame = Buffer | ArrayBuffer | Buffer[] | string;
export type WsMessageHandler = (data: Buffer | string, isBinary: boolean) => void;

/**
 * Frames a client may send before the handler is ready. Normal setup takes
 * milliseconds, and the busiest legitimate client (the daemon's reconnect
 * burst: hello, attention replays, agent limits) sends a handful.
 */
export const WS_PENDING_MAX_FRAMES = 256;
/** Bytes held before ready: four frames at the 1 MB per-message limit. */
export const WS_PENDING_MAX_BYTES = 4 * 1024 * 1024;
/** Close code when a client overruns the pending budget (RFC 6455 policy violation). */
export const WS_CLOSE_PENDING_OVERFLOW = 1008;

const OPEN = 1;

/** The part of a `ws` WebSocket this module touches (mock-friendly). */
export interface WsConnectionSocket {
  readonly readyState?: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  close(code?: number, reason?: string): void;
}

export interface WsConnection {
  /** The socket has closed or is closing. Check it after each `await` in setup. */
  readonly closed: boolean;
  /**
   * Setup succeeded: hand the held frames to `onMessage` in arrival order,
   * then every later frame as it arrives. Call once. Frames held for a
   * socket that has since closed are dropped, not delivered.
   */
  ready(onMessage: WsMessageHandler): void;
  /** Setup failed (auth, role, not found): drop held frames and ignore later ones. */
  discard(): void;
  /** Run `fn` once when the socket closes, or right away if it already has. */
  onClose(fn: () => void): void;
}

export interface WsBufferLimits {
  maxFrames?: number;
  maxBytes?: number;
}

function frameBytes(data: WsFrame): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf-8");
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  if (Buffer.isBuffer(data)) return data.length;
  return data.byteLength;
}

function asBufferOrString(data: WsFrame): Buffer | string {
  if (typeof data === "string" || Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function runHook(fn: () => void): void {
  try {
    fn();
  } catch {
    // A failing cleanup must not stop the others (or crash the close event).
  }
}

/**
 * Start holding the socket's frames and tracking its close. Low-level: route
 * handlers use `acceptWs`, which adds the per-IP connection limit.
 */
export function holdWsFrames(
  socket: WsConnectionSocket,
  limits: WsBufferLimits = {},
): WsConnection {
  const maxFrames = limits.maxFrames ?? WS_PENDING_MAX_FRAMES;
  const maxBytes = limits.maxBytes ?? WS_PENDING_MAX_BYTES;

  let pending: Array<[WsFrame, boolean]> = [];
  let pendingBytes = 0;
  let handler: WsMessageHandler | null = null;
  let discarded = false;
  let closeFired = false;
  const closeHooks: Array<() => void> = [];

  const isClosed = () =>
    closeFired || (typeof socket.readyState === "number" && socket.readyState > OPEN);

  const drop = () => {
    pending = [];
    pendingBytes = 0;
  };

  socket.on("message", (data: WsFrame, isBinary: boolean) => {
    if (discarded || isClosed()) {
      drop();
      return;
    }
    if (handler) {
      handler(asBufferOrString(data), isBinary === true);
      return;
    }
    const bytes = frameBytes(data);
    if (pending.length >= maxFrames || pendingBytes + bytes > maxBytes) {
      discarded = true;
      drop();
      socket.close(WS_CLOSE_PENDING_OVERFLOW, "Too many messages before the connection was ready");
      return;
    }
    pending.push([data, isBinary === true]);
    pendingBytes += bytes;
  });

  socket.on("close", () => {
    if (closeFired) return;
    closeFired = true;
    drop();
    for (const fn of closeHooks.splice(0)) runHook(fn);
  });

  return {
    get closed() {
      return isClosed();
    },
    ready(onMessage) {
      if (handler || discarded) return;
      const held = pending;
      drop();
      if (isClosed()) return;
      handler = onMessage;
      for (const [data, isBinary] of held) {
        // The handler may close the socket (e.g. an oversize frame): stop there.
        if (discarded || isClosed()) break;
        onMessage(asBufferOrString(data), isBinary);
      }
    },
    discard() {
      discarded = true;
      drop();
    },
    onClose(fn) {
      if (closeFired) runHook(fn);
      else closeHooks.push(fn);
    },
  };
}

/**
 * The prologue of every WS route. Call it synchronously, before the
 * handler's first `await`:
 *
 *     const conn = acceptWs(socket, req);
 *     if (!conn) return;                        // per-IP limit: already closed
 *     const user = await authenticateWs(socket, req);
 *     if (!user) return conn.discard();
 *     ...                                       // checks, lookups, replay
 *     conn.onClose(() => cleanup());            // not socket.on("close")
 *     conn.ready((data) => handle(data));       // not socket.on("message")
 *
 * The connection slot is released when the socket closes, whenever that is.
 */
export function acceptWs(
  socket: WsConnectionSocket,
  req: Pick<FastifyRequest, "ip" | "headers">,
): WsConnection | null {
  const clientIp = getClientIp(req);
  if (!trackConnection(clientIp)) {
    socket.close(WS_CLOSE_CONNECTION_LIMIT, "Too many connections");
    return null;
  }
  const conn = holdWsFrames(socket);
  conn.onClose(() => releaseConnection(clientIp));
  return conn;
}
