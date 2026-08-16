import { createHash } from "node:crypto";
import {
  PROVIDER_CATALOGS,
  mergeLiveModels,
  type AgentProviderId,
  type LiveModel,
  type ProviderCatalog,
} from "@optio/shared";
import { getRedisClient } from "./event-bus.js";
import { retrieveSecret } from "./secret-service.js";

/** Cache TTL for live-probed model lists. ~1h matches the task spec. */
const CACHE_TTL_SECONDS = 60 * 60;

/** Redis key prefix for cached live model lists. */
const CACHE_KEY_PREFIX = "optio:agent-options";

/**
 * Credential used for an upstream list-models probe. `api-key` is sent in the
 * provider's native key header; `oauth` is sent as a Bearer token (Anthropic
 * OAuth tokens from `claude setup-token` additionally need the oauth beta
 * header).
 */
interface ProbeCredential {
  value: string;
  kind: "api-key" | "oauth";
}

type LiveProbe = (credential: ProbeCredential) => Promise<LiveModel[]>;

/** Safety bound on list-models pagination — well above any real model count. */
const MAX_PROBE_PAGES = 10;

/** Anthropic: GET /v1/models → data[].{id,display_name}, paginated via after_id. */
async function probeAnthropic(credential: ProbeCredential): Promise<LiveModel[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (credential.kind === "oauth") {
    headers.Authorization = `Bearer ${credential.value}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = credential.value;
  }

  const models: LiveModel[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PROBE_PAGES; page++) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Anthropic /v1/models returned ${res.status}`);
    const body = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
      has_more?: boolean;
      last_id?: string;
    };
    for (const m of body.data ?? []) {
      if (m.id) models.push({ id: m.id, displayName: m.display_name });
    }
    if (!body.has_more || !body.last_id) break;
    afterId = body.last_id;
  }
  return models;
}

/** OpenAI: GET /v1/models → data[].id. */
async function probeOpenAI(credential: ProbeCredential): Promise<LiveModel[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${credential.value}` },
  });
  if (!res.ok) throw new Error(`OpenAI /v1/models returned ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).flatMap((m) => (m.id ? [{ id: m.id }] : []));
}

/** Gemini: GET /v1beta/models?key=... → models[].{name,displayName} (strip "models/" prefix). */
async function probeGemini(credential: ProbeCredential): Promise<LiveModel[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(credential.value)}`,
  );
  if (!res.ok) throw new Error(`Gemini /v1beta/models returned ${res.status}`);
  const body = (await res.json()) as {
    models?: Array<{ name?: string; displayName?: string }>;
  };
  return (body.models ?? []).flatMap((m) => {
    const name = m.name ?? "";
    const id = name.startsWith("models/") ? name.slice("models/".length) : name;
    return id ? [{ id, displayName: m.displayName }] : [];
  });
}

interface ProbeConfig {
  /** Redis cache key suffix (distinguishes providers sharing a DB column). */
  probeKey: AgentProviderId;
  /** Ordered credential sources for the upstream probe — first one found wins. */
  secretCandidates: Array<{ name: string; kind: ProbeCredential["kind"] }>;
  /** Probe function that returns a list of upstream models. */
  probe: LiveProbe;
}

const PROBE_CONFIG: Partial<Record<AgentProviderId, ProbeConfig>> = {
  anthropic: {
    probeKey: "anthropic",
    // OAuth-token deployments (the recommended k8s mode) have no API key, so
    // fall back to the Claude Code OAuth token for the probe.
    secretCandidates: [
      { name: "ANTHROPIC_API_KEY", kind: "api-key" },
      { name: "CLAUDE_CODE_OAUTH_TOKEN", kind: "oauth" },
    ],
    probe: probeAnthropic,
  },
  openai: {
    probeKey: "openai",
    secretCandidates: [{ name: "OPENAI_API_KEY", kind: "api-key" }],
    probe: probeOpenAI,
  },
  gemini: {
    probeKey: "gemini",
    secretCandidates: [{ name: "GEMINI_API_KEY", kind: "api-key" }],
    probe: probeGemini,
  },
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

async function readLiveModelsFromCache(
  provider: AgentProviderId,
  keyHash: string,
): Promise<{ models: LiveModel[]; refreshedAt: number } | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(buildCacheKey(provider, keyHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      models?: LiveModel[];
      ids?: string[]; // pre-displayName cache shape
      refreshedAt?: number;
    };
    const models = Array.isArray(parsed.models)
      ? parsed.models
      : Array.isArray(parsed.ids)
        ? parsed.ids.map((id) => ({ id }))
        : null;
    if (!models) return null;
    return {
      models,
      refreshedAt: parsed.refreshedAt ?? Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

async function writeLiveModelsToCache(
  provider: AgentProviderId,
  keyHash: string,
  models: LiveModel[],
): Promise<number> {
  const refreshedAt = Math.floor(Date.now() / 1000);
  try {
    const redis = getRedisClient();
    await redis.set(
      buildCacheKey(provider, keyHash),
      JSON.stringify({ models, refreshedAt }),
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

  // Look up a configured credential for the probe (first candidate that
  // resolves wins). None found → baseline only.
  let credential: ProbeCredential | null = null;
  for (const candidate of probeConfig.secretCandidates) {
    try {
      const value = await retrieveSecret(candidate.name, "global", opts.workspaceId ?? undefined);
      if (value) {
        credential = { value, kind: candidate.kind };
        break;
      }
    } catch {
      // Not configured — try the next candidate.
    }
  }

  if (!credential) {
    return {
      catalog: baseline,
      source: "baseline",
      cached: false,
      refreshedAt: null,
    };
  }

  const keyHash = hashKey(credential.value);

  if (!opts.forceRefresh) {
    const cached = await readLiveModelsFromCache(provider, keyHash);
    if (cached) {
      return {
        catalog: mergeLiveModels(baseline, cached.models),
        source: "live",
        cached: true,
        refreshedAt: cached.refreshedAt,
      };
    }
  }

  try {
    const models = await probeConfig.probe(credential);
    const refreshedAt = await writeLiveModelsToCache(provider, keyHash, models);
    return {
      catalog: mergeLiveModels(baseline, models),
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
