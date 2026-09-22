import { Queue, Worker } from "bullmq";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";
import { getRedisClient } from "../services/event-bus.js";

const connectionOpts = getBullMQConnectionOptions();

export const tokenValidationQueue = new Queue("token-validation", {
  connection: connectionOpts,
});

/**
 * Redis key where the latest token validation result is cached.
 * Read by GET /api/auth/status and the task-worker pre-flight check.
 */
export const TOKEN_VALIDATION_CACHE_KEY = "optio:token-validation";

/** TTL for the cached result — 10 minutes (2x the check interval). */
const CACHE_TTL_SECS = 600;

export interface TokenValidationResult {
  valid: boolean;
  lastValidated: string; // ISO-8601
  error?: string;
  /** Whether a CLAUDE_CODE_OAUTH_TOKEN secret exists at all. */
  tokenExists: boolean;
}

/**
 * Read the cached token validation result from Redis.
 * Returns null if no cached result exists.
 */
export async function getCachedTokenValidation(): Promise<TokenValidationResult | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(TOKEN_VALIDATION_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TokenValidationResult;
  } catch {
    return null;
  }
}

/** Overwrite the cached validation result (e.g. right after a refresh stored a good token). */
export async function recordTokenValidation(
  result: Omit<TokenValidationResult, "lastValidated">,
): Promise<void> {
  const redis = getRedisClient();
  await redis.setex(
    TOKEN_VALIDATION_CACHE_KEY,
    CACHE_TTL_SECS,
    JSON.stringify({ ...result, lastValidated: new Date().toISOString() }),
  );
}

const EXPIRED = "OAuth token has expired or been revoked — please paste a new one";

/**
 * Validate a Claude OAuth token against the Anthropic API.
 * Returns { valid: true } if the token is accepted, or { valid: false, error } if rejected.
 *
 * The usage endpoint answers first. Only a 401 there is a verdict: a revoked
 * token can keep drawing 429s from it for as long as you keep asking, which
 * used to read as "valid" and kept the automatic refresh from ever running.
 * So any other non-2xx answer is confirmed against `GET /v1/models`, which
 * rejects a revoked token outright. A network error still fails open.
 */
export async function validateClaudeToken(
  token: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (res.status === 401) return { valid: false, error: EXPIRED };
    if (res.ok) return { valid: true };
  } catch {
    // Network error — fall through to the second opinion.
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (res.status === 401 || res.status === 403) return { valid: false, error: EXPIRED };
    // 2xx, a rate limit on this endpoint too, or an outage: not a verdict.
    return { valid: true };
  } catch {
    // Network error — don't mark as invalid, just skip
    return { valid: true };
  }
}

/**
 * Periodic background worker that validates the stored CLAUDE_CODE_OAUTH_TOKEN.
 *
 * When the token is expired, publishes an `auth:failed` WebSocket event so the
 * UI can show a warning banner before any task is launched. Results are cached
 * in Redis so the auth status endpoint and task-worker pre-flight check can
 * read them without re-probing the Anthropic API.
 */
export function startTokenValidationWorker() {
  const intervalMs = parseInt(process.env.OPTIO_TOKEN_VALIDATION_INTERVAL ?? "300000", 10); // 5 min

  tokenValidationQueue.add(
    "validate-token",
    {},
    {
      repeat: {
        every: intervalMs,
      },
    },
  );

  const worker = new Worker(
    "token-validation",
    async () => {
      const redis = getRedisClient();

      // Try to retrieve the stored OAuth token from the secrets store
      let token: string | null = null;
      try {
        const { retrieveSecret } = await import("../services/secret-service.js");
        token = await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN").catch(() => null);
      } catch {
        // No secret-service available or encryption key not set — skip
      }

      // Also check host credentials (max-subscription mode)
      if (!token) {
        try {
          const { getClaudeAuthToken } = await import("../services/auth-service.js");
          const authResult = getClaudeAuthToken();
          if (authResult.available && authResult.token) {
            token = authResult.token;
          }
        } catch {
          // auth-service not available
        }
      }

      const now = new Date().toISOString();

      if (!token) {
        // No token configured — nothing to validate. Cache that fact.
        const result: TokenValidationResult = {
          valid: true,
          lastValidated: now,
          tokenExists: false,
        };
        await redis.setex(TOKEN_VALIDATION_CACHE_KEY, CACHE_TTL_SECS, JSON.stringify(result));
        return;
      }

      // Validate the token
      const validation = await validateClaudeToken(token);

      const result: TokenValidationResult = {
        valid: validation.valid,
        lastValidated: now,
        tokenExists: true,
        ...(validation.error ? { error: validation.error } : {}),
      };

      await redis.setex(TOKEN_VALIDATION_CACHE_KEY, CACHE_TTL_SECS, JSON.stringify(result));

      if (!validation.valid) {
        logger.warn("Claude OAuth token validation failed — token is expired or invalid");

        // A paired machine (Optio Local daemon) may hold a fresh login: take
        // it from there before bothering anyone with the paste banner.
        try {
          const { autoRefreshClaudeToken } =
            await import("../services/local-auth-refresh-service.js");
          if (await autoRefreshClaudeToken("validation-failed")) {
            logger.info("Claude OAuth token refreshed automatically from a paired machine");
            return;
          }
        } catch (err) {
          logger.warn({ err }, "automatic Claude token refresh failed");
        }

        // Invalidate the usage cache so the dashboard shows fresh data
        try {
          const { invalidateUsageCache } = await import("../services/auth-service.js");
          invalidateUsageCache();
        } catch {
          // non-fatal
        }

        // Publish auth:failed event so the UI shows a banner immediately
        try {
          const { publishEvent } = await import("../services/event-bus.js");
          await publishEvent({
            type: "auth:failed",
            message:
              "Claude Code OAuth token has expired. Go to Secrets to paste a new token, or re-run 'claude setup-token'.",
            timestamp: now,
          });
        } catch {
          // non-fatal — UI will pick it up on next poll
        }
      } else {
        logger.debug("Claude OAuth token validation passed");
      }
    },
    {
      connection: connectionOpts,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Token validation job failed");
  });

  return worker;
}
