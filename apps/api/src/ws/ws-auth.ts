import type { FastifyRequest } from "fastify";
import { validateSession, validateWsToken, type SessionUser } from "../services/session-service.js";
import { validateApiKey } from "../services/api-key-service.js";
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

/** Prefix used in the Sec-WebSocket-Protocol header to carry upgrade tokens. */
export const WS_AUTH_PROTOCOL_PREFIX = "optio-auth-";

/** Fixed protocol name sent alongside the auth token during WebSocket upgrade. */
export const WS_PROTOCOL_NAME = "optio-ws-v1";

/**
 * Extract a single-use upgrade token from the Sec-WebSocket-Protocol header.
 *
 * The client sends two subprotocols during the WebSocket upgrade:
 *   ["optio-ws-v1", "optio-auth-<TOKEN>"]
 *
 * The server selects "optio-ws-v1" as the negotiated protocol (via handleProtocols
 * in server.ts) so the raw token is never echoed back. This function extracts the
 * token from the second subprotocol.
 *
 * This avoids putting tokens in URLs (which leak into logs, browser history, Referer
 * headers, and proxy logs).
 */
function extractUpgradeTokenFromProtocol(req: FastifyRequest): string | undefined {
  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (!protocolHeader || typeof protocolHeader !== "string") return undefined;

  const protocols = protocolHeader.split(",").map((p) => p.trim());
  for (const p of protocols) {
    if (p.startsWith(WS_AUTH_PROTOCOL_PREFIX)) {
      return p.slice(WS_AUTH_PROTOCOL_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * Authenticate a WebSocket connection.
 *
 * Two paths:
 *  1. Session cookie (`optio_session`) — validated against the sessions table.
 *     Browsers send cookies on WebSocket upgrade requests automatically.
 *  2. Single-use upgrade token via `Sec-WebSocket-Protocol` header — validated
 *     and consumed from the in-memory WS token store (short-lived, ~30 s, one-time use).
 *     Used for cross-origin setups where cookies are not available.
 *
 * Tokens are NEVER read from URL query params to prevent leaking into logs.
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

  // Path 1: cookie-based session auth (long-lived session token or PAT)
  const cookieToken = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (cookieToken) {
    const user = cookieToken.startsWith("optio_pat_")
      ? await validateApiKey(cookieToken)
      : await validateSession(cookieToken);
    if (user) return user;
    // Cookie was present but invalid/expired — fall through to protocol check
  }

  // Path 2: single-use upgrade token or PAT via Sec-WebSocket-Protocol header
  const upgradeToken = extractUpgradeTokenFromProtocol(req);
  if (upgradeToken) {
    // PAT tokens can also be passed via Sec-WebSocket-Protocol header
    const user = upgradeToken.startsWith("optio_pat_")
      ? await validateApiKey(upgradeToken)
      : await validateWsToken(upgradeToken);
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
