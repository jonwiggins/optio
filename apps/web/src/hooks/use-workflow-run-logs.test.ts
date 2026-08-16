import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockGetWorkflowRunLogs = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getWorkflowRunLogs: (...args: any[]) => mockGetWorkflowRunLogs(...args),
  },
}));

// Mock the WS client — capture the event handler and simulate events
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
let wsHandler: ((event: any) => void) | null = null;
vi.mock("@/lib/ws-client", () => ({
  createWorkflowRunLogClient: () => ({
    on: (_event: string, handler: (event: any) => void) => {
      wsHandler = handler;
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
  }),
}));

vi.mock("@/lib/ws-auth", () => ({
  getWsTokenProvider: () => undefined,
}));

import { useWorkflowRunLogs } from "./use-workflow-run-logs";

describe("useWorkflowRunLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHandler = null;
    mockGetWorkflowRunLogs.mockResolvedValue({
      logs: [
        {
          content: "Starting agent",
          stream: "stdout",
          timestamp: "2025-06-01T00:00:00Z",
          logType: "system",
          metadata: null,
        },
        {
          content: "Running tool",
          stream: "stdout",
          timestamp: "2025-06-01T00:00:01Z",
          logType: "tool_use",
          metadata: { tool: "Bash" },
        },
      ],
    });
  });

  it("fetches historical logs on mount", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    expect(mockGetWorkflowRunLogs).toHaveBeenCalledWith("run-1", { limit: 10000 });
    expect(result.current.logs[0].content).toBe("Starting agent");
  });

  it("connects WS when isActive", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    expect(mockConnect).toHaveBeenCalled();
  });

  it("does not connect WS when not active", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(false);
  });

  it("appends live WS events after historical merge", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    // Simulate a live WS event
    act(() => {
      wsHandler?.({
        content: "New live event",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:02Z",
        logType: "text",
      });
    });

    expect(result.current.logs).toHaveLength(3);
    expect(result.current.logs[2].content).toBe("New live event");
  });

  it("ignores catchUp WebSocket frames while appending normal live frames", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    act(() => {
      wsHandler?.({
        content: "catch-up frame",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:02Z",
        logType: "text",
        catchUp: true,
      });
      wsHandler?.({
        content: "live frame",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:03Z",
        logType: "text",
      });
    });

    expect(result.current.logs.map((l) => l.content)).toEqual([
      "Starting agent",
      "Running tool",
      "live frame",
    ]);
  });

  it("deduplicates identical events", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    // Simulate a duplicate of the last log entry
    act(() => {
      wsHandler?.({
        content: "Running tool",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:01Z",
        logType: "tool_use",
      });
    });

    // Should still be 2 (duplicate was dropped)
    expect(result.current.logs).toHaveLength(2);
  });

  it("clears logs when clear is called", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.logs).toHaveLength(0);
  });

  it("sets capped when logs reach limit", async () => {
    const manyLogs = Array.from({ length: 10000 }, (_, i) => ({
      content: `Log ${i}`,
      stream: "stdout",
      timestamp: `2025-06-01T00:00:${String(i).padStart(2, "0")}Z`,
      logType: "text",
      metadata: null,
    }));
    mockGetWorkflowRunLogs.mockResolvedValue({ logs: manyLogs });

    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.capped).toBe(true);
    });
  });

  it("handles fetch errors gracefully", async () => {
    mockGetWorkflowRunLogs.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      // After error, logs should be empty (just live events, which are also empty)
      expect(result.current.logs).toHaveLength(0);
    });
  });

  it("disconnects WS on unmount", async () => {
    const { unmount } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalled();
    });

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });
});
