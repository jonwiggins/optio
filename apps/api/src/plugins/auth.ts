import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { validateSession, type SessionUser } from "../services/session-service.js";
import { validateApiKey } from "../services/api-key-service.js";
import { teamMembershipsOf } from "../services/team-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { getUserRole, ensureUserHasWorkspace } from "../services/workspace-service.js";
import { getWorkVisibility } from "../services/work-visibility.js";
import { listSecrets } from "../services/secret-service.js";
import type { WorkspaceRole } from "@optio/shared";
import { emitAuthFailureLog } from "../telemetry/logs.js";

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
  // Asking to join a team, or leaving one, is everyone's own business.
  /^\/api\/teams\/[^/]+\/join$/,
  // (channels: the fork's email / push choices — routes/notify.ts; chat-hook,
  // digest/test: one's own chat hook and digest — routes/notify-delivery.ts)
  /^\/api\/notifications\/(subscribe|preferences|test|channels|chat-hook(\/test)?|digest\/test)$/,
  // Commenting is a viewer right; edits/deletes are owner-gated in the service.
  /^\/api\/tasks\/[^/]+\/comments(\/[^/]+)?$/,
  // Ending one's own session is owner-gated in the route.
  /^\/api\/sessions\/[^/]+\/end$/,
  // Re-checking a token one may see (routes/credential-health.ts checks who).
  /^\/api\/credential-health\/check(-mine)?$/,
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
  // The CLI installer, its bundle and the start script (routes/cli-downloads.ts):
  // a remote workspace fetches them before it has a session; nothing in them
  // is secret.
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
 * Auth routes that are public (the sign-in flows only: the OAuth / OIDC
 * login and callback legs and the LDAP password form).
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
  "/api/auth/bitbucket/login",
  "/api/auth/bitbucket/callback",
  "/api/auth/gitea/login",
  "/api/auth/gitea/callback",
  "/api/auth/saml/login",
  "/api/auth/saml/callback",
  "/api/auth/saml/metadata",
  "/api/auth/cli/start",
  "/api/auth/cli/token",
]);

/**
 * Secrets whose presence indicates that initial setup has been completed.
 * Once any agent API key is configured, setup POST routes require auth.
 */
const AGENT_KEY_SECRETS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GEMINI_API_KEY",
  "CURSOR_API_KEY",
  // Vertex-mode installs store project ids rather than API keys; count them
  // so a Vertex-only setup still locks the /api/setup/* routes (mirrors the
  // per-provider checks in routes/setup.ts).
  "GOOGLE_CLOUD_PROJECT",
  "CLAUDE_VERTEX_PROJECT_ID",
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
    if (isPublicRoute(req.url, req.method)) return;

    // Setup routes (other than /status) are public only before initial setup.
    // Once setup is complete they require authentication like any other route.
    if (req.url.startsWith("/api/setup/")) {
      const complete = await isSetupComplete();
      if (!complete) return; // Allow without auth during initial setup
      // Fall through to normal auth check
    }

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

    // The teams the person is in, for the scope rules (services/ownership.ts),
    // and the workspace's work-visibility mode (services/work-visibility.ts).
    if (user.workspaceId && user.id) {
      const mine = await teamMembershipsOf(user.id, user.workspaceId);
      user.teamIds = mine.map((m) => m.teamId);
      user.adminTeamIds = mine.filter((m) => m.role === "admin").map((m) => m.teamId);
      user.workVisibility = await getWorkVisibility(user.workspaceId);
    } else {
      user.teamIds = [];
      user.adminTeamIds = [];
      user.workVisibility = await getWorkVisibility(null);
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
