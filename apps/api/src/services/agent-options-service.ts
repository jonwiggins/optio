import { createHash } from "node:crypto";
import {
  PROVIDER_CATALOGS,
  mergeLiveModels,
  type AgentProviderId,
  type ProviderCatalog,
} from "@optio/shared";
import { getRedisClient } from "./event-bus.js";
import { retrieveSecret } from "./secret-service.js";

/** Cache TTL for live-probed model lists. ~1h matches the task spec. */
const CACHE_TTL_SECONDS = 60 * 60;

/** Redis key prefix for cached live model lists. */
const CACHE_KEY_PREFIX = "optio:agent-options";

type LiveProbe = (apiKey: string) => Promise<string[]>;

/** Anthropic: GET /v1/models → data[].id. */
async function probeAnthropic(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`Anthropic /v1/models returned ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** OpenAI: GET /v1/models → data[].id. */
async function probeOpenAI(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI /v1/models returned ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** Gemini: GET /v1beta/models?key=... → models[].name (strip "models/" prefix). */
async function probeGemini(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) throw new Error(`Gemini /v1beta/models returned ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string }> };
  return (body.models ?? [])
    .map((m) => m.name ?? "")
    .map((name) => (name.startsWith("models/") ? name.slice("models/".length) : name))
    .filter(Boolean);
}

interface ProbeConfig {
  /** Redis cache key suffix (distinguishes providers sharing a DB column). */
  probeKey: AgentProviderId;
  /** Secret name that holds the API key for the upstream probe. */
  secretName: string;
  /** Probe function that returns a list of upstream model ids. */
  probe: LiveProbe;
}

const PROBE_CONFIG: Partial<Record<AgentProviderId, ProbeConfig>> = {
  anthropic: { probeKey: "anthropic", secretName: "ANTHROPIC_API_KEY", probe: probeAnthropic },
  openai: { probeKey: "openai", secretName: "OPENAI_API_KEY", probe: probeOpenAI },
  gemini: { probeKey: "gemini", secretName: "GEMINI_API_KEY", probe: probeGemini },
};

/**
 * Build a short hash of the key used for the probe — lets us invalidate the
 * cache automatically when the API key is rotated without storing the secret
 * itself in the Redis key.
 */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function buildCacheKey(provider: AgentProviderId, keyHash: string): string {
  return `${CACHE_KEY_PREFIX}:${provider}:${keyHash}`;
}

export interface ProviderOptionsResult {
  catalog: ProviderCatalog;
  /** "baseline" = hardcoded only; "live" = merged with upstream list. */
  source: "baseline" | "live";
  /** True if the live list came from Redis (not a fresh probe). */
  cached: boolean;
  /** Unix seconds when the cache entry was refreshed, or null when baseline-only. */
  refreshedAt: number | null;
  /** User-visible error if the live probe failed (cache-miss fallback to baseline). */
  error?: string;
}

interface GetOptions {
  /** Workspace scope for secret resolution. */
  workspaceId?: string | null;
  /** If true, skip the Redis cache and always probe upstream. */
  forceRefresh?: boolean;
}

async function readLiveIdsFromCache(
  provider: AgentProviderId,
  keyHash: string,
): Promise<{ ids: string[]; refreshedAt: number } | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(buildCacheKey(provider, keyHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ids?: string[]; refreshedAt?: number };
    if (!Array.isArray(parsed.ids)) return null;
    return {
      ids: parsed.ids,
      refreshedAt: parsed.refreshedAt ?? Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

async function writeLiveIdsToCache(
  provider: AgentProviderId,
  keyHash: string,
  ids: string[],
): Promise<number> {
  const refreshedAt = Math.floor(Date.now() / 1000);
  try {
    const redis = getRedisClient();
    await redis.set(
      buildCacheKey(provider, keyHash),
      JSON.stringify({ ids, refreshedAt }),
      "EX",
      CACHE_TTL_SECONDS,
    );
  } catch {
    // Cache write failures are non-fatal — the caller still gets the merged result.
  }
  return refreshedAt;
}

/**
 * Load the options catalog for a provider, optionally merging in a live
 * list-models probe. For providers without `liveRefreshSupported`, this
 * just returns the hardcoded baseline.
 */
export async function getProviderOptions(
  provider: AgentProviderId,
  opts: GetOptions = {},
): Promise<ProviderOptionsResult> {
  const baseline = PROVIDER_CATALOGS[provider];
  if (!baseline) {
    throw new Error(`Unknown agent provider: ${provider}`);
  }

  if (!baseline.liveRefreshSupported) {
    return {
      catalog: baseline,
      source: "baseline",
      cached: false,
      refreshedAt: null,
    };
  }

  const probeConfig = PROBE_CONFIG[provider];
  if (!probeConfig) {
    return {
      catalog: baseline,
      source: "baseline",
      cached: false,
      refreshedAt: null,
    };
  }

  // Look up the configured API key for the probe. Missing → baseline only.
  let apiKey: string | null = null;
  try {
    apiKey = await retrieveSecret(probeConfig.secretName, "global", opts.workspaceId ?? undefined);
  } catch {
    // No configured key — nothing to probe with.
  }

  if (!apiKey) {
    return {
      catalog: baseline,
      source: "baseline",
      cached: false,
      refreshedAt: null,
    };
  }

  const keyHash = hashKey(apiKey);

  if (!opts.forceRefresh) {
    const cached = await readLiveIdsFromCache(provider, keyHash);
    if (cached) {
      return {
        catalog: mergeLiveModels(baseline, cached.ids),
        source: "live",
        cached: true,
        refreshedAt: cached.refreshedAt,
      };
    }
  }

  try {
    const ids = await probeConfig.probe(apiKey);
    const refreshedAt = await writeLiveIdsToCache(provider, keyHash, ids);
    return {
      catalog: mergeLiveModels(baseline, ids),
      source: "live",
      cached: false,
      refreshedAt,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      catalog: baseline,
      source: "baseline",
      cached: false,
      refreshedAt: null,
      error,
    };
  }
}

/** Invalidate the cached list for a provider across every tracked API-key hash. */
export async function invalidateProviderCache(provider: AgentProviderId): Promise<void> {
  const redis = getRedisClient();
  try {
    // Small provider count + short hash space → SCAN is overkill.
    // Using a broad pattern match is fine here.
    const stream = redis.scanStream({ match: `${CACHE_KEY_PREFIX}:${provider}:*`, count: 50 });
    const toDelete: string[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (keys: string[]) => {
        toDelete.push(...keys);
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    if (toDelete.length > 0) {
      await redis.del(...toDelete);
    }
  } catch {
    // Cache invalidation failures are non-fatal.
  }
}
