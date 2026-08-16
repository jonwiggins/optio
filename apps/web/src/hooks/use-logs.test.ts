import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockOn = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
vi.mock("@/lib/ws-client", () => ({
  createLogClient: vi.fn(() => ({
    on: mockOn,
    connect: mockConnect,
    disconnect: mockDisconnect,
  })),
}));
vi.mock("@/lib/ws-auth", () => ({
  getWsTokenProvider: vi.fn(() => () => Promise.resolve("token")),
}));

const mockGetTaskLogs = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getTaskLogs: (...args: any[]) => mockGetTaskLogs(...args) },
}));

import { useLogs } from "./use-logs";

describe("useLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskLogs.mockResolvedValue({ logs: [] });
    // Reset mockOn so each test gets fresh handler capture
    mockOn.mockImplementation(() => () => {});
  });

  it("connects WebSocket on mount", () => {
    renderHook(() => useLogs("task-1"));
    expect(mockConnect).toHaveBeenCalled();
  });

  it("fetches historical logs on mount", () => {
    renderHook(() => useLogs("task-1"));
    expect(mockGetTaskLogs).toHaveBeenCalledWith("task-1", { limit: 10000 });
  });

  it("sets connected=true after connection", async () => {
    const { result } = renderHook(() => useLogs("task-1"));

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });
  });

  it("sets capped=true when historical log count reaches limit", async () => {
    const manyLogs = Array.from({ length: 10000 }, (_, i) => ({
      content: `line ${i}`,
      stream: "stdout",
      timestamp: `2025-06-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    mockGetTaskLogs.mockResolvedValue({ logs: manyLogs });

    const { result } = renderHook(() => useLogs("task-1"));

    await waitFor(() => {
      expect(result.current.capped).toBe(true);
    });
  });

  it("clears logs on clear() call", async () => {
    mockGetTaskLogs.mockResolvedValue({
      logs: [{ content: "hello", stream: "stdout", timestamp: "2025-06-01T00:00:00Z" }],
    });

    const { result } = renderHook(() => useLogs("task-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.logs).toHaveLength(0);
  });

  it("disconnects WebSocket on unmount", () => {
    const { unmount } = renderHook(() => useLogs("task-1"));
    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("merges historical and live logs (deduplicates)", async () => {
    let logHandler: ((event: any) => void) | undefined;
    mockOn.mockImplementation((eventType: string, handler: (event: any) => void) => {
      if (eventType === "task:log") {
        logHandler = handler;
      }
      return () => {};
    });

    // Historical logs will arrive after the live event
    mockGetTaskLogs.mockImplementation(() =>
      Promise.resolve({
        logs: [
          { content: "historical-1", stream: "stdout", timestamp: "2025-06-01T00:00:00Z" },
          { content: "duplicate", stream: "stdout", timestamp: "2025-06-01T00:00:01Z" },
        ],
      }),
    );

    const { result } = renderHook(() => useLogs("task-1"));

    // Simulate a live event arriving before historical logs resolve.
    // The hook buffers it in pendingLive and deduplicates on merge.
    act(() => {
      logHandler?.({
        content: "duplicate",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:01Z",
      });
      logHandler?.({
        content: "live-only",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(result.current.logs.length).toBe(3);
    });

    const contents = result.current.logs.map((l) => l.content);
    expect(contents).toEqual(["historical-1", "duplicate", "live-only"]);
  });

  it("ignores catchUp WebSocket frames while appending normal live frames", async () => {
    let logHandler: ((event: any) => void) | undefined;
    mockOn.mockImplementation((eventType: string, handler: (event: any) => void) => {
      if (eventType === "task:log") {
        logHandler = handler;
      }
      return () => {};
    });
    mockGetTaskLogs.mockResolvedValue({
      logs: [{ content: "historical", stream: "stdout", timestamp: "2025-06-01T00:00:00Z" }],
    });

    const { result } = renderHook(() => useLogs("task-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      logHandler?.({
        content: "catch-up frame",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:01Z",
        catchUp: true,
      });
      logHandler?.({
        content: "live frame",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:02Z",
      });
    });

    expect(result.current.logs.map((l) => l.content)).toEqual(["historical", "live frame"]);
  });
});
