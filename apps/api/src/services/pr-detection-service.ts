import { TASK_BRANCH_PREFIX, parseRepoUrl } from "@optio/shared";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { logger } from "../logger.js";

export interface ExistingPr {
  url: string;
  number: number;
  state: string;
}

/**
 * Result of verifying a task's PR against the git platform.
 *
 * - `verified`    — the platform confirmed an open PR whose head/source branch
 *                   is the task's deterministic branch (`optio/task-{taskId}`).
 * - `no_pr`       — the platform was reachable and authoritatively reported no
 *                   open PR for the task branch.
 * - `unavailable` — the platform could not be consulted (no token, unparseable
 *                   repo URL, or API error). Callers should fall back to their
 *                   previous behavior rather than treating this as "no PR".
 */
export type PrVerification =
  | { status: "verified"; pr: ExistingPr }
  | { status: "no_pr" }
  | { status: "unavailable"; reason: string };

/**
 * Extract owner and repo from a normalized repo URL.
 * e.g. "https://github.com/owner/repo" → { owner: "owner", repo: "repo" }
 */
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) return null;
  return { owner: ri.owner, repo: ri.repo };
}

/**
 * Check if an open PR already exists for a task's branch.
 *
 * Uses the GitPlatform abstraction to list open PRs filtered by branch.
 * Branch naming is deterministic: `optio/task-{taskId}`
 *
 * Returns the PR info if found, or null if no PR exists.
 */
export async function checkExistingPr(
  repoUrl: string,
  taskId: string,
  workspaceId: string | null,
): Promise<ExistingPr | null> {
  const verification = await verifyTaskPr(repoUrl, taskId, workspaceId);
  return verification.status === "verified" ? verification.pr : null;
}

/**
 * Verify against the git platform whether an open PR exists for a task's
 * branch. Unlike {@link checkExistingPr}, this distinguishes "the platform
 * says there is no PR" from "the platform could not be consulted", so callers
 * can reject unverified PR URLs scraped from agent output without breaking
 * platforms/configurations where verification is impossible.
 */
export async function verifyTaskPr(
  repoUrl: string,
  taskId: string,
  _workspaceId: string | null,
): Promise<PrVerification> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri) {
    logger.debug({ repoUrl }, "Cannot parse repo URL — skipping PR check");
    return { status: "unavailable", reason: "unparseable_repo_url" };
  }

  let platform;
  try {
    const result = await getGitPlatformForRepo(repoUrl, { server: true });
    platform = result.platform;
  } catch {
    logger.debug("No git token available — skipping existing PR check");
    return { status: "unavailable", reason: "no_git_token" };
  }

  const branch = `${TASK_BRANCH_PREFIX}${taskId}`;

  try {
    const pulls = await platform.listOpenPullRequests(ri, { branch });

    if (pulls.length === 0) return { status: "no_pr" };

    const pr = pulls[0];
    return {
      status: "verified",
      pr: {
        url: pr.url,
        number: pr.number,
        state: pr.state,
      },
    };
  } catch (err) {
    logger.debug({ err }, "Failed to check for existing PR");
    return { status: "unavailable", reason: "platform_lookup_failed" };
  }
}

/**
 * Decide which PR URL (if any) a task should trust, given a URL scraped from
 * agent output and the platform verification result.
 *
 * A `/pull/N` URL in agent output is not proof that a PR was opened — it may
 * be an example URL echoed from the prompt (see issue #531). The task branch
 * is deterministic, so the platform's answer for that branch is authoritative:
 *
 * - `verified`    → use the canonical URL reported by the platform (it wins
 *                   even over a differing scraped URL).
 * - `no_pr`       → reject the scraped URL (`rejectedUrl` is set so callers
 *                   can log the skip).
 * - `unavailable` → fall back to trusting the scraped URL (legacy behavior).
 */
export function resolveDetectedPrUrl(
  scrapedUrl: string | undefined,
  verification: PrVerification,
): { url: string | undefined; rejectedUrl?: string } {
  switch (verification.status) {
    case "verified":
      return { url: verification.pr.url };
    case "no_pr":
      return { url: undefined, rejectedUrl: scrapedUrl };
    case "unavailable":
      return { url: scrapedUrl };
  }
}
