import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the logger
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// Track subscriptions registered via diagnostics_channel
const subscribers = new Map<string, (...args: any[]) => void>();
vi.mock("node:diagnostics_channel", () => ({
  default: {
    subscribe: vi.fn((name: string, handler: (...args: any[]) => void) => {
      subscribers.set(name, handler);
    }),
  },
}));

import { logger } from "../logger.js";
import {
  initTlsObservability,
  getTlsGroupCounts,
  resetTlsGroupCounts,
  logTlsStackInfo,
} from "./tls-observability.js";

describe("tls-observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribers.clear();
    resetTlsGroupCounts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("logTlsStackInfo", () => {
    it("logs Node version, OpenSSL version, and PQ readiness", () => {
      logTlsStackInfo();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeVersion: process.version,
          opensslVersion: process.versions.openssl,
          pqReady: expect.any(Boolean),
        }),
        "TLS stack",
      );
    });
  });

  describe("initTlsObservability", () => {
    it("subscribes to undici:client:connected diagnostics channel", () => {
      initTlsObservability();

      expect(subscribers.has("undici:client:connected")).toBe(true);
    });

    it("records key-exchange group from connected socket", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      handler({
        socket: {
          getEphemeralKeyInfo: () => ({ name: "X25519MLKEM768" }),
        },
        connectParams: { host: "api.github.com" },
      });

      const counts = getTlsGroupCounts();
      expect(counts).toEqual([{ host: "api.github.com", group: "X25519MLKEM768", count: 1 }]);
    });

    it("increments count for repeated connections to same host+group", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      const event = {
        socket: {
          getEphemeralKeyInfo: () => ({ name: "X25519" }),
        },
        connectParams: { host: "api.anthropic.com" },
      };
      handler(event);
      handler(event);
      handler(event);

      const counts = getTlsGroupCounts();
      expect(counts).toEqual([{ host: "api.anthropic.com", group: "X25519", count: 3 }]);
    });

    it("tracks different groups for the same host separately", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      handler({
        socket: { getEphemeralKeyInfo: () => ({ name: "X25519MLKEM768" }) },
        connectParams: { host: "api.github.com" },
      });
      handler({
        socket: { getEphemeralKeyInfo: () => ({ name: "X25519" }) },
        connectParams: { host: "api.github.com" },
      });

      const counts = getTlsGroupCounts();
      expect(counts).toHaveLength(2);
      expect(counts).toContainEqual({ host: "api.github.com", group: "X25519MLKEM768", count: 1 });
      expect(counts).toContainEqual({ host: "api.github.com", group: "X25519", count: 1 });
    });

    it("uses 'unknown' when getEphemeralKeyInfo is not available", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      handler({
        socket: {},
        connectParams: { host: "example.com" },
      });

      const counts = getTlsGroupCounts();
      expect(counts).toEqual([{ host: "example.com", group: "unknown", count: 1 }]);
    });

    it("uses 'unknown' when host is not available", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      handler({
        socket: { getEphemeralKeyInfo: () => ({ name: "X25519" }) },
        connectParams: {},
      });

      const counts = getTlsGroupCounts();
      expect(counts).toEqual([{ host: "unknown", group: "X25519", count: 1 }]);
    });
  });

  describe("resetTlsGroupCounts", () => {
    it("clears all recorded counts", () => {
      initTlsObservability();

      const handler = subscribers.get("undici:client:connected")!;
      handler({
        socket: { getEphemeralKeyInfo: () => ({ name: "X25519" }) },
        connectParams: { host: "api.github.com" },
      });

      expect(getTlsGroupCounts()).toHaveLength(1);

      resetTlsGroupCounts();
      expect(getTlsGroupCounts()).toHaveLength(0);
    });
  });
});
