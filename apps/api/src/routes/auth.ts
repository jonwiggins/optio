import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getClaudeAuthToken,
  getClaudeUsage,
  invalidateCredentialsCache,
} from "../services/auth-service.js";
import { hasRecentClaudeAuthFailure } from "../services/auth-failure-detector.js";
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

export async function authRoutes(app: FastifyInstance) {
  // ─── Existing Claude auth endpoints ───

  app.get("/api/auth/claude-token", async (_req, reply) => {
    const result = getClaudeAuthToken();
    if (!result.available || !result.token) {
      return reply.status(503).send({ error: result.error ?? "Token not available" });
    }
    reply.type("text/plain").send(result.token);
  });

  app.get("/api/auth/status", async (_req, reply) => {
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

    // Validate the token against the Anthropic API if we have one
    let expired = false;
    if (result.available && result.token) {
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
      },
    });
  });

  app.get("/api/auth/usage", async (_req, reply) => {
    const [usage, hasRecentAuthFailure] = await Promise.all([
      getClaudeUsage(),
      hasRecentClaudeAuthFailure().catch(() => false),
    ]);
    reply.send({ usage: { ...usage, hasRecentAuthFailure } });
  });

  app.post("/api/auth/refresh", async (_req, reply) => {
    invalidateCredentialsCache();
    const result = getClaudeAuthToken();
    reply.send({
      subscription: {
        available: result.available,
        expiresAt: result.expiresAt,
        error: result.error,
      },
    });
  });

  // ─── OAuth endpoints ───

  /** List enabled OAuth providers + auth config. */
  app.get("/api/auth/providers", async (_req, reply) => {
    reply.send({
      providers: getEnabledProviders(),
      authDisabled: isAuthDisabled(),
    });
  });

  /** Initiate OAuth flow — redirects to provider. */
  app.get<{ Params: { provider: string } }>(
    "/api/auth/:provider/login",
    AUTH_RATE_LIMIT,
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
  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>("/api/auth/:provider/callback", AUTH_RATE_LIMIT, async (req, reply) => {
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
  });

  /** Exchange a short-lived auth code for the session token. */
  app.post("/api/auth/exchange-code", AUTH_RATE_LIMIT, async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code) {
      return reply.status(400).send({ error: "Missing code" });
    }

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
  });

  /** Get current user from session. */
  app.get("/api/auth/me", async (req, reply) => {
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
  });

  /** Get a short-lived token for authenticating WebSocket connections. */
  app.get("/api/auth/ws-token", async (req, reply) => {
    if (isAuthDisabled()) {
      // Auth disabled — return a dummy token (WS connections won't be checked)
      return reply.send({ token: "auth-disabled" });
    }

    if (!req.user) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const token = await createWsToken(req.user.id);
    return reply.send({ token });
  });

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

  /**
   * Start a CLI login flow. Stores PKCE challenge in Redis and returns
   * the URL the CLI should open in the browser.
   */
  app.post("/api/auth/cli/start", CLI_RATE_LIMIT, async (req, reply) => {
    const body = (req.body ?? {}) as {
      provider?: string;
      callback?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      client_name?: string;
      client_version?: string;
    };

    const { provider, callback, state: cliState, code_challenge, code_challenge_method } = body;

    if (!provider || !callback || !cliState || !code_challenge) {
      return reply
        .status(400)
        .send({ error: "Missing required fields: provider, callback, state, code_challenge" });
    }

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
  });

  /**
   * Exchange a CLI auth code + PKCE verifier for a personal access token.
   */
  app.post("/api/auth/cli/token", CLI_RATE_LIMIT, async (req, reply) => {
    const body = (req.body ?? {}) as {
      code?: string;
      code_verifier?: string;
    };

    const { code, code_verifier } = body;
    if (!code || !code_verifier) {
      return reply.status(400).send({ error: "Missing required fields: code, code_verifier" });
    }

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
  });

  // ─── API Key management ───

  /** Create an API key (authenticated users). */
  app.post("/api/auth/api-keys", async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const body = (req.body ?? {}) as {
      name?: string;
      expiresAt?: string;
    };

    const name = body.name || `API Key (${new Date().toISOString().slice(0, 10)})`;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

    const result = await createApiKey(req.user.id, name, expiresAt);
    reply.status(201).send(result);
  });

  /** List API keys for the current user. */
  app.get("/api/auth/api-keys", async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const keys = await listApiKeys(req.user.id);
    reply.send({ keys });
  });

  /** Revoke an API key. */
  app.delete<{ Params: { id: string } }>("/api/auth/api-keys/:id", async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: "Not authenticated" });
    }

    const revoked = await revokeApiKey(req.params.id, req.user.id);
    if (!revoked) {
      return reply.status(404).send({ error: "API key not found" });
    }
    reply.send({ ok: true });
  });

  /** Logout — revoke session and clear cookie. */
  app.post("/api/auth/logout", AUTH_RATE_LIMIT, async (req, reply) => {
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
  });
}
