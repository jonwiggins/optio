import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptWs,
  holdWsFrames,
  WS_CLOSE_PENDING_OVERFLOW,
  WS_PENDING_MAX_BYTES,
  WS_PENDING_MAX_FRAMES,
} from "./ws-connection.js";
import {
  _getConnectionCounts,
  _resetConnectionCounts,
  MAX_WS_CONNECTIONS_PER_IP,
  WS_CLOSE_CONNECTION_LIMIT,
} from "./ws-limits.js";

/** Stand-in for a server-side `ws` socket: `message` / `close` events + readyState. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  /** Server-initiated close: CLOSING now, `close` event later (see finishClose). */
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 1) this.readyState = 2;
  }
  /** The close handshake completes (or the peer hung up). */
  finishClose(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
  frame(text: string): void {
    this.emit("message", Buffer.from(text), false);
  }
}

const received = () => {
  const frames: string[] = [];
  const handler = vi.fn((data: Buffer | string) => {
    frames.push(typeof data === "string" ? data : data.toString("utf-8"));
  });
  return { frames, handler };
};

describe("holdWsFrames", () => {
  it("holds frames until ready, replays them in order, then delivers live ones", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.frame("hello");
    socket.frame("ping");

    const { frames, handler } = received();
    expect(handler).not.toHaveBeenCalled();
    conn.ready(handler);
    expect(frames).toEqual(["hello", "ping"]);

    socket.frame("live");
    expect(frames).toEqual(["hello", "ping", "live"]);
  });

  it("delivers frames straight through when nothing arrived before ready", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    const { frames, handler } = received();
    conn.ready(handler);
    socket.frame("a");
    expect(frames).toEqual(["a"]);
  });

  it("keeps the binary flag and normalizes ArrayBuffer / fragmented frames to a Buffer", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.emit("message", new TextEncoder().encode("ab").buffer, true);
    socket.emit("message", [Buffer.from("c"), Buffer.from("d")], true);
    const got: Array<[string, boolean, boolean]> = [];
    conn.ready((data, isBinary) => {
      got.push([String(data), Buffer.isBuffer(data), isBinary]);
    });
    expect(got).toEqual([
      ["ab", true, true],
      ["cd", true, true],
    ]);
  });

  it("ignores a second ready()", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    const first = received();
    const second = received();
    conn.ready(first.handler);
    conn.ready(second.handler);
    socket.frame("x");
    expect(first.frames).toEqual(["x"]);
    expect(second.handler).not.toHaveBeenCalled();
  });

  it("discard() drops held frames and every later one (auth failed)", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.frame("before");
    conn.discard();
    socket.frame("after");
    const { handler } = received();
    conn.ready(handler);
    socket.frame("later");
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops frames held for a socket that closed before ready", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.frame("orphan");
    socket.finishClose();
    const { handler } = received();
    conn.ready(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops held frames once the server started closing the socket", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.frame("one");
    socket.close(4403, "Access denied");
    expect(conn.closed).toBe(true);
    const { handler } = received();
    conn.ready(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops replaying when the handler closes the socket", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    socket.frame("too-big");
    socket.frame("next");
    const seen: string[] = [];
    conn.ready((data) => {
      seen.push(String(data));
      socket.close(4413, "Message too large");
    });
    expect(seen).toEqual(["too-big"]);
  });

  it("closes with 1008 and drops everything past the frame budget", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket, { maxFrames: 3 });
    for (let i = 0; i < 4; i++) socket.frame(`f${i}`);
    expect(socket.closeCalls).toEqual([
      [WS_CLOSE_PENDING_OVERFLOW, "Too many messages before the connection was ready"],
    ]);
    const { handler } = received();
    conn.ready(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("closes with 1008 past the byte budget", () => {
    const socket = new FakeSocket();
    holdWsFrames(socket, { maxBytes: 10 });
    socket.frame("123456");
    expect(socket.closeCalls).toEqual([]);
    socket.frame("789012");
    expect(socket.closeCalls[0]?.[0]).toBe(WS_CLOSE_PENDING_OVERFLOW);
  });

  it("defaults to a budget that fits a reconnect burst but not a flood", () => {
    expect(WS_PENDING_MAX_FRAMES).toBeGreaterThanOrEqual(64);
    expect(WS_PENDING_MAX_BYTES).toBeGreaterThanOrEqual(1_048_576);
    const socket = new FakeSocket();
    holdWsFrames(socket);
    for (let i = 0; i < WS_PENDING_MAX_FRAMES; i++) socket.frame("{}");
    expect(socket.closeCalls).toEqual([]);
    socket.frame("{}");
    expect(socket.closeCalls[0]?.[0]).toBe(WS_CLOSE_PENDING_OVERFLOW);
  });

  it("runs close hooks once, and right away when registered after the close", () => {
    const socket = new FakeSocket();
    const conn = holdWsFrames(socket);
    const early = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const later = vi.fn();
    conn.onClose(early);
    conn.onClose(throwing);
    expect(conn.closed).toBe(false);

    socket.finishClose();
    socket.emit("close");
    expect(early).toHaveBeenCalledTimes(1);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(conn.closed).toBe(true);

    conn.onClose(later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("processes a frame sent while async setup (auth) is still pending", async () => {
    const socket = new FakeSocket();
    let resolveAuth!: (user: { id: string }) => void;
    const auth = new Promise<{ id: string }>((r) => (resolveAuth = r));
    const { frames, handler } = received();

    // A route handler: synchronous prologue, then an await, then ready().
    const route = (async () => {
      const conn = holdWsFrames(socket);
      await auth;
      conn.ready(handler);
    })();

    socket.frame('{"type":"hello"}'); // the client's first frame, right on open
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    resolveAuth({ id: "u" });
    await route;
    expect(frames).toEqual(['{"type":"hello"}']);
  });
});

describe("acceptWs", () => {
  const req = { ip: "10.0.0.7", headers: {} } as never;

  beforeEach(() => _resetConnectionCounts());
  afterEach(() => _resetConnectionCounts());

  it("tracks the connection and releases it exactly once when the socket closes", () => {
    const socket = new FakeSocket();
    const conn = acceptWs(socket, req);
    expect(conn).not.toBeNull();
    expect(_getConnectionCounts().get("10.0.0.7")).toBe(1);

    socket.finishClose();
    socket.emit("close");
    expect(_getConnectionCounts().has("10.0.0.7")).toBe(false);
  });

  it("releases a connection that closed while the handler was still setting up", async () => {
    const socket = new FakeSocket();
    let resolveAuth!: () => void;
    const auth = new Promise<void>((r) => (resolveAuth = r));
    const route = (async () => {
      const conn = acceptWs(socket, req);
      if (!conn) return;
      await auth;
      if (conn.closed) return;
      throw new Error("setup must stop for a closed socket");
    })();

    socket.finishClose(); // client hung up during auth
    expect(_getConnectionCounts().has("10.0.0.7")).toBe(false);
    resolveAuth();
    await route;
  });

  it("rejects past the per-IP limit without buffering anything", () => {
    for (let i = 0; i < MAX_WS_CONNECTIONS_PER_IP; i++) {
      expect(acceptWs(new FakeSocket(), req)).not.toBeNull();
    }
    const socket = new FakeSocket();
    expect(acceptWs(socket, req)).toBeNull();
    expect(socket.closeCalls).toEqual([[WS_CLOSE_CONNECTION_LIMIT, "Too many connections"]]);
    expect(socket.listenerCount("message")).toBe(0);
    expect(_getConnectionCounts().get("10.0.0.7")).toBe(MAX_WS_CONNECTIONS_PER_IP);
  });
});
