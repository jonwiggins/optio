import { normalizeRepoUrl, type PrFacts } from "@optio/shared";

/**
 * The pull-request panel's per-repository facts cache, apart from the
 * service so the webhook receivers can drop an entry without loading it
 * (and everything it imports). Per API instance, like every cache here.
 */

export interface PrFactsCacheEntry {
  at: number;
  facts: PrFacts[];
}

export const prFactsCache = new Map<string, PrFactsCacheEntry>();
export const prFactsInFlight = new Map<string, Promise<PrFacts[]>>();

export const prFactsCacheKey = (workspaceId: string | null, repoUrl: string) =>
  `${workspaceId ?? "-"}:${normalizeRepoUrl(repoUrl)}`;

/** A webhook said the repo's PRs changed: the next read goes to the platform. */
export function invalidatePrInboxRepo(repoUrl: string): void {
  const suffix = `:${normalizeRepoUrl(repoUrl)}`;
  for (const key of prFactsCache.keys()) if (key.endsWith(suffix)) prFactsCache.delete(key);
}

/** For tests. */
export function clearPrInboxCache(): void {
  prFactsCache.clear();
  prFactsInFlight.clear();
}
