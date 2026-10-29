import { and, eq } from "drizzle-orm";
import {
  summarizeChecks,
  summarizeReviews,
  workLinkFromUrl,
  workLinkIdentity,
  type GitPlatform,
  type RepoIdentifier,
  type TicketSource,
  type WorkLink,
  type WorkLinkState,
  type WorkLinkStatus,
} from "@optio/shared";
import { getTicketProvider } from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { logger } from "../logger.js";
import { getRedisClient } from "./event-bus.js";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { retrieveSecret } from "./secret-service.js";

/**
 * Where the PRs and tickets a session's badges name stand, asked of their
 * hosts with the caller's own access (their GitHub / GitLab token, falling
 * back to the deployment's; the workspace's Linear / Jira provider) and
 * cached in Redis so a rail full of sessions polls each host once a minute,
 * not once per viewer per badge. A link the host cannot answer for (no
 * token, no access, no provider) is `state: null` and cached briefly, so a
 * private repo never turns into a request per render.
 */

/** Open things change; a merged / closed / done one is remembered longer. */
const TTL_LIVE_S = 60;
const TTL_SETTLED_S = 15 * 60;
const TTL_UNKNOWN_S = 2 * 60;
const CONCURRENCY = 4;

export interface WorkLinkStatusContext {
  userId?: string | null;
  workspaceId?: string | null;
}

function cacheKey(ctx: WorkLinkStatusContext, link: WorkLink): string {
  // Access differs per user (a private repo one person can see), so the
  // cache is per user; the organization's token answers for everyone else.
  return `optio:work-link-status:${ctx.workspaceId ?? "global"}:${ctx.userId ?? "org"}:${workLinkIdentity(link)}`;
}

function ttlFor(status: WorkLinkStatus): number {
  if (!status.state) return TTL_UNKNOWN_S;
  return status.state === "open" || status.state === "draft" || status.state === "in_progress"
    ? TTL_LIVE_S
    : TTL_SETTLED_S;
}

/** The repo a GitHub / GitLab link belongs to, and its number. */
function repoOf(link: WorkLink): { repoUrl: string; number: number } | null {
  const m = /^(https?:\/\/.+?)\/(?:pull|issues|-\/merge_requests|-\/issues)\/(\d+)$/.exec(link.url);
  if (!m) return null;
  return { repoUrl: m[1], number: Number(m[2]) };
}

async function prStatus(
  platform: GitPlatform,
  ri: RepoIdentifier,
  number: number,
): Promise<Omit<WorkLinkStatus, "url">> {
  const pr = await platform.getPullRequest(ri, number);
  const state: WorkLinkState = pr.merged
    ? "merged"
    : pr.state === "closed"
      ? "closed"
      : pr.draft
        ? "draft"
        : "open";
  if (state !== "open" && state !== "draft") return { state };
  const [checks, reviews] = await Promise.all([
    pr.headSha ? platform.getCIChecks(ri, pr.headSha).catch(() => []) : Promise.resolve([]),
    platform.getReviews(ri, number).catch(() => []),
  ]);
  return { state, checks: summarizeChecks(checks), review: summarizeReviews(reviews) };
}

async function gitLinkStatus(
  link: WorkLink,
  ctx: WorkLinkStatusContext,
): Promise<Omit<WorkLinkStatus, "url">> {
  const target = repoOf(link);
  if (!target) return { state: null };
  const { platform, ri } = await getGitPlatformForRepo(target.repoUrl, {
    userId: ctx.userId ?? undefined,
    workspaceId: ctx.workspaceId,
  });
  if (link.kind === "pr") return prStatus(platform, ri, target.number);
  if (!platform.getIssue) return { state: null };
  const issue = await platform.getIssue(ri, target.number);
  // A bare `#N` on GitHub may be a PR; the issue endpoint says so.
  if (issue.isPullRequest) return prStatus(platform, ri, target.number);
  return { state: issue.state === "closed" ? "done" : "open" };
}

/** A workspace's provider for a ticket source, credentials merged in (as the ticket sweep does). */
async function ticketProviderConfig(
  source: TicketSource,
  pick: (config: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select()
    .from(ticketProviders)
    .where(and(eq(ticketProviders.source, source), eq(ticketProviders.enabled, true)));
  for (const row of rows) {
    let config = { ...(row.config ?? {}) };
    try {
      config = {
        ...config,
        ...JSON.parse(await retrieveSecret(`ticket-provider:${row.id}`, "ticket-provider")),
      };
    } catch {
      // No stored credentials — the config may carry them.
    }
    if (pick(config)) return config;
  }
  return null;
}

async function ticketLinkStatus(link: WorkLink): Promise<Omit<WorkLinkStatus, "url">> {
  const source = link.provider as TicketSource;
  const host = (() => {
    try {
      return new URL(link.url).host.toLowerCase();
    } catch {
      return "";
    }
  })();
  const config = await ticketProviderConfig(source, (c) => {
    if (source !== "jira") return true;
    // A Jira key is only meaningful at the site the link points at.
    try {
      return new URL(String(c.baseUrl ?? "")).host.toLowerCase() === host;
    } catch {
      return false;
    }
  });
  if (!config) return { state: null };
  const provider = getTicketProvider(source);
  if (!provider.fetchTicketState) return { state: null };
  return { state: await provider.fetchTicketState(link.label, config) };
}

async function lookup(link: WorkLink, ctx: WorkLinkStatusContext): Promise<WorkLinkStatus> {
  try {
    const status =
      link.provider === "github" || link.provider === "gitlab"
        ? await gitLinkStatus(link, ctx)
        : await ticketLinkStatus(link);
    return { url: link.url, ...status };
  } catch (err) {
    logger.debug({ err, url: link.url }, "[work-links] status lookup failed");
    return { url: link.url, state: null };
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * The status of each URL, keyed by the URL as given. URLs that name no PR /
 * ticket are left out; the rest always answer (with `state: null` when the
 * host could not be asked).
 */
export async function getWorkLinkStatuses(
  urls: string[],
  ctx: WorkLinkStatusContext,
): Promise<WorkLinkStatus[]> {
  const links = new Map<string, WorkLink>();
  for (const url of urls) {
    const link = workLinkFromUrl(url);
    if (link && !links.has(url)) links.set(url, link);
  }
  if (links.size === 0) return [];

  const redis = getRedisClient();
  const entries = [...links.entries()];
  const cached = await Promise.all(
    entries.map(([, link]) => redis.get(cacheKey(ctx, link)).catch(() => null)),
  );

  const results: WorkLinkStatus[] = [];
  const misses: [string, WorkLink][] = [];
  entries.forEach(([url, link], i) => {
    const hit = cached[i];
    if (hit) {
      try {
        results.push({ ...(JSON.parse(hit) as WorkLinkStatus), url });
        return;
      } catch {
        // Fall through to a fresh lookup.
      }
    }
    misses.push([url, link]);
  });

  // The same PR under two URLs (`/issues/N` and `/pull/N`) is looked up once.
  const byIdentity = new Map<string, [string, WorkLink][]>();
  for (const miss of misses) {
    const id = workLinkIdentity(miss[1]);
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), miss]);
  }
  const fresh = await mapLimit([...byIdentity.values()], CONCURRENCY, async (group) => {
    const [, link] = group[0];
    const status = await lookup(link, ctx);
    const { url: _url, ...body } = status;
    await redis
      .set(cacheKey(ctx, link), JSON.stringify(body), "EX", ttlFor(status))
      .catch(() => undefined);
    return group.map(([url]) => ({ ...body, url }));
  });
  for (const statuses of fresh) results.push(...statuses);
  return results;
}
