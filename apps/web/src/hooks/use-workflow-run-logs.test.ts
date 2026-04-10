import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockGetWorkflowRunLogs = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getWorkflowRunLogs: (...args: any[]) => mockGetWorkflowRunLogs(...args),
  },
}));

import { useWorkflowRunLogs } from "./use-workflow-run-logs";

describe("useWorkflowRunLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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

  it("fetches logs on mount", async () => {
    vi.useRealTimers();
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockGetWorkflowRunLogs).toHaveBeenCalledWith("run-1", { limit: 10000 });
    expect(result.current.logs).toHaveLength(2);
    expect(result.current.logs[0].content).toBe("Starting agent");
  });

  it("starts with loading=true", () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));
    expect(result.current.loading).toBe(true);
  });

  it("sets connected=true when isActive", async () => {
    vi.useRealTimers();
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connected).toBe(true);
  });

  it("sets connected=false when not active", async () => {
    vi.useRealTimers();
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connected).toBe(false);
  });

  it("polls when active", async () => {
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", true));

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockGetWorkflowRunLogs).toHaveBeenCalledTimes(1);

    // Advance to trigger poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mockGetWorkflowRunLogs).toHaveBeenCalledTimes(2);
  });

  it("does not poll when inactive", async () => {
    vi.useRealTimers();
    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const callCount = mockGetWorkflowRunLogs.mock.calls.length;

    // Wait well beyond the poll interval — no new calls should happen
    await new Promise((r) => setTimeout(r, 100));

    expect(mockGetWorkflowRunLogs).toHaveBeenCalledTimes(callCount);
  });

  it("clears logs when clear is called", async () => {
    vi.useRealTimers();
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
    vi.useRealTimers();
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
    vi.useRealTimers();
    mockGetWorkflowRunLogs.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useWorkflowRunLogs("run-1", false));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should not crash, logs should be empty
    expect(result.current.logs).toHaveLength(0);
  });
});
