import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mockListPrReviewLogs = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    listPrReviewLogs: (...args: any[]) => mockListPrReviewLogs(...args),
  },
}));

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
let wsHandler: ((event: any) => void) | null = null;
vi.mock("@/lib/ws-client", () => ({
  createPrReviewLogClient: () => ({
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

import { usePrReviewLogs } from "./use-pr-review-logs";

describe("usePrReviewLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHandler = null;
    mockListPrReviewLogs.mockResolvedValue({
      logs: [
        {
          content: "Historical review log",
          stream: "stdout",
          timestamp: "2025-06-01T00:00:00Z",
          logType: "text",
          metadata: null,
        },
      ],
    });
  });

  it("fetches historical logs on mount", async () => {
    const { result } = renderHook(() => usePrReviewLogs("review-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    expect(mockListPrReviewLogs).toHaveBeenCalledWith("review-1");
    expect(result.current.logs[0].content).toBe("Historical review log");
  });

  it("appends live WebSocket frames after historical logs", async () => {
    const { result } = renderHook(() => usePrReviewLogs("review-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      wsHandler?.({
        content: "Live review log",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:01Z",
        logType: "text",
      });
    });

    expect(result.current.logs.map((l) => l.content)).toEqual([
      "Historical review log",
      "Live review log",
    ]);
  });

  it("ignores catchUp WebSocket frames while appending normal live frames", async () => {
    const { result } = renderHook(() => usePrReviewLogs("review-1"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      wsHandler?.({
        content: "Catch-up review log",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:01Z",
        logType: "text",
        catchUp: true,
      });
      wsHandler?.({
        content: "Live review log",
        stream: "stdout",
        timestamp: "2025-06-01T00:00:02Z",
        logType: "text",
      });
    });

    expect(result.current.logs.map((l) => l.content)).toEqual([
      "Historical review log",
      "Live review log",
    ]);
  });

  it("disconnects WebSocket on unmount", async () => {
    const { unmount } = renderHook(() => usePrReviewLogs("review-1"));

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalled();
    });

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });
});
