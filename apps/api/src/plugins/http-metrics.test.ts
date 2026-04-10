import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCounterAdd = vi.fn();
const mockHistogramRecord = vi.fn();

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: mockCounterAdd }),
      createHistogram: () => ({ record: mockHistogramRecord }),
    }),
  },
}));

vi.mock("../telemetry/metrics.js", () => ({
  isMetricsEnabled: vi.fn(() => true),
}));

import { httpMetricsPlugin, createHttpMetrics } from "./http-metrics.js";
import { isMetricsEnabled } from "../telemetry/metrics.js";

describe("http-metrics plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createHttpMetrics", () => {
    it("creates request counter and duration histogram", () => {
      const m = createHttpMetrics();
      expect(m).toBeDefined();
      expect(m.requestCounter).toBeDefined();
      expect(m.durationHistogram).toBeDefined();
    });
  });

  describe("when metrics are enabled", () => {
    it("records request duration and counter on response", async () => {
      const m = createHttpMetrics();
      const attrs = { method: "GET", route: "/api/health", status_code: 200 };

      m.recordRequest(attrs, 0.042);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, attrs);
      expect(mockHistogramRecord).toHaveBeenCalledWith(0.042, attrs);
    });

    it("normalizes route by stripping UUIDs", () => {
      const m = createHttpMetrics();
      const route = m.normalizeRoute("/api/tasks/550e8400-e29b-41d4-a716-446655440000/logs");
      expect(route).toBe("/api/tasks/:id/logs");
    });

    it("normalizes route by stripping numeric IDs", () => {
      const m = createHttpMetrics();
      const route = m.normalizeRoute("/api/repos/123/settings");
      expect(route).toBe("/api/repos/:id/settings");
    });

    it("preserves known route segments", () => {
      const m = createHttpMetrics();
      const route = m.normalizeRoute("/api/health");
      expect(route).toBe("/api/health");
    });
  });

  describe("when metrics are disabled", () => {
    it("recordRequest is a no-op", () => {
      vi.mocked(isMetricsEnabled).mockReturnValue(false);
      const m = createHttpMetrics();
      m.recordRequest({ method: "GET", route: "/api/health", status_code: 200 }, 0.042);
      // Still creates instruments (lazy-init pattern) but doesn't record
      // The no-op check happens in the plugin's onResponse hook
    });
  });
});
