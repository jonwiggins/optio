import { describe, it, expect, beforeEach } from "vitest";

// Mock the logger before importing the module under test
import { vi } from "vitest";
vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import {
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  getClientIp,
  MAX_WS_CONNECTIONS_PER_IP,
  MAX_WS_MESSAGE_SIZE,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
  _resetConnectionCounts,
  _getConnectionCounts,
} from "./ws-limits.js";

describe("ws-limits", () => {
  beforeEach(() => {
    _resetConnectionCounts();
  });

  describe("constants", () => {
    it("exports expected limit values", () => {
      expect(MAX_WS_CONNECTIONS_PER_IP).toBe(50);
      expect(MAX_WS_MESSAGE_SIZE).toBe(1_048_576);
      expect(WS_CLOSE_CONNECTION_LIMIT).toBe(4429);
      expect(WS_CLOSE_MESSAGE_TOO_LARGE).toBe(4413);
    });
  });

  describe("getClientIp", () => {
    it("returns the request's ip", () => {
      const req = { ip: "192.168.1.1", headers: {} };
      expect(getClientIp(req)).toBe("192.168.1.1");
    });

    it("ignores a client-written x-forwarded-for: req.ip already honours OPTIO_TRUST_PROXY", () => {
      const req = {
        ip: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18, 150.172.238.178" },
      };
      expect(getClientIp(req)).toBe("10.0.0.1");
    });

    it("counts by the address Fastify resolves behind a trusted proxy", async () => {
      const Fastify = (await import("fastify")).default;
      const app = Fastify({ trustProxy: 1 });
      let seen = "";
      app.get("/", async (req) => {
        seen = getClientIp(req);
        return "ok";
      });
      await app.inject({
        method: "GET",
        url: "/",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.50" },
      });
      await app.close();
      // One trusted hop: the ingress's view of the client, not the spoofed left-most entry.
      expect(seen).toBe("203.0.113.50");
    });
  });

  describe("trackConnection / releaseConnection", () => {
    it("allows connections up to the limit", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < MAX_WS_CONNECTIONS_PER_IP; i++) {
        expect(trackConnection(ip)).toBe(true);
      }
      expect(_getConnectionCounts().get(ip)).toBe(MAX_WS_CONNECTIONS_PER_IP);
    });

    it("rejects connections over the limit", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < MAX_WS_CONNECTIONS_PER_IP; i++) {
        trackConnection(ip);
      }
      expect(trackConnection(ip)).toBe(false);
      // Count should not increase beyond the limit
      expect(_getConnectionCounts().get(ip)).toBe(MAX_WS_CONNECTIONS_PER_IP);
    });

    it("releases connections correctly", () => {
      const ip = "192.168.1.1";
      trackConnection(ip);
      trackConnection(ip);
      expect(_getConnectionCounts().get(ip)).toBe(2);

      releaseConnection(ip);
      expect(_getConnectionCounts().get(ip)).toBe(1);

      releaseConnection(ip);
      expect(_getConnectionCounts().has(ip)).toBe(false);
    });

    it("handles releasing when no connections are tracked", () => {
      releaseConnection("192.168.1.1");
      expect(_getConnectionCounts().has("192.168.1.1")).toBe(false);
    });

    it("allows new connections after releasing", () => {
      const ip = "192.168.1.1";
      for (let i = 0; i < MAX_WS_CONNECTIONS_PER_IP; i++) {
        trackConnection(ip);
      }
      expect(trackConnection(ip)).toBe(false);

      releaseConnection(ip);
      expect(trackConnection(ip)).toBe(true);
    });

    it("tracks different IPs independently", () => {
      const ip1 = "192.168.1.1";
      const ip2 = "192.168.1.2";

      for (let i = 0; i < MAX_WS_CONNECTIONS_PER_IP; i++) {
        trackConnection(ip1);
      }
      expect(trackConnection(ip1)).toBe(false);
      expect(trackConnection(ip2)).toBe(true);
    });
  });

  describe("isMessageWithinSizeLimit", () => {
    it("allows small string messages", () => {
      expect(isMessageWithinSizeLimit("hello")).toBe(true);
    });

    it("allows small buffer messages", () => {
      expect(isMessageWithinSizeLimit(Buffer.from("hello"))).toBe(true);
    });

    it("allows messages at exactly the limit", () => {
      const msg = Buffer.alloc(MAX_WS_MESSAGE_SIZE);
      expect(isMessageWithinSizeLimit(msg)).toBe(true);
    });

    it("rejects messages over the limit", () => {
      const msg = Buffer.alloc(MAX_WS_MESSAGE_SIZE + 1);
      expect(isMessageWithinSizeLimit(msg)).toBe(false);
    });

    it("rejects large string messages", () => {
      // Create a string that exceeds the limit
      const msg = "x".repeat(MAX_WS_MESSAGE_SIZE + 1);
      expect(isMessageWithinSizeLimit(msg)).toBe(false);
    });

    it("allows empty messages", () => {
      expect(isMessageWithinSizeLimit("")).toBe(true);
      expect(isMessageWithinSizeLimit(Buffer.alloc(0))).toBe(true);
    });

    it("correctly handles multi-byte UTF-8 characters in strings", () => {
      // Each emoji is 4 bytes in UTF-8, so fewer characters are needed
      const singleByteStr = "a".repeat(MAX_WS_MESSAGE_SIZE);
      expect(isMessageWithinSizeLimit(singleByteStr)).toBe(true);

      // This string has MAX_WS_MESSAGE_SIZE characters but each is 4 bytes
      const multiByteStr = "\u{1F600}".repeat(MAX_WS_MESSAGE_SIZE / 4 + 1);
      expect(isMessageWithinSizeLimit(multiByteStr)).toBe(false);
    });
  });
});
