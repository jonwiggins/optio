import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockGetSessionChat = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getSessionChat: (...args: any[]) => mockGetSessionChat(...args) },
}));

vi.mock("@/lib/ws-client.js", () => ({
  getWsBaseUrl: () => "ws://localhost",
}));

// In-test fake WebSocket that lets us drive open/message events directly.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  // Test helpers ─────────────────────────────────────────────
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const originalWebSocket = (globalThis as any).WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  vi.clearAllMocks();
  mockGetSessionChat.mockResolvedValue({ events: [] });
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

import { useSessionLogs } from "./use-session-logs";

describe("useSessionLogs", () => {
  it("opens a session-chat WebSocket on mount", () => {
    renderHook(() => useSessionLogs("session-1"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/ws/sessions/session-1/chat");
  });

  it("loads historical chat events from the REST endpoint", async () => {
    renderHook(() => useSessionLogs("session-1"));
    expect(mockGetSessionChat).toHaveBeenCalledWith("session-1", { limit: 5000 });
  });

  it("renders historical chat events as logs once they resolve", async () => {
    mockGetSessionChat.mockResolvedValue({
      events: [
        {
          content: "hello from history",
          stream: "stdout",
          timestamp: "2026-04-27T00:00:00.000Z",
          logType: "text",
        },
      ],
    });

    const { result } = renderHook(() => useSessionLogs("session-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.logs[0].content).toBe("hello from history");
  });

  it("restores user messages from history into userMessages, not logs", async () => {
    mockGetSessionChat.mockResolvedValue({
      events: [
        {
          content: "what is 2 + 2?",
          stream: "stdin",
          timestamp: "2026-04-27T00:00:00.000Z",
          logType: "user_message",
        },
        {
          content: "4",
          stream: "stdout",
          timestamp: "2026-04-27T00:00:01.000Z",
          logType: "text",
        },
      ],
    });

    const { result } = renderHook(() => useSessionLogs("session-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.logs[0].content).toBe("4");
    expect(result.current.userMessages).toHaveLength(1);
    expect(result.current.userMessages[0].text).toBe("what is 2 + 2?");
  });

  it("merges live events with historical (deduplicated)", async () => {
    // Historical resolves AFTER live arrives, exercising the buffer/dedup path.
    let resolveHistory: (v: { events: any[] }) => void = () => {};
    mockGetSessionChat.mockImplementation(
      () => new Promise((resolve) => (resolveHistory = resolve)),
    );

    const { result } = renderHook(() => useSessionLogs("session-1"));
    const ws = FakeWebSocket.instances[0];

    act(() => {
      // Live event for a frame that ALSO appears in history → must dedup.
      ws.simulateMessage({
        type: "chat_event",
        event: {
          taskId: "session-1",
          timestamp: "2026-04-27T00:00:01.000Z",
          type: "text",
          content: "duplicate",
        },
      });
      // Live event that history doesn't include → must remain.
      ws.simulateMessage({
        type: "chat_event",
        event: {
          taskId: "session-1",
          timestamp: "2026-04-27T00:00:02.000Z",
          type: "text",
          content: "live-only",
        },
      });
    });

    act(() => {
      resolveHistory({
        events: [
          {
            content: "earlier",
            stream: "stdout",
            timestamp: "2026-04-27T00:00:00.000Z",
            logType: "text",
          },
          {
            content: "duplicate",
            stream: "stdout",
            timestamp: "2026-04-27T00:00:01.000Z",
            logType: "text",
          },
        ],
      });
    });

    await waitFor(() => {
      expect(result.current.logs.map((l) => l.content)).toEqual([
        "earlier",
        "duplicate",
        "live-only",
      ]);
    });
  });

  it("ignores catchUp WebSocket frames (REST is the source of truth for history)", async () => {
    const { result } = renderHook(() => useSessionLogs("session-1"));
    const ws = FakeWebSocket.instances[0];

    // History resolves empty
    await waitFor(() => expect(mockGetSessionChat).toHaveBeenCalled());

    act(() => {
      ws.simulateMessage({
        type: "chat_event",
        catchUp: true,
        event: {
          taskId: "session-1",
          timestamp: "2026-04-27T00:00:00.000Z",
          type: "text",
          content: "catch-up frame",
        },
      });
      ws.simulateMessage({
        type: "chat_event",
        event: {
          taskId: "session-1",
          timestamp: "2026-04-27T00:00:01.000Z",
          type: "text",
          content: "live frame",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.logs[0].content).toBe("live frame");
  });

  it("closes the WebSocket on unmount", () => {
    const { unmount } = renderHook(() => useSessionLogs("session-1"));
    const ws = FakeWebSocket.instances[0];
    const closeSpy = vi.spyOn(ws, "close");
    unmount();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("sets capped=true when historical event count reaches the limit", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      content: `e${i}`,
      stream: "stdout",
      timestamp: `2026-04-27T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      logType: "text",
    }));
    mockGetSessionChat.mockResolvedValue({ events: many });

    const { result } = renderHook(() => useSessionLogs("session-1"));

    await waitFor(() => expect(result.current.capped).toBe(true));
  });

  it("falls back to live-only logs when history fetch fails", async () => {
    mockGetSessionChat.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useSessionLogs("session-1"));
    const ws = FakeWebSocket.instances[0];

    await waitFor(() => expect(mockGetSessionChat).toHaveBeenCalled());

    act(() => {
      ws.simulateMessage({
        type: "chat_event",
        event: {
          taskId: "session-1",
          timestamp: "2026-04-27T00:00:00.000Z",
          type: "text",
          content: "live after failure",
        },
      });
    });

    await waitFor(() => expect(result.current.logs).toHaveLength(1));
    expect(result.current.logs[0].content).toBe("live after failure");
  });
});
