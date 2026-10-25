import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../logger.js";
import {
  metricsPort,
  prometheusEnabled,
  prometheusReader,
  startPrometheusOnly,
} from "./prometheus.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OPTIO_METRICS_PORT", () => {
  it("is off unless it names a port", () => {
    for (const v of [undefined, "", " ", "0", "off", "false", "OFF"]) {
      expect(metricsPort(v)).toBeNull();
    }
    for (const v of ["abc", "-1", "65536", "9464.5"]) {
      expect(metricsPort(v)).toBeNull();
    }
    expect(metricsPort("9464")).toBe(9464);
    expect(metricsPort(" 9100 ")).toBe(9100);
  });

  it("leaves upstream's telemetry alone when unset: no reader, no provider", async () => {
    vi.stubEnv("OPTIO_METRICS_PORT", "");
    expect(prometheusEnabled()).toBe(false);
    expect(await prometheusReader()).toBeNull();
    expect(await startPrometheusOnly()).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("says so, once, when the value isn't a port, and keeps the API starting", async () => {
    vi.stubEnv("OPTIO_METRICS_PORT", "metrics");
    expect(prometheusEnabled()).toBe(false);
    expect(await prometheusReader()).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][1])).toContain("not a port number");
  });
});
