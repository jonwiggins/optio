import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { validateSession, type SessionUser } from "../services/session-service.js";
import { validateApiKey } from "../services/api-key-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { getUserRole, ensureUserHasWorkspace } from "../services/workspace-service.js";
import type { WorkspaceRole } from "@optio/shared";
import { emitAuthFailureLog } from "../telemetry/logs.js";
import { browserOriginAllowed } from "../utils/browser-origin.js";

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

/**
 * A preHandler for actions on the whole deployment rather than one
 * workspace. Being a workspace admin isn't enough there — anyone signed in
 * can create a workspace and be its admin — so it takes a deployment admin.
 * A deployment that has none yet (upgraded from before the role existed, or
 * with no `OPTIO_DEPLOYMENT_ADMINS`) accepts an admin of its founding (oldest)
 * workspace until someone claims the role. Pair it with `requireRole("admin")`.
 */
export async function requireDeploymentAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (isAuthDisabled()) return;
  if (!req.user) return reply.status(401).send({ error: "Authentication required" });
  const { isDeploymentAdmin, hasDeploymentAdmin, isFoundingWorkspaceAdmin } =
    await import("../services/sign-in-config-service.js");
  if (req.user && (await isDeploymentAdmin(req.user))) return;
  if (req.user && !(await hasDeploymentAdmin()) && (await isFoundingWorkspaceAdmin(req.user.id)))
    return;
  return reply.status(403).send({ error: "Forbidden: requires a deployment admin" });
}

const SESSION_COOKIE_NAME = process.env.PUBLIC_URL?.startsWith("https://")
  ? "__Host-optio_session"
  : "optio_session";
const WORKSPACE_HEADER = "x-workspace-id";

/** HTTP methods that mutate state and therefore require at least "member". */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mutating routes that stay available to every authenticated user regardless
 * of workspace role (including viewers). These act only on the caller's own
 * resources — session, PATs, notification prefs, own comments — or create a
 * workspace the caller becomes admin of. Route/service-level ownership checks
 * still apply.
 */
const SELF_SCOPED_MUTATIONS: RegExp[] = [
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/api-keys(\/[^/]+)?$/,
  /^\/api\/workspaces$/,
  /^\/api\/workspaces\/[^/]+\/switch$/,
  /^\/api\/notifications\/(subscribe|preferences|test)$/,
  // Commenting is a viewer right; edits/deletes are owner-gated in the service.
  /^\/api\/tasks\/[^/]+\/comments(\/[^/]+)?$/,
  // Ending one's own session is owner-gated in the route.
  /^\/api\/sessions\/[^/]+\/end$/,
];

function isSelfScopedMutation(path: string): boolean {
  return SELF_SCOPED_MUTATIONS.some((re) => re.test(path));
}

/** Exact routes that are always public. */
const PUBLIC_ROUTES = new Set([
  // MCP authenticates PATs / scoped run credentials itself, including read-only POSTs.
  "/api/mcp",
  "/api/health",
  "/api/config/schema.json",
  "/api/setup/status",
  "/api/notifications/vapid-public-key",
  "/api/internal/git-credentials",
  "/api/internal/persistent-agents",
  "/api/cli/install.sh",
  "/api/cli/optio-cli.tgz",
  "/api/cli/workspace-start.sh",
]);

/**
 * Inbound webhook receivers — public for POST only, by exact path. Their
 * callers (GitHub, Slack, Linear, PagerDuty) can't hold an Optio session; each route
 * authenticates the delivery itself by the provider's HMAC over the raw body
 * and rejects it when unsigned, badly signed, stale, or when its secret is
 * unset. Everything else under /api/webhooks is outbound-webhook management
 * and stays behind auth — including GET/PATCH/DELETE on these same paths,
 * which would otherwise reach the management routes' `/api/webhooks/:id`.
 * A receiver whose trigger the deployment leaves out (OPTIO_TRIGGERS) stays
 * listed but is never registered (services/feature-guard.ts `receiverFor`), so a
 * delivery to it answers 404 rather than asking for a session.
 */
const PUBLIC_WEBHOOK_RECEIVERS = new Set([
  "/api/webhooks/github", // routes/tickets.ts: X-Hub-Signature-256, GITHUB_WEBHOOK_SECRET
  "/api/webhooks/slack/events", // routes/event-ingress.ts: X-Slack-Signature, SLACK_SIGNING_SECRET
  "/api/webhooks/slack/actions", // routes/slack.ts: X-Slack-Signature, SLACK_SIGNING_SECRET
  "/api/webhooks/linear", // routes/event-ingress.ts: Linear-Signature, LINEAR_WEBHOOK_SECRET
  "/api/webhooks/pagerduty", // routes/event-ingress.ts: X-PagerDuty-Signature, PAGERDUTY_WEBHOOK_SECRET
  "/api/webhooks/gitlab", // routes/event-ingress.ts: X-Gitlab-Token, GITLAB_WEBHOOK_SECRET
  "/api/webhooks/jira", // routes/event-ingress.ts: X-Hub-Signature, JIRA_WEBHOOK_SECRET
  "/api/webhooks/sentry", // routes/event-ingress.ts: Sentry-Hook-Signature, SENTRY_WEBHOOK_SECRET
  // Pylon, Alertmanager and Datadog deliveries go to /api/hooks/<type>/:triggerId
  // (public prefix below), checked against the trigger's own shared secret.
]);

/**
 * Prefix-matched routes that are always public.
 *
 * Public prefix routes must be intentionally unauthenticated. Outbound
 * webhook management lives under /api/webhooks and must remain protected
 * (the signed inbound receivers there are listed one by one above).
 */
const PUBLIC_PREFIXES = [
  "/api/hooks/",
  "/api/internal/persistent-agents/",
  "/ws/",
  "/docs",
  // SCIM provisioning checks its own bearer token (routes/scim.ts).
  "/api/scim/v2/",
  "/scim/v2/",
];

/**
 * Auth routes that are public (OAuth login/callback flows only).
 * Sensitive endpoints like claude-token, status, usage, me are NOT listed
 * here — they require authentication via the normal auth path.
 */
const PUBLIC_AUTH_ROUTES = new Set([
  "/api/auth/providers",
  "/api/auth/exchange-code",
  "/api/auth/github/login",
  "/api/auth/github/callback",
  "/api/auth/google/login",
  "/api/auth/google/callback",
  "/api/auth/gitlab/login",
  "/api/auth/gitlab/callback",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
  "/api/auth/ldap/login",
  "/api/auth/saml/login",
  "/api/auth/saml/callback",
  "/api/auth/saml/metadata",
  "/api/auth/cli/start",
  "/api/auth/cli/token",
]);

/**
 * Whether a request skips session auth. `method` matters only for the
 * inbound webhook receivers, which are public for POST alone.
 */
export function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0];
  if (PUBLIC_ROUTES.has(path) || PUBLIC_AUTH_ROUTES.has(path)) return true;
  if (method?.toUpperCase() === "POST" && PUBLIC_WEBHOOK_RECEIVERS.has(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  try {
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function parseBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

async function authPlugin(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    // Bearer clients explicitly supply their credential; browser cookies and
    // auth-disabled local installs need protection from forged browser POSTs.
    if (
      MUTATING_METHODS.has(req.method) &&
      !parseBearer(req.headers.authorization) &&
      !isPublicRoute(req.url, req.method) &&
      !browserOriginAllowed(req.headers.origin)
    ) {
      return reply.status(403).send({ error: "Origin not allowed" });
    }
    // Auth disabled — allow everything
    if (isAuthDisabled()) return;

    // Public routes — no auth needed
    if (isPublicRoute(req.url, req.method)) return;

    // The Sign-in configuration is reachable without a session only while
    // nobody can sign in at all (no provider configured anywhere); the route
    // then demands the setup token. See services/sign-in-config-service.ts.
    if (req.url.split("?")[0].startsWith("/api/auth/sign-in")) {
      const { isBootstrapMode } = await import("../services/sign-in-config-service.js");
      if (await isBootstrapMode()) return;
      // Fall through to normal auth check
    }

    // Token resolution order: Bearer header → session cookie
    // Note: WebSocket auth is handled separately by authenticateWs() in ws-auth.ts
    // using cookies and Sec-WebSocket-Protocol header (never URL query params).
    const token =
      parseBearer(req.headers.authorization) ??
      parseCookie(req.headers.cookie, SESSION_COOKIE_NAME);

    if (!token) {
      emitAuthFailureLog("no_credentials");
      return reply.status(401).send({ error: "Authentication required" });
    }

    // PAT tokens (optio_pat_*) validated via api_keys table; session tokens via sessions table
    const user = token.startsWith("optio_pat_")
      ? await validateApiKey(token)
      : await validateSession(token);
    if (!user) {
      emitAuthFailureLog("invalid_or_expired_session");
      return reply.status(401).send({ error: "Invalid or expired session" });
    }

    // Resolve workspace context
    const requestedWorkspaceId =
      (req.headers[WORKSPACE_HEADER] as string) ??
      parseCookie(req.headers.cookie, "optio_workspace");
    const workspaceId = requestedWorkspaceId || user.workspaceId;

    if (workspaceId) {
      const role = await getUserRole(workspaceId, user.id);
      if (role) {
        user.workspaceId = workspaceId;
        user.workspaceRole = role;
      } else if (requestedWorkspaceId) {
        return reply.status(403).send({
          error: "Forbidden: not a member of requested workspace",
        });
      } else {
        // Saved default workspace is missing/stale — fall back to a valid default.
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

    // Default-deny baseline: mutating API requests require at least "member".
    // Viewers are read-only except for the self-scoped allowlist above.
    // Route-level requireRole preHandlers can still demand "admin"; this is
    // the safety net that keeps a newly added route from shipping writable
    // by viewers.
    const path = req.url.split("?")[0];
    if (MUTATING_METHODS.has(req.method) && path.startsWith("/api/")) {
      const level = user.workspaceRole ? (ROLE_LEVEL[user.workspaceRole] ?? 0) : 0;
      if (level < ROLE_LEVEL.member && !isSelfScopedMutation(path)) {
        return reply.status(403).send({
          error: "Forbidden: viewers have read-only access",
        });
      }
    }
  });
}

export default fp(authPlugin, { name: "optio-auth" });
export { SESSION_COOKIE_NAME };
