import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
}

interface CredentialsData {
  claudeAiOauth?: ClaudeOAuthCredentials;
}

let cachedCredentials: CredentialsData | null = null;
let lastRead = 0;
const CACHE_TTL_MS = 30_000; // re-read every 30s

function readCredentialsFromKeychain(): CredentialsData | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readCredentialsFromFile(): CredentialsData | null {
  const paths = [
    join(process.env.CLAUDE_CONFIG_DIR ?? "", ".credentials.json"),
    join(process.env.HOME ?? "", ".claude", ".credentials.json"),
  ].filter(Boolean);

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function readCredentials(): CredentialsData | null {
  const now = Date.now();
  if (cachedCredentials && now - lastRead < CACHE_TTL_MS) {
    return cachedCredentials;
  }

  // Try Keychain first (macOS), then file (Linux)
  let creds = readCredentialsFromKeychain();
  if (!creds) {
    creds = readCredentialsFromFile();
  }

  if (creds) {
    cachedCredentials = creds;
    lastRead = now;
  }

  return creds;
}

export interface AuthTokenResult {
  available: boolean;
  token?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Get the Claude OAuth access token from the host's credentials.
 * This is used by agent containers via the apiKeyHelper callback.
 */
export function getClaudeAuthToken(): AuthTokenResult {
  const creds = readCredentials();

  if (!creds?.claudeAiOauth?.accessToken) {
    return {
      available: false,
      error: "No Claude subscription credentials found on this host",
    };
  }

  const oauth = creds.claudeAiOauth;

  // Check if token is expired (with 5-minute buffer)
  if (oauth.expiresAt) {
    const expiresAt = new Date(oauth.expiresAt);
    const bufferMs = 5 * 60 * 1000;
    if (expiresAt.getTime() - bufferMs < Date.now()) {
      // Token is expired or about to expire
      // Claude Code auto-refreshes tokens, so re-reading should get a fresh one
      cachedCredentials = null;
      const freshCreds = readCredentials();
      if (freshCreds?.claudeAiOauth?.accessToken) {
        return {
          available: true,
          token: freshCreds.claudeAiOauth.accessToken,
          expiresAt: freshCreds.claudeAiOauth.expiresAt,
        };
      }
      return {
        available: false,
        error: "Claude subscription token is expired and could not be refreshed",
      };
    }
  }

  return {
    available: true,
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt,
  };
}

/**
 * Check if a Claude subscription is available on this host.
 */
export function isSubscriptionAvailable(): boolean {
  const result = getClaudeAuthToken();
  return result.available;
}

/**
 * Invalidate the cached credentials so the next read fetches fresh ones.
 */
export function invalidateCredentialsCache(): void {
  cachedCredentials = null;
  lastRead = 0;
}

/**
 * Invalidate the cached usage data so the next call to getClaudeUsage() fetches fresh results.
 * Called when an auth failure is detected (e.g., task fails with expired token) to prevent
 * stale "healthy" usage data from hiding the expiration.
 */
export function invalidateUsageCache(): void {
  cachedUsage = null;
  usageCacheTime = 0;
}

// --- Claude Max usage tracking ---

export interface UsageBucket {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
}

export interface ClaudeUsageResult {
  available: boolean;
  fiveHour?: UsageBucket;
  sevenDay?: UsageBucket;
  sevenDaySonnet?: UsageBucket;
  sevenDayOpus?: UsageBucket;
  extraUsage?: ExtraUsage;
  error?: string;
}

let cachedUsage: ClaudeUsageResult | null = null;
let usageCacheTime = 0;
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — endpoint is aggressively rate-limited

function mapBucket(
  raw: { utilization: number | null; resets_at: string | null } | null,
): UsageBucket | undefined {
  if (!raw) return undefined;
  return { utilization: raw.utilization, resetsAt: raw.resets_at };
}

export async function getClaudeUsage(): Promise<ClaudeUsageResult> {
  const now = Date.now();
  if (cachedUsage && now - usageCacheTime < USAGE_CACHE_TTL_MS) {
    return cachedUsage;
  }

  // Try Keychain/file first (local dev), then secrets store (k8s oauth-token mode)
  let auth = getClaudeAuthToken();
  if (!auth.available || !auth.token) {
    try {
      const { retrieveSecret } = await import("./secret-service.js");
      const token = await retrieveSecret("CLAUDE_CODE_OAUTH_TOKEN").catch(() => null);
      if (token) {
        auth = { available: true, token: token as string };
      }
    } catch {}
  }
  if (!auth.available || !auth.token) {
    return { available: false, error: auth.error ?? "No OAuth token available" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body }, "Failed to fetch Claude usage");

      // On auth-failure status codes, surface the failure immediately so the
      // UI shows the re-auth banner without waiting for the next poll cycle.
      if (res.status === 401 || res.status === 403) {
        const errorMsg = `Usage API returned ${res.status}`;
        try {
          const { recordAuthEvent } = await import("./auth-failure-detector.js");
          await recordAuthEvent("claude", errorMsg, "usage-endpoint");
        } catch {
          // non-fatal — best-effort recording
        }
        try {
          const { publishEvent } = await import("./event-bus.js");
          await publishEvent({
            type: "auth:failed",
            message:
              "Claude Code OAuth token has expired. Go to Secrets to paste a new token, or re-run 'claude setup-token'.",
            timestamp: new Date().toISOString(),
          });
        } catch {
          // non-fatal — best-effort notification
        }
        invalidateUsageCache();
      }

      return { available: false, error: `Usage API returned ${res.status}` };
    }

    const data = await res.json();
    const result: ClaudeUsageResult = {
      available: true,
      fiveHour: mapBucket(data.five_hour),
      sevenDay: mapBucket(data.seven_day),
      sevenDaySonnet: mapBucket(data.seven_day_sonnet),
      sevenDayOpus: mapBucket(data.seven_day_opus),
      extraUsage: data.extra_usage
        ? {
            isEnabled: data.extra_usage.is_enabled,
            monthlyLimit: data.extra_usage.monthly_limit,
            usedCredits: data.extra_usage.used_credits,
            utilization: data.extra_usage.utilization,
          }
        : undefined,
    };

    cachedUsage = result;
    usageCacheTime = now;
    return result;
  } catch (err) {
    logger.warn({ err }, "Error fetching Claude usage");
    return { available: false, error: "Failed to reach usage API" };
  }
}
