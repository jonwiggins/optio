import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getClaudeAuthToken,
  getClaudeUsage,
  invalidateCredentialsCache,
} from "../services/auth-service.js";
import {
  hasRecentClaudeAuthFailure,
  getRecentAuthFailures,
} from "../services/auth-failure-detector.js";
import { getOAuthProvider, getEnabledProviders, isAuthDisabled } from "../services/oauth/index.js";
import {
  createSession,
  createWsToken,
  revokeSession,
  validateSession,
} from "../services/session-service.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-key-service.js";
import { storeUserGitHubTokens } from "../services/github-token-service.js";
import { SESSION_COOKIE_NAME } from "../plugins/auth.js";
import { getRedisClient } from "../services/event-bus.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";

// ── Request / response schemas for the auth endpoints ───────────────────

const ExchangeCodeBodySchema = z
  .object({
    code: z.string().describe("One-time auth code issued by the OAuth callback"),
  })
  .describe("Body for exchanging a one-time auth code for a session token");

const CliStartBodySchema = z
  .object({
    provider: z.string(),
    callback: z.string(),
    state: z.string(),
    code_challenge: z.string(),
    code_challenge_method: z.string().optional(),
    client_name: z.string().optional(),
    client_version: z.string().optional(),
  })
  .describe("Body for starting the CLI PKCE login flow");

const CliTokenBodySchema = z
  .object({
    code: z.string(),
    code_verifier: z.string(),
  })
  .describe("Body for exchanging a CLI auth code + PKCE verifier for a PAT");

const ApiKeyBodySchema = z
  .object({
    name: z.string().optional(),
    expiresAt: z.string().optional().describe("ISO-8601 expiry"),
  })
  .describe("Body for creating an API key");

const AuthProvidersResponseSchema = z
  .object({
    providers: z.array(z.unknown()),
    authDisabled: z.boolean(),
  })
  .describe("Enabled OAuth providers + auth config");

const AuthStatusResponseSchema = z
  .object({
    subscription: z
      .object({
        available: z.boolean(),
        expiresAt: z.string().optional().nullable(),
        error: z.string().optional(),
        expired: z.boolean(),
        lastValidated: z.string().optional().nullable(),
      })
      .passthrough(),
  })
  .describe("Claude subscription / OAuth token status");

const AuthUsageResponseSchema = z
  .object({
    usage: z.unknown(),
  })
  .describe("Claude usage info + recent auth failures");

const AuthRefreshResponseSchema = z
  .object({
    subscription: z.unknown(),
    authFailures: z.unknown(),
  })
  .describe("Result of refreshing the cached credential state");

const AuthMeResponseSchema = z
  .object({
    user: z.unknown(),
    authDisabled: z.boolean(),
  })
  .describe("Current authenticated user");

const WsTokenResponseSchema = z
  .object({
    token: z.string(),
  })
  .describe("Short-lived WebSocket auth token");

const ExchangeCodeResponseSchema = z
  .object({
    token: z.string(),
  })
  .describe("Session token issued in exchange for a one-time auth code");

const CliStartResponseSchema = z
  .object({
    url: z.string().describe("Provider authorize URL the CLI should open in the browser"),
  })
  .describe("CLI login start result");

const CliTokenResponseSchema = z
  .object({
    token: z.string().describe("Personal access token"),
    tokenId: z.string(),
    user: z.object({
      id: z.string(),
      email: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
    }),
  })
  .describe("CLI token exchange result");

const ApiKeyCreatedResponseSchema = z
  .unknown()
  .describe("Newly-minted API key (token, tokenId, name, expiresAt)");

const ApiKeyListResponseSchema = z
  .object({
    keys: z.array(z.unknown()),
  })
  .describe("API keys owned by the current user");

const OkResponseSchema = z.object({ ok: z.boolean() });

const WEB_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";

// Redis key prefixes and TTLs
const OAUTH_STATE_PREFIX = "oauth_state:";
const OAUTH_STATE_TTL_SECS = 600; // 10 minutes
const AUTH_CODE_PREFIX = "auth_code:";
const AUTH_CODE_TTL_SECS = 300; // 5 minutes

async function addOAuthState(state: string, provider: string): Promise<void> {
  const redis = getRedisClient();
  await redis.setex(
    `${OAUTH_STATE_PREFIX}${state}`,
    OAUTH_STATE_TTL_SECS,
    JSON.stringify({ provider }),
  );
}

async function getOAuthState(state: string): Promise<{ provider: string } | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${OAUTH_STATE_PREFIX}${state}`);
  if (!raw) return null;
  return JSON.parse(raw) as { provider: string };
}

async function deleteOAuthState(state: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`${OAUTH_STATE_PREFIX}${state}`);
}

async function addAuthCode(code: string, token: string): Promise<void> {
  const redis = getRedisClient();
  await redis.setex(`${AUTH_CODE_PREFIX}${code}`, AUTH_CODE_TTL_SECS, JSON.stringify({ token }));
}

async function getAuthCode(code: string): Promise<{ token: string } | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${AUTH_CODE_PREFIX}${code}`);
  if (!raw) return null;
  return JSON.parse(raw) as { token: string };
}

async function deleteAuthCode(code: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`${AUTH_CODE_PREFIX}${code}`);
}

// Stricter rate limit for auth endpoints (10 req/min vs 100 req/min global)
const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  },
};

export async function authRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ─── Existing Claude auth endpoints ───

  // Plaintext response — hidden from the spec since it's consumed by agents
  // via a non-JSON content type and the schema can't express "text/plain".
  app.get(
    "/api/auth/claude-token",
    {
      schema: {
        hide: true,
        operationId: "getClaudeToken",
        summary: "Get the current Claude auth token (plain text)",
        description:
          "Return the active Claude OAuth token as plain text for agent " +
          "pods. Returns 503 if no token is configured. Hidden from the " +
          "public spec because the response is text/plain, not JSON.",
        tags: ["Auth & Sessions"],
      },
    },
    async (_req, reply) => {
      const result = getClaudeAuthToken();
      if (!result.available || !result.token) {
        return reply.status(503).send({ error: result.error ?? "Token not available" });
      }
      reply.type("text/plain").send(result.token);
    },
  );

  app.get(
    "/api/auth/status",
    {
      schema: {
        operationId: "getAuthStatus",
        summary: "Get Claude authentication status",
        description:
          "Return whether a Claude subscription / OAuth token is available " +
          "and still valid. Probes the Anthropic API to detect expired tokens.",
        tags: ["Auth & Sessions"],
        response: { 200: AuthStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      let result = getClaudeAuthToken();
      // Fallback: check secrets store for oauth-token mode (k8s deployments)
      if (!result.available) {
        try {
          const { retrieveSecret } = await import("../services/secret-service.js");
          const token = await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN").catch(() => null);
          if (token) {
            result = { available: true, token: token as string };
          }
        } catch {}
      }

      // Check the background worker's cached validation first to avoid
      // an extra API call on every status poll
      let expired = false;
      let lastValidated: string | null = null;
      try {
        const { getCachedTokenValidation } = await import("../workers/token-validation-worker.js");
        const cached = await getCachedTokenValidation();
        if (cached) {
          lastValidated = cached.lastValidated;
          if (cached.tokenExists && !cached.valid) {
            expired = true;
            result.available = false;
            result.error = cached.error ?? "OAuth token has expired — please paste a new one";
          }
        }
      } catch {
        // Worker cache unavailable — fall through to live validation
      }

      // If no cached result, validate the token against the Anthropic API directly
      if (!expired && lastValidated === null && result.available && result.token) {
        try {
          const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
              Authorization: `Bearer ${result.token}`,
              "anthropic-beta": "oauth-2025-04-20",
            },
          });
          if (res.status === 401) {
            expired = true;
            result.available = false;
            result.error = "OAuth token has expired — please paste a new one";
          }
          lastValidated = new Date().toISOString();
        } catch {
          // Network error — don't mark as expired, just skip validation
        }
      }

      reply.send({
        subscription: {
          available: result.available,
          expiresAt: result.expiresAt,
          error: result.error,
          expired,
          lastValidated,
        },
      });
    },
  );

  app.get(
    "/api/auth/usage",
    {
      schema: {
        operationId: "getAuthUsage",
        summary: "Get Claude usage and recent auth failures",
        description:
          "Return the current Claude usage statistics plus recent " +
          "auth failure counts for Claude and GitHub.",
        tags: ["Auth & Sessions"],
        response: { 200: AuthUsageResponseSchema },
      },
    },
    async (_req, reply) => {
      const [usage, authFailures] = await Promise.all([
        getClaudeUsage(),
        getRecentAuthFailures().catch(() => ({ claude: false, github: false })),
      ]);
      // hasRecentAuthFailure kept for backward compat (true if either token type has failures)
      const hasRecentAuthFailure = authFailures.claude || authFailures.github;
      reply.send({ usage: { ...usage, hasRecentAuthFailure, authFailures } });
    },
  );

  app.post(
    "/api/auth/refresh",
    {
      schema: {
        operationId: "refreshAuthCache",
        summary: "Refresh the credential cache",
        description:
          "Invalidate the in-process credential cache and return the current " +
          "subscription / auth failure state.",
        tags: ["Auth & Sessions"],
        response: { 200: AuthRefreshResponseSchema },
      },
    },
    async (_req, reply) => {
      invalidateCredentialsCache();
      const result = getClaudeAuthToken();
      const authFailures = await getRecentAuthFailures().catch(() => ({
        claude: false,
        github: false,
      }));
      reply.send({
        subscription: {
          available: result.available,
          expiresAt: result.expiresAt,
          error: result.error,
        },
        authFailures,
      });
    },
  );

  // ─── OAuth endpoints ───

  app.get(
    "/api/auth/providers",
    {
      schema: {
        operationId: "listAuthProviders",
        summary: "List enabled OAuth providers",
        description:
          "Return the enabled OAuth provider list and whether auth is " +
          "globally disabled. Publicly accessible — the web UI calls this " +
          "before showing the login page.",
        tags: ["Auth & Sessions"],
        security: [],
        response: { 200: AuthProvidersResponseSchema },
      },
    },
    async (_req, reply) => {
      reply.send({
        providers: getEnabledProviders(),
        authDisabled: isAuthDisabled(),
      });
    },
  );

  /** Initiate OAuth flow — redirects to provider. */
  app.get(
    "/api/auth/:provider/login",
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        hide: true,
        operationId: "oauthLogin",
        summary: "Initiate OAuth login (redirects to provider)",
        description:
          "Kicks off an OAuth authorization-code flow. Generates a " +
          "single-use state token, stores it in Redis, and 302-redirects " +
          "to the provider's authorize URL. Hidden from the public spec " +
          "because the response is a 302 with a provider-specific URL.",
        tags: ["Auth & Sessions"],
        security: [],
        params: z.object({ provider: z.string() }),
      },
    },
    async (req, reply) => {
      const providerName = req.params.provider;
      const provider = getOAuthProvider(providerName);
      if (!provider) {
        return reply.status(404).send({ error: `Unknown provider: ${providerName}` });
      }

      const state = randomBytes(16).toString("hex");
      await addOAuthState(state, providerName);

      const url = provider.authorizeUrl(state);
      reply.redirect(url);
    },
  );

  /** OAuth callback — exchange code, create session, redirect to web. */
  app.get(
    "/api/auth/:provider/callback",
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        hide: true,
        operationId: "oauthCallback",
        summary: "OAuth callback (redirects to web UI)",
        description:
          "OAuth provider callback. Exchanges the auth code for provider " +
          "tokens, creates a session, and 302-redirects to the web app's " +
          "callback URL with a short-lived exchange code. Hidden from the " +
          "public spec because the response is a 302.",
        tags: ["Auth & Sessions"],
        security: [],
        params: z.object({ provider: z.string() }),
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { provider: providerName } = req.params;
      const { code, state, error } = req.query;

      if (error) {
        return reply.redirect(`${WEB_URL}/login?error=provider_error`);
      }

      if (!code || !state) {
        return reply.redirect(`${WEB_URL}/login?error=missing_params`);
      }

      // Verify state
      const storedState = await getOAuthState(state);
      if (!storedState || storedState.provider !== providerName) {
        return reply.redirect(`${WEB_URL}/login?error=invalid_state`);
      }
      await deleteOAuthState(state);

      const provider = getOAuthProvider(providerName);
      if (!provider) {
        return reply.redirect(`${WEB_URL}/login?error=unknown_provider`);
      }

      try {
        const tokens = await provider.exchangeCode(code);
        const profile = await provider.fetchUser(tokens.accessToken);
        const session = await createSession(providerName, profile);

        // Store GitHub App user tokens for git/API operations
        if (providerName === "github" && tokens.refreshToken && tokens.expiresIn) {
          await storeUserGitHubTokens(session.user.id, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: tokens.expiresIn,
          });
        }

        // Check if this is a CLI flow (state contains a dot separator with cliState suffix)
        const dotIdx = state.indexOf(".");
        if (dotIdx > 0) {
          const cliState = state.slice(dotIdx + 1);
          const redis = getRedisClient();
          const cliRaw = await redis.get(`cli_flow:${cliState}`);
          if (cliRaw) {
            await redis.del(`cli_flow:${cliState}`);
            const cliFlow = JSON.parse(cliRaw) as {
              callback: string;
              codeChallenge: string;
              codeChallengeMethod: string;
            };

            // Mint a one-time CLI auth code
            const cliCode = randomBytes(32).toString("hex");
            await redis.setex(
              `cli_code:${cliCode}`,
              300, // 5 minutes
              JSON.stringify({
                sessionToken: session.token,
                codeChallenge: cliFlow.codeChallenge,
                codeChallengeMethod: cliFlow.codeChallengeMethod,
              }),
            );

            // Redirect to the CLI's loopback callback
            const callbackUrl = new URL(cliFlow.callback);
            callbackUrl.searchParams.set("code", cliCode);
            callbackUrl.searchParams.set("state", cliState);
            return reply.redirect(callbackUrl.toString());
          }
        }

        // Standard web flow: generate a short-lived auth code and redirect to the web app's callback.
        // The web app exchanges the code for the session token server-side and
        // sets the HttpOnly cookie on its own origin — avoiding cross-origin
        // cookie issues when API and web run on different origins.
        const authCode = randomBytes(32).toString("hex");
        await addAuthCode(authCode, session.token);
        reply.redirect(`${WEB_URL}/auth/callback?code=${authCode}`);
      } catch (err) {
        app.log.error(err, "OAuth callback failed");
        reply.redirect(`${WEB_URL}/login?error=auth_failed`);
      }
    },
  );

  app.post(
    "/api/auth/exchange-code",
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        operationId: "exchangeAuthCode",
        summary: "Exchange a short-lived auth code for a session token",
        description:
          "After the OAuth callback redirects to the web app with a " +
          "one-time code, the web app exchanges it here for the session " +
          "token. One-time use, 5-minute TTL.",
        tags: ["Auth & Sessions"],
        security: [],
        body: ExchangeCodeBodySchema,
        response: { 200: ExchangeCodeResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { code } = req.body;

      const entry = await getAuthCode(code);
      if (!entry) {
        return reply.status(400).send({ error: "Invalid or expired code" });
      }
      await deleteAuthCode(code); // one-time use

      const user = await validateSession(entry.token);
      if (!user) {
        return reply.status(400).send({ error: "Session expired" });
      }

      reply.send({ token: entry.token });
    },
  );

  app.get(
    "/api/auth/me",
    {
      schema: {
        operationId: "getCurrentUser",
        summary: "Get the current authenticated user",
        description:
          "Return the current user based on the session cookie or Bearer " +
          "token. When auth is disabled, returns a synthetic local user.",
        tags: ["Auth & Sessions"],
        response: { 200: AuthMeResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (isAuthDisabled()) {
        return reply.send({
          user: {
            id: "local",
            provider: "local",
            email: "dev@localhost",
            displayName: "Local Dev",
            avatarUrl: null,
          },
          authDisabled: true,
        });
      }

      // Resolve token: Bearer header (BFF proxy) → session cookie (direct)
      const authHeader = req.headers.authorization;
      let token: string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      } else {
        const cookieHeader = req.headers.cookie;
        const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]*)`));
        token = match ? decodeURIComponent(match[1]) : undefined;
      }

      if (!token) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const user = await validateSession(token);
      if (!user) {
        return reply.status(401).send({ error: "Invalid or expired session" });
      }

      reply.send({ user, authDisabled: false });
    },
  );

  app.get(
    "/api/auth/ws-token",
    {
      schema: {
        operationId: "getWebSocketToken",
        summary: "Get a short-lived WebSocket auth token",
        description:
          "Mint a short-lived token that the web UI uses when opening " +
          "WebSocket connections. The token is passed via the " +
          "`Sec-WebSocket-Protocol` header so the raw session token never " +
          "crosses the wire twice.",
        tags: ["Auth & Sessions"],
        response: { 200: WsTokenResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (isAuthDisabled()) {
        // Auth disabled — return a dummy token (WS connections won't be checked)
        return reply.send({ token: "auth-disabled" });
      }

      if (!req.user) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const token = await createWsToken(req.user.id);
      return reply.send({ token });
    },
  );

  // ─── CLI login flow ───

  const CLI_STATE_PREFIX = "cli_flow:";
  const CLI_STATE_TTL_SECS = 600; // 10 minutes
  const CLI_CODE_PREFIX = "cli_code:";
  const CLI_CODE_TTL_SECS = 300; // 5 minutes

  const CLI_RATE_LIMIT = {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: "1 minute",
      },
    },
  };

  app.post(
    "/api/auth/cli/start",
    {
      ...CLI_RATE_LIMIT,
      schema: {
        operationId: "startCliLogin",
        summary: "Start a CLI login flow",
        description:
          "Begin a PKCE-backed CLI login flow. The CLI posts its loopback " +
          "callback, PKCE challenge, and a client-chosen state; the API " +
          "stores the state in Redis and returns the provider authorize URL " +
          "the CLI should open in the browser. Publicly accessible so the " +
          "CLI can bootstrap before any credentials exist.",
        tags: ["Auth & Sessions"],
        security: [],
        body: CliStartBodySchema,
        response: {
          200: CliStartResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const {
        provider,
        callback,
        state: cliState,
        code_challenge,
        code_challenge_method,
      } = req.body;

      const oauthProvider = getOAuthProvider(provider);
      if (!oauthProvider) {
        return reply.status(404).send({ error: `Unknown provider: ${provider}` });
      }

      // Store CLI flow data in Redis
      const redis = getRedisClient();
      await redis.setex(
        `${CLI_STATE_PREFIX}${cliState}`,
        CLI_STATE_TTL_SECS,
        JSON.stringify({
          provider,
          callback,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method ?? "S256",
        }),
      );

      // Create the OAuth state that embeds the CLI state
      const oauthState = randomBytes(16).toString("hex") + "." + cliState;
      await addOAuthState(oauthState, provider);

      const url = oauthProvider.authorizeUrl(oauthState);
      reply.send({ url });
    },
  );

  app.post(
    "/api/auth/cli/token",
    {
      ...CLI_RATE_LIMIT,
      schema: {
        operationId: "exchangeCliToken",
        summary: "Exchange a CLI auth code for a personal access token",
        description:
          "Second leg of the CLI login flow. The CLI posts the auth code " +
          "it received on its loopback callback plus the PKCE verifier. " +
          "The API validates PKCE, revokes the temporary web session, and " +
          "mints a personal access token the CLI can use going forward.",
        tags: ["Auth & Sessions"],
        security: [],
        body: CliTokenBodySchema,
        response: { 200: CliTokenResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { code, code_verifier } = req.body;

      // Look up the CLI code entry in Redis
      const redis = getRedisClient();
      const raw = await redis.get(`${CLI_CODE_PREFIX}${code}`);
      if (!raw) {
        return reply.status(400).send({ error: "Invalid or expired code" });
      }
      await redis.del(`${CLI_CODE_PREFIX}${code}`); // one-time use

      const entry = JSON.parse(raw) as {
        sessionToken: string;
        codeChallenge: string;
        codeChallengeMethod: string;
      };

      // Verify PKCE: hash the verifier and compare with the stored challenge
      const { createHash } = await import("node:crypto");
      const computedChallenge = createHash("sha256").update(code_verifier).digest("base64url");
      if (computedChallenge !== entry.codeChallenge) {
        return reply.status(400).send({ error: "PKCE verification failed" });
      }

      // Validate the underlying session to get the user
      const user = await validateSession(entry.sessionToken);
      if (!user) {
        return reply.status(400).send({ error: "Session expired" });
      }

      // Revoke the temporary web session — the CLI will use the PAT instead
      await revokeSession(entry.sessionToken);

      // Create a PAT for the CLI
      const result = await createApiKey(user.id, `CLI (${new Date().toISOString().slice(0, 10)})`);

      reply.send({
        token: result.token,
        tokenId: result.tokenId,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
        },
      });
    },
  );

  // ─── API Key management ───

  app.post(
    "/api/auth/api-keys",
    {
      schema: {
        operationId: "createApiKey",
        summary: "Create a personal access token",
        description:
          "Mint a new personal access token for the current user. " + "Authenticated users only.",
        tags: ["Auth & Sessions"],
        body: ApiKeyBodySchema,
        response: { 201: ApiKeyCreatedResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const name = req.body.name || `API Key (${new Date().toISOString().slice(0, 10)})`;
      const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : undefined;

      const result = await createApiKey(req.user.id, name, expiresAt);
      reply.status(201).send(result);
    },
  );

  app.get(
    "/api/auth/api-keys",
    {
      schema: {
        operationId: "listApiKeys",
        summary: "List my personal access tokens",
        description: "Return the current user's API keys (without the raw secret values).",
        tags: ["Auth & Sessions"],
        response: { 200: ApiKeyListResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const keys = await listApiKeys(req.user.id);
      reply.send({ keys });
    },
  );

  app.delete(
    "/api/auth/api-keys/:id",
    {
      schema: {
        operationId: "revokeApiKey",
        summary: "Revoke a personal access token",
        description: "Revoke a personal access token owned by the current user.",
        tags: ["Auth & Sessions"],
        params: IdParamsSchema,
        response: {
          200: OkResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.status(401).send({ error: "Not authenticated" });
      }

      const revoked = await revokeApiKey(req.params.id, req.user.id);
      if (!revoked) {
        return reply.status(404).send({ error: "API key not found" });
      }
      reply.send({ ok: true });
    },
  );

  app.post(
    "/api/auth/logout",
    {
      ...AUTH_RATE_LIMIT,
      schema: {
        operationId: "logout",
        summary: "Log out",
        description:
          "Revoke the current session token and clear the session cookie. " +
          "Safe to call even when no session exists.",
        tags: ["Auth & Sessions"],
        response: { 200: OkResponseSchema },
      },
    },
    async (req, reply) => {
      // Resolve token: Bearer header (BFF proxy) → session cookie (direct)
      const authHeader = req.headers.authorization;
      let token: string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
      } else {
        const cookieHeader = req.headers.cookie;
        const match = cookieHeader?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]*)`));
        token = match ? decodeURIComponent(match[1]) : undefined;
      }

      if (token) {
        await revokeSession(token);
      }

      const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
      reply
        .header(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`,
        )
        .send({ ok: true });
    },
  );
}
