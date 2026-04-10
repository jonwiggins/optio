import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsClient, getWsBaseUrl, createWorkflowRunLogClient } from "./ws-client";

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  url: string;
  protocols: string | string[] | undefined;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  send = vi.fn();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }
}

describe("WsClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a WebSocket connection on connect()", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://localhost:4000/ws/events");
  });

  it("does not create duplicate connections when already open", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("dispatches events to registered handlers", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const handler = vi.fn();
    client.on("task:state_changed", handler);

    const ws = MockWebSocket.instances[0];
    ws.onmessage!({ data: JSON.stringify({ type: "task:state_changed", taskId: "1" }) });

    expect(handler).toHaveBeenCalledWith({ type: "task:state_changed", taskId: "1" });
  });

  it("dispatches to wildcard handlers", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const handler = vi.fn();
    client.on("*", handler);

    const ws = MockWebSocket.instances[0];
    ws.onmessage!({ data: JSON.stringify({ type: "any:event" }) });

    expect(handler).toHaveBeenCalledWith({ type: "any:event" });
  });

  it("unsubscribes handler when returned function is called", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const handler = vi.fn();
    const unsub = client.on("test", handler);

    const ws = MockWebSocket.instances[0];
    ws.onmessage!({ data: JSON.stringify({ type: "test" }) });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    ws.onmessage!({ data: JSON.stringify({ type: "test" }) });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed JSON messages", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const handler = vi.fn();
    client.on("test", handler);

    const ws = MockWebSocket.instances[0];
    // Should not throw
    ws.onmessage!({ data: "not json" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reconnects after connection close", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.CLOSED;
    ws.onclose!({ code: 1006 });

    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("disconnect clears reconnect timer and closes socket", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const ws = MockWebSocket.instances[0];
    client.disconnect();

    expect(ws.close).toHaveBeenCalled();

    // Should not reconnect after disconnect
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("send() transmits JSON data when socket is open", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    client.send({ action: "subscribe" });
    const ws = MockWebSocket.instances[0];
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ action: "subscribe" }));
  });

  it("send() is a no-op when socket is not open", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.CLOSED;

    client.send({ action: "test" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("sends token via Sec-WebSocket-Protocol header, not URL", async () => {
    const tokenProvider = vi.fn().mockResolvedValue("test-token");
    const client = new WsClient("ws://localhost:4000/ws/events", tokenProvider);
    client.connect();

    // Token provider is async, need to flush promises
    await vi.runAllTimersAsync();

    expect(tokenProvider).toHaveBeenCalled();
    const ws = MockWebSocket.instances[0];
    // URL must NOT contain token (security: prevents token leaking into logs/history)
    expect(ws.url).toBe("ws://localhost:4000/ws/events");
    // Token must be sent via WebSocket subprotocol header
    expect(ws.protocols).toEqual(["optio-ws-v1", "optio-auth-test-token"]);
  });

  it("connects without protocols when provider returns null (cookie auth)", async () => {
    const tokenProvider = vi.fn().mockResolvedValue(null);
    const client = new WsClient("ws://localhost:4000/ws/events", tokenProvider);
    client.connect();

    await vi.runAllTimersAsync();

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:4000/ws/events");
    expect(ws.protocols).toBeUndefined();
  });

  it("retries connection when token provider fails", async () => {
    const tokenProvider = vi.fn().mockRejectedValueOnce(new Error("auth failed"));
    const client = new WsClient("ws://localhost:4000/ws/events", tokenProvider);
    client.connect();

    // Flush the rejected promise
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances).toHaveLength(0);

    // Now make the token provider succeed on retry
    tokenProvider.mockResolvedValueOnce("new-token");
    await vi.advanceTimersByTimeAsync(3000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].protocols).toEqual(["optio-ws-v1", "optio-auth-new-token"]);
  });

  it("closes socket on error event", () => {
    const client = new WsClient("ws://localhost:4000/ws/events");
    client.connect();

    const ws = MockWebSocket.instances[0];
    ws.onerror!();

    expect(ws.close).toHaveBeenCalled();
  });
});

describe("getWsBaseUrl", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (!globalThis.window && originalWindow) {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    }
  });

  it("returns NEXT_PUBLIC_WS_URL when set", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "ws://custom:9999");
    expect(getWsBaseUrl()).toBe("ws://custom:9999");
  });

  it("returns ws:// derived from PUBLIC_API_URL when injected", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { protocol: "http:", host: "localhost:30310" },
        __OPTIO_CONFIG: { publicApiUrl: "http://localhost:30400" },
      },
      writable: true,
      configurable: true,
    });
    expect(getWsBaseUrl()).toBe("ws://localhost:30400");
  });

  it("returns ws:// + host for http: pages", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { protocol: "http:", host: "localhost:3000" },
      },
      writable: true,
      configurable: true,
    });
    expect(getWsBaseUrl()).toBe("ws://localhost:3000");
  });

  it("returns wss:// + host for https: pages", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { protocol: "https:", host: "optio.example.com" },
      },
      writable: true,
      configurable: true,
    });
    expect(getWsBaseUrl()).toBe("wss://optio.example.com");
  });

  it("returns SSR fallback when window is undefined", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    // @ts-expect-error -- simulating SSR by removing window
    delete globalThis.window;
    expect(getWsBaseUrl()).toBe("ws://localhost:4000");
  });
});

describe("createWorkflowRunLogClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "ws://localhost:4000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates a WsClient with the correct URL", () => {
    const client = createWorkflowRunLogClient("wr-123");
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://localhost:4000/ws/workflow-runs/wr-123/logs");
  });

  it("passes token provider to the client", async () => {
    vi.useFakeTimers();
    const tokenProvider = vi.fn().mockResolvedValue("my-token");
    const client = createWorkflowRunLogClient("wr-456", tokenProvider);
    client.connect();

    await vi.runAllTimersAsync();

    expect(tokenProvider).toHaveBeenCalled();
    const ws = MockWebSocket.instances[0];
    expect(ws.protocols).toEqual(["optio-ws-v1", "optio-auth-my-token"]);
    vi.useRealTimers();
  });
});
