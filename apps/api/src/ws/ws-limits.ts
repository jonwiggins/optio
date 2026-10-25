import { logger } from "../logger.js";

const log = logger.child({ module: "ws-limits" });

/**
 * WebSocket connection and message limits.
 *
 * Enforces per-IP connection counts and message size validation
 * to protect against resource exhaustion attacks.
 */

/** Maximum concurrent WebSocket connections per IP address. */
export const MAX_WS_CONNECTIONS_PER_IP = 50;

/** Maximum message size in bytes (1 MB). */
export const MAX_WS_MESSAGE_SIZE = 1_048_576;

/** WebSocket close code for connection limit exceeded (custom application code). */
export const WS_CLOSE_CONNECTION_LIMIT = 4429;

/** WebSocket close code for message too large (custom application code). */
export const WS_CLOSE_MESSAGE_TOO_LARGE = 4413;

// ─── Per-IP connection tracking ───

const connectionCounts = new Map<string, number>();

/** @internal Expose for testing. */
export function _getConnectionCounts(): Map<string, number> {
  return connectionCounts;
}

/** @internal Reset all tracking state — only for tests. */
export function _resetConnectionCounts(): void {
  connectionCounts.clear();
}

/**
 * The client IP address of a Fastify request: `req.ip`, which Fastify takes
 * from X-Forwarded-For only as far as `trustProxy` (OPTIO_TRUST_PROXY,
 * utils/trust-proxy.ts) believes it — the same address the HTTP rate limits
 * count. The left-most X-Forwarded-For entry is whatever the client wrote,
 * so reading it let anyone pick a fresh bucket per connection.
 */
export function getClientIp(req: { ip: string }): string {
  return req.ip;
}

/**
 * Track a new WebSocket connection for the given IP.
 * Returns `true` if the connection is allowed, `false` if the limit is exceeded.
 */
export function trackConnection(ip: string): boolean {
  const current = connectionCounts.get(ip) ?? 0;
  if (current >= MAX_WS_CONNECTIONS_PER_IP) {
    log.warn({ ip, current }, "WebSocket connection limit exceeded");
    return false;
  }
  connectionCounts.set(ip, current + 1);
  return true;
}

/**
 * Release a tracked WebSocket connection for the given IP.
 * Call this when a WebSocket disconnects.
 */
export function releaseConnection(ip: string): void {
  const current = connectionCounts.get(ip) ?? 0;
  if (current <= 1) {
    connectionCounts.delete(ip);
  } else {
    connectionCounts.set(ip, current - 1);
  }
}

/**
 * Check whether a WebSocket message exceeds the size limit.
 * Returns `true` if the message is within limits, `false` if too large.
 */
export function isMessageWithinSizeLimit(data: Buffer | string): boolean {
  const size = typeof data === "string" ? Buffer.byteLength(data, "utf-8") : data.length;
  return size <= MAX_WS_MESSAGE_SIZE;
}
