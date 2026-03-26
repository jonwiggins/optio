import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { validateSession, type SessionUser } from "../services/session-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { getUserRole, ensureUserHasWorkspace } from "../services/workspace-service.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

const SESSION_COOKIE_NAME = "optio_session";
const WORKSPACE_HEADER = "x-workspace-id";

/** Routes that never require authentication. */
const PUBLIC_ROUTES = ["/api/health", "/api/auth/", "/api/setup/", "/api/webhooks/", "/ws/"];

function isPublicRoute(url: string): boolean {
  return PUBLIC_ROUTES.some((prefix) => url.startsWith(prefix));
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function authPlugin(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    // Auth disabled — allow everything
    if (isAuthDisabled()) return;

    // Public routes — no auth needed
    if (isPublicRoute(req.url)) return;

    // Accept token from cookie, Authorization header, or query param (WebSocket)
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const token =
      parseCookie(req.headers.cookie, SESSION_COOKIE_NAME) ??
      bearerToken ??
      (req.query as Record<string, string>)?.token;

    if (!token) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const user = await validateSession(token);
    if (!user) {
      return reply.status(401).send({ error: "Invalid or expired session" });
    }

    // Resolve workspace context
    const headerWorkspaceId =
      (req.headers[WORKSPACE_HEADER] as string) ??
      parseCookie(req.headers.cookie, "optio_workspace");
    const workspaceId = headerWorkspaceId || user.workspaceId;

    if (workspaceId) {
      const role = await getUserRole(workspaceId, user.id);
      if (role) {
        user.workspaceId = workspaceId;
        user.workspaceRole = role;
      } else {
        // User not a member of the requested workspace — fall back to default
        const defaultWsId = await ensureUserHasWorkspace(user.id);
        const defaultRole = await getUserRole(defaultWsId, user.id);
        user.workspaceId = defaultWsId;
        user.workspaceRole = defaultRole ?? "member";
      }
    } else {
      // No workspace set — ensure user has one
      const defaultWsId = await ensureUserHasWorkspace(user.id);
      const defaultRole = await getUserRole(defaultWsId, user.id);
      user.workspaceId = defaultWsId;
      user.workspaceRole = defaultRole ?? "member";
    }

    req.user = user;
  });
}

export default fp(authPlugin, { name: "optio-auth" });
export { SESSION_COOKIE_NAME };
