import type { FastifyRequest } from "fastify";
import { validateSession, validateWsToken, type SessionUser } from "../services/session-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/** Minimal WebSocket interface for auth — avoids depending on @types/ws. */
interface WsSocket {
  close(code?: number, reason?: string): void;
}

const SESSION_COOKIE_NAME = "optio_session";

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Authenticate a WebSocket connection.
 *
 * Two paths:
 *  1. Session cookie (`optio_session`) — validated against the sessions table.
 *  2. Single-use upgrade token (`?token=`) — validated and consumed from the
 *     in-memory WS token store (short-lived, ~30 s, one-time use).
 *
 * Returns the session user on success, or null after closing the socket with code 4401.
 * When auth is disabled, returns a synthetic dev user.
 */
export async function authenticateWs(
  socket: WsSocket,
  req: FastifyRequest,
): Promise<SessionUser | null> {
  if (isAuthDisabled()) {
    return {
      id: "local",
      provider: "local",
      email: "dev@localhost",
      displayName: "Local Dev",
      avatarUrl: null,
      workspaceId: null,
      workspaceRole: null,
    };
  }

  // Path 1: cookie-based session auth (long-lived session token)
  const cookieToken = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (cookieToken) {
    const user = await validateSession(cookieToken);
    if (user) return user;
    // Cookie was present but invalid/expired — fall through to close
  }

  // Path 2: single-use upgrade token via query param
  const upgradeToken = (req.query as Record<string, string>)?.token;
  if (upgradeToken) {
    const user = await validateWsToken(upgradeToken);
    if (user) return user;
    // Token was present but invalid/expired/already consumed
  }

  // No valid auth found
  const reason =
    cookieToken || upgradeToken ? "Invalid or expired session" : "Authentication required";
  socket.close(4401, reason);
  return null;
}

/**
 * Extract the raw session token from a Fastify request (cookie only).
 * Used for auth passthrough — the raw token is forwarded to agent pods so they
 * can make authenticated API calls on behalf of the user.
 *
 * Only reads the session cookie — never the query param upgrade token, which is
 * single-use and not suitable for passthrough.
 *
 * Returns undefined if no token is found or auth is disabled.
 */
export function extractSessionToken(req: FastifyRequest): string | undefined {
  if (isAuthDisabled()) return undefined;
  return parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
}
