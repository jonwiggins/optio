import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted() so these are available inside vi.mock() factory
const {
  mockStartSpan,
  mockSpanEnd,
  mockSpanSetStatus,
  mockSpanRecordException,
  mockSpan,
  mockInject,
  mockExtract,
} = vi.hoisted(() => {
  const mockStartSpan = vi.fn();
  const mockSpanEnd = vi.fn();
  const mockSpanSetStatus = vi.fn();
  const mockSpanRecordException = vi.fn();
  const mockSpanSetAttribute = vi.fn();
  const mockSpanContext = vi.fn().mockReturnValue({
    traceId: "abc123def456abc123def456abc123de",
    spanId: "1234567890abcdef",
  });

  const mockSpan = {
    end: mockSpanEnd,
    setStatus: mockSpanSetStatus,
    recordException: mockSpanRecordException,
    setAttribute: mockSpanSetAttribute,
    spanContext: mockSpanContext,
    isRecording: () => true,
    addEvent: vi.fn(),
    updateName: vi.fn(),
    setAttributes: vi.fn(),
  };

  const mockInject = vi.fn();
  const mockExtract = vi.fn();

  return {
    mockStartSpan,
    mockSpanEnd,
    mockSpanSetStatus,
    mockSpanRecordException,
    mockSpanSetAttribute,
    mockSpanContext,
    mockSpan,
    mockInject,
    mockExtract,
  };
});

vi.mock("@opentelemetry/api", () => {
  const SpanStatusCode = { OK: 1, ERROR: 2, UNSET: 0 };
  const ROOT_CONTEXT = {};
  const activeContext = {};

  return {
    SpanStatusCode,
    ROOT_CONTEXT,
    trace: {
      getTracer: () => ({
        startSpan: (...args: unknown[]) => {
          mockStartSpan(...args);
          return mockSpan;
        },
      }),
      getActiveSpan: () => mockSpan,
      setSpan: (_ctx: unknown, _span: unknown) => activeContext,
    },
    context: {
      active: () => activeContext,
      with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
    propagation: {
      inject: mockInject,
      extract: mockExtract,
    },
  };
});

vi.mock("@optio/shared", () => ({
  classifyError: (msg: string) => {
    if (msg?.includes("ECONNREFUSED")) {
      return { category: "network", title: "Connection refused" };
    }
    return { category: "unknown", title: "Unknown error" };
  },
}));

import {
  withSpan,
  injectTraceContextIntoJob,
  contextFromJobData,
  getCurrentTraceId,
  sanitizeUrl,
  enableSpans,
  isSpansEnabled,
} from "./spans.js";

describe("spans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sanitizeUrl", () => {
    it("strips query string from valid URL", () => {
      expect(sanitizeUrl("https://github.com/foo/bar?token=secret123")).toBe(
        "https://github.com/foo/bar",
      );
    });

    it("strips fragment from valid URL", () => {
      expect(sanitizeUrl("https://example.com/path#section")).toBe("https://example.com/path");
    });

    it("strips both query and fragment", () => {
      expect(sanitizeUrl("https://api.example.com/v1?key=abc#top")).toBe(
        "https://api.example.com/v1",
      );
    });

    it("preserves clean URL", () => {
      expect(sanitizeUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
    });

    it("handles non-URL strings by stripping after ? or #", () => {
      expect(sanitizeUrl("not-a-url?secret=value")).toBe("not-a-url");
    });
  });

  describe("isSpansEnabled / enableSpans", () => {
    it("is a function", () => {
      expect(typeof isSpansEnabled).toBe("function");
    });
  });

  describe("withSpan (when enabled)", () => {
    it("executes the function and returns its result", async () => {
      enableSpans();
      const result = await withSpan("test.span", { "task.id": "123" }, async () => {
        return "hello";
      });
      expect(result).toBe("hello");
    });

    it("sets OK status on success", async () => {
      enableSpans();
      await withSpan("test.span", {}, async () => "ok");
      expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 1 }); // OK
    });

    it("records exception and sets ERROR status on failure", async () => {
      enableSpans();
      await expect(
        withSpan("test.span", {}, async () => {
          throw new Error("ECONNREFUSED connecting to host");
        }),
      ).rejects.toThrow("ECONNREFUSED");

      expect(mockSpanRecordException).toHaveBeenCalled();
      expect(mockSpanSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 }), // ERROR
      );
    });

    it("ends the span in all cases", async () => {
      enableSpans();
      await withSpan("test.span", {}, async () => "ok");
      expect(mockSpanEnd).toHaveBeenCalled();
    });
  });

  describe("injectTraceContextIntoJob", () => {
    it("adds _traceparent to job data when enabled", () => {
      enableSpans();
      mockInject.mockImplementation((_ctx: unknown, carrier: Record<string, string>) => {
        carrier.traceparent = "00-traceid-spanid-01";
        carrier.tracestate = "foo=bar";
      });

      const result = injectTraceContextIntoJob({ taskId: "123" }) as Record<string, unknown>;
      expect(result._traceparent).toBe("00-traceid-spanid-01");
      expect(result._tracestate).toBe("foo=bar");
      expect(result.taskId).toBe("123");
    });

    it("returns original data when inject produces no traceparent", () => {
      enableSpans();
      mockInject.mockImplementation(() => {});
      const original = { taskId: "456" };
      const result = injectTraceContextIntoJob(original);
      expect(result).toBe(original);
    });
  });

  describe("contextFromJobData", () => {
    it("extracts context from job data with _traceparent", () => {
      enableSpans();
      contextFromJobData({
        _traceparent: "00-traceid-spanid-01",
        _tracestate: "foo=bar",
      });
      expect(mockExtract).toHaveBeenCalled();
    });

    it("returns active context when no _traceparent present", () => {
      enableSpans();
      const result = contextFromJobData({ taskId: "123" });
      expect(mockExtract).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe("getCurrentTraceId", () => {
    it("returns trace ID from active span", () => {
      enableSpans();
      const traceId = getCurrentTraceId();
      expect(traceId).toBe("abc123def456abc123def456abc123de");
    });
  });
});
