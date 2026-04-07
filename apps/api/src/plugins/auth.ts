import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { validateSession, type SessionUser } from "../services/session-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { getUserRole, ensureUserHasWorkspace } from "../services/workspace-service.js";
import { listSecrets } from "../services/secret-service.js";
import type { WorkspaceRole } from "@optio/shared";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** Role hierarchy: admin > member > viewer. */
const ROLE_LEVEL: Record<string, number> = { admin: 3, member: 2, viewer: 1 };

/**
 * Returns a Fastify preHandler that rejects requests from users whose
 * workspace role is below `minimumRole`.
 *
 * When auth is disabled the check is skipped (local dev).
 */
export function requireRole(minimumRole: WorkspaceRole) {
  const minLevel = ROLE_LEVEL[minimumRole] ?? 0;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Auth disabled — allow everything (local dev)
    if (isAuthDisabled()) return;

    const role = req.user?.workspaceRole;
    const level = role ? (ROLE_LEVEL[role] ?? 0) : 0;

    if (level < minLevel) {
      return reply.status(403).send({
        error: `Forbidden: requires ${minimumRole} role`,
      });
    }
  };
}

const SESSION_COOKIE_NAME = "optio_session";
const WORKSPACE_HEADER = "x-workspace-id";

/** Routes that never require authentication. */
const PUBLIC_ROUTES = [
  "/api/health",
  "/api/auth/",
  "/api/setup/status",
  "/api/webhooks/",
  "/ws/",
  "/api/internal/git-credentials",
];

/**
 * Secrets whose presence indicates that initial setup has been completed.
 * Once any agent API key is configured, setup POST routes require auth.
 */
const AGENT_KEY_SECRETS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
];

let _setupCompleteCache: { value: boolean; expires: number } | null = null;
const SETUP_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Returns true when at least one agent API key secret exists, indicating
 * initial setup is complete. Result is cached for 60 seconds.
 */
export async function isSetupComplete(): Promise<boolean> {
  const now = Date.now();
  if (_setupCompleteCache && now < _setupCompleteCache.expires) {
    return _setupCompleteCache.value;
  }
  try {
    const allSecrets = await listSecrets();
    const names = allSecrets.map((s) => s.name);
    const complete = AGENT_KEY_SECRETS.some((k) => names.includes(k));
    _setupCompleteCache = { value: complete, expires: now + SETUP_CACHE_TTL_MS };
    return complete;
  } catch {
    return false;
  }
}

/** Reset the setup-complete cache (for testing). */
export function resetSetupCompleteCache(): void {
  _setupCompleteCache = null;
}

function isPublicRoute(url: string): boolean {
  return PUBLIC_ROUTES.some((prefix) => url.startsWith(prefix));
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

async function authPlugin(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    // Auth disabled — allow everything
    if (isAuthDisabled()) return;

    // Public routes — no auth needed
    if (isPublicRoute(req.url)) return;

    // Setup routes (other than /status) are public only before initial setup.
    // Once setup is complete they require authentication like any other route.
    if (req.url.startsWith("/api/setup/")) {
      const complete = await isSetupComplete();
      if (!complete) return; // Allow without auth during initial setup
      // Fall through to normal auth check
    }

    // Token resolution order: Bearer header → session cookie
    // Note: WebSocket auth is handled separately by authenticateWs() in ws-auth.ts
    // using cookies and Sec-WebSocket-Protocol header (never URL query params).
    const token =
      parseBearer(req.headers.authorization) ??
      parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);

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
