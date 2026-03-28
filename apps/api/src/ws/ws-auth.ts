import type { FastifyRequest } from "fastify";
import { validateSession, type SessionUser } from "../services/session-service.js";
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
 * Authenticate a WebSocket connection using session cookie or token query param.
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

  const token =
    parseCookie(req.headers.cookie, SESSION_COOKIE_NAME) ??
    (req.query as Record<string, string>)?.token;

  if (!token) {
    socket.close(4401, "Authentication required");
    return null;
  }

  const user = await validateSession(token);
  if (!user) {
    socket.close(4401, "Invalid or expired session");
    return null;
  }

  return user;
}

/**
 * Extract the raw session token from a Fastify request (cookie or query param).
 * Used for auth passthrough — the raw token is forwarded to agent pods so they
 * can make authenticated API calls on behalf of the user.
 * Returns undefined if no token is found or auth is disabled.
 */
export function extractSessionToken(req: FastifyRequest): string | undefined {
  if (isAuthDisabled()) return undefined;
  return (
    parseCookie(req.headers.cookie, SESSION_COOKIE_NAME) ??
    (req.query as Record<string, string>)?.token
  );
}
